import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createServer, type IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import type {WebRoute} from '@deepseek-ai/dsh-host-webserver';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {registerResourceApi} from '../src/resource-api.ts';
import {ResourceSyncManager} from '../src/resource-sync.ts';
import {ResourceGitError, type GitRun} from '../src/resource-git.ts';
import {ResourceGitAuthentication} from '../src/resource-auth.ts';
import {resourceFixture, gitFixture, localCloneRunner, finishClone} from './fixtures/resources.ts';

async function fixture(override?: (...args: Parameters<GitRun>) => ReturnType<GitRun> | undefined, auth?: ResourceGitAuthentication) {
  const f = resourceFixture(); gitFixture(f.outside);
  const ctx = new Context(); const routes: WebRoute[] = [];
  let native = true;
  ctx.provide('directoryPicker', {capability: () => ({kind: native ? 'native' : 'browse'})});
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = routes.find(route => route.kind === 'exact' ? route.path === path : path.startsWith(route.path + '/'));
    if (!route) {res.writeHead(404); res.end(); return;}
    void route.handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port: number}).port; const origin = `http://127.0.0.1:${port}`;
  ctx.provide('webServer', {port, register: (route: WebRoute) => {routes.push(route); return () => {};}} as unknown as Context['webServer']);
  ctx.provide('connection', {requestRejection: (req: IncomingMessage) => req.headers.authorization === 'fixture' ? undefined : 401} as unknown as Context['connection']);
  const clones = new ResourceCloneManager(f.store, f.runtime, localCloneRunner(f.outside), undefined, auth);
  const sync = new ResourceSyncManager(clones, (args, cwd, options) => override?.(args, cwd, options) ?? clones.run(args, cwd, options), {intervalMs: 0});
  const close = registerResourceApi(ctx, f.store, clones, sync);
  const headers = {authorization: 'fixture', origin, 'content-type': 'application/json'};
  const get = () => fetch(origin + '/api/project/resources', {headers});
  const post = (path: string, body: unknown) => fetch(origin + '/api/project/resources' + path, {method: 'POST', headers, body: JSON.stringify(body)});
  return {...f, ctx, clones, sync, close, get, post, headers, origin, setNative: (value: boolean) => {native = value;}, cleanup: async () => {
    await close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ctx.fiber.dispose(); f.cleanup();
  }};
}

test('resource API authenticates every endpoint and validates native capability, origins, body limits and project scope', async () => {
  const f = await fixture();
  try {
    const revision = f.store.revision();
    for (const path of ['', '/inspect', '/clone', '/sync', '/auth', '/operations/12345678-1234-1234-1234-123456789abc/cancel', '/operations/12345678-1234-1234-1234-123456789abc/register']) {
      const url = f.origin + '/api/project/resources' + path;
      assert.equal((await fetch(url, {method: 'POST'})).status, 401);
      assert.equal((await fetch(url, {method: 'POST', headers: {...f.headers, origin: 'http://evil.invalid'}, body: '{}'})).status, 403);
      assert.equal((await fetch(url, {method: 'POST', headers: f.headers, body: ' '.repeat(65537)})).status, 413);
      assert.equal((await fetch(url, {method: 'DELETE', headers: f.headers})).status, 405);
    }
    assert.equal((await f.post('/operations/12345678-1234-1234-1234-123456789abc/cancel', {})).status, 404);
    assert.equal((await f.post('/sync', {id: 'missing', action: 'update', expectedRevision: revision})).status, 404);
    assert.equal((await f.post('/sync', {id: 'root', action: 'check', expectedRevision: 'a'.repeat(64)})).status, 409);
    f.setNative(false);
    assert.equal((await (await f.get()).json()).canPick, false);
    assert.equal((await f.post('/inspect', {path: f.outside})).status, 409);
    assert.equal((await f.post('', {action: 'addLocal', name: 'No native picker', type: 'local', path: f.outside, expectedRevision: revision})).status, 409);
    assert.equal(f.store.revision(), revision);
    const rejected = await f.post('/clone', {requestId: 'one', expectedRevision: revision, name: 'Secret', path: 'resources/secret', url: 'https://user:private-fixture@example.com/repo'});
    assert.equal(rejected.status, 422); assert.doesNotMatch(await rejected.text(), /private-fixture/);
  } finally {await f.cleanup();}
});

test('authentication API is scoped to live operations, sanitizes invalid input and never echoes submitted secrets', async () => {
  const auth = new ResourceGitAuthentication(); const f = await fixture(undefined, auth);
  const work = auth.run(async (_args, _cwd, options) => {
    if (!options?.auth) throw new ResourceGitError('git-auth-required'); return 'done';
  }, [], f.root, {}, {url: 'https://example.com/private.git', name: 'Private', action: 'clone'}, true, () => {});
  try {
    assert.equal((await fetch(f.origin + '/api/project/resources/auth')).status, 401);
    assert.equal((await fetch(f.origin + '/api/project/resources/auth/keys')).status, 401);
    const snapshot = await (await fetch(f.origin + '/api/project/resources/auth', {headers: f.headers})).json();
    const id = snapshot.requests[0].id;
    const invalid = await f.post('/auth', {id, credential: {kind: 'https', username: 'user', password: 'private-api-fixture\n'}});
    assert.equal(invalid.status, 422); assert.deepEqual(await invalid.json(), {error: 'git-auth-invalid'});
    const ok = await f.post('/auth', {id, credential: {kind: 'https', username: 'user', password: 'private-api-fixture'}});
    assert.equal(ok.status, 200); assert.doesNotMatch(await ok.text(), /private-api-fixture|password|username/);
    assert.equal(await work, 'done');
    assert.equal((await f.post('/auth', {id, credential: null})).status, 409);
  } finally {auth.dispose(); await Promise.allSettled([work]); await f.cleanup();}
});

test('sync API returns before fetch completes, locks the resource and exposes a sanitized result after navigation', async () => {
  let release!: () => void; let started!: () => void;
  const fetching = new Promise<void>(resolve => {started = resolve;});
  const f = await fixture(args => args.includes('fetch') ? new Promise((_resolve, reject) => {
    release = () => reject(new ResourceGitError('git-auth-required')); started();
  }) : undefined);
  try {
    const operation = await f.clones.start({requestId: 'sync', expectedRevision: f.store.revision(), name: 'Backend', url: 'https://example.com/backend.git', path: 'resources/backend'});
    await finishClone(f.clones, operation.id);
    const id = operation.resourceId; const expectedRevision = f.store.revision();
    assert.deepEqual(await (await f.post('/sync', {id, action: 'check', expectedRevision})).json(), {accepted: true});
    await fetching;
    assert.equal((await f.post('', {id, action: 'remove', expectedRevision})).status, 409);
    const active = await (await f.get()).json();
    assert.equal(active.resources.find((item: {id: string}) => item.id === id).git.sync.phase, 'checking');
    release();
    for (let i = 0; i < 100; i++) {
      const data = await (await f.get()).json(); const status = data.resources.find((item: {id: string}) => item.id === id).git.sync;
      if (!status.phase) {assert.equal(status.error, 'git-auth-required'); assert.equal(f.store.revision(), expectedRevision); return;}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Sync did not finish');
  } finally {release?.(); await f.cleanup();}
});

test('resource API updates project data, handles revision conflicts and registers actual local clone fixtures', async () => {
  const f = await fixture();
  try {
    const initial = await (await f.get()).json();
    const inspected = await (await f.post('/inspect', {path: f.outside})).json();
    assert.equal(inspected.path, f.outside);
    const added = await f.post('', {action: 'addLocal', name: 'Outside', type: 'local', path: f.outside, expectedRevision: initial.revision});
    assert.equal(added.status, 200);
    const data = await added.json(); const item = data.resources.find((item: {name: string}) => item.name === 'Outside');
    const stale = await f.post('', {action: 'edit', id: item.id, name: 'Stale', expectedRevision: initial.revision});
    assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), {error: 'revision-conflict'});
    assert.equal((await f.post('', {action: 'remove', id: item.id, expectedRevision: data.revision})).status, 200);
    const clone = await f.post('/clone', {requestId: 'one', expectedRevision: f.store.revision(), name: 'Backend', url: 'https://example.com/backend.git', path: 'resources/backend'});
    assert.equal(clone.status, 200); const operation = (await clone.json()).operation;
    assert.equal((await finishClone(f.clones, operation.id)).status, 'completed');
    assert.equal((await f.post(`/operations/${operation.id}/cancel`, {})).status, 200);
    assert.equal(f.store.read().resources.length, 2);
    await f.close(); assert.equal((await f.get()).status, 503);
    assert.equal((await f.post('', {action: 'remove', id: 'root', expectedRevision: f.store.revision()})).status, 503);
  } finally {await f.cleanup();}
});

test('resource endpoints refuse manifest identity changes during the same Host lifetime', async () => {
  const f = await fixture();
  try {
    const text = readFileSync(f.manifest, 'utf8');
    writeFileSync(f.manifest, text.replace(/^id:.*$/m, 'id: another-project'));
    assert.equal((await f.get()).status, 422);
    assert.equal((await f.post('/inspect', {path: f.outside})).status, 422);
  } finally {await f.cleanup();}
});
