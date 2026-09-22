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
  /** True when sibling entries share these paths, so committing one stages the whole file. */
  shared?: boolean;
  /** Artifact count for a task entry. */
  artifacts?: number;
}
export interface ProjectChangeFile {path: string; status: ResourceChangeStatus}
export interface McpServerSummary {id: string; serverName: string; signature: string}
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

const MCP_DECLARATION = 'mcp/servers.yaml';

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

/** Tolerant read of one declaration file; unusable entries are dropped instead of failing the review. */
export function parseMcpServers(text: string | undefined): McpServerSummary[] {
  if (!text) return [];
  try {
    const document = parse(text) as {servers?: unknown} | undefined;
    if (!Array.isArray(document?.servers)) return [];
    const servers: McpServerSummary[] = [];
    for (const item of document.servers) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.serverName !== 'string') continue;
      servers.push({id: record.id, serverName: record.serverName, signature: changeSignature(record)});
    }
    return servers;
  } catch {return [];}
}

/** Added, deleted or updated, from the states of every path that belongs to the entry. */
function aggregate(statuses: readonly ResourceChangeStatus[]): ResourceChangeStatus {
  if (statuses.every(status => status === 'added' || status === 'untracked')) return 'added';
  if (statuses.every(status => status === 'deleted')) return 'deleted';
  return 'modified';
}

interface Collected {
  kind: ProjectChangeKind; name: string; description?: string; shared: boolean;
  paths: Set<string>; statuses: ResourceChangeStatus[]; artifacts?: number;
}

/**
 * Group Git changes into project assets. Unrecognized paths are kept as `file` entries: the review
 * never drops a change silently, it only decides what is selected by default on the client.
 */
export function mapProjectChanges(files: readonly ProjectChangeFile[], context: ProjectChangeContext): ProjectChangeEntry[] {
  const collected = new Map<string, Collected>();
  const collect = (id: string, kind: ProjectChangeKind, name: string, path: string, status: ResourceChangeStatus,
    options: {description?: string; shared?: boolean; artifacts?: number} = {}): void => {
    const existing = collected.get(id);
    if (existing) {existing.paths.add(path); existing.statuses.push(status); return;}
    collected.set(id, {kind, name, ...(options.description === undefined ? {} : {description: options.description}),
      shared: options.shared === true, paths: new Set([path]), statuses: [status],
      ...(options.artifacts === undefined ? {} : {artifacts: options.artifacts})});
  };
  let declaration: ProjectChangeFile | undefined;
  for (const file of files) {
    const path = normalize(file.path);
    if (!path) continue;
    if (path === MCP_DECLARATION) {declaration = file; continue;}
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
  if (declaration) {
    const head = new Map((context.mcpHead ?? []).map(server => [server.id, server]));
    const working = new Map((context.mcpWorking ?? []).map(server => [server.id, server]));
    // Every declaration lives in one file, so a per-server entry shares its paths with its siblings.
    for (const [id, server] of working) {
      const previous = head.get(id);
      if (!previous) collect(`mcp:${id}`, 'mcp', server.serverName, MCP_DECLARATION, 'added', {description: id, shared: true});
      else if (previous.signature !== server.signature) collect(`mcp:${id}`, 'mcp', server.serverName, MCP_DECLARATION, 'modified', {description: id, shared: true});
    }
    for (const [id, server] of head) {
      if (!working.has(id)) collect(`mcp:${id}`, 'mcp', server.serverName, MCP_DECLARATION, 'deleted', {description: id, shared: true});
    }
    // A formatting-only edit changes no declaration; keep the file itself so nothing is hidden.
    if (collected.size === 0 || ![...collected.values()].some(item => item.kind === 'mcp')) {
      collect(`mcp:${MCP_DECLARATION}`, 'mcp', MCP_DECLARATION, MCP_DECLARATION, normalize(declaration.path) === MCP_DECLARATION ? declaration.status : 'modified');
    }
  }
  return [...collected.entries()].map(([id, item]) => ({
    id, kind: item.kind, name: item.name, ...(item.description === undefined ? {} : {description: item.description}),
    status: aggregate(item.statuses), paths: [...item.paths].sort(),
    ...(item.shared ? {shared: true} : {}), ...(item.artifacts === undefined ? {} : {artifacts: item.artifacts}),
  })).sort((left, right) => PROJECT_CHANGE_KINDS.indexOf(left.kind) - PROJECT_CHANGE_KINDS.indexOf(right.kind)
    || left.name.localeCompare(right.name));
}
