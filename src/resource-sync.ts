import {existsSync, realpathSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ProjectHttpError} from './http.ts';
import {resourceFailure} from './resource-files.ts';
import {ResourceGitError, type GitRun} from './resource-git.ts';
import {validResourceUrl, type ManagedResource, type ResourceGitSync, type ResourcesSnapshot} from './resource-contract.ts';
import type {ResourceCloneManager} from './resource-clones.ts';
import {isProjectRootResource, managedResources} from './resource-scope.ts';

interface Repository {
  branch?: string; head?: string; remote?: string; remoteRef?: string; trackingRef?: string; upstreamHead?: string;
  target: string; connected: boolean; dirty: boolean; inProgress: boolean; ahead?: number; behind?: number; upstream?: string;
}
interface RecordState {key: string; target?: string; checkedAt?: string; updatedAt?: string; error?: string; attemptedAt: number}
interface ActiveSync {phase: 'checking' | 'updating'; controller: AbortController; done: Promise<void>; interactive: boolean}
const failureCode = (error: unknown): string => error instanceof ProjectHttpError || error instanceof ResourceGitError ? error.code : 'git-sync-failed';
const operationMarkers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'];

/** Local inspection only. Track the actual current branch; manifest.branch remains a clone option. */
async function inspect(path: string, url: string | undefined, run: GitRun): Promise<Repository> {
  if (realpathSync(await run(['rev-parse', '--show-toplevel'], path)) !== realpathSync(path)) resourceFailure('resource-git-invalid');
  const output = await run(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=none'], path);
  const lines = output.split('\n');
  const value = (name: string) => lines.find(line => line.startsWith(`# branch.${name} `))?.slice(name.length + 10);
  const branch = value('head'); const head = value('oid');
  const gitDir = await run(['rev-parse', '--absolute-git-dir'], path);
  const result: Repository = {branch: branch && branch !== '(detached)' ? branch : undefined,
    head: head && head !== '(initial)' ? head : undefined, target: '', connected: false,
    dirty: lines.some(line => line && !line.startsWith('# ')), inProgress: operationMarkers.some(marker => existsSync(join(gitDir, marker)))};
  // A new local repository is usable before it has an origin or a first commit.
  const remotes = (await run(['remote'], path)).split('\n');
  if (!url || !remotes.includes('origin')) return result;
  const origin = await run(['remote', 'get-url', 'origin'], path);
  if (!validResourceUrl(origin) || origin !== url) resourceFailure('resource-origin-mismatch');
  result.connected = true;
  if (!result.branch || !result.head) return result;
  const ref = `refs/heads/${result.branch}`;
  const refs = await run(['for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', ref], path);
  const tracking = refs.split('\n').map(line => line.split('\0')).find(parts => parts[0] === ref);
  const [, remote, remoteRef, trackingRef] = tracking ?? [];
  if (!remote || remote === '.' || !remoteRef?.startsWith('refs/heads/') || !trackingRef?.startsWith('refs/remotes/')) return result;
  if (await run(['remote', 'get-url', remote], path) !== url) resourceFailure('resource-origin-mismatch');
  await run(['check-ref-format', remoteRef], path); await run(['check-ref-format', trackingRef], path);
  Object.assign(result, {remote, remoteRef, trackingRef, upstream: trackingRef.slice('refs/remotes/'.length),
    target: JSON.stringify([result.branch, remote, remoteRef, trackingRef, url])});
  // A missing tracking ref is still fetchable. Never call it current before a successful remote check.
  result.upstreamHead = await run(['rev-parse', '--verify', `${trackingRef}^{commit}`], path).catch(() => undefined);
  if (result.upstreamHead) {
    const counts = await run(['rev-list', '--left-right', '--count', `${result.head}...${result.upstreamHead}`], path);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) resourceFailure('git-sync-failed');
    Object.assign(result, {ahead, behind});
  }
  return result;
}

/** Host-owned checks survive navigation. GET stays local; only explicit update advances a working tree. */
export class ResourceSyncManager {
  private records = new Map<string, RecordState>();
  private cache = new Map<string, {key: string; at: number; result: Promise<Repository>}>();
  private active = new Map<string, ActiveSync>();
  private repositoryTails = new Map<string, Promise<void>>();
  private closing = false;
  private lifetime = new AbortController();
  private reads = new Set<Promise<Repository>>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly interval: number;
  constructor(readonly clones: ResourceCloneManager, readonly run: GitRun = clones.run,
    private readonly options: {intervalMs?: number; initialDelayMs?: number; timeoutMs?: number} = {}) {
    this.interval = options.intervalMs ?? 5 * 60_000;
  }
  private open(): void {if (this.closing) resourceFailure('project-closing', 503);}
  private resource(id: string): ManagedResource {
    const project = this.clones.project();
    const item = project.resources.find(item => item.id === id) ?? resourceFailure('resource-not-found', 404);
    if (isProjectRootResource(item, project.root)) resourceFailure('resource-project-root');
    if (item.type !== 'git' || item.status !== 'ready' || !item.path) resourceFailure('resource-unavailable');
    return item;
  }
  private key(item: ManagedResource): string {
    const stat = statSync(item.path!);
    return JSON.stringify([item.path, item.url, stat.dev, stat.ino]);
  }
  private local(item: ManagedResource, fresh = false, signal?: AbortSignal): Promise<Repository> {
    const key = this.key(item);
    const cached = this.cache.get(item.id);
    if (!fresh && cached && Date.now() - cached.at < 5000 && cached.key === key) return cached.result;
    const run: GitRun = (args, cwd) => this.run(args, cwd, {signal: signal ?? this.lifetime.signal, sync: true});
    const entry = {key, at: Infinity, result: Promise.resolve({} as Repository)};
    const result = entry.result = inspect(item.path!, item.url, run).finally(() => {entry.at = Date.now(); this.reads.delete(result);});
    this.reads.add(result);
    if (!fresh) this.cache.set(item.id, entry);
    return result;
  }
  private view(local: Repository, record?: RecordState): ResourceGitSync {
    if (!local.connected) return {status: 'unlinked', dirty: local.dirty, inProgress: local.inProgress};
    if (local.branch && !local.head) return {status: 'unborn', dirty: local.dirty, inProgress: local.inProgress};
    const checked = Boolean(record?.checkedAt && record.target === local.target);
    const status: ResourceGitSync['status'] = !local.branch ? 'detached' : !local.target ? 'no-upstream' : !checked ? 'unchecked'
      : !local.upstreamHead ? 'error' : local.ahead && local.behind ? 'diverged' : local.behind ? 'behind' : local.ahead ? 'ahead' : 'current';
    return {status: record?.error ? 'error' : status, dirty: local.dirty, inProgress: local.inProgress, upstream: local.upstream,
      ...(checked ? {ahead: local.ahead, behind: local.behind, checkedAt: record!.checkedAt} : {}),
      updatedAt: record?.updatedAt, error: record?.error};
  }
  async snapshot(canPick: boolean): Promise<ResourcesSnapshot> {
    const data = await this.clones.snapshot(canPick);
    for (let offset = 0; offset < data.resources.length; offset += 4) await Promise.all(data.resources.slice(offset, offset + 4).map(async item => {
      if (item.type !== 'git' || item.status !== 'ready' || !item.path) return;
      let sync: ResourceGitSync;
      try {
        const key = this.key(item); let record = this.records.get(item.id);
        if (record && record.key !== key) {this.invalidate(item.id); record = undefined;}
        const local = await this.local(item);
        // A branch change invalidates the previous remote observation, including its error.
        if (record?.target && record.target !== local.target && !this.active.has(item.id)) {
          record = {key, target: local.target, attemptedAt: 0, ...(record.error === 'git-state-changed' ? {error: record.error} : {})};
          this.records.set(item.id, record);
        }
        sync = this.view(local, record);
        item.git = {...item.git, branch: local.branch ?? item.git?.branch};
      } catch (error) {sync = {status: 'error', error: failureCode(error)};}
      const active = this.active.get(item.id);
      if (active) sync.phase = active.phase;
      item.git = {...item.git, sync};
    }));
    // Callers compare full resource data; include sync state in the public version too.
    data.version = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
    return data;
  }
  assertMutable(id: string): void {if (this.active.has(id)) resourceFailure('git-sync-busy');}
  invalidate(id: string): void {this.records.delete(id); this.cache.delete(id);}
  start(id: string, action: 'check' | 'update', expectedRevision: string, interactive = true): Promise<void> {
    this.open(); this.clones.store.assertRevision(expectedRevision); this.clones.assertMutable(id);
    const existing = this.active.get(id);
    // A manual check may race the automatic check before the next snapshot arrives.
    if (existing?.phase === 'checking' && action === 'check') {existing.interactive ||= interactive; return existing.done;}
    if (existing) resourceFailure('git-sync-busy');
    const item = this.resource(id); const key = this.key(item);
    if (!item.url) resourceFailure('git-no-remote');
    const controller = new AbortController();
    const active: ActiveSync = {phase: action === 'check' ? 'checking' : 'updating', controller, done: Promise.resolve(), interactive};
    this.active.set(id, active);
    active.done = this.execute(item, key, action, expectedRevision, controller.signal, () => active.interactive).finally(() => {
      this.cache.delete(id); this.clones.invalidate(); if (this.active.get(id) === active) this.active.delete(id);
    });
    return active.done;
  }
  private async lockRepository(item: ManagedResource, signal: AbortSignal): Promise<() => void> {
    // Linked worktrees share refs and fetch locks. Only these related resources wait on each other;
    // separate clones, even of the same remote URL, remain fully independent.
    const directory = await this.run(['rev-parse', '--git-common-dir'], item.path!, {signal, sync: true});
    const key = realpathSync(resolve(item.path!, directory));
    const previous = this.repositoryTails.get(key);
    let release!: () => void;
    const tail = new Promise<void>(done => {release = done;});
    this.repositoryTails.set(key, tail);
    await previous;
    return () => {release(); if (this.repositoryTails.get(key) === tail) this.repositoryTails.delete(key);};
  }
  private async execute(item: ManagedResource, key: string, action: 'check' | 'update', revision: string, signal: AbortSignal, interactive: () => boolean): Promise<void> {
    const previous = this.records.get(item.id);
    const record: RecordState = {key, attemptedAt: Date.now(), ...(previous?.key === key ? {checkedAt: previous.checkedAt, target: previous.target, updatedAt: previous.updatedAt} : {})};
    this.records.set(item.id, record);
    const current = () => {
      this.open(); if (signal.aborted) resourceFailure('project-closing');
      this.clones.store.assertRevision(revision);
      if (this.key(this.resource(item.id)) !== key) resourceFailure('git-state-changed');
    };
    let release: (() => void) | undefined;
    try {
      release = await this.lockRepository(item, signal); current();
      const before = await this.local(item, true, signal); current();
      if (record.target !== before.target) {record.checkedAt = undefined; record.updatedAt = undefined;}
      record.target = before.target;
      if (!before.connected) resourceFailure('git-no-remote');
      if (!before.branch) resourceFailure('git-detached');
      if (!before.target) resourceFailure('git-no-upstream');
      if (action === 'update') this.updatable(before);
      const fetch: GitRun = this.clones.auth ? (args, cwd, options = {}) => this.clones.auth!.run(this.run, args, cwd, options,
        {url: item.url!, name: item.name, action}, interactive, current) : this.run;
      await fetch(['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=',
        '--', item.url!, `+${before.remoteRef}:${before.trackingRef}`], item.path!, {signal, sync: true, timeoutMs: this.options.timeoutMs ?? 60_000});
      current();
      const fetched = await this.local(item, true, signal); current();
      if (fetched.target !== before.target || fetched.head !== before.head) resourceFailure('git-state-changed');
      record.checkedAt = new Date().toISOString();
      if (action === 'update') {
        this.updatable(fetched);
        if (!fetched.upstreamHead) resourceFailure('git-remote-branch-missing');
        if (fetched.behind) {
          // Pin the fetched commit. Never rebase, stash, force-reset, run hooks or overwrite ignored files.
          await this.run(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
            'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', fetched.upstreamHead], item.path!,
          {signal, sync: true, timeoutMs: this.options.timeoutMs ?? 60_000});
          current(); record.updatedAt = new Date().toISOString();
        }
      }
    } catch (error) {record.error = failureCode(error);}
    finally {release?.();}
  }
  private updatable(local: Repository): void {
    if (local.inProgress) resourceFailure('git-in-progress');
    if (local.dirty) resourceFailure('git-local-changes');
    if (local.ahead && local.behind) resourceFailure('git-history-diverged');
  }
  startAutomaticChecks(): void {
    if (this.timer || this.closing || this.interval <= 0) return;
    const tick = async () => {
      try {
        // Automatic checks stay paced; explicit actions on other resources can run concurrently.
        const project = this.clones.project();
        for (const item of managedResources(project.resources, project.root)) {
          if (this.closing) break;
          if (item.type !== 'git' || item.status !== 'ready' || !item.path || !item.url || this.clones.isBusy(item.id) || this.active.has(item.id)) continue;
          const record = this.records.get(item.id);
          if (record?.key === this.key(item) && Date.now() - record.attemptedAt < this.interval) continue;
          try {
            const local = await this.local(item);
            if (local.connected && local.target) await this.start(item.id, 'check', this.clones.store.revision(), false);
          } catch { /* The snapshot reports local errors; one resource must not block other checks. */ }
        }
      } catch { /* Invalid project data is reported by the existing resource API. */ }
      // Periodic checks are temporarily paused (2026-09-18); keep the startup check and manual actions.
      // if (!this.closing) {this.timer = setTimeout(tick, Math.min(this.interval, 15_000)); this.timer.unref();}
    };
    this.timer = setTimeout(tick, this.options.initialDelayMs ?? 10_000); this.timer.unref();
  }
  async dispose(): Promise<void> {
    this.closing = true; clearTimeout(this.timer);
    const active = [...this.active.values()]; active.forEach(job => job.controller.abort()); this.lifetime.abort();
    await Promise.allSettled([...active.map(job => job.done), ...this.reads]);
  }
}
