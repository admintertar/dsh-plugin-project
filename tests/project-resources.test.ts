import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse, stringify} from 'yaml';
import {readProject, projectContext} from '../src/project.ts';
import {ProjectResourceStore} from '../src/project-resources.ts';
import {ProjectTaskStore} from '../src/tasks.ts';
import {validResourceUrl} from '../src/resource-contract.ts';
import {resourceFixture, gitFixture} from './fixtures/resources.ts';

test('resources preserve YAML comments and keep external paths local across add, rename, bind and remove', async () => {
  const f = resourceFixture();
  try {
    writeFileSync(f.manifest, '# portable project\n' + readFileSync(f.manifest, 'utf8').replace('resources:', 'resources: # resource list'));
    const sourceFile = join(f.outside, 'source.txt'); writeFileSync(sourceFile, 'keep me');
    await f.store.mutate({action: 'addLocal', name: 'Reference', type: 'local', path: f.outside, expectedRevision: f.store.revision()});
    const item = f.store.read().resources.find(item => item.name === 'Reference')!;
    assert.equal(item.path, f.outside); assert.equal(item.external, true); assert.equal(item.bound, true);
    assert.doesNotMatch(readFileSync(f.manifest, 'utf8'), new RegExp(f.outside));
    assert.match(readFileSync(f.manifest, 'utf8'), /# portable project|# resource list/);
    const local = join(f.root, '.agent-project', 'local.yaml');
    assert.equal(parse(readFileSync(local, 'utf8')).resources[item.id], f.outside);
    if (process.platform !== 'win32') assert.equal(statSync(local).mode & 0o777, 0o600);
    assert.match(readFileSync(join(f.root, '.agent-project/.gitignore'), 'utf8'), /\/local.yaml/);
    await f.store.mutate({action: 'edit', id: item.id, name: 'Renamed', expectedRevision: f.store.revision()});
    assert.equal(f.store.read().resources.find(item => item.name === 'Renamed')!.id, item.id);
    const inside = join(f.root, 'notes'); mkdirSync(inside);
    await f.store.mutate({action: 'bind', id: item.id, path: inside, expectedRevision: f.store.revision()});
    assert.equal(f.store.definition(item.id).path, 'notes');
    assert.equal(f.store.read().resources.find(entry => entry.id === item.id)!.bound, false);
    await f.store.mutate({action: 'remove', id: item.id, expectedRevision: f.store.revision()});
    await assert.rejects(f.store.mutate({action: 'remove', id: 'root', expectedRevision: f.store.revision()}), /resource-project-root/);
    assert.deepEqual(f.store.read().resources.map(item => item.id), ['root']);
    assert.equal(readFileSync(sourceFile, 'utf8'), 'keep me'); assert.ok(existsSync(inside));
  } finally {f.cleanup();}
});

test('resource revisions reject external edits and canonical paths reject duplicates without copying files', async () => {
  const f = resourceFixture();
  try {
    const revision = f.store.revision();
    writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8') + '# external edit\n');
    await assert.rejects(f.store.mutate({action: 'addLocal', type: 'local', name: 'Outside', path: f.outside, expectedRevision: revision}), /revision-conflict/);
    assert.equal(f.store.read().resources.length, 1);
    const alias = join(f.root, 'alias'); symlinkSync(f.outside, alias);
    await f.store.mutate({action: 'addLocal', type: 'local', name: 'Outside', path: alias, expectedRevision: f.store.revision()});
    assert.equal(f.store.read().resources[1]!.external, true);
    assert.equal((await f.store.inspect(f.outside)).duplicateId, f.store.read().resources[1]!.id);
    await assert.rejects(f.store.mutate({action: 'addLocal', type: 'local', name: 'Duplicate', path: f.outside, expectedRevision: f.store.revision()}), /resource-duplicate/);
    await assert.rejects(f.store.mutate({action: 'addLocal', type: 'local', name: 'Root', path: f.root, expectedRevision: f.store.revision()}), /resource-duplicate/);
  } finally {f.cleanup();}
});

for (const stage of ['journal', 'manifest', 'local'] as const) test(`resource transactions recover a crash after ${stage} without losing either file`, async () => {
  const f = resourceFixture();
  try {
    const store = new ProjectResourceStore(f.manifest, undefined, current => {if (current === stage) throw new Error('injected interruption');});
    await assert.rejects(store.mutate({action: 'addLocal', type: 'local', name: 'Recovered', path: f.outside, expectedRevision: store.revision()}), /injected interruption/);
    assert.ok(existsSync(join(f.root, '.agent-project/resource-transaction.json')));
    const reopened = new ProjectResourceStore(f.manifest);
    assert.equal(reopened.read().resources.find(item => item.name === 'Recovered')!.path, f.outside);
    assert.equal(existsSync(join(f.root, '.agent-project/resource-transaction.json')), false);
    assert.equal(reopened.read().resources.length, 2);
  } finally {f.cleanup();}
});

test('resource recovery refuses unrelated external edits and metadata symlinks', async () => {
  const f = resourceFixture();
  try {
    const store = new ProjectResourceStore(f.manifest, undefined, () => {throw new Error('interrupt');});
    await assert.rejects(store.mutate({action: 'addLocal', type: 'local', name: 'Resource', path: f.outside, expectedRevision: store.revision()}));
    writeFileSync(f.manifest, '# externally edited\n' + readFileSync(f.manifest, 'utf8'));
    const before = readFileSync(f.manifest, 'utf8');
    assert.throws(() => readProject(f.manifest), /resource-recovery-conflict/);
    assert.equal(readFileSync(f.manifest, 'utf8'), before);
  } finally {f.cleanup();}
  const g = resourceFixture();
  try {
    rmSync(join(g.root, '.agent-project'), {recursive: true});
    symlinkSync(g.outside, join(g.root, '.agent-project'));
    await assert.rejects(g.store.mutate({action: 'addLocal', type: 'local', name: 'Resource', path: g.outside, expectedRevision: 'x'.repeat(64)}), /resource-config-invalid/);
    assert.equal(existsSync(join(g.outside, 'local.yaml')), false);
  } finally {g.cleanup();}
});

test('unbound and unavailable resources do not fall back to root task artifacts or break the project', async () => {
  const f = resourceFixture();
  try {
    const data = parse(readFileSync(f.manifest, 'utf8'));
    data.resources.push({id: 'unbound', name: 'Unbound', type: 'local'}, {id: 'file', name: 'Not a directory', type: 'local', path: 'report.md'});
    writeFileSync(f.manifest, stringify(data)); writeFileSync(join(f.root, 'report.md'), 'wrong root file');
    const view = f.store.read();
    assert.equal(view.resources[1]!.status, 'unbound'); assert.equal(view.resources[1]!.path, undefined);
    assert.equal(view.resources[2]!.status, 'unavailable');
    assert.match(projectContext(view), /directory not bound/);
    const tasks = new ProjectTaskStore(view);
    assert.equal(tasks.referencePath({id: 'ref', label: 'Unbound', type: 'file', resourceId: 'unbound', path: 'report.md'}), undefined);
    const task = tasks.create({title: 'History', objective: 'Keep references', operationId: 'create'}, {sessionId: 'session'}).task;
    assert.throws(() => tasks.update(task.id, {operationId: 'artifact', expectedRevision: task.revision,
      artifacts: [{type: 'file', path: 'artifacts/report.md', source: {resourceId: 'unbound', path: 'report.md'}}]}, {sessionId: 'session'}), /[Uu]navailable/);
  } finally {f.cleanup();}
});

test('Git directory inspection recognizes roots and worktrees, filters credentials, and requires explicit origin rebinding', async () => {
  const f = resourceFixture();
  try {
    const git = gitFixture(f.outside); git('remote', 'add', 'origin', 'https://example.com/source.git');
    mkdirSync(join(f.outside, 'subdir'));
    assert.equal((await f.store.inspect(join(f.outside, 'subdir'))).git, undefined);
    await f.store.mutate({action: 'addLocal', type: 'git', url: 'https://example.com/source.git', name: 'Git', path: f.outside, expectedRevision: f.store.revision()});
    const item = f.store.read().resources[1]!;
    const other = join(f.base, 'other'); const otherGit = gitFixture(other);
    otherGit('remote', 'add', 'origin', 'https://example.com/other.git');
    await assert.rejects(f.store.mutate({action: 'bind', id: item.id, path: other, expectedRevision: f.store.revision()}), /resource-origin-mismatch/);
    await f.store.mutate({action: 'bind', id: item.id, path: other, originChoice: 'keep', expectedRevision: f.store.revision()});
    assert.equal(f.store.definition(item.id).url, 'https://example.com/source.git');
    assert.equal(otherGit('remote', 'get-url', 'origin'), 'https://example.com/other.git');
    const worktree = join(f.base, 'worktree'); git('worktree', 'add', worktree, 'feature');
    assert.equal((await f.store.inspect(worktree)).git?.branch, 'feature');
    git('remote', 'set-url', 'origin', 'https://private-user:secret-fixture@example.com/repo');
    assert.doesNotMatch(JSON.stringify(await f.store.inspect(f.outside)), /private-user|secret-fixture/);
  } finally {f.cleanup();}
});

test('a local Git working tree is accepted as a Git resource before it has an origin remote', async () => {
  const f = resourceFixture();
  try {
    gitFixture(f.outside);
    const inspection = await f.store.inspect(f.outside);
    assert.equal(inspection.git?.branch, 'main'); assert.equal(inspection.git?.url, undefined);
    // A claimed URL must still match the detected origin, so an unlinked repository cannot inherit a stale one.
    await assert.rejects(f.store.mutate({action: 'addLocal', type: 'git', url: 'https://example.com/source.git', name: 'Mismatch',
      path: f.outside, expectedRevision: f.store.revision()}), /resource-git-invalid/);
    const plain = join(f.base, 'plain'); mkdirSync(plain);
    await assert.rejects(f.store.mutate({action: 'addLocal', type: 'git', name: 'Not a repository',
      path: plain, expectedRevision: f.store.revision()}), /resource-git-invalid/);
    await f.store.mutate({action: 'addLocal', type: 'git', name: 'Local repository', path: f.outside, expectedRevision: f.store.revision()});
    const item = f.store.read().resources[1]!;
    assert.equal(item.type, 'git'); assert.equal(item.url, undefined); assert.equal(item.path, f.outside);
    assert.doesNotMatch(readFileSync(f.manifest, 'utf8'), /url:/);
  } finally {f.cleanup();}
});

test('Git URL validation rejects credentials, option/helper injection and local transport', () => {
  for (const url of ['https://github.com/example/repo.git', 'ssh://git@example.com:2222/repo', 'git@example.com:group/repo.git']) assert.equal(validResourceUrl(url), true, url);
  for (const url of ['--upload-pack=x', 'ext::touch /tmp/nope', '/tmp/repo', 'file:///tmp/repo', 'http://example.com/repo', 'git://example.com/repo',
    'https://user:secret@example.com/repo', 'https://user@example.com/repo', 'ssh://git:secret@example.com/repo',
    'https://example.com/repo?token=secret', 'https://example.com/repo#secret', 'https://example.com/%0a--evil', 'git@host:repo\n--evil']) assert.equal(validResourceUrl(url), false, url);
});
