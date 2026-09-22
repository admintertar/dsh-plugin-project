import {parse} from 'yaml';
import type {ResourceChangeStatus} from './resource-contract.ts';

/**
 * The project root is a Git repository, but its contents are project assets: tasks, skills,
 * memory documents and MCP declarations. The overview reviews those assets, so a change list
 * is grouped by asset kind instead of listing files.
 */
export type ProjectChangeKind = 'task' | 'skill' | 'memory' | 'mcp' | 'file';
export const PROJECT_CHANGE_KINDS: readonly ProjectChangeKind[] = ['task', 'skill', 'memory', 'mcp', 'file'];

/** One reviewable asset. `paths` are the repository-relative paths a commit of it would stage. */
export interface ProjectChangeEntry {
  id: string;
  kind: ProjectChangeKind;
  /** The asset's own name: a task title, a Skill name, a memory document name, a server name or a path. */
  name: string;
  /** Supporting data, never localized: a directory, a declaration id or a file path. */
  description?: string;
  status: ResourceChangeStatus;
  paths: string[];
  /** Artifact count for a task entry. */
  artifacts?: number;
}
export interface ProjectChangeFile {path: string; status: ResourceChangeStatus}
export interface McpServerSummary {id: string; serverName: string; signature: string;
  /** The declaration file this server was read from: a review selection commits exactly this path. */
  source: string}
export interface ProjectChangeContext {
  memory: readonly {id: string; name: string; path: string}[];
  tasks: readonly {directory: string; title: string; artifactCount: number}[];
  mcpWorking?: readonly McpServerSummary[];
  mcpHead?: readonly McpServerSummary[];
}
export interface ProjectChangesSnapshot {
  revision: string;
  /** False when the project root is not a Git working tree; the panel then only explains that. */
  available: boolean;
  branch?: string;
  url?: string;
  sync?: {status: string; dirty?: boolean; ahead?: number; behind?: number; error?: string};
  entries: ProjectChangeEntry[];
}

/** The retired single declaration file. It is skipped everywhere: migration removes it on open. */
const MCP_LEGACY_DECLARATION = 'mcp/servers.yaml';
/** One declaration per file lives under `mcp/servers/`. */
const MCP_SERVER_DECLARATION = /^mcp\/servers\/[^/]+\.yaml$/;
const isServerDeclaration = (path: string): boolean => MCP_SERVER_DECLARATION.test(path);

const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Repository-relative paths only. Reject absolute paths, drive letters, parent traversal and
 * control characters, so a review selection can never stage something outside the project root.
 */
export function safeChangePath(value: string): string | undefined {
  const path = normalize(value);
  if (!path || path.length > 4000 || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return undefined;
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined;
  return path;
}

/** Stable serialization, so two declarations compare equal regardless of key order. */
export function changeSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(changeSignature).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${changeSignature(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One MCP declaration file, with its text. */
export interface McpDeclarationFile {path: string; text: string | undefined}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Declarations across every source file. Two shapes are accepted: the legacy file carries
 * `{servers: [...]}`, while a per-server file carries one declaration object on its own. Later files
 * win, so a per-server declaration shadows a legacy one with the same id, and every summary
 * remembers the file it came from.
 */
export function parseMcpServers(files: readonly McpDeclarationFile[]): McpServerSummary[] {
  const found = new Map<string, McpServerSummary>();
  const absorb = (record: Record<string, unknown>, source: string): void => {
    if (typeof record.id !== 'string' || typeof record.serverName !== 'string') return;
    found.set(record.id, {id: record.id, serverName: record.serverName, source,
      signature: changeSignature(record)});
  };
  for (const file of files) {
    if (!file.text) continue;
    try {
      const document = parse(file.text) as unknown;
      if (Array.isArray(document)) {for (const item of document) if (isRecord(item)) absorb(item, file.path);}
      else if (isRecord(document)) {
        if (Array.isArray(document.servers)) {for (const item of document.servers) if (isRecord(item)) absorb(item, file.path);}
        else absorb(document, file.path);
      }
    } catch {continue;}
  }
  return [...found.values()];
}

/** Added, deleted or updated, from the states of every path that belongs to the entry. */
function aggregate(statuses: readonly ResourceChangeStatus[]): ResourceChangeStatus {
  if (statuses.every(status => status === 'added' || status === 'untracked')) return 'added';
  if (statuses.every(status => status === 'deleted')) return 'deleted';
  return 'modified';
}

interface Collected {
  kind: ProjectChangeKind; name: string; description?: string;
  paths: Set<string>; statuses: ResourceChangeStatus[]; artifacts?: number;
}

/**
 * Group Git changes into project assets. Unrecognized paths are kept as `file` entries: the review
 * never drops a change silently, it only decides what is selected by default on the client.
 */
export function mapProjectChanges(files: readonly ProjectChangeFile[], context: ProjectChangeContext): ProjectChangeEntry[] {
  const collected = new Map<string, Collected>();
  const collect = (id: string, kind: ProjectChangeKind, name: string, path: string, status: ResourceChangeStatus,
    options: {description?: string; artifacts?: number} = {}): void => {
    const existing = collected.get(id);
    if (existing) {existing.paths.add(path); existing.statuses.push(status); return;}
    collected.set(id, {kind, name, ...(options.description === undefined ? {} : {description: options.description}),
      paths: new Set([path]), statuses: [status],
      ...(options.artifacts === undefined ? {} : {artifacts: options.artifacts})});
  };
  for (const file of files) {
    const path = normalize(file.path);
    if (!path) continue;
    // Declaration files are owned by the MCP branch below, and the retired single file is skipped
    // entirely: its removal is a migration artifact, not an asset the user has to decide about.
    if (path === MCP_LEGACY_DECLARATION || isServerDeclaration(path)) continue;
    const [head, second] = path.split('/');
    if (head === 'tasks' && second) {
      const task = context.tasks.find(item => item.directory === second);
      collect(`task:${second}`, 'task', task?.title ?? second, path, file.status,
        {description: `tasks/${second}`, ...(task === undefined ? {} : {artifacts: task.artifactCount})});
      continue;
    }
    if (head === 'skills' && second) {
      const name = second === 'index.yaml' ? 'index.yaml' : second;
      collect(`skill:${second}`, 'skill', name, path, file.status,
        {description: second === 'index.yaml' ? 'skills/index.yaml' : `skills/${second}`});
      continue;
    }
    if (head === 'memory' && second) {
      const declared = context.memory.find(item => normalize(item.path) === path);
      collect(`memory:${declared?.id ?? second}`, 'memory', declared?.name ?? second, path, file.status,
        {description: `memory/${second}`});
      continue;
    }
    collect(`file:${path}`, 'file', path, path, file.status);
  }
  // MCP declarations become one entry per server, and each entry owns exactly the file it lives in.
  {
    const head = new Map((context.mcpHead ?? []).map(server => [server.id, server]));
    const working = new Map((context.mcpWorking ?? []).map(server => [server.id, server]));
    for (const [id, server] of working) {
      const previous = head.get(id);
      if (previous === undefined) collect(`mcp:${id}`, 'mcp', server.serverName, server.source, 'added', {description: id});
      else if (previous.signature !== server.signature) collect(`mcp:${id}`, 'mcp', server.serverName, server.source, 'modified', {description: id});
    }
    for (const [id, server] of head) {
      if (!working.has(id)) collect(`mcp:${id}`, 'mcp', server.serverName, server.source, 'deleted', {description: id});
    }
    // A declaration file whose own bytes changed without any declaration changing — a formatting edit,
    // say — still has to show up.
    for (const file of files) {
      const path = normalize(file.path);
      if (!isServerDeclaration(path)) continue;
      if ([...collected.values()].some(item => item.kind === 'mcp' && item.paths.has(path))) continue;
      collect(`mcp:${path}`, 'mcp', path, path, file.status);
    }
  }
  return [...collected.entries()].map(([id, item]) => ({
    id, kind: item.kind, name: item.name, ...(item.description === undefined ? {} : {description: item.description}),
    status: aggregate(item.statuses), paths: [...item.paths].sort(),
    ...(item.artifacts === undefined ? {} : {artifacts: item.artifacts}),
  })).sort((left, right) => PROJECT_CHANGE_KINDS.indexOf(left.kind) - PROJECT_CHANGE_KINDS.indexOf(right.kind)
    || left.name.localeCompare(right.name));
}
