import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {ResourceController} from '../src/client/resource-controller.ts';
import {detectedResourceType} from '../src/client/resource-ui.ts';

const empty = {revision: 'a'.repeat(64), version: 'initial', resources: [], operations: [], canPick: true, pickSource: 'native', canClone: true};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

test('a picked Git working tree defaults to the Git resource type, with or without an origin', () => {
  assert.equal(detectedResourceType({path: '/tmp/repo', name: 'repo', external: true, git: {branch: 'main'}}), 'git');
  assert.equal(detectedResourceType({path: '/tmp/repo', name: 'repo', external: true,
    git: {url: 'https://example.com/repo.git', branch: 'main'}}), 'git');
  assert.equal(detectedResourceType({path: '/tmp/folder', name: 'folder', external: true}), 'local');
  assert.equal(detectedResourceType(undefined), 'local');
});

test('resource controller retains a successful snapshot on error and ignores late GETs after mutation', async () => {
  let resolveOld!: (value: Response) => void; let fail = false; let calls = 0; let changed = 0;
  const controller = new ResourceController(() => {changed++;}, (async (_url, init) => {
    if (fail) return response({error: 'private-fixture'}, 422);
    if (init?.method === 'POST') return response({...empty, revision: 'b'.repeat(64), version: 'saved'});
    if (++calls === 2) return new Promise(resolve => {resolveOld = resolve;});
    return response({...empty, revision: calls > 2 ? 'b'.repeat(64) : empty.revision, version: calls > 2 ? 'fresh' : 'initial'});
  }) as typeof fetch);
  try {
    await controller.refresh(); const old = controller.refresh();
    assert.equal(await controller.mutate({action: 'remove', id: 'root', expectedRevision: empty.revision}), true);
    resolveOld(response({...empty, version: 'stale'})); await old;
    assert.equal(controller.getSnapshot().data?.version, 'fresh');
    assert.ok(changed >= 2);
    fail = true; await controller.refresh();
    assert.equal(controller.getSnapshot().error, 'operation-failed');
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private-fixture/);
    assert.equal(controller.getSnapshot().data?.version, 'fresh');
  } finally {controller.dispose();}
});

test('resource controller blocks duplicate item mutations, preserves errors for draft review and aborts on disposal', async () => {
  let finish!: (value: Response) => void; let signal: AbortSignal | undefined;
  const controller = new ResourceController(() => {}, (async (_url, init) => {
    if (init?.method === 'POST') {signal = init.signal as AbortSignal; return new Promise(resolve => {finish = resolve;});}
    return response(empty);
  }) as typeof fetch);
  await controller.refresh();
  const first = controller.mutate({action: 'remove', id: 'root', expectedRevision: empty.revision});
  assert.equal(await controller.mutate({action: 'remove', id: 'root', expectedRevision: empty.revision}), false);
  finish(response({error: 'revision-conflict'}, 409)); assert.equal(await first, false);
  assert.equal(controller.getSnapshot().error, 'revision-conflict');
  controller.clearError(); assert.equal(controller.getSnapshot().error, undefined);
  const next = controller.mutate({action: 'remove', id: 'root', expectedRevision: empty.revision});
  controller.dispose(); assert.equal(signal?.aborted, true); finish(response(empty));
  assert.equal(await next, false);
});

test('resource sync requests are independent and failures remain on the affected resource until retry', async () => {
  const data = {...empty, resources: ['a', 'b'].map(id => ({id, name: id, type: 'git', status: 'ready'}))};
  const replies = new Map<string, (value: Response) => void>();
  const controller = new ResourceController(() => {}, (async (_url, init) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => {replies.set(JSON.parse(init.body as string).id, resolve);});
    return response(data);
  }) as typeof fetch);
  try {
    await controller.refresh();
    const a = controller.sync('a', 'check', empty.revision); const b = controller.sync('b', 'check', empty.revision);
    assert.deepEqual(controller.getSnapshot().pending, ['a', 'b']);
    assert.equal(await controller.sync('a', 'check', empty.revision), false);
    replies.get('b')!(response({error: 'revision-conflict'}, 409)); assert.equal(await b, false);
    assert.equal(controller.getSnapshot().error, undefined);
    assert.equal(controller.getSnapshot().syncErrors.b, 'revision-conflict');
    replies.get('a')!(response({accepted: true})); assert.equal(await a, true);
    assert.equal(controller.getSnapshot().syncErrors.a, undefined); assert.equal(controller.getSnapshot().syncErrors.b, 'revision-conflict');
    const retry = controller.sync('b', 'check', empty.revision);
    assert.equal(controller.getSnapshot().syncErrors.b, undefined);
    replies.get('b')!(response({accepted: true})); assert.equal(await retry, true);
    assert.equal(controller.getSnapshot().error, undefined); assert.deepEqual(controller.getSnapshot().syncErrors, {});
    const raced = controller.sync('a', 'update', empty.revision);
    replies.get('a')!(response({error: 'git-sync-busy'}, 409)); assert.equal(await raced, false);
    assert.equal(controller.getSnapshot().syncErrors.a, undefined, 'A fresh snapshot replaces transient duplicate-operation errors');
  } finally {controller.dispose();}
});

test('commit carries the message, switch carries the branch and branch reads stay out of the snapshot', async () => {
  const bodies: Record<string, unknown>[] = []; const urls: string[] = [];
  const controller = new ResourceController(() => {}, (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url).includes('/branches')) return response({current: 'main', local: ['main', 'work'], remote: ['feature', 'main'], remoteName: 'origin'});
    if (String(url).includes('/changes')) return response({files: [{path: 'README.md', status: 'modified'}, {path: 'new.txt', status: 'untracked'}]});
    if (init?.method === 'POST') {bodies.push(JSON.parse(String(init.body))); return response({accepted: true});}
    return response(empty);
  }) as unknown as typeof fetch);
  try {
    assert.equal(await controller.sync('root', 'commit', empty.revision, 'panel commit'), true);
    assert.equal(await controller.sync('root', 'switch', empty.revision, undefined, 'work'), true);
    assert.equal(await controller.sync('root', 'push', empty.revision), true);
    assert.deepEqual(bodies[0], {id: 'root', action: 'commit', expectedRevision: empty.revision, message: 'panel commit'});
    assert.deepEqual(bodies[1], {id: 'root', action: 'switch', expectedRevision: empty.revision, branch: 'work'});
    // Push takes neither, so the request must not carry an empty message or branch.
    assert.deepEqual(bodies[2], {id: 'root', action: 'push', expectedRevision: empty.revision});
    const branches = await controller.branches('root');
    assert.equal(branches?.current, 'main'); assert.deepEqual(branches?.local, ['main', 'work']); assert.deepEqual(branches?.remote, ['feature', 'main']);
    assert.ok(urls.some(url => url.endsWith('/branches?id=root')), 'the branch read is a plain GET by resource id');
    const changes = await controller.changes('root');
    assert.deepEqual(changes?.files, [{path: 'README.md', status: 'modified'}, {path: 'new.txt', status: 'untracked'}]);
    assert.ok(urls.some(url => url.endsWith('/changes?id=root')), 'the change list is a plain GET by resource id');
    assert.equal(controller.getSnapshot().pending.length, 0);
  } finally {controller.dispose();}
});
