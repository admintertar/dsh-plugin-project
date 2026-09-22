import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {execFile, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {ResourceSyncManager} from '../src/resource-sync.ts';
import {ResourceGitError, runResourceGit, type GitRun} from '../src/resource-git.ts';
import {gitFixture, resourceFixture} from './fixtures/resources.ts';

const url = 'https://example.com/project.git';
const execute = promisify(execFile);

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
/**
 * A project root whose origin is a real repository, so a check and an update can actually fetch.
 * Only the fetch URL is rewritten; production still validates and uses the configured remote.
 */
function remoteFixture() {
  const f = resourceFixture();
  const git = gitFixture(f.root);
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
  git('remote', 'add', 'origin', url);
  git('config', 'branch.main.remote', 'origin'); git('config', 'branch.main.merge', 'refs/heads/main');
  // The remote starts as a copy of the project root, so the two share history and can fast-forward.
  execFileSync('git', ['clone', '--quiet', '--', f.root, f.outside], {stdio: 'ignore'});
  const remote = (...args: string[]) => execFileSync('git', args, {cwd: f.outside, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const run: GitRun = async (args, cwd, options) => {
    if (!args.includes('fetch')) return runResourceGit(args, cwd, options);
    const copy = [...args]; copy[copy.indexOf('--') + 1] = f.outside;
    try {return (await execute('git', copy, {cwd, signal: options?.signal, timeout: 15_000, encoding: 'utf8'})).stdout.trim();}
    catch (error) {throw new ResourceGitError(String(error).includes("couldn't find remote ref") ? 'git-remote-branch-missing' : 'git-sync-failed');}
  };
  const clones = new ResourceCloneManager(f.store, f.runtime, run);
  const sync = new ResourceSyncManager(clones, run, {intervalMs: 0});
  const advance = () => {
    // The remote follows the project root first, so its new commit is strictly ahead instead of divergent.
    remote('fetch', '--quiet', '--', f.root, 'main'); remote('merge', '--ff-only', '--quiet', 'FETCH_HEAD');
    writeFileSync(join(f.outside, 'README.md'), '# Remote change\n');
    remote('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-am', 'remote change');
  };
  return {...f, git, remote, advance, clones, sync, cleanup: async () => {await sync.dispose(); await clones.dispose(); f.cleanup();}};
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

test('a project repository update fast-forwards the branch the project assets live on', async () => {
  const f = remoteFixture();
  try {
    // The fixture project holds its own untracked files, and an update refuses to run over a dirty tree.
    await f.sync.startProjectRoot('commit', (await f.sync.projectRootStatus()).revision, true, 'test: baseline');
    assert.equal((await f.sync.projectRootStatus()).repository?.sync.dirty, false);
    const revision = (await f.sync.projectRootStatus()).revision;
    f.advance();
    await f.sync.startProjectRoot('check', revision);
    const checked = await f.sync.projectRootStatus();
    assert.equal(checked.repository?.sync.status, 'behind');
    assert.equal(checked.repository?.sync.behind, 1);
    // The same action the repository details dialog offers: fetch, then fast-forward only.
    await f.sync.startProjectRoot('update', revision);
    const updated = await f.sync.projectRootStatus();
    assert.equal(updated.repository?.sync.error, undefined);
    assert.equal(updated.repository?.sync.status, 'current');
    assert.equal(updated.repository?.sync.behind, 0);
    assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), '# Remote change\n');
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
