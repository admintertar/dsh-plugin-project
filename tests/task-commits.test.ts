import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {writeFileSync, readFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {resourceFixture, gitFixture} from './fixtures/resources.ts';
import {ProjectTaskStore} from '../src/tasks.ts';
import {TaskCommitReader} from '../src/task-commits.ts';
import {ResourceGitError, runResourceGit, type GitRun} from '../src/resource-git.ts';
import {repositoryIdentity, commitWebUrl} from '../src/task-commit-contract.ts';
import {ResourceGitAuthentication} from '../src/resource-auth.ts';

const url = 'https://example.com/org/repository.git';
async function fixture() {
  const f = resourceFixture(); const source = gitFixture(f.outside);
  const local = join(f.root, 'repository');
  execFileSync('git', ['clone', '--', f.outside, local], {stdio: 'ignore'});
  const git = (...args: string[]) => execFileSync('git', args, {cwd: local, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('remote', 'set-url', 'origin', url);
  await f.store.mutate({action: 'addLocal', expectedRevision: f.store.revision(), name: 'Repository', path: local, type: 'git', url});
  const tasks = new ProjectTaskStore(f.store.read());
  const task = tasks.create({title: 'Commits', objective: 'Review historical changes', operationId: 'create'}).task;
  const record = (commit: string) => {
    const taskNow = tasks.get(task.id);
    const updated = tasks.update(task.id, {operationId: `record-${commit}`, expectedRevision: taskNow.revision,
      artifacts: [{type: 'commit', repository: url.replace(/\.git$/, ''), commit}]}).task;
    return {id: updated.id, index: updated.artifacts.length - 1, revision: updated.revision};
  };
  const commit = (message: string) => {git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message); return git('rev-parse', 'HEAD');};
  const reader = new TaskCommitReader(() => f.store.read(), () => tasks);
  return {...f, local, git, source, tasks, task, record, commit, reader, cleanup: async () => {await reader.dispose(); f.cleanup();}};
}

for (const cancelled of [false, true]) test(`commit fetch authentication ${cancelled ? 'ends when the preview closes' : 'continues in the original task and resource scope'}`, async () => {
  const f = await fixture(); const auth = new ResourceGitAuthentication(); const abort = new AbortController();
  let authenticatedFetches = 0;
  const run: GitRun = async (args, cwd, options) => {
    if (!args.includes('fetch')) return runResourceGit(args, cwd, options);
    if (!options?.auth) throw new ResourceGitError('git-auth-required');
    assert.equal(options.auth.url, url); authenticatedFetches++; return '';
  };
  const reader = new TaskCommitReader(() => f.store.read(), () => f.tasks, run, auth);
  const request = f.record(f.git('rev-parse', 'HEAD'));
  const work = reader.preview(request, {fetch: true, signal: abort.signal});
  const result = work.then(data => data, error => error as Error);
  try {
    for (let i = 0; i < 500 && !auth.snapshot().requests.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(auth.snapshot().requests.length, 1); assert.equal(auth.snapshot().requests[0]!.action, 'commit');
    if (cancelled) abort.abort();
    else auth.answer(auth.snapshot().requests[0]!.id, {kind: 'https', username: 'fixture', password: 'private-task-auth-fixture'});
    const done = await result;
    if (cancelled) assert.ok(done instanceof Error);
    else {assert.ok(!(done instanceof Error)); assert.equal(done.state, 'ready');}
    assert.equal(authenticatedFetches, cancelled ? 0 : 1); assert.equal(auth.snapshot().requests.length, 0);
  } finally {abort.abort(); auth.dispose(); await result; await reader.dispose(); await f.cleanup();}
});

test('commit previews read immutable history, exact edits, renamed paths, binaries, large files and mode changes', {skip: process.platform === 'win32'}, async () => {
  const f = await fixture();
  try {
    const strange = '名称\twith space\nfile.txt';
    writeFileSync(join(f.local, strange), 'old line\nkept\n');
    const initial = f.commit('Prepare names');
    f.git('mv', 'README.md', 'renamed.md');
    writeFileSync(join(f.local, strange), 'new line  \nkept\n');
    writeFileSync(join(f.local, 'binary.bin'), Buffer.from([0, 255, 1]));
    writeFileSync(join(f.local, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
    const hash = f.commit('Changes to review'); const request = f.record(hash);
    f.git('checkout', '--detach', initial); writeFileSync(join(f.local, strange), 'UNCOMMITTED\n');
    const before = f.git('status', '--porcelain');
    const preview = await f.reader.preview(request);
    assert.equal(preview.state, 'ready'); assert.equal(preview.message, 'Changes to review'); assert.equal(preview.author, 'Fixture');
    assert.equal(preview.parents[0], initial);
    const file = async (path: string) => (await f.reader.preview(request, {file: preview.files.find(item => item.path === path)!.index})).diff!;
    const edit = await file(strange);
    assert.deepEqual(edit.changes, [{oldLine: 1, newLine: 1, oldText: 'old line\n', newText: 'new line  \n'}]);
    assert.equal(edit.added, 1); assert.equal(edit.removed, 1);
    assert.equal((await file('binary.bin')).kind, 'binary'); assert.equal((await file('large.txt')).kind, 'large');
    assert.equal(preview.files.find(item => item.path === 'renamed.md')?.previousPath, 'README.md');
    assert.deepEqual((await file('renamed.md')).changes, []);
    assert.equal(f.git('status', '--porcelain'), before); assert.equal(readFileSync(join(f.local, strange), 'utf8'), 'UNCOMMITTED\n');
    f.git('restore', '--', strange); chmodSync(join(f.local, strange), 0o755);
    const modeRequest = f.record(f.commit('Executable'));
    const mode = await f.reader.preview(modeRequest, {file: 0});
    assert.equal(mode.files[0]?.oldMode, '100644'); assert.equal(mode.files[0]?.newMode, '100755'); assert.deepEqual(mode.diff?.changes, []);
  } finally {await f.cleanup();}
});

test('initial and merge commits use empty tree and first parent; replacement refs do not rewrite the preview', async () => {
  const f = await fixture(); try {
    const rootHash = f.git('rev-list', '--max-parents=0', 'HEAD');
    const root = await f.reader.preview(f.record(rootHash), {file: 0});
    assert.deepEqual(root.parents, []); assert.equal(root.diff?.added, 1); assert.equal(root.files[0]?.status, 'A');
    f.git('checkout', '-b', 'side'); writeFileSync(join(f.local, 'side.txt'), 'Side\n'); const side = f.commit('Side');
    f.git('checkout', 'main'); writeFileSync(join(f.local, 'main.txt'), 'Main\n'); const parent = f.commit('Main');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', 'merge', '--no-ff', '-m', 'Merge', 'side');
    const merge = f.git('rev-parse', 'HEAD'); const request = f.record(merge);
    f.git('replace', merge, parent);
    const result = await f.reader.preview(request);
    assert.equal(result.message, 'Merge'); assert.deepEqual(result.parents, [parent, side]); assert.deepEqual(result.files.map(file => file.path), ['side.txt']);
  } finally {await f.cleanup();}
});

test('missing commits fetch only on an explicit request without changing HEAD, index, working files or remote refs', async () => {
  const f = await fixture(); let reader: TaskCommitReader | undefined;
  try {
    writeFileSync(join(f.outside, 'remote.txt'), 'Remote\n'); f.source('add', '.');
    f.source('-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', 'commit', '-m', 'Remote commit');
    const hash = f.source('rev-parse', 'HEAD'); const request = f.record(hash);
    const commands: string[][] = [];
    const runner: GitRun = async (args, cwd, options) => {
      commands.push([...args]);
      if (!args.includes('fetch')) return runResourceGit(args, cwd, options);
      assert.equal(args[args.indexOf('--') + 1], url); assert.equal(args.at(-1), hash);
      assert.ok(args.includes('--no-write-fetch-head')); assert.ok(args.includes('--refmap='));
      const copy = [...args]; copy[copy.indexOf('--') + 1] = f.outside;
      return execFileSync('git', copy, {cwd, encoding: 'utf8'}).trim();
    };
    reader = new TaskCommitReader(() => f.store.read(), () => f.tasks, runner);
    const head = f.git('rev-parse', 'HEAD'); const refs = f.git('show-ref');
    writeFileSync(join(f.local, 'README.md'), 'Local work\n'); f.git('add', 'README.md');
    const index = f.git('write-tree'); const before = f.git('status', '--porcelain');
    assert.equal((await reader.preview(request)).state, 'missing'); assert.equal(commands.some(args => args.includes('fetch')), false);
    assert.equal((await reader.preview(request, {fetch: true})).state, 'ready');
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('show-ref'), refs); assert.equal(f.git('write-tree'), index);
    assert.equal(f.git('status', '--porcelain'), before); assert.equal(readFileSync(join(f.local, 'README.md'), 'utf8'), 'Local work\n');
  } finally {await reader?.dispose(); await f.cleanup();}
});

test('task revisions, exact artifacts, matching resources and unchanged bindings are mandatory', async () => {
  const f = await fixture(); let reader: TaskCommitReader | undefined;
  try {
    const request = f.record(f.git('rev-parse', 'HEAD'));
    await assert.rejects(f.reader.preview({...request, revision: '0'.repeat(64)}), /task-revision-conflict/);
    await assert.rejects(f.reader.preview({...request, index: 20}), /task-commit-unavailable/);
    await assert.rejects(f.reader.preview(request, {file: 2000}), /task-commit-unavailable/);
    f.git('remote', 'set-url', 'origin', 'https://example.com/other.git');
    await assert.rejects(f.reader.preview(request, {fetch: true}), /task-commit-origin-mismatch/);
    f.git('remote', 'set-url', 'origin', url);
    let changed = false;
    reader = new TaskCommitReader(() => {
      const project = f.store.read(); return changed ? {...project, resources: project.resources.map(item => ({...item, url: 'https://example.com/other.git'}))} : project;
    }, () => f.tasks, async (...args) => {const result = await runResourceGit(...args); changed = true; return result;});
    await assert.rejects(reader.preview(request), /task-commit-resource-unavailable|task-commit-state-changed/);
  } finally {await reader?.dispose(); await f.cleanup();}
});

test('shallow history can fetch its missing parent while deletion, newline and submodule changes remain previewable', async () => {
  const f = await fixture(); let reader: TaskCommitReader | undefined;
  try {
    writeFileSync(join(f.outside, 'last.txt'), 'No final newline'); f.source('add', '.');
    f.source('-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', 'commit', '-m', 'Next');
    const hash = f.source('rev-parse', 'HEAD'); const shallow = join(f.root, 'shallow');
    execFileSync('git', ['clone', '--depth=1', 'file://' + f.outside, shallow], {stdio: 'ignore'});
    execFileSync('git', ['remote', 'set-url', 'origin', url], {cwd: shallow});
    const resourceId = f.store.read().resources.find(item => item.type === 'git')!.id;
    await f.store.mutate({action: 'bind', id: resourceId, expectedRevision: f.store.revision(), path: shallow});
    const request = f.record(hash);
    assert.equal(f.store.read().resources.find(item => item.id === resourceId)!.path, shallow);
    assert.equal(execFileSync('git', ['cat-file', '-t', hash], {cwd: shallow, encoding: 'utf8'}).trim(), 'commit');
    assert.equal(await runResourceGit(['cat-file', '-t', hash], shallow, {sync: true, literalObjects: true}), 'commit');
    reader = new TaskCommitReader(() => f.store.read(), () => f.tasks, async (args, cwd, options) => {
      if (!args.includes('fetch')) return runResourceGit(args, cwd, options);
      assert.ok(args.includes('--depth=2'));
      const copy = [...args]; copy[copy.indexOf('--') + 1] = 'file://' + f.outside;
      return execFileSync('git', copy, {cwd, encoding: 'utf8'}).trim();
    });
    assert.equal((await reader.preview(request)).state, 'parent-missing');
    assert.equal((await reader.preview(request, {fetch: true})).state, 'ready');
    assert.equal((await reader.preview(request, {file: 0})).diff?.newNoNewline, true);
    await f.store.mutate({action: 'bind', id: resourceId, expectedRevision: f.store.revision(), path: f.local});
    f.git('rm', 'README.md'); f.git('update-index', '--add', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD')},vendor`);
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Delete and submodule');
    const pointers = await f.reader.preview(f.record(f.git('rev-parse', 'HEAD')));
    const pointerRequest = {id: f.task.id, index: f.tasks.get(f.task.id).artifacts.length - 1, revision: f.tasks.get(f.task.id).revision};
    const removed = await f.reader.preview(pointerRequest, {file: pointers.files.find(file => file.status === 'D')!.index});
    assert.equal(removed.diff?.removed, 1); assert.equal(removed.diff?.added, 0);
    assert.equal((await f.reader.preview(pointerRequest, {file: pointers.files.find(file => file.path === 'vendor')!.index})).diff?.kind, 'submodule');
  } finally {await reader?.dispose(); await f.cleanup();}
});

test('tab cancellation and Host closure abort ongoing Git reads and wait for settlement', async () => {
  const f = await fixture(); let reader: TaskCommitReader | undefined;
  try {
    const signals: AbortSignal[] = [];
    reader = new TaskCommitReader(() => f.store.read(), () => f.tasks, (_args, _cwd, options) => new Promise((_resolve, reject) => {
      signals.push(options!.signal!); options!.signal!.addEventListener('abort', () => reject(new Error('stopped')), {once: true});
    }));
    const request = f.record(f.git('rev-parse', 'HEAD')); const abort = new AbortController();
    const first = assert.rejects(reader.preview(request, {signal: abort.signal}), /stopped/);
    const second = assert.rejects(reader.preview(request), /stopped/);
    abort.abort(); await first; assert.equal(signals[0]?.aborted, true); assert.equal(signals[1]?.aborted, false);
    await reader.dispose(); await second; assert.equal(signals[1]?.aborted, true);
    await assert.rejects(reader.preview(request), /project-closing/);
  } finally {await reader?.dispose(); await f.cleanup();}
});

test('repository identities normalize supported transports without broad URL or command interpretation', () => {
  assert.equal(repositoryIdentity('git@example.com:org/repo.git'), repositoryIdentity('https://example.com/org/repo/'));
  assert.equal(repositoryIdentity('ssh://git@example.com:22/org/repo.git'), repositoryIdentity('https://example.com/org/repo'));
  assert.notEqual(repositoryIdentity('ssh://git@example.com:2222/org/repo.git'), repositoryIdentity('https://example.com/org/repo'));
  assert.equal(repositoryIdentity('https://user:secret@example.com/org/repo'), undefined);
  assert.equal(commitWebUrl('javascript:alert(1)', 'a'.repeat(40)), undefined);
  assert.equal(commitWebUrl('https://github.com/org/repo.git', 'a'.repeat(40)), 'https://github.com/org/repo/commit/' + 'a'.repeat(40));
});
