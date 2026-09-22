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
  const pending = controller.commit([{paths: ['tasks/Alpha'], message: 'feat(task): record "Alpha"'}]);
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
  assert.equal(await pending, true);
  assert.deepEqual(actions, ['check']);
  assert.equal(controller.getSnapshot().action, undefined);
  controller.dispose();
});
