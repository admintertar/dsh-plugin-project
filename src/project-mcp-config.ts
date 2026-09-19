import {readFileSync, statSync} from 'node:fs';
import {parse, stringify} from 'yaml';
import {z} from 'zod';
import {atomicWriteFile} from './atomic-file.ts';
import {ensureProjectLayout, type ProjectLayout} from './project-layout.ts';
import type {ProjectView} from './project.ts';
import {RECONNECT_DEFAULTS} from './vendor/dsh-mcp-client/connection.ts';

const MAX_PUBLIC_BYTES = 256 * 1024;
const MAX_LOCAL_BYTES = 256 * 1024;
const MAX_SERVERS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_TOOL_TIMEOUT_MS = 100;
const MAX_TOOL_TIMEOUT_MS = 10 * 60 * 1_000;

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const serverNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const stringMapSchema = z.record(z.string().min(1).max(256), z.string().max(32 * 1024));
const reconnectSchema = z.object({
  enabled: z.boolean().optional(),
  initialDelayMs: z.number().finite().int().min(1).max(MAX_TIMER_DELAY_MS).optional(),
  maxDelayMs: z.number().finite().int().min(1).max(MAX_TIMER_DELAY_MS).optional(),
  maxAttempts: z.number().int().min(1).max(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs) > (value.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs)) {
    ctx.addIssue({code: 'custom', message: 'initialDelayMs must be less than or equal to maxDelayMs'});
  }
});

const commonServer = {
  id: idSchema,
  serverName: serverNameSchema,
  enabled: z.boolean(),
  toolCallTimeoutMs: z.number().finite().int().min(MIN_TOOL_TIMEOUT_MS).max(MAX_TOOL_TIMEOUT_MS),
  reconnect: reconnectSchema.optional(),
};
const stdioServerSchema = z.object({
  ...commonServer,
  transport: z.literal('stdio'),
  command: z.string().min(1).max(4_000),
  args: z.array(z.string().max(32 * 1024)).max(256),
}).strict();
const httpServerSchema = z.object({
  ...commonServer,
  transport: z.literal('streamable-http'),
  url: z.string().url().max(8_000).refine(value => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'MCP URL must use http or https'),
}).strict();
const serverSchema = z.discriminatedUnion('transport', [stdioServerSchema, httpServerSchema]);
const publicSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.array(serverSchema).max(MAX_SERVERS),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  value.servers.forEach((server, index) => {
    if (ids.has(server.id)) ctx.addIssue({code: 'custom', message: `Duplicate MCP id: ${server.id}`, path: ['servers', index, 'id']});
    if (names.has(server.serverName)) {
      ctx.addIssue({code: 'custom', message: `Duplicate MCP serverName: ${server.serverName}`, path: ['servers', index, 'serverName']});
    }
    ids.add(server.id);
    names.add(server.serverName);
  });
});
const localOverrideSchema = z.object({
  env: stringMapSchema.optional(),
  headers: stringMapSchema.optional(),
  cwd: z.string().min(1).max(8_000).optional(),
}).strict();
const localSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.record(idSchema, localOverrideSchema),
}).strict();

/** Optional automatic reconnect policy persisted with a public MCP declaration. */
export interface ProjectMcpReconnectConfig {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

interface ProjectMcpServerBase {
  id: string;
  serverName: string;
  enabled: boolean;
  toolCallTimeoutMs: number;
  reconnect?: ProjectMcpReconnectConfig;
}

/** Portable MCP declaration stored in `mcp/servers.yaml`. */
export type ProjectMcpServer = ProjectMcpServerBase & (
  | {transport: 'stdio'; command: string; args: string[]}
  | {transport: 'streamable-http'; url: string}
);

/** Machine-local and potentially sensitive MCP values stored only in `mcp/local.yaml`. */
export interface ProjectMcpLocalOverride {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
}

/** Redacted UI/API projection; the sensitive maps and cwd never cross this boundary. */
export type ProjectMcpServerView = ProjectMcpServer & {
  hasEnvironment: boolean;
  hasHeaders: boolean;
  hasCwd: boolean;
};

/** Fully resolved stdio config consumed only by the MCP runtime manager. */
export type ResolvedProjectMcpServer = ProjectMcpServerBase & (
  | {transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string}
  | {transport: 'streamable-http'; url: string; headers: Record<string, string>}
);

/** Injectable atomic writer used to exercise the two-file rollback boundary. */
export interface ProjectMcpConfigStoreOptions {
  writeFile?: (path: string, content: string, mode: number) => void;
}

interface McpState {
  public: {schemaVersion: 1; servers: ProjectMcpServer[]};
  local: {schemaVersion: 1; servers: Record<string, ProjectMcpLocalOverride>};
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function boundedText(path: string, bytes: number): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > bytes) throw new Error(`Expected a file no larger than ${bytes} bytes: ${path}`);
  const content = readFileSync(path);
  if (content.length > bytes) throw new Error(`File changed beyond the size limit: ${path}`);
  return content.toString('utf8');
}

function emptyOverride(value: ProjectMcpLocalOverride): boolean {
  return value.env === undefined && value.headers === undefined && value.cwd === undefined;
}

function validateLocal(server: ProjectMcpServer, local: ProjectMcpLocalOverride): void {
  if (server.transport === 'stdio' && local.headers !== undefined) {
    throw new Error(`MCP local headers require streamable-http transport: ${server.id}`);
  }
  if (server.transport === 'streamable-http' && (local.env !== undefined || local.cwd !== undefined)) {
    throw new Error(`MCP local env/cwd require stdio transport: ${server.id}`);
  }
}

/**
 * Owns validated public declarations and private local overrides. Public
 * projections are always redacted; only `resolved()` returns secret-bearing data.
 */
export class ProjectMcpConfigStore {
  readonly layout: ProjectLayout;
  private readonly writeFile: (path: string, content: string, mode: number) => void;

  constructor(project: Pick<ProjectView, 'root'>, options: ProjectMcpConfigStoreOptions = {}) {
    this.layout = ensureProjectLayout(project.root);
    this.writeFile = options.writeFile ?? atomicWriteFile;
  }

  /** List public MCP declarations in file order with presence-only local flags. */
  list(): ProjectMcpServerView[] {
    const state = this.readState();
    return state.public.servers.map(server => this.view(server, state.local.servers[server.id]));
  }

  /** Read one redacted declaration, or undefined when its id is absent. */
  get(id: string): ProjectMcpServerView | undefined {
    const validId = idSchema.parse(id);
    return this.list().find(server => server.id === validId);
  }

  /** Merge one declaration with its private values for host-internal runtime use. */
  resolved(id: string): ResolvedProjectMcpServer | undefined {
    const validId = idSchema.parse(id);
    const state = this.readState();
    const server = state.public.servers.find(item => item.id === validId);
    if (server === undefined) return undefined;
    const local = state.local.servers[server.id] ?? {};
    if (server.transport === 'stdio') {
      return {...server, env: {...local.env}, cwd: local.cwd ?? ''};
    }
    return {...server, headers: {...local.headers}};
  }

  /**
   * Create or replace one declaration. Omitting `local` preserves the existing
   * private override; passing an empty object clears it.
   */
  upsert(server: ProjectMcpServer, local?: ProjectMcpLocalOverride): ProjectMcpServerView {
    const next = this.prepare(server, local);
    this.commit(next.publicDocument, next.localDocument, next.localChanged);
    return this.view(next.valid, next.localDocument.servers[next.valid.id]);
  }

  /** Validate a complete unsaved candidate without touching either configuration file. */
  preview(server: ProjectMcpServer, local?: ProjectMcpLocalOverride): ResolvedProjectMcpServer {
    const next = this.prepare(server, local);
    this.serialize(next.publicDocument, next.localDocument);
    const override = next.localDocument.servers[next.valid.id] ?? {};
    if (next.valid.transport === 'stdio') return {...next.valid, env: {...override.env}, cwd: override.cwd ?? ''};
    return {...next.valid, headers: {...override.headers}};
  }

  private prepare(server: ProjectMcpServer, local?: ProjectMcpLocalOverride) {
    const valid = serverSchema.parse(server) as ProjectMcpServer;
    const state = this.readState();
    const index = state.public.servers.findIndex(item => item.id === valid.id);
    const servers = [...state.public.servers];
    if (index < 0) servers.push(valid);
    else servers[index] = valid;
    const publicDocument = publicSchema.parse({schemaVersion: 1, servers}) as McpState['public'];

    const localServers = {...state.local.servers};
    let localChanged = false;
    if (local !== undefined) {
      const validLocal = localOverrideSchema.parse(local) as ProjectMcpLocalOverride;
      validateLocal(valid, validLocal);
      if (emptyOverride(validLocal)) delete localServers[valid.id];
      else localServers[valid.id] = validLocal;
      localChanged = true;
    }
    const retainedLocal = localServers[valid.id];
    if (retainedLocal !== undefined) validateLocal(valid, retainedLocal);
    const localDocument = localSchema.parse({schemaVersion: 1, servers: localServers}) as McpState['local'];
    return {valid, publicDocument, localDocument, localChanged};
  }

  /** Delete one declaration and its private override in the same recoverable transaction. */
  delete(id: string): void {
    const validId = idSchema.parse(id);
    const state = this.readState();
    if (!state.public.servers.some(server => server.id === validId)) return;
    const publicDocument: McpState['public'] = {
      schemaVersion: 1,
      servers: state.public.servers.filter(server => server.id !== validId),
    };
    const localServers = {...state.local.servers};
    const localChanged = Object.hasOwn(localServers, validId);
    delete localServers[validId];
    const localDocument: McpState['local'] = {schemaVersion: 1, servers: localServers};
    this.commit(publicDocument, localDocument, localChanged);
  }

  private readState(): McpState {
    const publicDocument = publicSchema.parse(parse(boundedText(this.layout.mcpServers, MAX_PUBLIC_BYTES))) as McpState['public'];
    let localDocument: McpState['local'];
    try {
      localDocument = localSchema.parse(parse(boundedText(this.layout.mcpLocal, MAX_LOCAL_BYTES))) as McpState['local'];
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      localDocument = {schemaVersion: 1, servers: {}};
    }
    const byId = new Map(publicDocument.servers.map(server => [server.id, server]));
    for (const [id, local] of Object.entries(localDocument.servers)) {
      const server = byId.get(id);
      if (server === undefined) throw new Error(`Unknown local MCP server override: ${id}`);
      validateLocal(server, local);
    }
    return {public: publicDocument, local: localDocument};
  }

  private serialize(publicDocument: McpState['public'], localDocument: McpState['local']) {
    const publicContent = stringify(publicDocument, {lineWidth: 0});
    const localContent = stringify(localDocument, {lineWidth: 0});
    // Validate both serialized documents before touching either file.
    if (Buffer.byteLength(publicContent, 'utf8') > MAX_PUBLIC_BYTES) {
      throw new Error(`MCP public config exceeds ${MAX_PUBLIC_BYTES} bytes`);
    }
    if (Buffer.byteLength(localContent, 'utf8') > MAX_LOCAL_BYTES) {
      throw new Error(`MCP local config exceeds ${MAX_LOCAL_BYTES} bytes`);
    }
    return {publicContent, localContent};
  }

  /** Write public state first; if the private commit fails, restore the exact public bytes. */
  private commit(publicDocument: McpState['public'], localDocument: McpState['local'], localChanged: boolean): void {
    const {publicContent, localContent} = this.serialize(publicDocument, localDocument);
    if (!localChanged) {
      this.writeFile(this.layout.mcpServers, publicContent, 0o600);
      return;
    }
    const beforePublic = readFileSync(this.layout.mcpServers, 'utf8');
    const beforePublicMode = statSync(this.layout.mcpServers).mode & 0o777;
    this.writeFile(this.layout.mcpServers, publicContent, beforePublicMode);
    try {
      this.writeFile(this.layout.mcpLocal, localContent, 0o600);
    } catch (error) {
      try {this.writeFile(this.layout.mcpServers, beforePublic, beforePublicMode);}
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'MCP private commit failed and public rollback also failed');
      }
      throw error;
    }
  }

  private view(server: ProjectMcpServer, local: ProjectMcpLocalOverride | undefined): ProjectMcpServerView {
    return {
      ...server,
      hasEnvironment: local?.env !== undefined && Object.keys(local.env).length > 0,
      hasHeaders: local?.headers !== undefined && Object.keys(local.headers).length > 0,
      hasCwd: local?.cwd !== undefined,
    };
  }
}

export {serverSchema as projectMcpServerSchema, localOverrideSchema as projectMcpLocalSchema};
