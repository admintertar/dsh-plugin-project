import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse, stringify} from 'yaml';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {ProjectTaskStore} from '../src/tasks.ts';
import {ResourceGitError, type GitRun} from '../src/resource-git.ts';
import {resourceFixture, gitFixture, localCloneRunner, finishClone} from './fixtures/resources.ts';

const request = (revision: string, extra = {}) => ({requestId: 'request-1', expectedRevision: revision, name: 'Backend', url: 'https://example.com/backend.git', path: 'resources/backend', ...extra});

test('Git clone uses an exclusive project target and registers a verified working tree with a stable identity', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    gitFixture(f.outside); const run = localCloneRunner(f.outside);
    manager = new ResourceCloneManager(f.store, f.runtime, run);
    const operation = await manager.start(request(f.store.revision(), {branch: 'feature'}));
    const done = await finishClone(manager, operation.id);
    assert.equal(done.status, 'completed', done.error);
    const item = f.store.read().resources.find(item => item.id === operation.resourceId)!;
    assert.equal(item.path, join(f.root, 'resources/backend')); assert.equal(item.branch, 'feature');
    assert.equal(readFileSync(join(item.path!, 'README.md'), 'utf8'), '# Fixture\n');
    assert.match(readFileSync(join(f.root, '.gitignore'), 'utf8'), /\/resources\/backend\//);
    assert.equal((await manager.start(request(operation.revision, {branch: 'feature'}))).id, operation.id);
    assert.equal(f.store.read().resources.length, 2);
    await f.store.mutate({action: 'remove', id: item.id, expectedRevision: f.store.revision()});
    assert.ok(existsSync(join(item.path!, '.git')));
  } finally {await manager?.dispose(); f.cleanup();}
});

test('Git clone rejects existing empty directories, reserved targets, symlink parents and tracked deleted targets', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    const git = gitFixture(f.root); gitFixture(f.outside);
    manager = new ResourceCloneManager(f.store, f.runtime, localCloneRunner(f.outside));
    mkdirSync(join(f.root, 'empty')); symlinkSync(f.outside, join(f.root, 'escape'));
    for (const path of ['empty', '../outside', '/absolute', 'tasks/repo', 'memory/repo', 'Memory/repo', '.agent-project/repo', 'src/.git/repo', 'escape/repo']) {
      await assert.rejects(manager.start(request(f.store.revision(), {path})), /target-exists|resource-target-invalid/);
    }
    mkdirSync(join(f.root, 'tracked')); writeFileSync(join(f.root, 'tracked', 'tracked.txt'), 'tracked'); git('add', 'tracked');
    renameSync(join(f.root, 'tracked'), join(f.root, 'moved'));
    await assert.rejects(manager.start(request(f.store.revision(), {path: 'tracked'})), /target-tracked/);
    assert.equal(existsSync(join(f.outside, 'repo')), false);
    assert.equal(f.store.read().resources.length, 1);
  } finally {await manager?.dispose(); f.cleanup();}
});

test('a clone completed after a configuration edit remains pending and can be registered without downloading again', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    gitFixture(f.outside); const real = localCloneRunner(f.outside); let clones = 0;
    const run: GitRun = async (args, cwd, options) => {
      const result = await real(args, cwd, options);
      if (args.includes('clone')) {clones++; writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8') + '# during clone\n');}
      return result;
    };
    manager = new ResourceCloneManager(f.store, f.runtime, run);
    const operation = await manager.start(request(f.store.revision()));
    assert.equal((await finishClone(manager, operation.id)).status, 'pending');
    assert.equal(f.store.read().resources.length, 1);
    await manager.register(operation.id, f.store.revision());
    assert.equal((await manager.snapshot(false)).operations[0]!.status, 'completed');
    assert.equal(clones, 1); assert.equal(f.store.read().resources.length, 2);
  } finally {await manager?.dispose(); f.cleanup();}
});

test('cancellation and shutdown wait for the Git runner, retain directories and never register a cancelled resource', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    gitFixture(f.outside); let running = false; let finished = false;
    const run = localCloneRunner(f.outside, (args, _cwd, options) => {
      if (!args.includes('clone')) return;
      running = true;
      return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => setTimeout(() => {finished = true; reject(new ResourceGitError('clone-cancelled'));}, 20), {once: true}));
    });
    manager = new ResourceCloneManager(f.store, f.runtime, run);
    const operation = await manager.start(request(f.store.revision()));
    assert.equal(running, true);
    await assert.rejects(async () => manager!.start(request(f.store.revision(), {requestId: 'two', path: 'resources/two'})), /clone-busy/);
    await manager.cancel(operation.id);
    assert.equal(finished, true); assert.ok(existsSync(operation.target));
    assert.equal((await manager.snapshot(false)).operations[0]!.status, 'cancelled');
    assert.equal(f.store.read().resources.length, 1);
    finished = false;
    const second = await manager.start(request(f.store.revision(), {requestId: 'two', path: 'resources/two'}));
    await manager.dispose(); assert.equal(finished, true);
    assert.equal((await manager.snapshot(false)).operations.find(op => op.id === second.id)!.status, 'cancelled');
    await assert.rejects(async () => manager!.start(request(f.store.revision(), {requestId: 'late'})), /project-closing/);
  } finally {await manager?.dispose(); f.cleanup();}
});

test('cloning failures do not leak Git output and recovered records do not automatically run Git clone', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    const run = localCloneRunner(f.outside, args => args.includes('clone') ? Promise.reject(new Error('secret-fixture')) : undefined);
    manager = new ResourceCloneManager(f.store, f.runtime, run);
    const operation = await manager.start(request(f.store.revision()));
    const failed = await finishClone(manager, operation.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'clone-failed');
    assert.doesNotMatch(readFileSync(manager.stateFile, 'utf8'), /secret-fixture/);
    const state = JSON.parse(readFileSync(manager.stateFile, 'utf8')); state.operations[0].status = 'cloning';
    writeFileSync(manager.stateFile, JSON.stringify(state)); await manager.dispose();
    let calls = 0;
    manager = new ResourceCloneManager(f.store, f.runtime, async () => {calls++; return '';});
    assert.equal(calls, 0);
    const snapshot = await manager.snapshot(false);
    assert.equal(snapshot.operations[0]!.status, 'interrupted'); assert.equal(calls, 1, 'only Git availability was checked');
  } finally {await manager?.dispose(); f.cleanup();}
});

test('registration refuses a replaced directory and missing Git disables only cloning', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    gitFixture(f.outside); const real = localCloneRunner(f.outside);
    manager = new ResourceCloneManager(f.store, f.runtime, async (args, cwd, options) => {
      const result = await real(args, cwd, options);
      if (args.includes('clone')) writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8') + '# conflict\n');
      return result;
    });
    const operation = await manager.start(request(f.store.revision())); await finishClone(manager, operation.id);
    renameSync(operation.target, operation.target + '-original'); mkdirSync(operation.target);
    await assert.rejects(manager.register(operation.id, f.store.revision()), /resource-target-invalid/);
    await manager.dispose();
    manager = new ResourceCloneManager(f.store, f.runtime, async () => {throw new ResourceGitError('git-unavailable');});
    assert.equal((await manager.snapshot(true)).canClone, false);
    assert.equal((await manager.snapshot(true)).canPick, true);
    await assert.rejects(manager.start(request(f.store.revision(), {requestId: 'new', path: 'new'})), /git-unavailable/);
  } finally {await manager?.dispose(); f.cleanup();}
});

test('partial clones of existing resources remain unavailable across restarts and can retry at a new target', async () => {
  const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
  try {
    gitFixture(f.outside);
    const definition = parse(readFileSync(f.manifest, 'utf8'));
    definition.resources.push({id: 'backend', name: 'Backend', type: 'git', path: 'resources/backend', url: 'https://example.com/backend.git'});
    writeFileSync(f.manifest, stringify(definition));
    const run = localCloneRunner(f.outside, (args, cwd, options) => {
      if (!args.includes('clone')) return;
      writeFileSync(join(cwd, 'partial.txt'), 'not a finished checkout');
      return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new ResourceGitError('clone-cancelled')), {once: true}));
    });
    manager = new ResourceCloneManager(f.store, f.runtime, run);
    const operation = await manager.start(request(f.store.revision(), {id: 'backend'}));
    assert.equal(manager.project().resources.find(item => item.id === 'backend')!.status, 'unavailable');
    assert.equal((await manager.snapshot(false)).resources.find(item => item.id === 'backend')!.status, 'unavailable');
    const taskStore = new ProjectTaskStore(manager.project());
    assert.equal(taskStore.referencePath({id: 'ref', label: 'Partial', type: 'file', resourceId: 'backend', path: 'partial.txt'}), undefined);
    await manager.cancel(operation.id); await manager.dispose();
    // History eviction must not clear the persistent incomplete-resource guard.
    const state = JSON.parse(readFileSync(manager.stateFile, 'utf8')); state.operations = [];
    writeFileSync(manager.stateFile, JSON.stringify(state));
    manager = new ResourceCloneManager(f.store, f.runtime, localCloneRunner(f.outside));
    assert.equal(manager.project().resources.find(item => item.id === 'backend')!.status, 'unavailable');
    const retry = await manager.start(request(f.store.revision(), {id: 'backend', requestId: 'retry', path: 'resources/backend-retry'}));
    assert.equal(manager.project().resources.find(item => item.id === 'backend')!.status, 'unavailable');
    assert.equal((await finishClone(manager, retry.id)).status, 'completed');
    const resource = manager.project().resources.find(item => item.id === 'backend')!;
    assert.equal(resource.status, 'ready'); assert.equal(resource.path, retry.target);
    assert.ok(existsSync(join(operation.target, 'partial.txt')));
  } finally {await manager?.dispose(); f.cleanup();}
});

test('default branches and empty repositories register, while nonexistent branches leave no resource', async () => {
  for (const empty of [false, true]) {
    const f = resourceFixture(); let manager: ResourceCloneManager | undefined;
    try {
      gitFixture(f.outside, empty);
      manager = new ResourceCloneManager(f.store, f.runtime, localCloneRunner(f.outside));
      const operation = await manager.start(request(f.store.revision()));
      assert.equal((await finishClone(manager, operation.id)).status, 'completed');
      assert.equal((await manager.snapshot(false)).resources.find(item => item.id === operation.resourceId)!.git?.branch, 'main');
      const failed = await manager.start(request(f.store.revision(), {requestId: 'missing-branch', path: 'resources/missing-branch', branch: 'not-present'}));
      assert.equal((await finishClone(manager, failed.id)).status, 'failed');
      assert.equal(f.store.read().resources.length, 2);
      assert.ok(existsSync(failed.target));
    } finally {await manager?.dispose(); f.cleanup();}
  }
});
