import {createHash, randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {appendGitignoreRules, atomicWriteFile} from './atomic-file.ts';
import {ProjectHttpError} from './http.ts';
import {ProjectResourceStore, resourceId} from './project-resources.ts';
import {nodeError, optionalText, resourceFailure, within} from './resource-files.ts';
import {inspectResourceGit, ResourceGitError, validateResourceBranch, type GitRun} from './resource-git.ts';
import {validResourceUrl, type ResourceCloneOperation, type ResourceCloneRequest, type ResourcesSnapshot} from './resource-contract.ts';
import type {PickSource} from './api-types.ts';
import type {ResourceGitAuthentication} from './resource-auth.ts';
import {isProjectRootResource, managedResources} from './resource-scope.ts';

const operationSchema = z.object({
  id: z.string().uuid(), requestId: z.string().min(1).max(128), resourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  existing: z.boolean(), name: z.string().min(1).max(160), url: z.string().refine(validResourceUrl), path: z.string().max(8000),
  target: z.string().max(8000), branch: z.string().max(255).optional(), revision: z.string().length(64),
  status: z.enum(['cloning', 'cancelling', 'cancelled', 'failed', 'pending', 'completed', 'interrupted']),
  phase: z.enum(['receiving', 'resolving', 'checkout']).optional(), percent: z.number().min(0).max(100).optional(),
  error: z.string().max(80).optional(), createdAt: z.string(), updatedAt: z.string(),
  identity: z.object({dev: z.number(), ino: z.number()}).optional(),
}).strict();
const incompleteSchema = z.object({resourceId: operationSchema.shape.resourceId, target: operationSchema.shape.target,
  identity: operationSchema.shape.identity}).strict();
const stateSchema = z.object({schemaVersion: z.literal(1), operations: z.array(operationSchema).max(21),
  incomplete: z.array(incompleteSchema).max(100).default([])}).strict();
const failureCode = (error: unknown) => error instanceof ProjectHttpError || error instanceof ResourceGitError ? error.code : 'clone-failed';

/** Project-owned clone jobs survive page changes; only completed workspaces may enter the manifest. */
export class ResourceCloneManager {
  private operations: ResourceCloneOperation[] = [];
  // Separate from bounded history: evicting an old job must never make a partial clone usable.
  private incomplete: z.infer<typeof incompleteSchema>[] = [];
  private active?: {operation: ResourceCloneOperation; controller: AbortController; done: Promise<void>};
  private preparing?: Promise<ResourceCloneOperation>;
  private closing = false;
  private available?: boolean;
  private availability?: Promise<boolean>;
  private readonly gitCache = new Map<string, {at: number; value: Awaited<ReturnType<typeof inspectResourceGit>>}>();
  readonly stateFile: string;
  constructor(readonly store: ProjectResourceStore, readonly runtime: string, readonly run: GitRun = store.run,
    private readonly timeoutMs = 30 * 60 * 1000, readonly auth?: ResourceGitAuthentication) {
    this.stateFile = join(runtime, 'operations.json');
    const text = optionalText(this.stateFile, 1024 * 1024);
    if (text !== null) {
      const state = stateSchema.parse(JSON.parse(text));
      this.operations = state.operations; this.incomplete = state.incomplete;
      for (const operation of this.operations) {
        if (operation.status === 'cloning' || operation.status === 'cancelling') {
          operation.status = 'interrupted'; operation.error = 'operation-interrupted';
        }
      }
    }
  }
  private open(): void {if (this.closing) resourceFailure('project-closing', 503);}
  private persist(): void {
    mkdirSync(this.runtime, {recursive: true, mode: 0o700});
    if (lstatSync(this.runtime).isSymbolicLink()) resourceFailure('operation-storage-failed');
    this.operations = this.operations.slice(-20);
    const text = JSON.stringify({schemaVersion: 1, operations: this.operations, incomplete: this.incomplete});
    if (Buffer.byteLength(text) > 1024 * 1024) resourceFailure('operation-storage-failed');
    atomicWriteFile(this.stateFile, text, 0o600);
  }
  async gitAvailable(): Promise<boolean> {
    if (this.available !== undefined) return this.available;
    return this.availability ??= this.run(['--version'], this.store.root).then(() => this.available = true, () => this.available = false);
  }
  async snapshot(canPick: boolean, pickSource: PickSource | null = canPick ? 'native' : null): Promise<ResourcesSnapshot> {
    const canClone = await this.gitAvailable();
    const revision = this.store.revision();
    const project = this.project();
    const resources: ResourcesSnapshot['resources'] = managedResources(project.resources, project.root).map(item => ({...item}));
    // Bound process fanout when a shared project declares many repositories.
    for (let offset = 0; offset < resources.length; offset += 4) await Promise.all(resources.slice(offset, offset + 4).map(async item => {
      if (item.type !== 'git' || item.status !== 'ready' || !item.path) return;
      const key = `${item.id}:${item.path}`;
      let cached = this.gitCache.get(key);
      if (!cached || Date.now() - cached.at > 5000) {
        cached = {at: Date.now(), value: canClone ? await inspectResourceGit(item.path, this.run) : undefined};
        this.gitCache.set(key, cached);
      }
      item.git = cached.value ? {branch: cached.value.branch,
        ...(cached.value.url && item.url && cached.value.url !== item.url ? {diagnostic: 'resource-origin-mismatch'} : {})}
        : {diagnostic: canClone ? 'resource-git-invalid' : 'git-unavailable'};
    }));
    const data = {revision, resources, operations: this.operations.map(item => ({...item})), canPick, pickSource, canClone};
    return {...data, version: createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)};
  }
  /** Shared by cards, overview, Task access and model context; a directory alone is not a finished clone. */
  project(): ReturnType<ProjectResourceStore['read']> {
    const project = this.store.read();
    for (const item of project.resources) {
      if (item.status === 'ready' && this.incomplete.some(entry => entry.resourceId === item.id && entry.target === item.path)) item.status = 'unavailable';
    }
    return project;
  }
  releaseResource(id: string): void {
    this.incomplete = this.incomplete.filter(entry => entry.resourceId !== id);
    this.persist();
  }
  /** Explicit refresh may re-detect a Git installation, without performing any network operation. */
  invalidate(): void {this.gitCache.clear(); this.available = undefined; this.availability = undefined;}
  isBusy(id?: string): boolean {return Boolean(this.active && (id === undefined || this.active.operation.resourceId === id));}
  assertMutable(id: string): void {if (this.isBusy(id)) resourceFailure('clone-busy');}
  private target(path: string, createParents = false): string {
    if (!path || path.length > 8000 || isAbsolute(path) || /[\\\u0000-\u001f\u007f:]/.test(path)) resourceFailure('resource-target-invalid', 422);
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
      || ['.agent-project', 'memory', 'tasks', 'skills', 'mcp'].includes(parts[0]!.toLowerCase())) resourceFailure('resource-target-invalid', 422);
    let parent = this.store.root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (createParents) {try {mkdirSync(parent, {mode: 0o755});} catch (error) {if (!nodeError(error, 'EEXIST')) throw error;}}
      try {
        if (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory() || !within(realpathSync.native(this.store.root), realpathSync.native(parent))) resourceFailure('resource-target-invalid', 422);
      } catch (error) {if (!nodeError(error, 'ENOENT')) throw error;}
    }
    const target = resolve(this.store.root, ...parts);
    if (!within(this.store.root, target) || target === this.store.root) resourceFailure('resource-target-invalid', 422);
    return target;
  }
  private async untracked(target: string): Promise<void> {
    let outer: string;
    try {outer = await this.run(['rev-parse', '--show-toplevel'], this.store.root);} catch {return;}
    // Git reports the resolved long form while the store root may still carry 8.3 short
    // names, and relative() would then compute a nonsense path; canonicalize both sides.
    const canonical = resolve(realpathSync.native(this.store.root), relative(this.store.root, target));
    const rel = relative(realpathSync.native(outer), canonical).split(sep).join('/');
    const tracked = await this.run(['--literal-pathspecs', 'ls-files', '--', rel], outer);
    if (tracked) resourceFailure('target-tracked');
  }
  start(request: ResourceCloneRequest): Promise<ResourceCloneOperation> {
    this.open();
    const previous = this.operations.find(item => item.requestId === request.requestId);
    if (previous) {
      if (previous.name !== request.name.trim() || previous.url !== request.url || previous.path !== request.path
        || previous.branch !== (request.branch || undefined) || previous.existing !== Boolean(request.id)
        || (request.id !== undefined && previous.resourceId !== request.id)) resourceFailure('revision-conflict');
      return Promise.resolve({...previous});
    }
    if (this.preparing || this.active) resourceFailure('clone-busy');
    const preparing = this.prepare(request);
    this.preparing = preparing;
    void preparing.finally(() => {if (this.preparing === preparing) this.preparing = undefined;}).catch(() => {});
    return preparing;
  }
  private async prepare(request: ResourceCloneRequest): Promise<ResourceCloneOperation> {
    if (!validResourceUrl(request.url)) resourceFailure('resource-url-invalid', 422);
    this.store.assertRevision(request.expectedRevision);
    if (!request.id && this.store.read().resources.length >= 100) resourceFailure('resource-config-invalid', 422);
    if (!await this.gitAvailable()) resourceFailure('git-unavailable', 422);
    await validateResourceBranch(request.branch, this.store.root, this.run);
    this.open();
    if (request.id) {
      const existing = this.project().resources.find(item => item.id === request.id);
      if (existing && isProjectRootResource(existing, this.store.root)) resourceFailure('resource-project-root');
      if (!existing || existing.type !== 'git') resourceFailure('resource-not-found', 404);
      if (existing.path && (existing.external || existing.status === 'ready')) resourceFailure('target-exists');
    }
    const target = this.target(request.path);
    try {lstatSync(target); return resourceFailure('target-exists');} catch (error) {if (!nodeError(error, 'ENOENT')) throw error;}
    await this.untracked(target);
    this.open(); this.store.assertRevision(request.expectedRevision);
    this.target(request.path, true);
    const ignore = join(this.store.root, '.gitignore');
    try {if (lstatSync(ignore).isSymbolicLink() || !statSync(ignore).isFile()) resourceFailure('resource-target-invalid', 422);}
    catch (error) {if (!nodeError(error, 'ENOENT')) throw error;}
    const rule = '/' + request.path.replace(/[\\*?\[\] !#]/g, '\\$&') + '/';
    appendGitignoreRules(this.store.root, [rule]);
    const now = new Date().toISOString();
    const operation: ResourceCloneOperation = {id: randomUUID(), requestId: request.requestId,
      resourceId: request.id ?? resourceId(request.name), existing: request.id !== undefined,
      name: request.name.trim(), url: request.url, path: request.path, target, branch: request.branch || undefined,
      revision: request.expectedRevision, status: 'cloning', createdAt: now, updatedAt: now};
    this.operations.push(operation);
    if (operation.existing && this.store.read().resources.find(item => item.id === operation.resourceId)?.path === target) {
      const ids = new Set(this.store.read().resources.map(item => item.id));
      this.incomplete = this.incomplete.filter(entry => ids.has(entry.resourceId) && entry.resourceId !== operation.resourceId);
      this.incomplete.push({resourceId: operation.resourceId, target, identity: operation.identity});
    }
    try {this.persist();} catch {
      operation.status = 'failed'; operation.error = 'operation-storage-failed';
      resourceFailure('operation-storage-failed');
    }
    // Record intent before mkdir so a crash never leaves an unrecorded partial workspace.
    let created = false;
    try {
      mkdirSync(target, {mode: 0o755}); created = true;
      const info = lstatSync(target); operation.identity = {dev: info.dev, ino: info.ino};
      const incomplete = this.incomplete.find(entry => entry.resourceId === operation.resourceId && entry.target === target);
      if (incomplete) incomplete.identity = operation.identity;
      this.persist();
    } catch (error) {
      operation.status = 'failed'; operation.error = nodeError(error, 'EEXIST') ? 'target-exists' : 'operation-storage-failed';
      if (!created) this.incomplete = this.incomplete.filter(entry => entry.resourceId !== operation.resourceId || entry.target !== target);
      try {this.persist();} catch { /* Keep the original intent for restart recovery. */ }
      resourceFailure(operation.error);
    }
    const controller = new AbortController();
    const active = {operation, controller, done: Promise.resolve()};
    this.active = active;
    active.done = this.execute(operation, controller.signal).finally(() => {if (this.active === active) this.active = undefined;});
    // execute contains its error handling, including persistence failures.
    return {...operation};
  }
  private owned(operation: ResourceCloneOperation): void {
    const target = this.target(operation.path);
    if (target !== operation.target) resourceFailure('resource-target-invalid', 422);
    let stat;
    try {stat = lstatSync(target);} catch {return resourceFailure('resource-unavailable');}
    if (!stat.isDirectory() || stat.isSymbolicLink() || !operation.identity
      || stat.dev !== operation.identity.dev || stat.ino !== operation.identity.ino) resourceFailure('resource-target-invalid', 422);
  }
  private async validateCompleted(operation: ResourceCloneOperation): Promise<void> {
    this.owned(operation);
    const repository = await inspectResourceGit(operation.target, this.run);
    this.owned(operation);
    if (!repository || repository.url !== operation.url || (operation.branch && repository.branch !== operation.branch)) resourceFailure('resource-git-invalid', 422);
  }
  private async execute(operation: ResourceCloneOperation, signal: AbortSignal): Promise<void> {
    let cloned = false;
    try {
      const empty = join(this.runtime, 'empty-git-template');
      mkdirSync(empty, {recursive: true, mode: 0o700});
      this.owned(operation);
      const run: GitRun = this.auth ? (args, cwd, options = {}) => this.auth!.run(this.run, args, cwd, options,
        {url: operation.url, name: operation.name, action: 'clone'}, true, () => {
          this.open(); this.store.assertRevision(operation.revision); this.owned(operation);
          // Git normally removes its temporary files after an authentication failure.
          // Retry only our still-empty directory; never erase a partial clone or user files.
          if (readdirSync(operation.target).length) resourceFailure('target-exists');
        }) : this.run;
      await run(['-c', `core.hooksPath=${empty}`, '-c', `init.templateDir=${empty}`,
        'clone', '--progress', '--no-recurse-submodules', ...(operation.branch ? ['--branch', operation.branch] : []), '--', operation.url, '.'], operation.target,
      {signal, timeoutMs: this.timeoutMs, progress: text => {
        const matches = [...text.matchAll(/(Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/g)];
        const last = matches.at(-1);
        if (last) {operation.phase = last[1] === 'Receiving objects' ? 'receiving' : last[1] === 'Resolving deltas' ? 'resolving' : 'checkout'; operation.percent = Math.min(100, Number(last[2]));}
      }});
      cloned = true;
      await this.validateCompleted(operation);
      if (signal.aborted || this.closing) throw new ResourceGitError('clone-cancelled');
      this.store.registerClone(operation, operation.revision);
      this.incomplete = this.incomplete.filter(entry => entry.resourceId !== operation.resourceId);
      operation.status = 'completed'; operation.error = undefined;
      this.gitCache.clear();
    } catch (error) {
      const code = failureCode(error);
      operation.status = code === 'clone-cancelled' || code === 'git-auth-cancelled' ? 'cancelled' : cloned ? 'pending' : 'failed';
      operation.error = code === 'clone-cancelled' || code === 'git-auth-cancelled' ? undefined : code;
    } finally {
      operation.updatedAt = new Date().toISOString();
      try {this.persist();} catch {operation.error = 'operation-storage-failed';}
    }
  }
  async cancel(id: string): Promise<void> {
    const operation = this.operations.find(item => item.id === id) ?? resourceFailure('operation-not-found', 404);
    if (this.active?.operation === operation) {
      const active = this.active;
      operation.status = 'cancelling'; active.controller.abort();
      await active.done;
    }
  }
  async register(id: string, expectedRevision: string): Promise<void> {
    this.open();
    if (this.active || this.preparing) resourceFailure('clone-busy');
    const operation = this.operations.find(item => item.id === id) ?? resourceFailure('operation-not-found', 404);
    if (operation.status === 'completed') return;
    if (!['pending', 'interrupted'].includes(operation.status)) resourceFailure('operation-not-ready');
    this.store.assertRevision(expectedRevision);
    await this.validateCompleted(operation);
    this.open();
    // A crash can occur after the YAML transaction committed but before the job record was saved.
    const already = this.store.read().resources.find(item => item.id === operation.resourceId);
    if (!(already?.path === operation.target && already.url === operation.url && already.name === operation.name)) {
      this.store.registerClone(operation, expectedRevision);
    }
    operation.status = 'completed'; operation.error = undefined; operation.updatedAt = new Date().toISOString();
    this.incomplete = this.incomplete.filter(entry => entry.resourceId !== operation.resourceId);
    this.persist(); this.gitCache.clear();
  }
  async dispose(): Promise<void> {
    this.closing = true;
    this.active?.controller.abort();
    await this.preparing?.catch(() => {});
    this.active?.controller.abort();
    await this.active?.done;
  }
}
