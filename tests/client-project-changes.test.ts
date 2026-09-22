import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {ProjectChangesController} from '../src/client/project-changes-controller.ts';

const snapshot = {revision: 'a'.repeat(64), available: true, entries: []};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
/** A fetch double that holds the write open until the test releases it. */
function holding(actions: string[], gate: {promise: Promise<void>}) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as {action?: string};
    if (body?.action !== undefined) {actions.push(body.action); await gate.promise;}
    const payload = body?.action === undefined ? snapshot : {accepted: true};
    return new Response(JSON.stringify(payload), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

test('the changes controller reports a commit while it is in flight', async () => {
  const gate = deferred(); const actions: string[] = [];
  const controller = new ProjectChangesController(holding(actions, gate));
  await controller.refresh();
  const pending = controller.commit([{id: 'task:Alpha', kind: 'task', paths: ['tasks/Alpha'], message: 'feat(task): record "Alpha"'}]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.getSnapshot().pending, true);
  assert.equal(controller.getSnapshot().action, 'commit');
  gate.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(actions, ['commit']);
  assert.equal(controller.getSnapshot().pending, false);
  assert.equal(controller.getSnapshot().action, undefined);
  controller.dispose();
});

test('the changes controller names the repository action it is waiting for', async () => {
  const gate = deferred(); const actions: string[] = [];
  const controller = new ProjectChangesController(holding(actions, gate));
  const pending = controller.sync('check', snapshot.revision);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.getSnapshot().action, 'check');
  gate.resolve();
  assert.deepEqual(await pending, {accepted: true});
  assert.deepEqual(actions, ['check']);
  assert.equal(controller.getSnapshot().action, undefined);
  controller.dispose();
});

test('the changes controller sends a repository update, so new remote commits can be applied', async () => {
  const bodies: Record<string, unknown>[] = []; const gate = deferred();
  const controller = new ProjectChangesController(async (_input, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (body !== undefined) {bodies.push(body); await gate.promise;}
    return new Response(JSON.stringify(body === undefined ? snapshot : {accepted: true}), {status: 200, headers: {'content-type': 'application/json'}});
  });
  await controller.refresh();
  const updating = controller.sync('update', snapshot.revision);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.getSnapshot().action, 'update');
  gate.resolve();
  assert.deepEqual(await updating, {accepted: true});
  assert.deepEqual(bodies, [{action: 'update', expectedRevision: snapshot.revision}]);
  controller.dispose();
});

test('a repository update reports a merge it could not complete, with the conflicting files', async () => {
  const reply = {revision: snapshot.revision, available: true, entries: [],
    merge: {status: 'conflict', files: ['tasks/Alpha/task.md', 'skills/index.yaml']}};
  const controller = new ProjectChangesController(async (_input, init) => new Response(
    JSON.stringify(init?.method === 'POST' ? reply : snapshot), {status: 200, headers: {'content-type': 'application/json'}}));
  await controller.refresh();
  const result = await controller.sync('update', snapshot.revision);
  assert.deepEqual(result?.merge, {status: 'conflict', files: ['tasks/Alpha/task.md', 'skills/index.yaml']});
  // A conflict is an outcome, not a page error: the panel must not report a failed action.
  assert.equal(controller.getSnapshot().error, undefined);
  controller.dispose();
});
