import {createHash, randomUUID} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import type {Config as McpClientConfig} from '@deepseek-ai/dsh-mcp-client';
import type {ToolDefinition} from '@deepseek-ai/dsh-tools';
import {startConnection, resolveReconnectPolicy, type ConnectionHandle, type ConnectionState} from './vendor/dsh-mcp-client/connection.ts';
import {
  type ProjectMcpConfigStore,
  type ResolvedProjectMcpServer,
} from './project-mcp-config.ts';

/** One successfully connected MCP instance, optionally exposing bridgeable Tool definitions. */
export interface MountedProjectMcp {
  readonly toolNames: readonly string[];
  readonly connectionState?: ConnectionState;
  readonly definitions?: () => readonly ToolDefinition[];
  readonly subscribe?: (listener: () => void) => () => void;
  dispose(): Promise<void>;
}

/** Injectable connection seam used by lifecycle tests and the real isolated Cordis mount. */
export type ProjectMcpMount = (config: ResolvedProjectMcpServer) => Promise<MountedProjectMcp>;

export interface ProjectMcpRuntimeOptions {
  mount?: ProjectMcpMount;
}

export interface ProjectMcpErrorView {
  name: string;
  message: string;
}

/** Current runtime state projected without any local MCP values. */
export interface ProjectMcpRuntimeView {
  id: string;
  serverName: string;
  /** A live connection or automatic reconnect is active on this Host. */
  active: boolean;
  status: ConnectionState | 'disabled';
  toolNames: string[];
  lastError?: ProjectMcpErrorView;
}

export interface ProjectMcpConnectionTestResult {
  ok: boolean;
  toolNames: string[];
  error?: ProjectMcpErrorView;
}

interface ActiveServer {
  fingerprint: string;
  mounted: MountedProjectMcp;
  toolNames: string[];
  status: ConnectionState;
  lastError?: ProjectMcpErrorView;
  publishedDefinitions: ToolDefinition[];
  publishedDisposers: Array<() => unknown>;
  unsubscribe?: () => void;
}

/**
 * Minimal Tool registry used by an isolated MCP client. It retains the real
 * executable definitions without publishing them to the host until the whole
 * candidate connection has completed initial discovery.
 */
class CollectingToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly listeners = new Set<() => void>();
  private notificationQueued = false;

  register(definition: ToolDefinition): () => void {
    if (this.tools.has(definition.name)) throw new Error(`Duplicate collected Tool: ${definition.name}`);
    this.tools.set(definition.name, definition);
    this.notify();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.tools.get(definition.name) === definition) this.tools.delete(definition.name);
      this.notify();
    };
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  names(): string[] {
    return this.definitions().map(definition => definition.name);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  }

  /** Coalesce an MCP generation's unregister/register sequence into one complete observation. */
  notify(): void {
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      for (const listener of this.listeners) listener();
    });
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

/** Hash the resolved config so private values participate without being retained in a diagnostic field. */
function fingerprint(config: ResolvedProjectMcpServer): string {
  return createHash('sha256').update(JSON.stringify(stableValue(config))).digest('hex');
}

function clientConfig(server: ResolvedProjectMcpServer): McpClientConfig {
  const common = {
    serverName: server.serverName,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: true,
    ...(server.reconnect === undefined ? {} : {reconnect: server.reconnect}),
  };
  if (server.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: server.command,
      args: [...server.args],
      env: {...server.env},
      cwd: server.cwd,
    };
  }
  return {...common, transport: 'streamable-http', url: server.url, headers: {...server.headers}};
}

/**
 * Mount the pinned DSH connection adapter in an isolated root. A collector lets
 * the manager publish ready tools and observe health independently of tool count.
 */
async function isolatedMount(config: ResolvedProjectMcpServer, host: Context): Promise<MountedProjectMcp> {
  const isolated = new Context();
  const collector = new CollectingToolRegistry();
  isolated.provide('tools', collector as unknown as Context['tools']);
  // Rich MCP results need the same attachment store and model metadata as Host tools.
  const attachments = host.get('attachments');
  const llm = host.get('llm');
  if (attachments !== undefined) isolated.provide('attachments', attachments);
  if (llm !== undefined) isolated.provide('llm', llm);
  let connection: ConnectionHandle | undefined;
  let state: ConnectionState = 'reconnecting';
  try {
    connection = startConnection(isolated, clientConfig(config),
      resolveReconnectPolicy(config.reconnect, 'Project MCP reconnect'), next => {
        state = next;
        collector.notify();
      });
    const outcome = await connection.ready;
    if (outcome.error !== undefined) throw outcome.error;
  } catch (error) {
    await connection?.dispose();
    await isolated.fiber.dispose();
    throw error;
  }
  return {
    get toolNames() {return collector.names();},
    get connectionState() {return state;},
    definitions: () => collector.definitions(),
    subscribe: listener => collector.subscribe(listener),
    dispose: async () => {
      await connection?.dispose();
      await isolated.fiber.dispose();
    },
  };
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name) ? error.name : 'Error';
}

function secretValues(config: ResolvedProjectMcpServer): string[] {
  const values = config.transport === 'stdio'
    ? [...Object.values(config.env), config.cwd]
    : Object.values(config.headers);
  return values.filter(value => value.length > 0).sort((left, right) => right.length - left.length);
}

/** Project-scoped manager that reconciles file declarations with live MCP Tool registrations. */
export class ProjectMcpRuntime {
  private readonly active = new Map<string, ActiveServer>();
  private readonly failures = new Map<string, ProjectMcpErrorView>();
  private readonly mount: ProjectMcpMount;
  private operation: Promise<void> = Promise.resolve();
  private closing = false;
  private disposal: Promise<void> | undefined;
  private readonly pendingTests = new Set<Promise<ProjectMcpConnectionTestResult>>();

  constructor(
    private readonly ctx: Context,
    private readonly store: ProjectMcpConfigStore,
    options: ProjectMcpRuntimeOptions = {},
  ) {
    this.mount = options.mount ?? (config => isolatedMount(config, ctx));
  }

  /** Reconcile every enabled declaration serially so replacements and removals cannot interleave. */
  reconcile(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Project MCP runtime is disposed'));
    const run = this.operation.then(() => this.reconcileNow());
    this.operation = run.catch(() => {});
    return run;
  }

  /** Return a redacted status snapshot in the same order as `servers.yaml`. */
  snapshot(): ProjectMcpRuntimeView[] {
    return this.store.list().map(server => {
      const active = this.active.get(server.id);
      if (!server.enabled) {
        return {id: server.id, serverName: server.serverName, active: false, status: 'disabled' as const, toolNames: []};
      }
      const failure = this.failures.get(server.id);
      if (active === undefined) {
        return {
          id: server.id, serverName: server.serverName, active: false, status: 'error' as const, toolNames: [],
          ...(failure === undefined ? {} : {lastError: failure}),
        };
      }
      return {
        id: server.id,
        serverName: server.serverName,
        active: ['connected', 'reconnecting'].includes(active.mounted.connectionState ?? active.status),
        status: failure === undefined ? active.status : 'error',
        toolNames: [...active.toolNames],
        ...((failure ?? active.lastError) === undefined ? {} : {lastError: failure ?? active.lastError}),
      };
    });
  }

  /** Probe one unsaved resolved config under a unique namespace and always release the temporary instance. */
  testConnection(config: ResolvedProjectMcpServer): Promise<ProjectMcpConnectionTestResult> {
    if (this.closing) return Promise.reject(new Error('Project MCP runtime is disposed'));
    const run = this.probeConnection(config);
    this.pendingTests.add(run);
    void run.finally(() => {this.pendingTests.delete(run);}).catch(() => {});
    return run;
  }

  private async probeConnection(config: ResolvedProjectMcpServer): Promise<ProjectMcpConnectionTestResult> {
    const namespace = `test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const candidate = {...config, serverName: namespace};
    let mounted: MountedProjectMcp | undefined;
    let result: ProjectMcpConnectionTestResult;
    try {
      mounted = await this.mount(candidate);
      result = {ok: true, toolNames: [...mounted.toolNames]};
    } catch (error) {
      result = {ok: false, toolNames: [], error: this.diagnostic(error, candidate)};
    } finally {
      if (mounted !== undefined) {
        try {await mounted.dispose();}
        catch (error) {
          result = {ok: false, toolNames: [], error: this.diagnostic(error, candidate)};
        }
      }
    }
    return result!;
  }

  /** Stop new reconciliation, wait for current work, then close every instance and host Tool bridge. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closing = true;
    this.disposal = (async () => {
      await this.operation;
      await Promise.allSettled(this.pendingTests);
      const servers = [...this.active.entries()];
      this.active.clear();
      const results = await Promise.allSettled(servers.map(([, active]) => this.stopActive(active)));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'One or more Project MCP instances failed to dispose');
    })();
    return this.disposal;
  }

  private async reconcileNow(): Promise<void> {
    const declared = this.store.list();
    const desiredIds = new Set(declared.filter(server => server.enabled).map(server => server.id));
    for (const [id, active] of [...this.active]) {
      if (desiredIds.has(id)) continue;
      this.active.delete(id);
      this.failures.delete(id);
      await this.stopActive(active);
    }

    for (const declaration of declared) {
      if (!declaration.enabled) continue;
      const config = this.store.resolved(declaration.id);
      if (config === undefined) continue;
      const nextFingerprint = fingerprint(config);
      const previous = this.active.get(config.id);
      if (previous?.fingerprint === nextFingerprint
        && (previous.status === 'connected' || previous.mounted.connectionState === 'reconnecting')) {
        // Saving the already-running configuration also resolves a failed replacement.
        this.failures.delete(config.id);
        continue;
      }
      let candidate: MountedProjectMcp | undefined;
      try {
        candidate = await this.mount(config);
        const publication = this.swapPublication(candidate, previous);
        previous?.unsubscribe?.();
        const next: ActiveServer = {
          fingerprint: nextFingerprint,
          mounted: candidate,
          toolNames: [...candidate.toolNames],
          status: 'connected',
          publishedDefinitions: publication.definitions,
          publishedDisposers: publication.disposers,
        };
        next.unsubscribe = candidate.subscribe?.(() => {this.refreshPublished(config.id, next, config);});
        this.active.set(config.id, next);
        this.failures.delete(config.id);
        if (candidate.connectionState !== undefined && candidate.connectionState !== 'connected') {
          this.refreshPublished(config.id, next, config);
        }
        if (previous !== undefined) {
          try {await previous.mounted.dispose();}
          catch (error) {
            next.status = 'error';
            next.lastError = this.diagnostic(error, config);
          }
        }
      } catch (error) {
        if (candidate !== undefined) {
          try {await candidate.dispose();}
          catch { /* The candidate error remains the actionable replacement failure. */ }
        }
        const diagnostic = this.diagnostic(error, config);
        this.failures.set(config.id, diagnostic);
        // The failure belongs to the candidate. Preserve the previous
        // connection's lifecycle state so a still-running fallback stays on.
      }
    }
  }

  /** Replace host registrations with rollback if any candidate Tool conflicts. */
  private swapPublication(
    candidate: MountedProjectMcp,
    previous: ActiveServer | undefined,
  ): {definitions: ToolDefinition[]; disposers: Array<() => unknown>} {
    const definitions = [...(candidate.definitions?.() ?? [])];
    if (definitions.length === 0 && (previous === undefined || previous.publishedDefinitions.length === 0)) {
      return {definitions, disposers: []};
    }
    const tools = this.ctx.get('tools');
    if (tools === undefined) throw new Error('Project MCP Tool publication requires the DSH tools service');
    const oldDefinitions = previous?.publishedDefinitions ?? [];
    const oldDisposers = previous?.publishedDisposers ?? [];
    this.disposePublications(oldDisposers);
    if (previous !== undefined) previous.publishedDisposers = [];
    const disposers: Array<() => unknown> = [];
    try {
      for (const definition of definitions) disposers.push(tools.register(definition));
      return {definitions, disposers};
    } catch (error) {
      this.disposePublications(disposers);
      if (previous !== undefined) {
        previous.publishedDisposers = oldDefinitions.map(definition => tools.register(definition));
      }
      throw error;
    }
  }

  /** Re-publish a connected server's later MCP tools/list generation. */
  private refreshPublished(id: string, active: ActiveServer, config: ResolvedProjectMcpServer): void {
    if (this.active.get(id) !== active || this.closing) return;
    try {
      const state = active.mounted.connectionState ?? 'connected';
      if (state !== 'connected') {
        this.disposePublications(active.publishedDisposers);
        active.publishedDisposers = [];
        active.publishedDefinitions = [];
        active.toolNames = [];
        active.status = state;
        active.lastError = {name: 'ConnectionError', message: state === 'reconnecting'
          ? 'MCP connection lost; reconnecting' : 'MCP connection closed; automatic reconnect is unavailable'};
        return;
      }
      const publication = this.swapPublication(active.mounted, active);
      active.publishedDefinitions = publication.definitions;
      active.publishedDisposers = publication.disposers;
      active.toolNames = [...active.mounted.toolNames];
      active.status = 'connected';
      active.lastError = undefined;
    } catch (error) {
      active.status = 'error';
      active.lastError = this.diagnostic(error, config);
    }
  }

  private async stopActive(active: ActiveServer): Promise<void> {
    const errors: unknown[] = [];
    try {active.unsubscribe?.();}
    catch (error) {errors.push(error);}
    try {this.disposePublications(active.publishedDisposers);}
    catch (error) {errors.push(error);}
    active.publishedDisposers = [];
    try {await active.mounted.dispose();}
    catch (error) {errors.push(error);}
    if (errors.length > 0) throw new AggregateError(errors, 'Project MCP instance failed to dispose cleanly');
  }

  private disposePublications(disposers: Array<() => unknown>): void {
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try {dispose();}
      catch (error) {errors.push(error);}
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Project MCP Tool registrations failed to dispose cleanly');
  }

  /** Bound error metadata and remove every private env/header/cwd value from its message. */
  private diagnostic(error: unknown, config: ResolvedProjectMcpServer): ProjectMcpErrorView {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secretValues(config)) message = message.split(secret).join('[redacted]');
    return {name: errorName(error), message: message.slice(0, 1_000)};
  }
}
