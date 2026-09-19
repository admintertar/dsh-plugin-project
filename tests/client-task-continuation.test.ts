import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {TaskContinuationController, type TaskContinuationDependencies} from '../src/client/task-continuation.ts';

const task = {id: 'task-a', title: 'Continue work', status: 'active'};
function fixture(overrides: Partial<TaskContinuationDependencies> = {}) {
  const events: string[] = [];
  let draft = '';
  const navigation = new AbortController();
  let sequence = 0;
  const dependencies: TaskContinuationDependencies = {
    project: () => ({id: 'project', root: '/project'}),
    beginNavigation: () => navigation.signal,
    createSession: async (_root, id) => {events.push(`create:${id}`);},
    readTask: async id => {events.push(`read:${id}`); return task;},
    input: () => ({draft: () => draft, setDraft: value => {draft = value; events.push('draft');}}),
    draft: value => `Read ${value.id}, verify the current state, then continue within the existing scope.`,
    openSession: id => {events.push(`open:${id}`);},
    id: () => `id-${++sequence}`,
    ...overrides,
  };
  return {controller: new TaskContinuationController(dependencies), events, navigation,
    getDraft: () => draft, setDraft: (value: string) => {draft = value;}};
}

test('task continuation reads before opening and only prepares an unsent draft', async () => {
  const f = fixture();
  const result = await f.controller.continue(task);
  assert.deepEqual(f.events, ['create:id-1', 'read:task-a', 'draft', 'open:id-1']);
  assert.equal(result.sessionId, 'id-1');
  assert.match(f.getDraft(), /Read task-a/);
});

test('task continuation deduplicates clicks and retries the same Session and task read', async () => {
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => {unblock = resolve;});
  const calls: string[] = [];
  let fail = true;
  const f = fixture({readTask: async id => {
    calls.push(id); await gate;
    if (fail) throw new Error('response-lost');
    return task;
  }});
  const first = f.controller.continue(task);
  const duplicate = f.controller.continue(task);
  assert.equal(first, duplicate);
  unblock();
  await assert.rejects(first, /response-lost/);
  fail = false;
  await f.controller.continue(task);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(f.events, ['create:id-1', 'draft', 'open:id-1']);
});

test('task continuation retries a lost creation response with its preallocated identity', async () => {
  const identities: string[] = [];
  const f = fixture({createSession: async (_root, id) => {
    identities.push(id); if (identities.length === 1) throw new Error('response-lost');
  }});
  await assert.rejects(f.controller.continue(task), /response-lost/);
  await f.controller.continue(task);
  assert.deepEqual(identities, ['id-1', 'id-1']);
});

test('task continuation preserves input typed while reading and ignores stale navigation', async () => {
  const f = fixture({readTask: async id => {
    f.setDraft('My own instructions');
    return task;
  }});
  assert.equal((await f.controller.continue(task)).draftPreserved, true);
  assert.equal(f.getDraft(), 'My own instructions');
  assert.deepEqual(f.events, ['create:id-1', 'open:id-1']);

  const cancelled = fixture({readTask: async id => {
    cancelled.navigation.abort();
    return task;
  }});
  assert.equal((await cancelled.controller.continue(task)).cancelled, true);
  assert.deepEqual(cancelled.events, ['create:id-1']);
  assert.equal(cancelled.getDraft(), '');
});

test('task continuation does not navigate after changing projects', async () => {
  let project = {id: 'one', root: '/one'};
  const changed = fixture({project: () => project, createSession: async () => {project = {id: 'two', root: '/two'};}});
  assert.equal((await changed.controller.continue(task)).cancelled, true);
  assert.deepEqual(changed.events, []);
});

test('task continuation preserves attachment-only and busy composer input', async () => {
  const notices: string[] = [];
  const f = fixture({input: () => ({draft: () => '', canFill: () => false,
    setDraft: () => assert.fail('must not modify an occupied composer'), notifyPreserved: text => notices.push(text)})});
  assert.equal((await f.controller.continue(task)).draftPreserved, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Read task-a/);
  assert.deepEqual(f.events, ['create:id-1', 'read:task-a', 'open:id-1']);
});

test('panel cancellation keeps the prepared Session available for a later retry', async () => {
  const panel = new AbortController();
  let calls = 0;
  const identities: string[] = [];
  const f = fixture({readTask: async id => {
    identities.push(id);
    if (++calls === 1) panel.abort();
    return task;
  }});
  assert.equal((await f.controller.continue(task, panel.signal)).cancelled, true);
  assert.equal(f.getDraft(), '');
  assert.deepEqual(f.events, ['create:id-1']);
  await f.controller.continue(task, new AbortController().signal);
  assert.deepEqual(identities, ['task-a', 'task-a']);
  assert.deepEqual(f.events, ['create:id-1', 'draft', 'open:id-1']);
});

test('continuation refreshes task status before generating the draft', async () => {
  const completed = fixture({readTask: async () => ({...task, status: 'completed'}), draft: record => record.status === 'completed' ? 'Review the completed work' : 'Continue work'});
  await completed.controller.continue(task); assert.equal(completed.getDraft(), 'Review the completed work');
});
