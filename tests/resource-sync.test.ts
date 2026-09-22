import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse, stringify} from 'yaml';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {ResourceSyncManager} from '../src/resource-sync.ts';
import {ResourceGitError, runResourceGit, type GitRun} from '../src/resource-git.ts';
import {gitFixture, localCloneRunner, resourceFixture} from './fixtures/resources.ts';

const execute = promisify(execFile);
const url = 'https://example.com/resources.git';
async function waitForScheduledCheck(work: Promise<void>): Promise<void> {
  // Production timers are unref'ed because the Host owns the event loop; this fixture has no Host server.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {await Promise.race([work, new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(new Error('Automatic check did not start')), 15_000);})]);}
  finally {clearTimeout(timer);}
}
async function fixture(options: ConstructorParameters<typeof ResourceSyncManager>[2] = {intervalMs: 0}) {
  const f = resourceFixture(); const source = gitFixture(f.outside);
  const path = join(f.root, 'resources'); mkdirSync(path);
  await localCloneRunner(f.outside)(['clone', '--', url, '.'], path);
  await f.store.mutate({action: 'addLocal', type: 'git', path, url, name: 'Source', expectedRevision: f.store.revision()});
  const item = f.store.read().resources.find(item => item.type === 'git')!;
  const git = (...args: string[]) => execFileSync('git', args, {cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  let override: ((...args: Parameters<GitRun>) => ReturnType<GitRun> | undefined) | undefined;
  const calls: string[][] = [];
  const run: GitRun = async (args, cwd, runOptions) => {
    calls.push([...args]); const custom = override?.(args, cwd, runOptions); if (custom) return custom;
    if (!args.includes('fetch')) return runResourceGit(args, cwd, runOptions);
    // This transport is fixture-only. Production still permits credential-free HTTPS/SSH only.
    const copy = [...args]; copy[copy.indexOf('--') + 1] = f.outside;
    try {return (await execute('git', copy, {cwd, signal: runOptions?.signal, timeout: 15_000, encoding: 'utf8'})).stdout.trim();}
    catch (error) {throw new ResourceGitError(String(error).includes("couldn't find remote ref") ? 'git-remote-branch-missing' : 'git-sync-failed');}
  };
  const clones = new ResourceCloneManager(f.store, f.runtime, run);
  const sync = new ResourceSyncManager(clones, run, options);
  const state = async () => (await sync.snapshot(false)).resources.find(resource => resource.id === item.id)!.git!.sync!;
  const finish = async () => {
    for (let i = 0; i < 300; i++) {
      const result = await state(); if (!result.phase) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Resource sync did not settle');
  };
  const act = async (action: 'check' | 'update') => {await sync.start(item.id, action, f.store.revision()); return state();};
  let commits = 0;
  const advance = () => {
    writeFileSync(join(f.outside, 'README.md'), `# Update ${++commits}\n`); source('add', '.');
    source('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `update ${commits}`);
    return source('rev-parse', 'HEAD');
  };
  const commitLocal = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'local');
  const addResource = async (linked = false) => {
    const secondPath = join(f.root, linked ? 'linked' : 'second');
    if (linked) {git('worktree', 'add', '-b', 'linked', secondPath, 'origin/main'); git('branch', '--set-upstream-to=origin/main', 'linked');}
    else {mkdirSync(secondPath); await localCloneRunner(f.outside)(['clone', '--', url, '.'], secondPath);}
    await f.store.mutate({action: 'addLocal', type: 'git', path: secondPath, url, name: 'Second', expectedRevision: f.store.revision()});
    return f.store.read().resources.find(resource => resource.path === secondPath)!;
  };
  return {...f, sync, clones, item, git, source, path, state, finish, act, advance, commitLocal, calls, addResource,
    override: (value: typeof override) => {override = value;},
    cleanup: async () => {await sync.dispose(); await clones.dispose(); f.cleanup();}};
}

test('checks fetch remote state without changing files; explicit update refetches then fast-forwards without hooks', async () => {
  const f = await fixture();
  try {
    const revision = f.store.revision(); const head = f.git('rev-parse', 'HEAD');
    assert.equal((await f.state()).status, 'unchecked'); assert.equal(f.calls.some(args => args.includes('fetch')), false);
    f.advance(); const checked = await f.act('check');
    assert.equal(checked.status, 'behind'); assert.equal(checked.behind, 1); assert.ok(checked.checkedAt);
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(readFileSync(join(f.path, 'README.md'), 'utf8'), '# Fixture\n');
    const latest = f.advance();
    const marker = join(f.base, 'hook-ran');
    writeFileSync(join(f.path, '.git/hooks/post-merge'), `#!/bin/sh\ntouch '${marker}'\n`, {mode: 0o755});
    const updated = await f.act('update');
    assert.equal(updated.error, undefined); assert.equal(updated.status, 'current'); assert.ok(updated.updatedAt);
    assert.equal(f.git('rev-parse', 'HEAD'), latest); assert.equal(existsSync(marker), false);
    assert.equal(f.store.revision(), revision); assert.equal(f.calls.filter(args => args.includes('fetch')).length, 2);
    assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'main');
  } finally {await f.cleanup();}
});

test('new local repositories are unlinked, stay out of automatic fetches and preserve root access for tasks', async () => {
  const f = resourceFixture();
  const git = gitFixture(join(f.root, 'resources/local'), true);
  const definition = parse(readFileSync(f.manifest, 'utf8'));
  definition.resources.push({id: 'local', name: 'Local', type: 'git', path: 'resources/local'});
  writeFileSync(f.manifest, stringify(definition));
  writeFileSync(join(f.root, 'resources/local/draft.txt'), 'keep this draft');
  const calls: string[][] = [];
  const run: GitRun = (args, cwd, options) => {calls.push([...args]); return runResourceGit(args, cwd, options);};
  const clones = new ResourceCloneManager(f.store, f.runtime, run);
  const sync = new ResourceSyncManager(clones, run, {initialDelayMs: 1});
  try {
    sync.startAutomaticChecks();
    const snapshot = await sync.snapshot(false);
    assert.deepEqual(snapshot.resources.map(item => item.id), ['local']);
    assert.ok(f.store.read().resources.find(item => item.id === 'root'), 'task root binding remains available');
    const state = snapshot.resources[0]!.git!;
    assert.equal(state.diagnostic, undefined);
    assert.equal(state.sync?.status, 'unlinked'); assert.equal(state.sync?.dirty, true);
    assert.equal(state.sync?.error, undefined);
    assert.throws(() => sync.start('local', 'check', f.store.revision()), /git-no-remote/);
    assert.throws(() => sync.start('root', 'check', f.store.revision()), /resource-project-root/);
    assert.equal(calls.some(args => args.includes('fetch')), false);
    assert.equal(git('remote'), '');
    assert.equal(readFileSync(join(f.root, 'resources/local/draft.txt'), 'utf8'), 'keep this draft');
  } finally {await sync.dispose(); await clones.dispose(); f.cleanup();}
});

test('removing an origin produces an unlinked state, and associating it restores tracking without a download', async () => {
  const f = await fixture();
  try {
    await f.act('check');
    f.git('remote', 'remove', 'origin'); f.clones.invalidate(); f.sync.invalidate(f.item.id);
    assert.equal((await f.state()).status, 'unlinked');
    const head = f.git('rev-parse', 'HEAD'), before = f.calls.filter(args => args.includes('fetch')).length;
    await f.store.mutate({action: 'associate', id: f.item.id, url, branch: 'main', expectedRevision: f.store.revision()});
    f.clones.invalidate(); f.sync.invalidate(f.item.id);
    assert.equal(f.git('config', 'branch.main.remote'), 'origin');
    assert.equal(f.git('config', 'branch.main.merge'), 'refs/heads/main');
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.calls.filter(args => args.includes('fetch')).length, before);
    assert.equal((await f.state()).status, 'unchecked');
    assert.equal((await f.act('check')).status, 'current');
  } finally {await f.cleanup();}
});

for (const kind of ['modified', 'staged', 'untracked'] as const) test(`update preserves ${kind} local files and refuses to advance`, async () => {
  const f = await fixture();
  try {
    f.advance(); const file = join(f.path, kind === 'untracked' ? 'notes.txt' : 'README.md'); writeFileSync(file, 'User draft\n');
    if (kind === 'staged') f.git('add', 'README.md');
    const before = f.git('rev-parse', 'HEAD'); const checked = await f.act('check');
    assert.equal(checked.status, 'behind'); assert.equal(checked.dirty, true);
    assert.equal((await f.act('update')).error, 'git-local-changes');
    assert.equal(f.git('rev-parse', 'HEAD'), before); assert.equal(readFileSync(file, 'utf8'), 'User draft\n');
    assert.equal(f.calls.filter(args => args.includes('fetch')).length, 1);
  } finally {await f.cleanup();}
});

test('a diverged branch is merged, keeping both the local and the remote commits', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, 'local.txt'), 'local'); f.git('add', '.'); f.commitLocal();
    const local = f.git('rev-parse', 'HEAD');
    assert.equal((await f.act('check')).status, 'ahead');
    const remote = f.advance(); const checked = await f.act('check');
    assert.equal(checked.status, 'diverged'); assert.equal(checked.ahead, 1); assert.equal(checked.behind, 1);
    // The caller learns what the update did, so a conflict can be handed to a conversation instead.
    assert.deepEqual(await f.sync.start(f.item.id, 'update', f.store.revision()), {status: 'merged', files: []});
    const merged = await f.act('check');
    assert.equal(merged.error, undefined); assert.equal(merged.status, 'ahead');
    // The merge commit and the local commit are both ahead of the remote now.
    assert.equal(merged.ahead, 2); assert.equal(merged.behind, 0);
    // A merge commit sits on top: the first parent is the local commit, the second the fetched one.
    assert.equal(f.git('rev-parse', 'HEAD^1'), local);
    assert.equal(f.git('rev-parse', 'HEAD^2'), remote);
    assert.equal(readFileSync(join(f.path, 'local.txt'), 'utf8'), 'local');
    assert.equal(readFileSync(join(f.path, 'README.md'), 'utf8'), `# Update 1\n`);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally {await f.cleanup();}
});

test('a conflicting merge is reported and rolled back completely, never leaving a half-merged tree', async () => {
  const f = await fixture();
  try {
    // Both sides rewrite the same file, so no merge can resolve it automatically.
    writeFileSync(join(f.path, 'README.md'), '# Local draft\n'); f.git('add', '.'); f.commitLocal();
    const before = f.git('rev-parse', 'HEAD');
    f.advance();
    assert.equal((await f.act('check')).status, 'diverged');
    assert.deepEqual(await f.sync.start(f.item.id, 'update', f.store.revision()), {status: 'conflict', files: ['README.md']});
    // The worktree and the index are exactly what they were: no merge commit, no MERGE_HEAD, no conflict markers.
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    assert.equal(existsSync(join(f.path, '.git/MERGE_HEAD')), false);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(readFileSync(join(f.path, 'README.md'), 'utf8'), '# Local draft\n');
    const rolledBack = await f.act('check');
    assert.equal(rolledBack.error, undefined); assert.equal(rolledBack.status, 'diverged');
    // Resolving the conflict by hand — here by taking the remote text — lets a later update through.
    writeFileSync(join(f.path, 'README.md'), `# Update 1\n`); f.git('add', '.'); f.commitLocal();
    assert.deepEqual(await f.sync.start(f.item.id, 'update', f.store.revision()), {status: 'merged', files: []});
    assert.equal((await f.act('check')).status, 'ahead');
  } finally {await f.cleanup();}
});

for (const kind of ['detached', 'no-upstream', 'origin', 'merge'] as const) test(`reports ${kind} and refuses an unsafe update`, async () => {
  const f = await fixture();
  try {
    f.advance();
    if (kind === 'detached') f.git('checkout', '--detach');
    if (kind === 'no-upstream') f.git('branch', '--unset-upstream');
    if (kind === 'origin') f.git('remote', 'set-url', 'origin', 'https://example.com/another.git');
    if (kind === 'merge') writeFileSync(join(f.path, '.git/MERGE_HEAD'), f.git('rev-parse', 'HEAD'));
    const before = f.git('rev-parse', 'HEAD');
    const result = await f.act('update');
    assert.equal(result.error, {detached: 'git-detached', 'no-upstream': 'git-no-upstream', origin: 'resource-origin-mismatch', merge: 'git-in-progress'}[kind]);
    assert.equal(f.git('rev-parse', 'HEAD'), before); assert.equal(f.calls.some(args => args.includes('fetch')), false);
  } finally {await f.cleanup();}
});

test('remote deletion and authentication failure never report a stale remote as up to date', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.act('check')).status, 'current');
    f.source('checkout', 'feature'); f.source('branch', '-D', 'main');
    assert.equal((await f.act('check')).error, 'git-remote-branch-missing');
    f.override(args => args.includes('fetch') ? Promise.reject(new ResourceGitError('git-auth-required')) : undefined);
    const failed = await f.act('check'); assert.equal(failed.status, 'error'); assert.equal(failed.error, 'git-auth-required'); assert.ok(failed.checkedAt);
  } finally {await f.cleanup();}
});

test('ignored local files are retained if a remote update would overwrite them', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, '.git/info/exclude'), 'private.txt\n'); writeFileSync(join(f.path, 'private.txt'), 'Keep me');
    writeFileSync(join(f.outside, 'private.txt'), 'Remote'); f.advance();
    const head = f.git('rev-parse', 'HEAD');
    assert.equal((await f.act('check')).status, 'behind');
    assert.equal((await f.act('update')).error, 'git-sync-failed');
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(readFileSync(join(f.path, 'private.txt'), 'utf8'), 'Keep me');
  } finally {await f.cleanup();}
});

test('a branch switch during fetch stops the update and subsequent checks use the current tracking branch', async () => {
  const f = await fixture();
  try {
    f.advance(); await f.act('check');
    f.override(args => {
      if (args.includes('fetch')) {f.git('checkout', '-b', 'feature', '--track', 'origin/feature'); f.override(undefined);}
      return undefined;
    });
    const featureHead = f.source('rev-parse', 'feature');
    await f.act('update');
    assert.equal(f.git('rev-parse', 'HEAD'), featureHead); assert.equal(f.calls.some(args => args.includes('merge')), false);
    const checked = await f.act('check'); assert.equal(checked.status, 'current'); assert.equal(checked.upstream, 'origin/feature');
    f.git('checkout', 'main');
    f.override(args => args.includes('fetch') ? Promise.reject(new ResourceGitError('git-auth-required')) : undefined);
    const failed = await f.act('check');
    assert.equal(failed.error, 'git-auth-required'); assert.equal(failed.checkedAt, undefined, 'Do not reuse a check time from another branch');
  } finally {await f.cleanup();}
});

test('sync excludes conflicting operations on the same resource; disposal prevents a working-tree update', async () => {
  const f = await fixture(); let aborted = false; let started!: () => void;
  const fetching = new Promise<void>(resolve => {started = resolve;});
  try {
    f.override((args, _cwd, options) => args.includes('fetch') ? new Promise((_resolve, reject) => {
      started(); options?.signal?.addEventListener('abort', () => {aborted = true; reject(new ResourceGitError('clone-cancelled'));}, {once: true});
    }) : undefined);
    f.sync.start(f.item.id, 'update', f.store.revision()); await fetching;
    assert.throws(() => f.sync.start(f.item.id, 'check', f.store.revision()), /git-sync-busy/);
    assert.throws(() => f.sync.assertMutable(f.item.id), /git-sync-busy/);
    await f.sync.dispose(); assert.equal(aborted, true); assert.equal(f.calls.some(args => args.includes('merge')), false);
    assert.throws(() => f.sync.start(f.item.id, 'check', f.store.revision()), /project-closing/);
  } finally {await f.cleanup();}
});

test('independent resources fetch concurrently; an automatic check does not block a manual update or duplicate a check', async () => {
  const f = await fixture({intervalMs: 60_000, initialDelayMs: 1}); const releases: (() => void)[] = []; const fetching = new Set<string>();
  let started!: () => void; const firstFetch = new Promise<void>(resolve => {started = resolve;});
  try {
    const second = await f.addResource(); const latest = f.advance(); const revision = f.store.revision();
    f.override((args, cwd, options) => {
      if (!args.includes('fetch')) return undefined;
      fetching.add(cwd);
      if (cwd === f.path) return new Promise((_resolve, reject) => {
        releases.push(() => reject(new ResourceGitError('git-auth-required')));
        options?.signal?.addEventListener('abort', () => reject(new ResourceGitError('clone-cancelled')), {once: true});
        started();
      });
      return undefined;
    });
    f.sync.startAutomaticChecks(); await waitForScheduledCheck(firstFetch);
    const first = f.sync.start(f.item.id, 'check', revision);
    assert.equal(f.sync.start(f.item.id, 'check', revision), first, 'Reuse an in-flight manual or automatic check');
    const next = f.sync.start(second.id, 'update', revision);
    await next;
    assert.equal(fetching.size, 2, 'The second fetch must run while the first remains pending');
    const state = await f.sync.snapshot(false);
    assert.equal(state.resources.find(item => item.id === f.item.id)!.git!.sync!.phase, 'checking');
    assert.equal(state.resources.find(item => item.id === second.id)!.git!.sync!.status, 'current');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: second.path, encoding: 'utf8'}).trim(), latest);
    releases.forEach(release => release()); await first;
    assert.equal((await f.state()).error, 'git-auth-required');
    assert.equal(f.calls.filter(args => args.includes('fetch')).length, 2);
  } finally {releases.forEach(release => release()); await f.cleanup();}
});

test('linked worktrees sharing Git refs wait for each other without a project-wide busy error', async () => {
  const f = await fixture(); let release!: () => void; let fetched!: () => void;
  const fetching = new Promise<void>(resolve => {fetched = resolve;});
  try {
    const second = await f.addResource(true); const revision = f.store.revision();
    f.override((args, cwd, options) => args.includes('fetch') && cwd === f.path ? new Promise((_resolve, reject) => {
      release = () => reject(new ResourceGitError('git-auth-required')); fetched();
      options?.signal?.addEventListener('abort', release, {once: true});
    }) : undefined);
    const first = f.sync.start(f.item.id, 'check', revision); await fetching;
    const next = f.sync.start(second.id, 'check', revision);
    const active = await f.sync.snapshot(false);
    assert.equal(active.resources.filter(item => item.git?.sync?.phase === 'checking').length, 2);
    assert.equal(f.calls.filter(args => args.includes('fetch')).length, 1);
    release(); await Promise.all([first, next]);
    assert.equal(f.calls.filter(args => args.includes('fetch')).length, 2);
    const result = (await f.sync.snapshot(false)).resources.find(item => item.id === second.id)!.git!.sync!;
    assert.equal(result.status, 'current'); assert.equal(result.error, undefined);
  } finally {release?.(); await f.cleanup();}
});

test('closing aborts every concurrent resource operation and waits for them to finish', async () => {
  const f = await fixture(); const aborted = new Set<string>(); const started = new Set<string>();
  try {
    const second = await f.addResource(); const revision = f.store.revision();
    f.override((args, cwd, options) => args.includes('fetch') ? new Promise((_resolve, reject) => {
      started.add(cwd); options?.signal?.addEventListener('abort', () => {
        aborted.add(cwd); reject(new ResourceGitError('clone-cancelled'));
      }, {once: true});
    }) : undefined);
    const first = f.sync.start(f.item.id, 'check', revision); const next = f.sync.start(second.id, 'update', revision);
    for (let i = 0; i < 1000 && started.size < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(started.size, 2);
    await f.sync.dispose(); await Promise.all([first, next]); assert.equal(aborted.size, 2);
    assert.equal(f.calls.some(args => args.includes('merge')), false);
  } finally {await f.cleanup();}
});

for (const kind of ['files', 'configuration'] as const) test(`changes to ${kind} during fetch stop a requested update`, async () => {
  const f = await fixture();
  try {
    f.advance(); await f.act('check'); const head = f.git('rev-parse', 'HEAD');
    f.override(args => {
      if (args.includes('fetch')) {
        if (kind === 'files') writeFileSync(join(f.path, 'README.md'), 'Draft written during fetch');
        else writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8').replace('name: Source', 'name: Renamed'));
        f.override(undefined);
      }
      return undefined;
    });
    const result = await f.act('update');
    assert.equal(result.error, kind === 'files' ? 'git-local-changes' : 'revision-conflict');
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.calls.some(args => args.includes('merge')), false);
    if (kind === 'files') assert.equal(readFileSync(join(f.path, 'README.md'), 'utf8'), 'Draft written during fetch');
  } finally {await f.cleanup();}
});

test('startup checks run once without changing files; subsequent checks and updates remain manual', async () => {
  const f = await fixture({intervalMs: 50, initialDelayMs: 1});
  try {
    let fetched!: () => void;
    const firstFetch = new Promise<void>(resolve => {fetched = resolve;});
    f.override(args => {if (args.includes('fetch')) fetched(); return undefined;});
    const head = f.git('rev-parse', 'HEAD'); f.advance(); f.sync.startAutomaticChecks();
    await waitForScheduledCheck(firstFetch);
    await f.sync.start(f.item.id, 'check', f.store.revision());
    assert.equal((await f.state()).behind, 1);
    const latest = f.advance();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.calls.filter(args => args.includes('fetch')).length, 1);
    assert.equal((await f.state()).behind, 1);
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.calls.some(args => args.includes('merge')), false);
    assert.equal((await f.act('check')).behind, 2);
    assert.equal((await f.act('update')).status, 'current');
    assert.equal(f.git('rev-parse', 'HEAD'), latest);
  } finally {await f.cleanup();}
});

/** The fixture origin is a working repository, so its checked-out branch must accept a push. */
function allowPushToOrigin(f: Awaited<ReturnType<typeof fixture>>) {
  f.source('config', 'receive.denyCurrentBranch', 'ignore');
  // This must stay synchronous for non-push calls: the fixture treats any returned value as an override,
  // and an async function would answer every fetch with an empty promise.
  f.override((args, cwd, options) => {
    if (!args.includes('push')) return undefined;
    const copy = [...args]; copy[copy.indexOf('--') + 1] = f.outside;
    return execute('git', copy, {cwd, signal: options?.signal, timeout: 15_000, encoding: 'utf8'}).then(result => result.stdout.trim());
  });
}
/** Commit needs a resolvable identity; the fixture origin is not the machine's global configuration. */
function giveIdentity(f: Awaited<ReturnType<typeof fixture>>) {
  f.git('config', 'user.name', 'Fixture'); f.git('config', 'user.email', 'fixture@example.com');
}

test('commit stages every change, reports the branch ahead and never runs repository hooks', async () => {
  const f = await fixture();
  try {
    giveIdentity(f);
    assert.equal((await f.act('check')).status, 'current');
    const marker = join(f.base, 'pre-commit-ran');
    writeFileSync(join(f.path, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, {mode: 0o755});
    writeFileSync(join(f.path, 'README.md'), '# Local edit\n');
    writeFileSync(join(f.path, 'untracked.txt'), 'new\n');
    // Read the working tree directly; a snapshot may still be inside its short read cache.
    assert.notEqual(f.git('status', '--porcelain'), '');
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, 'panel commit');
    const after = await f.state();
    assert.equal(after.error, undefined); assert.equal(after.dirty, false);
    assert.equal(after.status, 'ahead'); assert.equal(after.ahead, 1);
    assert.equal(f.git('log', '-1', '--pretty=%s'), 'panel commit');
    assert.match(f.git('show', '--name-only', '--pretty=format:', 'HEAD'), /untracked\.txt/);
    assert.equal(existsSync(marker), false, 'the panel commit must not run repository hooks');
  } finally {await f.cleanup();}
});

test('commit refuses an empty message, a clean tree and a missing identity', async () => {
  const f = await fixture();
  try {
    giveIdentity(f);
    writeFileSync(join(f.path, 'README.md'), '# Local edit\n');
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, '   ');
    assert.equal((await f.state()).error, 'git-commit-message-required');
    assert.equal(f.git('log', '--pretty=%s'), 'fixture', 'a refused commit leaves history untouched');
    f.git('config', 'user.email', '');
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, 'panel commit');
    assert.equal((await f.state()).error, 'git-identity-missing');
    giveIdentity(f);
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, 'panel commit');
    assert.equal((await f.state()).error, undefined);
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, 'again');
    assert.equal((await f.state()).error, 'git-nothing-to-commit');
  } finally {await f.cleanup();}
});

test('push advances only a fast-forward, never forces and records the pushed tracking branch', async () => {
  const f = await fixture();
  try {
    allowPushToOrigin(f); giveIdentity(f);
    assert.equal((await f.act('check')).status, 'current');
    writeFileSync(join(f.path, 'README.md'), '# Local work\n');
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, 'local work');
    const local = f.git('rev-parse', 'HEAD');
    await f.sync.start(f.item.id, 'push', f.store.revision());
    const after = await f.state();
    assert.equal(after.error, undefined);
    assert.equal(after.status, 'current'); assert.equal(after.ahead, 0);
    assert.equal(f.source('rev-parse', 'HEAD'), local);
    const pushes = f.calls.filter(args => args.includes('push'));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]!.at(-1), 'main:refs/heads/main');
    assert.equal(pushes[0]!.some(value => /^--force|^-f$|force-with-lease/.test(value)), false, 'push must never force');
    assert.equal(f.git('rev-parse', 'refs/remotes/origin/main'), local);
  } finally {await f.cleanup();}
});

test('push refuses diverged history and a branch with nothing to push', async () => {
  const f = await fixture();
  try {
    allowPushToOrigin(f); giveIdentity(f);
    assert.equal((await f.act('check')).status, 'current');
    await f.sync.start(f.item.id, 'push', f.store.revision());
    assert.equal((await f.state()).error, 'git-nothing-to-push');
    writeFileSync(join(f.path, 'README.md'), '# Local work\n');
    await f.sync.start(f.item.id, 'commit', f.store.revision(), true, 'local work');
    f.advance(); await f.act('check');
    assert.equal((await f.state()).status, 'diverged');
    await f.sync.start(f.item.id, 'push', f.store.revision());
    assert.equal((await f.state()).error, 'git-history-diverged');
    assert.equal(f.calls.filter(args => args.includes('push')).length, 0, 'a refused push never reaches Git');
  } finally {await f.cleanup();}
});

test('changes reports the modified, untracked, deleted and renamed files a commit would include', async () => {
  const f = await fixture();
  try {
    giveIdentity(f);
    writeFileSync(join(f.path, 'removed.txt'), 'gone\n');
    writeFileSync(join(f.path, 'renamed.txt'), 'x\n');
    f.git('add', 'removed.txt', 'renamed.txt');
    f.git('commit', '--quiet', '-m', 'add fixtures');
    writeFileSync(join(f.path, 'README.md'), '# Edited\n');
    writeFileSync(join(f.path, 'untracked.txt'), 'new\n');
    rmSync(join(f.path, 'removed.txt'));
    f.git('mv', 'renamed.txt', 'renamed-new.txt');
    const {files} = await f.sync.changes(f.item.id);
    assert.deepEqual(Object.fromEntries(files.map(file => [file.path, file.status])),
      {'README.md': 'modified', 'untracked.txt': 'untracked', 'removed.txt': 'deleted', 'renamed-new.txt': 'renamed'});
  } finally {await f.cleanup();}
});

test('branches lists local and remote names; switching refuses local changes and unknown branches', async () => {
  const f = await fixture();
  try {
    const listed = await f.sync.branches(f.item.id);
    assert.equal(listed.current, 'main'); assert.equal(listed.remoteName, 'origin');
    assert.deepEqual(listed.local, ['main']);
    assert.deepEqual(listed.remote, ['feature', 'main']);
    f.git('branch', 'work');
    await f.sync.start(f.item.id, 'switch', f.store.revision(), true, 'work');
    assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'work');
    await f.sync.start(f.item.id, 'switch', f.store.revision(), true, 'nope');
    assert.equal((await f.state()).error, 'git-branch-missing');
    await f.sync.start(f.item.id, 'switch', f.store.revision(), true, '-x');
    assert.equal((await f.state()).error, 'resource-branch-invalid');
    writeFileSync(join(f.path, 'README.md'), '# Uncommitted\n');
    await f.sync.start(f.item.id, 'switch', f.store.revision(), true, 'main');
    assert.equal((await f.state()).error, 'git-local-changes');
    assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'work', 'a refused switch keeps the current branch');
  } finally {await f.cleanup();}
});
