import {realpathSync, statSync} from 'node:fs';
import {ProjectHttpError} from './http.ts';
import type {ProjectView} from './project.ts';
import type {ProjectTaskStore} from './tasks.ts';
import {ResourceGitError, runResourceGit, type GitRun} from './resource-git.ts';
import type {ResourceGitAuthentication} from './resource-auth.ts';
import {repositoryIdentity, type TaskCommitRequest, type TaskCommitPreview, type TaskCommitFile, type TaskCommitDiff, type TaskCommitChange} from './task-commit-contract.ts';

const MAX_BLOB = 256 * 1024;
const MAX_FILES = 2000;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function fail(code: string, status = 409): never {throw new ProjectHttpError(status, code);}
interface FileObjects extends TaskCommitFile {oldObject: string; newObject: string}

/** NUL-delimited raw records preserve spaces, tabs, newlines and renamed paths. */
function filesFromRaw(raw: string): FileObjects[] {
  const fields = raw.split('\0'); const files: FileObjects[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRTC])\d*$/.exec(fields[i++]!);
    if (!match || !oid.test(match[3]!) || !oid.test(match[4]!)) fail('task-commit-failed');
    const first = fields[i++]; const renamed = match[5] === 'R' || match[5] === 'C';
    const path = renamed ? fields[i++] : first;
    if (!first || !path || files.length >= MAX_FILES) fail('task-commit-too-large', 413);
    files.push({index: files.length, path, ...(renamed ? {previousPath: first} : {}), status: match[5] as FileObjects['status'],
      oldMode: match[1]!, newMode: match[2]!, oldObject: match[3]!, newObject: match[4]!});
  }
  return files;
}

/** Git supplies zero-context fragments so stable and beta DiffBlock count only actual edits. */
function changesFromPatch(patch: string): TaskCommitChange[] {
  const changes: TaskCommitChange[] = []; let current: TaskCommitChange | undefined;
  let old: string[] = [], next: string[] = [];
  const finish = () => {
    if (current) changes.push({...current, oldText: old.length ? old.join('\n') + '\n' : null, newText: next.length ? next.join('\n') + '\n' : ''});
    old = []; next = [];
  };
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {finish(); current = {oldLine: Number(hunk[1]), newLine: Number(hunk[2]), oldText: null, newText: ''};}
    else if (current && line.startsWith('-')) old.push(line.slice(1));
    else if (current && line.startsWith('+')) next.push(line.slice(1));
  }
  finish(); return changes;
}
const lineCount = (text: string) => text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;

/** Task identity grants access to one recorded commit in a registered project resource. */
export class TaskCommitReader {
  private jobs = new Map<AbortController, Promise<TaskCommitPreview>>();
  private closing = false;
  constructor(private read: () => ProjectView, private store: () => ProjectTaskStore, private run: GitRun = runResourceGit,
    private auth?: ResourceGitAuthentication) {}

  private target(request: TaskCommitRequest) {
    if (this.closing) fail('project-closing', 503);
    const project = this.read(); const task = this.store().get(request.id);
    if (task.revision !== request.revision) fail('task-revision-conflict');
    const artifact = task.artifacts[request.index];
    if (!artifact || artifact.type !== 'commit') fail('task-commit-unavailable', 404);
    const identity = repositoryIdentity(artifact.repository);
    const candidates = project.resources.filter(item => item.type === 'git' && item.url && identity && repositoryIdentity(item.url) === identity);
    if (candidates.length > 1) fail('task-commit-resource-ambiguous');
    const resource = candidates[0];
    if (!resource?.path || !resource.url || resource.status !== 'ready') fail('task-commit-resource-unavailable', 404);
    const path = realpathSync(resource.path); const stat = statSync(path);
    return {project, artifact, resource, path, identity, key: JSON.stringify([project.id, project.root, resource.id, path, resource.url, stat.dev, stat.ino, artifact.commit])};
  }

  preview(request: TaskCommitRequest, options: {file?: number; fetch?: boolean; signal?: AbortSignal} = {}): Promise<TaskCommitPreview> {
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
    const job = this.execute(request, {...options, signal}).catch(error => {
      if (error instanceof ResourceGitError || error instanceof ProjectHttpError) {
        if (error.code === 'git-host-unverified') fail('task-commit-host-unverified');
        if (error.code === 'git-auth-remote-changed') fail('task-commit-auth-remote-changed');
        if (error.code.startsWith('git-auth-')) fail('task-commit-auth');
      }
      if (error instanceof ProjectHttpError) throw error;
      if (error instanceof ResourceGitError) {
        const code = error.code === 'git-unavailable' ? 'task-commit-no-git'
          : error.code === 'git-sync-timeout' ? 'task-commit-timeout' : error.code === 'git-output-too-large' ? 'task-commit-too-large' : 'task-commit-failed';
        fail(code);
      }
      throw error;
    }).finally(() => {this.jobs.delete(abort);});
    this.jobs.set(abort, job); return job;
  }

  private async execute(request: TaskCommitRequest, options: {file?: number; fetch?: boolean; signal: AbortSignal}): Promise<TaskCommitPreview> {
    const target = this.target(request);
    const current = () => {
      options.signal.throwIfAborted();
      if (this.target(request).key !== target.key) fail('task-commit-state-changed');
    };
    const run = async (args: string[], raw = false) => {
      current();
      const runOptions = {signal: options.signal, sync: true, literalObjects: true, raw, timeoutMs: args.includes('fetch') ? 60_000 : 10_000};
      const result = args.includes('fetch') && this.auth
        ? await this.auth.run(this.run, args, target.path, runOptions, {url: target.resource.url!, name: target.resource.name, action: 'commit'}, true, current)
        : await this.run(args, target.path, runOptions);
      current(); return result;
    };
    const assertOrigin = async () => {
      if (realpathSync.native(await run(['rev-parse', '--show-toplevel'])) !== realpathSync.native(target.path)) fail('task-commit-resource-unavailable');
      if (repositoryIdentity(await run(['remote', 'get-url', 'origin'])) !== target.identity) fail('task-commit-origin-mismatch');
    };
    await assertOrigin();
    const commit = target.artifact.commit;
    if (options.fetch) {
      const shallow = await run(['rev-parse', '--is-shallow-repository']) === 'true';
      try {
        // Download only the recorded object/history. No destination ref, FETCH_HEAD, checkout, hooks or maintenance.
        await run(['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--refmap=',
          ...(shallow ? ['--depth=2'] : []), '--', target.resource.url!, commit]);
      } catch (error) {
        if (error instanceof ResourceGitError && error.code === 'git-sync-failed') fail('task-commit-fetch-failed');
        throw error;
      }
      await assertOrigin();
    }
    const result: TaskCommitPreview = {state: 'missing', repository: target.artifact.repository, resourceName: target.resource.name, commit, parents: [], files: []};
    // Missing objects stay local failures; the runner disables partial-clone lazy fetches.
    const present = async (hash: string) => {
      try {return await run(['cat-file', '-t', hash]) === 'commit';}
      catch (error) {if (error instanceof ResourceGitError && error.code === 'git-sync-failed') return false; throw error;}
    };
    if (!await present(commit)) return result;
    if (Number(await run(['cat-file', '-s', commit])) > 128 * 1024) fail('task-commit-too-large', 413);
    const object = await run(['cat-file', 'commit', commit], true);
    const boundary = object.indexOf('\n\n'); if (boundary < 0) fail('task-commit-failed');
    const headers = object.slice(0, boundary).split('\n');
    result.parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    if (result.parents.some(parent => !oid.test(parent))) fail('task-commit-failed');
    const author = /^author (.*) <[^>]*> (\d+) [+-]\d{4}$/.exec(headers.find(line => line.startsWith('author ')) ?? '');
    result.author = author?.[1];
    const timestamp = author ? new Date(Number(author[2]) * 1000) : undefined;
    result.authoredAt = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
    result.message = object.slice(boundary + 2).trimEnd();
    if (result.parents[0] && !await present(result.parents[0])) {result.state = 'parent-missing'; return result;}
    const files = filesFromRaw(await run(['-c', 'diff.renameLimit=1000', 'diff-tree', '--root', '--no-commit-id', '-r', '--raw', '-z', '--no-abbrev', '-M',
      '--no-ext-diff', '--no-textconv', ...(result.parents[0] ? [result.parents[0], commit] : [commit]), '--'], true));
    result.state = 'ready'; result.files = files.map(({oldObject, newObject, ...file}) => file);
    if (options.file !== undefined) {
      const file = files[options.file]; if (!file) fail('task-commit-unavailable', 404);
      result.diff = await this.diff(file, run);
    }
    await assertOrigin(); return result;
  }

  private async diff(file: FileObjects, run: (args: string[], raw?: boolean) => Promise<string>): Promise<TaskCommitDiff> {
    const result: TaskCommitDiff = {kind: 'text', changes: [], added: 0, removed: 0, oldObject: file.oldObject, newObject: file.newObject};
    if (file.oldMode === '160000' || file.newMode === '160000') return {...result, kind: 'submodule'};
    const oldExists = !/^0+$/.test(file.oldObject); const newExists = !/^0+$/.test(file.newObject);
    for (const hash of [oldExists && file.oldObject, newExists && file.newObject]) {
      if (hash && Number(await run(['cat-file', '-s', hash])) > MAX_BLOB) return {...result, kind: 'large'};
    }
    const oldText = oldExists ? await run(['cat-file', 'blob', file.oldObject], true) : '';
    const newText = newExists ? await run(['cat-file', 'blob', file.newObject], true) : '';
    if (/[\0\uFFFD]/.test(oldText + newText)) return {...result, kind: 'binary'};
    result.oldNoNewline = oldText !== '' && !oldText.endsWith('\n');
    result.newNoNewline = newText !== '' && !newText.endsWith('\n');
    if (oldExists && newExists && oldText !== newText) {
      result.changes = changesFromPatch(await run(['-c', 'diff.algorithm=myers', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text',
        '--unified=0', '--inter-hunk-context=0', file.oldObject, file.newObject, '--'], true));
    } else if (oldText !== newText) result.changes = [{oldLine: oldExists ? 1 : 0, newLine: newExists ? 1 : 0, oldText: oldExists ? oldText : null, newText}];
    if (result.changes.length > 200) return {...result, kind: 'large', changes: []};
    result.added = result.changes.reduce((sum, change) => sum + lineCount(change.newText), 0);
    result.removed = result.changes.reduce((sum, change) => sum + lineCount(change.oldText ?? ''), 0);
    return result;
  }

  async dispose(): Promise<void> {
    this.closing = true; for (const abort of this.jobs.keys()) abort.abort();
    await Promise.allSettled([...this.jobs.values()]);
  }
}
