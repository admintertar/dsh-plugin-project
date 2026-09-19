import {constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {parse, stringify} from 'yaml';
import {z} from 'zod';
import {appendGitignoreRules, atomicWriteFile, exclusiveAtomicWriteFile} from './atomic-file.ts';
import {ensureProjectLayout, projectLayout, type ProjectLayout} from './project-layout.ts';
import type {ProjectView} from './project.ts';
import {withTaskWriteLock} from './task-lock.ts';
import {artifactSchema, briefSchema, createProjectTaskSchema, entrySchema, handoffSchema,
  operationIdSchema, referenceSchema, revisionSchema, taskIdSchema, taskPhaseSchema, taskStatusSchema, updateProjectTaskSchema,
  type CreateProjectTask, type ProjectArtifact, type ProjectTask, type ProjectTaskDiagnostic,
  type ProjectTaskList, type TaskArchiveControl, type TaskBrief, type TaskDetail, type TaskEntry, type TaskEntryInput,
  type TaskListOptions, type TaskListPage, type TaskMutationResult, type TaskRecord, type TaskReference,
  type TaskSource, type TaskWriteSource, type UpdateProjectTask} from './task-contract.ts';
export * from './task-contract.ts';

const MAX_TASK_BYTES = 256 * 1024;
const MAX_TASKS = 500;
const MAX_ARTIFACTS = 200;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const iso = z.string().datetime({offset: true});
const text = z.string().min(1).max(8_000);
const directorySchema = z.string().min(1).max(160).refine(value => !/[\\/:*?"<>|\x00-\x1f]/.test(value) && value !== '.' && value !== '..' && !value.startsWith('.') && !/[. ]$/.test(value));
const receiptSchema = z.object({fingerprint: revisionSchema, kind: z.enum(['create', 'update', 'archive']), at: iso, entryIds: z.array(taskIdSchema)}).strict();
const metadataV3 = z.object({
  schemaVersion: z.literal(3), directory: directorySchema, id: taskIdSchema, title: z.string().min(1).max(240), objective: text, status: taskStatusSchema,
  createdAt: iso, updatedAt: iso, blockedReason: text.optional(), artifacts: z.array(artifactSchema).max(MAX_ARTIFACTS), archived: z.boolean(),
  phase: taskPhaseSchema.optional(), brief: briefSchema.optional(), questions: z.array(text).max(100).optional(),
  handoff: handoffSchema.optional(), references: z.array(referenceSchema).max(200), entries: z.array(entrySchema),
  operations: z.record(revisionSchema, receiptSchema), criterionVersions: z.record(taskIdSchema, z.number().int().positive()).default({}),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
interface StoredTask extends ProjectTask {revision: string; operations: Record<string, Receipt>; criterionVersions: Record<string, number>}
const sourceSchema = z.object({sessionId: z.string().min(1).max(256), eventId: z.string().min(1).max(2_000).optional()}).strict();
const sourcesSchema = z.record(taskIdSchema, z.record(taskIdSchema, sourceSchema));
export interface ProjectTaskStoreOptions {clock?: () => Date; idGenerator?: () => string; writeFile?: typeof atomicWriteFile}
export class TaskStoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {super(message); this.name = 'TaskStoreError'; this.code = code; this.status = status;}
}
function nodeError(error: unknown, code: string): boolean {return error instanceof Error && 'code' in error && error.code === code;}
function hash(value: string|Buffer): string {return createHash('sha256').update(value).digest('hex');}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function publicTask(task: StoredTask): TaskRecord {const {operations: _, criterionVersions: _v, ...record} = task; return record;}
function diagnostic(path: string, code: ProjectTaskDiagnostic['code'], error: string): ProjectTaskDiagnostic {return {path, code, error};}
function boundedText(path: string, bytes: number): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new TaskStoreError('invalid-record', 'Task storage files cannot be symbolic links', 422);
  if (!info.isFile() || info.size > bytes) throw new TaskStoreError('size-limit', `Record exceeds ${bytes} bytes or is not a regular file`, 422);
  const content = readFileSync(path);
  if (content.length > bytes) throw new TaskStoreError('size-limit', `Record exceeds ${bytes} bytes`, 422);
  return content.toString('utf8');
}
function decodeTask(path: string): StoredTask {
  const raw = boundedText(path, MAX_TASK_BYTES);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('Task Markdown is missing YAML frontmatter');
  const input = parse(match[1]!);
  const metadata = metadataV3.parse(input);
  let summary = match[2]!;
  if (summary.endsWith('\n')) summary = summary.slice(0, -1);
  if (Buffer.byteLength(summary) > 128 * 1024) throw new Error('Task summary exceeds 128 KiB');
  return {...metadata, ...(summary ? {summary} : {}), revision: hash(raw)};
}
function encodeTask(task: StoredTask): string {
  const {revision: _, summary, ...metadata} = task;
  const valid = metadataV3.parse(metadata);
  if (summary !== undefined && Buffer.byteLength(summary) > 128 * 1024) throw new TaskStoreError('size-limit', 'Task summary exceeds 128 KiB', 422);
  const document = `---\n${stringify(valid, {lineWidth: 0})}---\n\n${summary ?? ''}\n`;
  if (Buffer.byteLength(document) > MAX_TASK_BYTES) throw new TaskStoreError('size-limit', `Task exceeds ${MAX_TASK_BYTES} bytes`, 422);
  return document;
}
function isWithin(root: string, target: string): boolean {const child = relative(root, target); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));}
function portablePath(path: string): string {return path.split(sep).join('/');}
function canonicalWhenPresent(path: string): string {return existsSync(path) ? realpathSync(path) : resolve(path);}
function artifactKey(artifact: ProjectArtifact): string {return artifact.type === 'file' ? `file:${artifact.path}` : artifact.type === 'url' ? `url:${artifact.url}` : artifact.type === 'commit' ? `commit:${artifact.repository}:${artifact.commit}` : `note:${artifact.description}`;}
function unique(ids: readonly string[], name: string): void {if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${name} id`);}
function excerpt(value: string|undefined, max = 300): string|undefined {return value === undefined ? undefined : value.length > max ? `${value.slice(0, max - 1)}…` : value;}
function cursor(revision: string, offset: number): string {return Buffer.from(JSON.stringify({revision, offset})).toString('base64url');}
function cursorOffset(value: string|undefined, revision: string): number {
  if (value === undefined) return 0;
  const parsed = z.object({revision: revisionSchema, offset: z.number().int().nonnegative()}).strict().parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  if (parsed.revision !== revision) throw new TaskStoreError('revision-conflict', 'Task pagination revision conflict; read again');
  return parsed.offset;
}
function pageLimit(value?: number): number {return z.number().int().min(1).max(50).parse(value ?? 20);}

/** Latest, not superseded verification for each criterion's current version. */
export function taskVerifications(task: ProjectTask): Record<string, TaskEntry> {
  const superseded = new Set(task.entries.flatMap(entry => entry.supersedes ? [entry.supersedes] : []));
  const criteria = new Map(task.brief?.acceptanceCriteria?.map(item => [item.id, item.version]));
  const result: Record<string, TaskEntry> = {};
  for (const entry of task.entries) {
    const check = entry.verification;
    if (entry.kind === 'verification' && check && !superseded.has(entry.id) && criteria.get(check.criterionId) === check.criterionVersion) result[check.criterionId] = entry;
  }
  return result;
}

/** Independent task bundles; local conversation provenance is strictly optional. */
export class ProjectTaskStore {
  readonly layout: ProjectLayout;
  private readonly project: ProjectView;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly writeFile: typeof atomicWriteFile;
  private pendingCopies: Array<{source: string; target: string}> = [];
  constructor(project: ProjectView, options: ProjectTaskStoreOptions = {}) {
    this.project = project;
    const candidate = projectLayout(project.root);
    if (existsSync(candidate.tasks) && lstatSync(candidate.tasks).isSymbolicLink()) throw new TaskStoreError('invalid-storage', 'Task storage directory cannot be a symbolic link', 422);
    this.layout = ensureProjectLayout(project.root);
    appendGitignoreRules(this.layout.root, ['tasks/.write-lock', 'tasks/.write-lock.recovery']);
    this.clock = options.clock ?? (() => new Date()); this.idGenerator = options.idGenerator ?? (() => `task-${randomUUID()}`);
    this.writeFile = options.writeFile ?? atomicWriteFile;
  }
  get(id: string): TaskRecord {return publicTask(this.readTask(id));}
  list(): ProjectTaskList {
    const directories = this.taskDirectories();
    const diagnostics: ProjectTaskDiagnostic[] = directories.length > MAX_TASKS ? [diagnostic('tasks', 'size-limit', 'Too many task directories')] : [];
    const tasks: TaskRecord[] = [];
    const duplicates = new Set<string>();
    for (const directory of directories.slice(0, MAX_TASKS)) {
      try {
        const task = this.readDirectory(directory);
        if (tasks.some(item => item.id === task.id)) duplicates.add(task.id);
        tasks.push(publicTask(task));
      } catch {diagnostics.push(diagnostic(`tasks/${directory}/task.md`, 'invalid-task', 'Invalid task directory record'));}
    }
    for (const task of tasks.filter(item => duplicates.has(item.id))) diagnostics.push(diagnostic(`tasks/${task.directory}/task.md`, 'invalid-task', 'Duplicate task identity'));
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return {tasks: tasks.filter(item => !duplicates.has(item.id)), diagnostics};
  }
  listPage(options: TaskListOptions = {}): TaskListPage {
    const all = this.list(); const query = options.query?.toLocaleLowerCase();
    const matching = all.tasks.filter(task => (options.includeArchived || !task.archived) && (!options.status || task.status === options.status) && (!query || `${task.title}\n${task.objective}`.toLocaleLowerCase().includes(query)));
    const revision = hash(stable({tasks: matching.map(task => [task.id, task.revision]), query, status: options.status, includeArchived: options.includeArchived ?? false}));
    const offset = cursorOffset(options.cursor, revision); const limit = pageLimit(options.limit);
    const tasks = matching.slice(offset, offset + limit).map(task => {
      const {brief: _, handoff, entries: _e, references: _r, artifacts: _a, questions: _q, ...row} = task;
      return {...row, objective: excerpt(task.objective)!, summary: excerpt(task.summary), blockedReason: excerpt(task.blockedReason), nextStep: excerpt(handoff?.nextSteps?.[0]), truncated: task.objective.length > 300 || (task.summary?.length ?? 0) > 300 || (task.blockedReason?.length ?? 0) > 300 || (handoff?.nextSteps?.[0]?.length ?? 0) > 300};
    });
    return {tasks, total: matching.length, unarchivedTotal: all.tasks.filter(task => !task.archived).length, diagnostics: all.diagnostics, ...(offset + limit < matching.length ? {nextCursor: cursor(revision, offset + limit)} : {})};
  }
  detail(id: string, options: {cursor?: string; limit?: number} = {}): TaskDetail {
    const task = this.get(id); const offset = cursorOffset(options.cursor, task.revision); const limit = pageLimit(options.limit);
    const newest = [...task.entries].reverse();
    return {task: {...task, entries: newest.slice(offset, offset + limit)}, totalEntries: newest.length, verification: taskVerifications(task), ...(offset + limit < newest.length ? {entriesNextCursor: cursor(task.revision, offset + limit)} : {})};
  }
  create(input: CreateProjectTask, source?: TaskWriteSource): TaskMutationResult {
    const value = createProjectTaskSchema.parse(input);
    return this.lock(() => {
      const key = hash(value.operationId); const fingerprint = hash(stable({kind: 'create', value}));
      const found = this.findOperation(key); if (found) return this.replay(found, key, fingerprint);
      if (this.taskDirectories().length >= MAX_TASKS) throw new Error('Too many task directories');
      const now = this.now(); const id = taskIdSchema.parse(this.idGenerator());
      if (this.list().tasks.some(item => item.id === id)) throw new Error('Duplicate task identity');
      const {title, objective, summary, phase, questions, handoff} = value;
      let base = title.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 60).replace(/[. ]+$/g, '') || 'Task';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) base = `Task-${base}`;
      let directory = base;
      for (let suffix = 1; existsSync(join(this.layout.tasks, directory)); suffix++) directory = `${base}-${id.slice(-8)}${suffix === 1 ? '' : `-${suffix}`}`;
      const task: StoredTask = {schemaVersion: 3, directory, id, title, objective, status: 'active', createdAt: now, updatedAt: now, archived: false,
        artifacts: [], references: this.mergeReferences([], value.references ?? []), entries: [], operations: {}, criterionVersions: {}, revision: '',
        ...(summary ? {summary} : {}), ...(phase ? {phase} : {}), ...(questions ? {questions} : {}), ...(handoff ? {handoff} : {})};
      if (value.brief) task.brief = this.nextBrief(undefined, value.brief, false, task.criterionVersions);
      task.entries = this.appendEntries(task, value.entries ?? [], now); this.validateReferences(task);
      task.operations[key] = {kind: 'create', fingerprint, at: now, entryIds: task.entries.map(entry => entry.id)};
      const content = encodeTask(task);
      mkdirSync(join(this.layout.tasks, directory)); mkdirSync(join(this.layout.tasks, directory, 'artifacts'));
      exclusiveAtomicWriteFile(this.recordPath(directory), content); task.revision = hash(content);
      this.saveSources(task, task.entries, source);
      return this.result(task, false);
    });
  }
  update(id: string, input: UpdateProjectTask, source?: TaskWriteSource): TaskMutationResult {
    const value = updateProjectTaskSchema.parse(input);
    return this.lock(() => {
      const task = this.readTask(id); const key = hash(value.operationId); const fingerprint = hash(stable({kind: 'update', id, value}));
      if (task.operations[key]) return this.replay(task, key, fingerprint);
      if (this.findOperation(key)) throw new TaskStoreError('operation-conflict', 'operationId already used');
      this.expectRevision(task, value.expectedRevision);
      this.pendingCopies = [];
      const now = this.now(); const next = this.applyUpdate(task, value, now);
      next.operations[key] = {kind: 'update', fingerprint, at: now, entryIds: next.entries.slice(task.entries.length).map(entry => entry.id)};
      const content = encodeTask(next); this.expectRevision(this.readTask(id), task.revision);
      for (const copy of this.pendingCopies) {this.taskFile(next.directory, portablePath(relative(dirname(this.recordPath(next.directory)), copy.target)), true); copyFileSync(copy.source, copy.target, constants.COPYFILE_EXCL);}
      this.pendingCopies = [];
      this.writeFile(this.recordPath(next.directory), content); next.revision = hash(content);
      this.saveSources(next, next.entries.slice(task.entries.length), source);
      return this.result(next, false);
    });
  }
  setArchived(id: string, archived: boolean, control: TaskArchiveControl): TaskMutationResult {
    z.boolean().parse(archived); revisionSchema.parse(control.expectedRevision); operationIdSchema.parse(control.operationId);
    return this.lock(() => {
      const task = this.readTask(id); const key = hash(control.operationId); const fingerprint = hash(stable({kind: 'archive', id, archived, control}));
      if (task.operations[key]) return this.replay(task, key, fingerprint);
      if (this.findOperation(key)) throw new TaskStoreError('operation-conflict', 'operationId already used');
      this.expectRevision(task, control.expectedRevision);
      const now = this.now(); const next = {...task, archived, updatedAt: now, operations: {...task.operations, [key]: {kind: 'archive' as const, fingerprint, at: now, entryIds: []}}};
      const content = encodeTask(next); this.expectRevision(this.readTask(id), task.revision);
      this.writeFile(this.recordPath(next.directory), content); next.revision = hash(content);
      return this.result(next, false);
    });
  }
  sources(id: string): Record<string, TaskSource> {
    try {return sourcesSchema.parse(parse(boundedText(this.layout.taskSources, 1024 * 1024)))[id] ?? {};} catch {return {};}
  }
  private saveSources(task: StoredTask, entries: TaskEntry[], source?: TaskWriteSource): void {
    if (!source || !entries.length) return;
    try {
      sourceSchema.parse(source);
      const all = existsSync(this.layout.taskSources) ? sourcesSchema.parse(parse(boundedText(this.layout.taskSources, 1024 * 1024))) : {};
      const items = all[task.id] ??= {}; for (const entry of entries) items[entry.id] = source;
      const content = stringify(all); if (Buffer.byteLength(content) > 1024 * 1024) return;
      mkdirSync(dirname(this.layout.taskSources), {recursive: true});
      if (realpathSync(dirname(this.layout.taskSources)) !== dirname(this.layout.taskSources)) return;
      atomicWriteFile(this.layout.taskSources, content);
    } catch { /* Optional provenance must never prevent saving portable task records. */ }
  }
  artifactPath(task: Pick<TaskRecord, 'directory'>, artifact: ProjectArtifact): string|undefined {
    if (artifact.type !== 'file') return undefined;
    try {const file = this.taskFile(task.directory, artifact.path); return statSync(file).isFile() ? file : undefined;} catch {return undefined;}
  }
  referencePath(reference: TaskReference): string|undefined {
    if (reference.type !== 'file') return undefined;
    try {const file = this.sourceFile(reference); return statSync(file).isFile() ? file : undefined;} catch {return undefined;}
  }
  private sourceFile(source: {resourceId?: string; path: string}): string {
    const resource = source.resourceId ? this.project.resources.find(item => item.id === source.resourceId) : undefined;
    if (source.resourceId && (!resource?.path || resource.status !== 'ready')) throw new Error('Resource unavailable');
    const root = realpathSync(resource?.path ?? this.project.root);
    const file = realpathSync(resolve(root, source.path));
    if (!isWithin(root, file)) throw new Error('File is outside its project or resource');
    return file;
  }
  private taskFile(directory: string, path: string, create = false): string {
    const root = dirname(this.recordPath(directory));
    if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || !path.startsWith('artifacts/')) throw new Error('Task files require artifacts/ relative paths');
    const file = resolve(root, path);
    if (!isWithin(join(root, 'artifacts'), file) || file === join(root, 'artifacts')) throw new Error('Invalid artifact path');
    // Check existing ancestors before mkdir/copy; never follow a link out of the bundle.
    let parent = dirname(file);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!isWithin(root, realpathSync(parent)) || realpathSync(parent) !== parent) throw new Error('Artifact parent cannot be a symbolic link');
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || realpathSync(file) !== file)) throw new Error('Artifact cannot be a symbolic link');
    if (create) mkdirSync(dirname(file), {recursive: true});
    return file;
  }
  private applyUpdate(task: StoredTask, value: z.output<typeof updateProjectTaskSchema>, now: string): StoredTask {
    const next: StoredTask = structuredClone(task); next.updatedAt = now;
    if (value.title !== undefined) next.title = value.title;
    const contractChanged = value.objective !== undefined && value.objective !== task.objective || (['scope', 'constraints', 'outOfScope'] as const).some(key => value.brief && key in value.brief && stable(value.brief[key] ?? undefined) !== stable(task.brief?.[key]));
    if (value.objective !== undefined) next.objective = value.objective;
    if (value.brief !== undefined || contractChanged) next.brief = this.nextBrief(task.brief, value.brief ?? {}, contractChanged, next.criterionVersions);
    const scopeChanged = contractChanged || stable(next.brief?.acceptanceCriteria) !== stable(task.brief?.acceptanceCriteria);
    if (scopeChanged && (!value.changeReason || !value.entries?.some(entry => entry.kind === 'scope' && entry.reason))) throw new Error('Task scope changes require changeReason and a scope entry with reason');
    if (scopeChanged && task.status === 'completed' && value.status !== 'active') throw new Error('Completed task scope changes require explicit active rework');
    if (value.status !== undefined) next.status = value.status;
    if (task.status === 'completed' && next.status !== 'completed') {
      if (next.status !== 'active' || !value.changeReason) throw new Error('Reopening a completed Task requires active status and changeReason');
    }
    if (next.status === 'cancelled' && task.status !== 'cancelled' && !value.changeReason) throw new Error('Cancelling a Task requires changeReason');
    for (const key of ['summary', 'blockedReason', 'phase', 'handoff'] as const) {
      const item = value[key]; if (item === null) delete next[key]; else if (item !== undefined) (next as unknown as Record<string, unknown>)[key] = item;
    }
    if (value.questions !== undefined) next.questions = value.questions;
    if (next.status !== 'blocked') delete next.blockedReason;
    if (next.status === 'blocked' && !next.blockedReason) throw new Error('blockedReason is required when a Task is blocked');
    next.artifacts = this.mergeArtifacts(next, task.artifacts.filter(item => item.type !== 'file' || !value.removeArtifacts?.includes(item.path)), value.artifacts ?? []);
    next.references = this.mergeReferences(task.references.filter(item => !value.removeReferences?.includes(item.id)), value.references ?? []);
    const additions = [...(value.entries ?? [])];
    if (task.status !== next.status && (next.status === 'cancelled' || task.status === 'completed')) {
      additions.push({id: `change-${randomUUID()}`, kind: 'decision', content: `${task.status} → ${next.status}`, reason: value.changeReason!});
    }
    next.entries = this.appendEntries(next, additions, now);
    this.validateReferences(next);
    if (next.status === 'completed' && task.status !== 'completed' && value.handoff === undefined) throw new Error('Completion requires refreshed handoff (or null when no remaining work)');
    if (next.status === 'completed') this.validateCompletion(next, task.status !== 'completed', value.entries ?? []);
    return next;
  }
  private nextBrief(current: TaskBrief|undefined, patch: NonNullable<z.output<typeof updateProjectTaskSchema>['brief']>, scopeChanged: boolean, versions: Record<string, number>): TaskBrief {
    const next: TaskBrief = structuredClone(current ?? {});
    for (const key of ['currentBehavior', 'scope', 'constraints', 'outOfScope'] as const) {
      const value = patch[key]; if (value === null) delete next[key]; else if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    const criteria = patch.acceptanceCriteria ?? current?.acceptanceCriteria;
    if (criteria !== undefined) {
      unique(criteria.map(item => item.id), 'criterion');
      next.acceptanceCriteria = criteria.map(item => {
        const old = current?.acceptanceCriteria?.find(previous => previous.id === item.id);
        const version = old ? Math.max(old.version, versions[item.id] ?? 0) + (scopeChanged || old.text !== item.text || old.required !== item.required ? 1 : 0) : (versions[item.id] ?? 0) + 1;
        versions[item.id] = version;
        return {id: item.id, text: item.text, required: item.required, version};
      });
    }
    return next;
  }
  private appendEntries(task: StoredTask, input: TaskEntryInput[], now: string): TaskEntry[] {
    const entries = [...task.entries]; const known = new Set(entries.map(entry => entry.id));
    for (const value of input) {
      if (known.has(value.id)) throw new Error(`Duplicate Task entry id: ${value.id}`);
      if (value.supersedes && !known.has(value.supersedes)) throw new Error('Task supersedes must refer to an existing earlier entry');
      const replaced = value.supersedes ? entries.find(entry => entry.id === value.supersedes) : undefined;
      if (replaced?.kind === 'verification' && (value.kind !== 'verification' || value.verification?.criterionId !== replaced.verification?.criterionId)) throw new Error('Verification can only be superseded by verification for the same criterion');
      if (value.kind === 'scope' && !value.reason) throw new Error('Task scope entry requires reason');
      if (value.kind === 'verification') {
        const check = value.verification; if (!check) throw new Error('Verification entry requires verification details');
        const criterion = task.brief?.acceptanceCriteria?.find(item => item.id === check.criterionId);
        if (!criterion || criterion.version !== check.criterionVersion) throw new Error('Verification must refer to a current criterion id/version');
      } else if (value.verification) throw new Error('Only verification entries may contain verification details');
      if (value.kind === 'completion' && (!value.verificationEntryIds?.length || value.verificationEntryIds.some(id => !entries.some(entry => entry.id === id && entry.kind === 'verification')))) throw new Error('Completion entry must reference saved verification entries');
      entries.push({...value, createdAt: now}); known.add(value.id);
    }
    return entries;
  }
  private validateCompletion(task: StoredTask, entering: boolean, additions: TaskEntryInput[]): void {
    if (!task.summary?.trim()) throw new Error('summary is required when a Task is completed');
    const criteria = task.brief?.acceptanceCriteria ?? [];
    if (!criteria.length) throw new Error('Completion requires at least one acceptance criterion');
    const checks = taskVerifications(task); const superseded = new Set(task.entries.flatMap(entry => entry.supersedes ? [entry.supersedes] : []));
    const completion = [...task.entries].reverse().find(entry => entry.kind === 'completion' && !superseded.has(entry.id));
    if (!completion || entering && !additions.some(entry => entry.id === completion.id)) throw new Error('Completion requires a new completion entry');
    for (const criterion of criteria) {
      if (!criterion.required) continue;
      const verification = checks[criterion.id];
      if (verification?.verification?.result !== 'passed') throw new Error(`Required criterion is not passed: ${criterion.id} v${criterion.version}; explicitly reopen before saving failed verification`);
      if (!completion.verificationEntryIds?.includes(verification.id)) throw new Error(`Completion must reference current verification: ${verification.id}`);
    }
  }
  private validateReferences(task: StoredTask): void {
    unique(task.references.map(item => item.id), 'reference'); const ids = new Set(task.references.map(item => item.id));
    for (const id of [...(task.handoff?.readBefore ?? []), ...task.entries.flatMap(entry => entry.referenceIds ?? [])]) if (!ids.has(id)) throw new Error(`Unknown Task reference: ${id}`);
  }
  private mergeReferences(current: TaskReference[], additions: TaskReference[]): TaskReference[] {
    const result = [...current];
    for (const reference of additions) {
      referenceSchema.parse(reference);
      const previous = result.findIndex(item => item.id === reference.id);
      if (previous >= 0) result[previous] = reference; else result.push(reference);
    }
    if (result.length > 200) throw new Error('Too many references'); return result;
  }
  private mergeArtifacts(task: StoredTask, current: ProjectArtifact[], additions: NonNullable<UpdateProjectTask['artifacts']>): ProjectArtifact[] {
    const result = [...current];
    for (const input of additions) {
      let artifact: ProjectArtifact;
      if (input.type === 'file') {
        const target = this.taskFile(task.directory, input.path);
        if ('source' in input) {
          const source = this.sourceFile(input.source);
          if (!statSync(source).isFile() || statSync(source).size > MAX_ARTIFACT_BYTES) throw new Error('Artifact source is not a file or exceeds 32 MiB');
          if (existsSync(target)) {
            if (!statSync(target).isFile() || statSync(target).size > MAX_ARTIFACT_BYTES || hash(readFileSync(target)) !== hash(readFileSync(source))) throw new Error('Artifact snapshot already exists with different content; use a new path');
          } else if (!this.pendingCopies.some(copy => copy.target === target)) this.pendingCopies.push({source, target});
          else throw new Error('Duplicate artifact copy destination');
        }
        if (!this.pendingCopies.some(copy => copy.target === target) && (!existsSync(target) || !statSync(target).isFile() || statSync(target).size > MAX_ARTIFACT_BYTES)) throw new Error('Task artifact file is missing or exceeds 32 MiB');
        artifact = {type: 'file', path: portablePath(relative(dirname(this.recordPath(task.directory)), target)), ...(input.description ? {description: input.description} : {})};
      } else artifact = artifactSchema.parse(input);
      const index = result.findIndex(item => artifactKey(item) === artifactKey(artifact));
      if (index >= 0) result[index] = artifact; else result.push(artifact);
    }
    if (result.length > MAX_ARTIFACTS) throw new Error('Too many artifacts'); return result;
  }
  private result(task: StoredTask, replayed: boolean): TaskMutationResult {return {task: publicTask(task), taskCommitted: true, replayed, diagnostics: []};}
  private replay(task: StoredTask, key: string, fingerprint: string): TaskMutationResult {
    if (task.operations[key]!.fingerprint !== fingerprint) throw new TaskStoreError('operation-conflict', 'Task operationId conflicts with different content');
    return this.result(task, true);
  }
  private readDirectory(directory: string): StoredTask {
    const task = decodeTask(this.recordPath(directory));
    if (task.directory !== directory) throw new Error('Task directory does not match record');
    return task;
  }
  private readTask(id: string): StoredTask {
    taskIdSchema.parse(id); const found: StoredTask[] = [];
    for (const directory of this.taskDirectories().slice(0, MAX_TASKS)) {
      try {const task = this.readDirectory(directory); if (task.id === id) found.push(task);} catch { /* Other damaged tasks do not block this one. */ }
    }
    if (found.length > 1) throw new TaskStoreError('invalid-task', 'Duplicate task identity', 422);
    if (!found[0]) throw new TaskStoreError('task-not-found', 'Task was not found', 404);
    return found[0];
  }
  private findOperation(key: string): StoredTask|undefined {
    for (const task of this.list().tasks) {const stored = this.readDirectory(task.directory); if (stored.operations[key]) return stored;} return undefined;
  }
  private expectRevision(task: StoredTask, expected: string): void {if (task.revision !== expected) throw new TaskStoreError('revision-conflict', 'Task revision conflict; read again');}
  private lock<T>(work: () => T): T {this.assertStorageBoundary(); return withTaskWriteLock(join(this.layout.tasks, '.write-lock'), work);}
  private assertStorageBoundary(): void {if (lstatSync(this.layout.tasks).isSymbolicLink() || realpathSync(this.layout.tasks) !== this.layout.tasks) throw new TaskStoreError('invalid-storage', 'Task storage must remain in this project', 422);}
  private taskDirectories(): string[] {this.assertStorageBoundary(); return readdirSync(this.layout.tasks, {withFileTypes: true}).filter(item => !item.name.startsWith('.') && (item.isDirectory() || item.isSymbolicLink())).map(item => item.name).sort();}
  private recordPath(directory: string): string {
    this.assertStorageBoundary(); directorySchema.parse(directory); const root = join(this.layout.tasks, directory);
    if (existsSync(root) && (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root)) throw new TaskStoreError('invalid-storage', 'Task directory cannot be a symbolic link', 422);
    return join(root, 'task.md');
  }
  private now(): string {const value = this.clock(); if (Number.isNaN(value.getTime())) throw new Error('Invalid clock'); return value.toISOString();}
}
