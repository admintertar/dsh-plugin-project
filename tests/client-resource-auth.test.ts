import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {ResourceAuthController} from '../src/client/resource-auth-controller.ts';
const request = {id: 'request', kind: 'https', action: 'clone', url: 'https://example.com/private.git', name: 'Private', retry: false};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

test('a late authentication poll cannot reopen an answered prompt or retain its credentials', async () => {
  let old!: (response: Response) => void; let reads = 0; let submitted: unknown;
  const controller = new ResourceAuthController((async (_url, init) => {
    if (init?.method === 'POST') {submitted = JSON.parse(init.body as string); return response({requests: []});}
    if (++reads === 2) return new Promise<Response>(resolve => {old = resolve;});
    return response({requests: [request]});
  }) as typeof fetch);
  try {
    await controller.refresh(); const poll = controller.refresh();
    assert.equal(await controller.answer(request.id, {kind: 'https', username: 'user', password: 'private-fixture'}), true);
    assert.deepEqual(submitted, {id: request.id, credential: {kind: 'https', username: 'user', password: 'private-fixture'}});
    old(response({requests: [request]})); await poll;
    assert.deepEqual(controller.getSnapshot().requests, []);
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private-fixture/);
  } finally {controller.dispose();}
});

test('invalid key input retains the prompt with a fixed error and dismissal sends no credentials', async () => {
  let cancelling = false;
  const controller = new ResourceAuthController((async (_url, init) => {
    if (init?.method !== 'POST') return response({requests: [request]});
    if (!cancelling) return response({error: 'git-key-invalid'}, 422);
    assert.deepEqual(JSON.parse(init.body as string), {id: request.id, credential: null}); return response({requests: []});
  }) as typeof fetch);
  try {
    await controller.refresh();
    assert.equal(await controller.answer(request.id, {kind: 'ssh', keyPath: '/missing', passphrase: 'private-fixture'}), false);
    assert.equal(controller.getSnapshot().requests.length, 1); assert.equal(controller.getSnapshot().error, 'git-key-invalid');
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private-fixture/);
    cancelling = true; assert.equal(await controller.answer(request.id, null), true);
    assert.equal(controller.getSnapshot().requests.length, 0);
  } finally {controller.dispose();}
});
