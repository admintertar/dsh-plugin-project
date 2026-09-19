import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ResourceGitAuthentication, gitKeyChoices, validateGitKey} from '../src/resource-auth.ts';
import {ResourceGitError, type GitRun} from '../src/resource-git.ts';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {ResourceSyncManager} from '../src/resource-sync.ts';
import {resourceFixture, gitFixture, localCloneRunner, finishClone} from './fixtures/resources.ts';
import type {GitAuthScope, GitCredential} from '../src/resource-auth-contract.ts';

const credential: GitCredential = {kind: 'https', username: 'test-user', password: 'private-auth-fixture'};
const scope: GitAuthScope = {url: 'https://example.com/private.git', name: 'Private', action: 'clone'};
async function pending(auth: ResourceGitAuthentication, count = 1) {
  // Manual sync performs real Git inspection before requesting credentials.
  // Allow that work to finish on busy machines without changing the assertion.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = auth.snapshot().requests; if (requests.length === count) return requests;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Authentication request did not arrive');
}

test('parallel authentication requests isolate credentials and never project them in snapshots', async () => {
  const auth = new ResourceGitAuthentication(); const seen: {url: string; credential: GitCredential}[] = [];
  const run: GitRun = async (_args, _cwd, options) => {
    if (!options?.auth) throw new ResourceGitError('git-auth-required');
    seen.push(options.auth); return options.auth.url;
  };
  const other = {...scope, url: 'HTTPS://other.example.com/other.git'};
  const first = auth.run(run, [], '.', {}, scope, true, () => {});
  const second = auth.run(run, [], '.', {}, other, true, () => {});
  try {
    const requests = await pending(auth, 2);
    assert.throws(() => auth.answer(requests[0]!.id, {kind: 'ssh', keyPath: '/missing', passphrase: ''}), /git-auth-invalid/);
    assert.throws(() => auth.answer(requests[0]!.id, {...credential, password: 'bad\npassword'}), /git-auth-invalid/);
    auth.answer(requests[1]!.id, {...credential, username: 'second-user'});
    assert.equal(await second, other.url);
    assert.equal(auth.snapshot().requests.length, 1);
    auth.answer(requests[0]!.id, credential); assert.equal(await first, scope.url);
    assert.deepEqual(seen.map(item => [item.url, item.credential.kind === 'https' && item.credential.username]), [[other.url, 'second-user'], [scope.url, 'test-user']]);
    assert.doesNotMatch(JSON.stringify(auth.snapshot()), /private-auth-fixture|test-user/);
    assert.throws(() => auth.answer(requests[0]!.id, credential), /git-auth-expired/);
  } finally {auth.dispose(); await Promise.allSettled([first, second]);}
});

test('background checks never prompt and invalid credentials receive a fresh retry request', async () => {
  const auth = new ResourceGitAuthentication();
  const run: GitRun = async () => {throw new ResourceGitError('git-auth-required');};
  await assert.rejects(auth.run(run, [], '.', {}, scope, false, () => {}), /git-auth-required/);
  assert.deepEqual(auth.snapshot(), {requests: []});
  const work = auth.run(run, [], '.', {}, scope, true, () => {});
  const rejected = assert.rejects(work, /git-auth-required/);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [request] = await pending(auth); assert.equal(request!.retry, attempt > 0);
      auth.answer(request!.id, credential);
    }
    await rejected; assert.equal(auth.snapshot().requests.length, 0);
  } finally {auth.dispose(); await rejected;}
});

for (const action of ['cancel', 'abort', 'dispose', 'expire'] as const) test(`authentication ${action} releases the operation and removes its prompt`, async () => {
  const auth = new ResourceGitAuthentication(action === 'expire' ? 100 : 60_000);
  const controller = new AbortController();
  const work = auth.run(async () => {throw new ResourceGitError('git-auth-required');}, [], '.', {signal: controller.signal}, scope, true, () => {});
  const rejected = assert.rejects(work, action === 'cancel' ? /git-auth-cancelled/ : action === 'expire' ? /git-auth-expired/ : /clone-cancelled/);
  // Keep the test alive while the production prompt uses an unref'ed deadline.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const [request] = await pending(auth);
    if (action === 'cancel') auth.answer(request!.id, null);
    if (action === 'abort') controller.abort();
    if (action === 'dispose') auth.dispose();
    await rejected; assert.equal(auth.snapshot().requests.length, 0);
  } finally {clearTimeout(keepAlive); auth.dispose();}
});

test('key choices include only private keys and reject unsafe permissions without exposing their contents', () => {
  const f = resourceFixture(); const directory = join(f.base, 'keys'); mkdirSync(directory);
  const privateKey = join(directory, 'id_ed25519'); const contents = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-fixture\n';
  writeFileSync(privateKey, contents, {mode: 0o600});
  writeFileSync(join(directory, 'id_ed25519.pub'), 'ssh-ed25519 public');
  writeFileSync(join(directory, 'known_hosts'), 'example host key');
  try {
    assert.deepEqual(gitKeyChoices(directory), [{name: 'id_ed25519', path: privateKey}]);
    assert.doesNotMatch(JSON.stringify(gitKeyChoices(directory)), /private-key-fixture/);
    assert.throws(() => validateGitKey(directory), /git-key-invalid/);
    assert.throws(() => validateGitKey('id_ed25519'), /git-key-invalid/);
    if (process.platform !== 'win32') {chmodSync(privateKey, 0o644); assert.throws(() => validateGitKey(privateKey), /git-key-permissions/);}
  } finally {f.cleanup();}
});

for (const changed of [false, true]) test(`clone resumes after authentication and ${changed ? 'preserves files created while waiting' : 'never persists its credentials'}`, async () => {
  const f = resourceFixture(); gitFixture(f.outside); const auth = new ResourceGitAuthentication();
  const run = localCloneRunner(f.outside, (args, _cwd, options) => args.includes('clone') && !options?.auth
    ? Promise.reject(new ResourceGitError('git-auth-required')) : undefined);
  const clones = new ResourceCloneManager(f.store, f.runtime, run, undefined, auth);
  try {
    const operation = await clones.start({requestId: 'private', expectedRevision: f.store.revision(), name: 'Private', url: scope.url, path: 'resources/private'});
    const [request] = await pending(auth);
    if (changed) writeFileSync(join(operation.target, 'draft.txt'), 'Keep my draft');
    auth.answer(request!.id, credential);
    const finished = await finishClone(clones, operation.id);
    assert.equal(finished.status, changed ? 'failed' : 'completed');
    if (changed) {assert.equal(finished.error, 'target-exists'); assert.equal(readFileSync(join(operation.target, 'draft.txt'), 'utf8'), 'Keep my draft');}
    else assert.equal(existsSync(join(operation.target, 'README.md')), true);
    assert.doesNotMatch(readFileSync(clones.stateFile, 'utf8') + readFileSync(f.manifest, 'utf8') + JSON.stringify(await clones.snapshot(false)), /private-auth-fixture|test-user/);
  } finally {auth.dispose(); await clones.dispose(); f.cleanup();}
});

test('a manual resource check can authenticate after a silent background failure, and closing cancels a waiting update', async () => {
  const f = resourceFixture(); gitFixture(f.outside); const auth = new ResourceGitAuthentication();
  const run = localCloneRunner(f.outside, (args, _cwd, options) => args.includes('fetch')
    ? options?.auth ? Promise.resolve('') : Promise.reject(new ResourceGitError('git-auth-required')) : undefined);
  const clones = new ResourceCloneManager(f.store, f.runtime, run, undefined, auth);
  const sync = new ResourceSyncManager(clones, run, {intervalMs: 0});
  try {
    const op = await clones.start({requestId: 'ready', expectedRevision: f.store.revision(), name: 'Private', url: scope.url, path: 'resources/private'});
    await finishClone(clones, op.id);
    await sync.start(op.resourceId, 'check', f.store.revision(), false);
    assert.equal(auth.snapshot().requests.length, 0);
    assert.equal((await sync.snapshot(false)).resources.find(item => item.id === op.resourceId)!.git!.sync!.error, 'git-auth-required');
    const check = sync.start(op.resourceId, 'check', f.store.revision());
    const [request] = await pending(auth); auth.answer(request!.id, credential); await check;
    assert.equal((await sync.snapshot(false)).resources.find(item => item.id === op.resourceId)!.git!.sync!.status, 'current');
    const update = sync.start(op.resourceId, 'update', f.store.revision());
    await pending(auth); await sync.dispose(); await update;
    assert.equal(auth.snapshot().requests.length, 0);
  } finally {auth.dispose(); await sync.dispose(); await clones.dispose(); f.cleanup();}
});
