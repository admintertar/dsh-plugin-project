import {existsSync, realpathSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ProjectHttpError} from './http.ts';
import {resourceFailure} from './resource-files.ts';
import {ResourceGitError, type GitRun} from './resource-git.ts';
import {validResourceUrl, type ManagedResource, type ResourceBranches, type ResourceChangeStatus, type ResourceChanges, type ResourceGitSync, type ResourcesSnapshot, type ResourceSyncAction} from './resource-contract.ts';
import type {ResourceCloneManager} from './resource-clones.ts';
import type {PickSource} from './api-types.ts';
import {isProjectRootResource, managedResources} from './resource-scope.ts';

interface Repository {
  branch?: string; head?: string; remote?: string; remoteRef?: string; trackingRef?: string; upstreamHead?: string;
  target: string; connected: boolean; dirty: boolean; inProgress: boolean; ahead?: number; behind?: number; upstream?: string;
  files: {path: string; status: ResourceChangeStatus}[];
}
interface RecordState {key: string; target?: string; checkedAt?: string; updatedAt?: string; error?: string; attemptedAt: number}
interface ActiveSync {phase: NonNullable<ResourceGitSync['phase']>; controller: AbortController; done: Promise<void>; interactive: boolean}
const failureCode = (error: unknown): string => error instanceof ProjectHttpError || error instanceof ResourceGitError ? error.code : 'git-sync-failed';
const operationMarkers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'];

/** The two status letters of a porcelain v2 record, reduced to the state a commit would record. */
function changeStatus(xy: string): ResourceChangeStatus {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  return 'modified';
}
/** Porcelain v2 records: `1` ordinary, `2` rename/copy, `u` unmerged, `?` untracked. */
function parseChanges(output: string): {path: string; status: ResourceChangeStatus}[] {
  const files: {path: string; status: ResourceChangeStatus}[] = [];
  for (const line of output.split('\n')) {
    if (!line || line.startsWith('# ')) continue;
    if (line.startsWith('? ')) {files.push({path: line.slice(2), status: 'untracked'}); continue;}
    const parts = line.split(' ');
    // A path follows a fixed field count per record type, and porcelain leaves spaces unquoted.
    if (parts[0] === 'u') {files.push({path: parts.slice(10).join(' '), status: 'conflicted'}); continue;}
    if (parts[0] === '1' || parts[0] === '2') files.push({
      path: parts.slice(parts[0] === '1' ? 8 : 9).join(' ').split('\t')[0]!,
      status: parts[0] === '2' ? 'renamed' : changeStatus(parts[1] ?? '')});
  }
  return files;
}

/** Local inspection only. Track the actual current branch; manifest.branch remains a clone option. */
async function inspect(path: string, url: string | undefined, run: GitRun): Promise<Repository> {
  if (realpathSync(await run(['rev-parse', '--show-toplevel'], path)) !== realpathSync(path)) resourceFailure('resource-git-invalid');
  const output = await run(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=none'], path);
  const lines = output.split('\n');
  const value = (name: string) => lines.find(line => line.startsWith(`# branch.${name} `))?.slice(name.length + 10);
  const branch = value('head'); const head = value('oid');
  const gitDir = await run(['rev-parse', '--absolute-git-dir'], path);
  const result: Repository = {branch: branch && branch !== '(detached)' ? branch : undefined,
    head: head && head !== '(initial)' ? head : undefined, target: '', connected: false, files: parseChanges(output),
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
  async snapshot(canPick: boolean, pickSource: PickSource | null = canPick ? 'native' : null): Promise<ResourcesSnapshot> {
    const data = await this.clones.snapshot(canPick, pickSource);
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
  private static readonly phases: Record<ResourceSyncAction, NonNullable<ResourceGitSync['phase']>> =
    {check: 'checking', update: 'updating', commit: 'committing', push: 'pushing', switch: 'switching'};
  /** `input` carries the commit message or the target branch, depending on the action. */
  start(id: string, action: ResourceSyncAction, expectedRevision: string, interactive = true, input?: string): Promise<void> {
    this.open(); this.clones.store.assertRevision(expectedRevision); this.clones.assertMutable(id);
    const existing = this.active.get(id);
    // A manual check may race the automatic check before the next snapshot arrives.
    if (existing?.phase === 'checking' && action === 'check') {existing.interactive ||= interactive; return existing.done;}
    if (existing) resourceFailure('git-sync-busy');
    const item = this.resource(id); const key = this.key(item);
    // Switching branches is a local operation; every other action needs the configured remote.
    if (action !== 'switch' && !item.url) resourceFailure('git-no-remote');
    const controller = new AbortController();
    const active: ActiveSync = {phase: ResourceSyncManager.phases[action], controller, done: Promise.resolve(), interactive};
    this.active.set(id, active);
    const operation = action === 'check' || action === 'update'
      ? this.execute(item, key, action, expectedRevision, controller.signal, () => active.interactive)
      : this.mutate(item, key, action, input, expectedRevision, controller.signal, () => active.interactive);
    active.done = operation.finally(() => {
      this.cache.delete(id); this.clones.invalidate(); if (this.active.get(id) === active) this.active.delete(id);
    });
    return active.done;
  }
  /** Branch names for the picker. Local branches are switchable; remote ones are reference only. */
  async branches(id: string): Promise<ResourceBranches> {
    this.open();
    return this.branchNames(this.resource(id));
  }
  /** The changes a commit would include, read fresh for the confirmation dialog. */
  async changes(id: string): Promise<ResourceChanges> {
    this.open();
    return {files: (await this.local(this.resource(id), true)).files};
  }
  private async branchNames(item: ManagedResource, signal?: AbortSignal): Promise<ResourceBranches> {
    const run: GitRun = (args, cwd) => this.run(args, cwd, {signal: signal ?? this.lifetime.signal, sync: true});
    const repository = await this.local(item, true, signal);
    // Read full refnames: the remote HEAD is symbolic, and %(refname:short) reports it as the bare remote name.
    const refs = async (pattern: string) => (await run(['for-each-ref', '--format=%(refname)', pattern], item.path!))
      .split('\n').map(name => name.trim()).filter(Boolean);
    const local = (await refs('refs/heads')).map(name => name.slice('refs/heads/'.length)).sort();
    const prefix = repository.remote ? `refs/remotes/${repository.remote}/` : '';
    const remote = repository.remote
      ? (await refs(`refs/remotes/${repository.remote}`)).filter(name => name !== `${prefix}HEAD`)
        .map(name => name.slice(prefix.length)).sort()
      : [];
    return {local, remote, ...(repository.branch ? {current: repository.branch} : {}),
      ...(repository.remote ? {remoteName: repository.remote} : {})};
  }
  /**
   * Local history actions. Each re-reads the repository under the shared lock and
   * refuses an unsafe state before touching anything; none of them rewrites history.
   */
  private async mutate(item: ManagedResource, key: string, action: 'commit' | 'push' | 'switch', input: string | undefined,
    revision: string, signal: AbortSignal, interactive: () => boolean): Promise<void> {
    const previous = this.records.get(item.id);
    const record: RecordState = {key, attemptedAt: Date.now(),
      ...(previous?.key === key ? {checkedAt: previous.checkedAt, target: previous.target, updatedAt: previous.updatedAt} : {})};
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
      record.target = before.target;
      if (action === 'commit') await this.commit(item, before, input, signal);
      else if (action === 'push') await this.push(item, before, interactive, signal, current);
      else await this.switchBranch(item, before, input, signal);
      current(); record.updatedAt = new Date().toISOString();
    } catch (error) {record.error = failureCode(error);}
    finally {release?.();}
  }
  /**
   * Commit every working-tree change. Hooks and signing stay off: the Host has no
   * interactive terminal, so a hook or a signing passphrase would hang the operation.
   */
  private async commit(item: ManagedResource, local: Repository, message: string | undefined, signal: AbortSignal): Promise<void> {
    if (local.inProgress) resourceFailure('git-in-progress');
    const text = (message ?? '').trim();
    if (!text || text.length > 4096) resourceFailure('git-commit-message-required');
    if (!local.dirty) resourceFailure('git-nothing-to-commit');
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const read = (args: readonly string[]) => this.run(args, item.path!, {signal, sync: true, timeoutMs}).catch(() => '');
    if (!(await read(['config', '--get', 'user.email'])).trim() || !(await read(['config', '--get', 'user.name'])).trim()) {
      resourceFailure('git-identity-missing');
    }
    await this.run(['-c', 'core.hooksPath=/dev/null', 'add', '--all'], item.path!, {signal, sync: true, timeoutMs});
    await this.run(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--message', text],
      item.path!, {signal, sync: true, timeoutMs});
  }
  /** Push the current branch without ever forcing; a rejected push is reported, never rewritten. */
  private async push(item: ManagedResource, local: Repository, interactive: () => boolean, signal: AbortSignal,
    current: () => void): Promise<void> {
    if (local.inProgress) resourceFailure('git-in-progress');
    if (!local.branch) resourceFailure('git-detached');
    if (!local.connected) resourceFailure('git-no-remote');
    if (!local.target || !local.remoteRef || !local.upstream) resourceFailure('git-no-upstream');
    if (local.ahead && local.behind) resourceFailure('git-history-diverged');
    // A missing tracking ref means the branch is not on the remote yet; that first push is allowed.
    if (local.upstreamHead && !local.ahead) resourceFailure('git-nothing-to-push');
    const auth = this.clones.auth;
    const run: GitRun = auth ? (args, cwd, options = {}) => auth.run(this.run, args, cwd, options,
      {url: item.url!, name: item.name, action: 'push'}, interactive, current) : this.run;
    try {
      // No force flag is ever passed, so a non-fast-forward update is rejected by the remote.
      await run(['-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', '--no-recurse-submodules', '--',
        item.url!, `${local.branch}:${local.remoteRef}`], item.path!, {signal, sync: true, timeoutMs: this.options.timeoutMs ?? 60_000});
    } catch (error) {
      // Credential, host and cancellation failures keep their own codes; anything else is a rejection.
      const code = failureCode(error);
      if (['git-auth-required', 'git-auth-invalid', 'git-auth-expired', 'git-auth-cancelled', 'git-auth-unavailable',
        'git-auth-remote-changed', 'git-host-unverified', 'git-sync-timeout', 'clone-cancelled', 'project-closing'].includes(code)) throw error;
      resourceFailure('git-push-rejected');
    }
    // Git only advances the remote-tracking ref for a named remote, and this pushes by URL,
    // so record the pushed commit here; otherwise the resource keeps reporting itself ahead.
    await this.run(['update-ref', local.trackingRef!, local.head!], item.path!, {signal, sync: true,
      timeoutMs: this.options.timeoutMs ?? 60_000});
  }
  /** Switch to an existing local branch. Local changes are refused rather than stashed. */
  private async switchBranch(item: ManagedResource, local: Repository, branch: string | undefined, signal: AbortSignal): Promise<void> {
    if (local.inProgress) resourceFailure('git-in-progress');
    if (local.dirty) resourceFailure('git-local-changes');
    const target = (branch ?? '').trim();
    if (!target || target.startsWith('-') || target.length > 255) resourceFailure('resource-branch-invalid');
    await this.run(['check-ref-format', '--branch', target], item.path!, {signal, sync: true})
      .catch(() => resourceFailure('resource-branch-invalid'));
    if (!(await this.branchNames(item, signal)).local.includes(target)) resourceFailure('git-branch-missing');
    await this.run(['-c', 'core.hooksPath=/dev/null', 'switch', '--no-guess', target], item.path!,
      {signal, sync: true, timeoutMs: this.options.timeoutMs ?? 60_000});
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
