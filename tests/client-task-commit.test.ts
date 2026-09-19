import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {TaskCommitView, type TaskCommitPreviewRequest} from '../src/client/task-commit-view.ts';
import {ProjectCapabilityController} from '../src/client/controller.ts';
import type {TaskCommitPreview} from '../src/task-commit-contract.ts';

const request: TaskCommitPreviewRequest = {id: 'task', index: 0, revision: 'a'.repeat(64), kind: 'commit', repository: 'https://example.com/repo', commit: 'b'.repeat(40), title: 'Code'};
const preview: TaskCommitPreview = {state: 'ready', repository: request.repository, resourceName: 'Repo', commit: request.commit, parents: [],
  files: [0, 1].map(index => ({index, path: `${index}.ts`, status: 'M', oldMode: '100644', newMode: '100644'}))};
const diff = {kind: 'text', changes: [], added: 0, removed: 0, oldObject: 'c'.repeat(40), newObject: 'd'.repeat(40)} as const;

test('commit file selection discards late replies, retains tab state, scopes failures and cancels on close', async () => {
  const pending: Array<{file?: number; signal: AbortSignal; resolve(value: TaskCommitPreview): void; reject(error: Error): void}> = [];
  const view = new TaskCommitView(request, (_request, options) => new Promise((resolve, reject) => pending.push({...options, resolve, reject})));
  const load = view.load(); pending[0]!.resolve(preview); await load;
  const a = view.select(0), b = view.select(1);
  assert.equal(pending[1]!.signal.aborted, true);
  pending[2]!.resolve({...preview, diff: {...diff, changes: []}}); await b;
  pending[1]!.resolve({...preview, diff: {...diff, changes: [], added: 500}}); await a;
  assert.equal(view.getSnapshot().selected, 1); assert.equal(view.getSnapshot().diff?.added, 0);
  await view.select(1); await view.select(1); assert.equal(pending.length, 3, 'Reopening a file uses this tab’s cache');
  const failure = view.select(0); pending[3]!.reject(new Error('task-commit-state-changed')); await failure;
  assert.equal(view.getSnapshot().error, undefined); assert.equal(view.getSnapshot().fileError, 'task-commit-state-changed');
  const retry = view.retryFile(); assert.equal(view.getSnapshot().fileError, undefined);
  view.dispose(); assert.equal(pending[4]!.signal.aborted, true); pending[4]!.resolve({...preview, diff: {...diff, changes: []}}); await retry;
  assert.equal(view.getSnapshot().diff, undefined);
});

test('commit preview uses explicit Task requests and per-tab lifetimes without a Session or arbitrary Git arguments', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const controller = new ProjectCapabilityController((async (url, init) => {calls.push({url: String(url), init}); return Response.json(preview);}) as typeof fetch);
  const lifetime = new AbortController();
  try {
    const view = controller.taskCommitView(request, lifetime.signal);
    await view.load();
    assert.equal(controller.taskCommitView(request, lifetime.signal), view);
    const url = new URL(calls[0]!.url, 'http://fixture');
    assert.deepEqual(Object.fromEntries(url.searchParams), {id: 'task', index: '0', revision: request.revision});
    await view.load(true);
    assert.equal(calls[1]!.url, '/api/project/tasks/commit/fetch'); assert.equal(calls[1]!.init?.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1]!.init?.body as string), {id: 'task', index: 0, revision: request.revision});
    lifetime.abort(); await view.load(); assert.equal(calls.length, 2);
    assert.notEqual(controller.taskCommitView(request, new AbortController().signal), view);
  } finally {controller.dispose();}
});
