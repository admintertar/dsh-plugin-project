import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import type {BoundActions} from '@deepseek-ai/dsh-client-store';
import type {TextStore} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client';
import type {TaskFilePreview} from '../src/api-types.ts';
import {taskPreviewReads, type TaskPreviewRequest} from '../src/client/task-preview.tsx';

const request: TaskPreviewRequest = {id: 'task-1', revision: 'a'.repeat(64), kind: 'artifact', index: 0, path: 'artifacts/report.md'};
const file = (text: string): TaskFilePreview => ({name: 'report.md', extension: '.md', mime: 'text/plain', text, version: text, size: text.length});
const flush = () => new Promise(resolve => setImmediate(resolve));
function recorder() {
  const events: Array<[string, ...unknown[]]> = [];
  const actions = new Proxy({}, {get: (_, key) => (...args: unknown[]) => {events.push([String(key), ...args]);}}) as BoundActions<TextStore>;
  return {events, actions};
}

test('official preview reads use explicit Task authority; newer reloads and closed tabs discard stale responses', async () => {
  const pending: Array<{resolve(value: TaskFilePreview): void; signal: AbortSignal}> = [];
  const {events, actions} = recorder();
  const reads = taskPreviewReads({taskFile: (...args) => {
    assert.deepEqual(args.slice(0, 4), ['task-1', 'artifact', 0, request.revision]);
    return new Promise(resolve => pending.push({resolve, signal: args[4]!}));
  }}, request, actions);
  const lifetime = new AbortController(); const tab = 'preview-1' as never; const ignoredSession = {sessionId: 'must-not-reach-host' as never, path: '/private/other'};
  reads.loadPage(tab, ignoredSession, 1, lifetime.signal);
  reads.reloadPages(tab, ignoredSession, lifetime.signal);
  assert.equal(pending[0]!.signal.aborted, true);
  pending[1]!.resolve(file('new\n')); await flush(); pending[0]!.resolve(file('old')); await flush();
  assert.equal(events.filter(event => event[0] === 'page').length, 1);
  assert.equal((events.find(event => event[0] === 'page')![2] as {text: string}).text, 'new');
  reads.reloadPages(tab, ignoredSession, lifetime.signal); lifetime.abort(); pending[2]!.resolve(file('late')); await flush();
  assert.equal(pending[2]!.signal.aborted, true); assert.equal(events.filter(event => event[0] === 'page').length, 1);
  reads.dispose();
});

test('official text and binary modes receive complete content and declared failures', async () => {
  const {events, actions} = recorder(); let result = file('');
  const reads = taskPreviewReads({taskFile: async () => result}, request, actions);
  const lifetime = new AbortController(); const tab = 'preview-1' as never; const source = {sessionId: 'ui-only' as never, path: request.path};
  reads.loadPage(tab, source, 1, lifetime.signal); await flush();
  assert.equal((events.find(event => event[0] === 'page')![2] as {lines: number}).lines, 0);
  result = {...file(''), text: undefined, base64: Buffer.from([0, 1, 2]).toString('base64')};
  reads.loadAll(tab, source, lifetime.signal); await flush();
  assert.deepEqual([...((events.find(event => event[0] === 'complete')![2] as {data: Uint8Array}).data)], [0, 1, 2]);
  reads.loadPage(tab, source, 1, lifetime.signal); await flush();
  assert.equal((events.find(event => event[0] === 'failed')![2] as {code: string}).code, 'workspace-file/not-text');
  lifetime.abort(); reads.dispose();
});
