import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {ResourceSyncManager} from '../src/resource-sync.ts';
import {runResourceGit} from '../src/resource-git.ts';
import {gitFixture, resourceFixture} from './fixtures/resources.ts';

const url = 'https://example.com/project.git';

/** A project root that is itself a Git working tree with an origin, plus the shared sync manager. */
function fixture() {
  const f = resourceFixture();
  const git = gitFixture(f.root);
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
  git('remote', 'add', 'origin', url);
  const clones = new ResourceCloneManager(f.store, f.runtime, runResourceGit);
  const sync = new ResourceSyncManager(clones, runResourceGit, {intervalMs: 0});
  return {...f, git, clones, sync, cleanup: async () => {await sync.dispose(); await clones.dispose(); f.cleanup();}};
}
function plainFixture() {
  const f = resourceFixture();
  const clones = new ResourceCloneManager(f.store, f.runtime, runResourceGit);
  const sync = new ResourceSyncManager(clones, runResourceGit, {intervalMs: 0});
  return {...f, clones, sync, cleanup: async () => {await sync.dispose(); await clones.dispose(); f.cleanup();}};
}

test('the project repository reports its own Git state without becoming a managed resource', async () => {
  const f = fixture();
  try {
    const status = await f.sync.projectRootStatus();
    assert.equal(status.path, f.root);
    assert.equal(status.name, 'project');
    assert.equal(status.repository?.url, url);
    assert.equal(status.repository?.branch, 'main');
    assert.equal(status.repository?.sync.status, 'no-upstream');
    assert.match(status.revision, /^[a-f0-9]{64}$/);
    // The manifest declares the root as a local resource; the snapshot still excludes it entirely.
    const snapshot = await f.sync.snapshot(false);
    assert.equal(snapshot.resources.length, 0);
    assert.equal(snapshot.resources.some(item => item.path === f.root), false);
  } finally {await f.cleanup();}
});

test('project repository commit, changes, branch listing and switch reuse the resource Git rules', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'notes.md'), '# Notes\n');
    const before = await f.sync.projectRootChanges();
    const paths = before.files.map(file => file.path);
    // The fixture project layout is not committed either, so it shows up beside the new file.
    assert.equal(paths.includes('notes.md'), true);
    assert.equal(paths.includes('example.agent-project'), true);
    assert.equal(before.files.every(file => file.status === 'untracked'), true);
    const revision = (await f.sync.projectRootStatus()).revision;
    await f.sync.startProjectRoot('commit', revision, true, 'test: add notes');
    const committed = await f.sync.projectRootStatus();
    assert.equal(committed.repository?.sync.dirty, false);
    assert.equal(execFileSync('git', ['log', '-1', '--pretty=%s'], {cwd: f.root, encoding: 'utf8'}).trim(), 'test: add notes');
    const branches = await f.sync.projectRootBranches();
    assert.deepEqual(branches.local, ['feature', 'main']);
    assert.equal(branches.current, 'main');
    // Switching is refused while the working tree is dirty, exactly like a resource.
    writeFileSync(join(f.root, 'notes.md'), '# Notes changed\n');
    await f.sync.startProjectRoot('switch', revision, true, 'feature');
    assert.equal((await f.sync.projectRootStatus()).repository?.branch, 'main');
    await f.sync.startProjectRoot('commit', revision, true, 'test: change notes');
    // Keep the fixture's feature branch on the same commit so the switch stays non-destructive.
    f.git('branch', '-f', 'feature', 'main');
    await f.sync.startProjectRoot('switch', revision, true, 'feature');
    assert.equal((await f.sync.projectRootStatus()).repository?.branch, 'feature');
  } finally {await f.cleanup();}
});

test('a project repository check reuses the resource sync state machine and its error codes', async () => {
  const f = fixture();
  try {
    const revision = (await f.sync.projectRootStatus()).revision;
    await f.sync.startProjectRoot('check', revision);
    const status = await f.sync.projectRootStatus();
    assert.equal(status.repository?.sync.status, 'error');
    assert.equal(status.repository?.sync.error, 'git-no-upstream');
  } finally {await f.cleanup();}
});

test('a project root that is not a Git working tree reports no repository instead of failing', async () => {
  const f = plainFixture();
  try {
    const status = await f.sync.projectRootStatus();
    assert.equal(status.path, f.root);
    assert.equal(status.repository, undefined);
    await assert.rejects(() => f.sync.projectRootBranches(), (error: Error) => error.message === 'resource-unavailable');
    await assert.rejects(() => f.sync.startProjectRoot('check', status.revision), (error: Error) => error.message === 'resource-unavailable');
  } finally {await f.cleanup();}
});

test('project repository actions reject a stale project revision like every other project write', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => f.sync.startProjectRoot('check', 'a'.repeat(64)), (error: Error) => error.message === 'revision-conflict');
  } finally {await f.cleanup();}
});
