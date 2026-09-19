import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse, stringify} from 'yaml';
import {associateResourceRemote} from '../src/resource-remote.ts';
import {ProjectResourceStore} from '../src/project-resources.ts';
import {runResourceGit, type GitRun} from '../src/resource-git.ts';
import {resourceFixture, gitFixture} from './fixtures/resources.ts';

test('association records the portable remote and configures an unborn branch without touching local work', async () => {
  const f = resourceFixture();
  try {
    const path = join(f.root, 'resources/api'), git = gitFixture(path, true);
    const data = parse(readFileSync(f.manifest, 'utf8'));
    data.resources.push({id: 'api', name: 'API', type: 'git', path: 'resources/api'});
    writeFileSync(f.manifest, stringify(data));
    writeFileSync(join(path, 'draft.txt'), 'local work'); git('add', 'draft.txt');
    const index = readFileSync(join(path, '.git/index'));
    await f.store.mutate({action: 'associate', id: 'api', url: 'https://example.com/api.git', expectedRevision: f.store.revision()});
    assert.equal(f.store.definition('api').url, 'https://example.com/api.git');
    assert.equal(git('remote', 'get-url', 'origin'), 'https://example.com/api.git');
    assert.equal(git('config', 'branch.main.merge'), 'refs/heads/main');
    assert.equal(git('config', 'branch.main.remote'), 'origin');
    assert.deepEqual(readFileSync(join(path, '.git/index')), index);
    assert.equal(readFileSync(join(path, 'draft.txt'), 'utf8'), 'local work');
    assert.throws(() => git('rev-parse', '--verify', 'HEAD'));
    await assert.rejects(f.store.mutate({action: 'associate', id: 'api', url: 'https://example.com/other.git', expectedRevision: f.store.revision()}), /resource-origin-mismatch/);
    assert.equal(git('remote', 'get-url', 'origin'), 'https://example.com/api.git');
    await assert.rejects(f.store.mutate({action: 'associate', id: 'root', url: 'https://example.com/root.git', expectedRevision: f.store.revision()}), /resource-project-root/);
  } finally {f.cleanup();}
});

test('failed association restores its config values and preserves unrelated concurrent Git configuration', async () => {
  const f = resourceFixture();
  try {
    const git = gitFixture(f.outside);
    git('config', 'branch.main.remote', 'previous'); git('config', 'branch.main.merge', 'refs/heads/previous');
    const calls: string[][] = [];
    const run: GitRun = (args, cwd, options) => {calls.push([...args]); return runResourceGit(args, cwd, options);};
    await assert.rejects(associateResourceRemote(f.outside, 'https://example.com/api.git', 'feature/demo', run, () => {}, () => {
      git('config', 'user.name', 'Concurrent user'); throw new Error('save failed');
    }), /save failed/);
    assert.equal(git('remote'), '');
    assert.equal(git('config', 'branch.main.remote'), 'previous');
    assert.equal(git('config', 'branch.main.merge'), 'refs/heads/previous');
    assert.equal(git('config', 'user.name'), 'Concurrent user');
    assert.equal(calls.some(args => args.some(value => ['fetch', 'push', 'clone', 'checkout'].includes(value))), false);
    for (const [url, branch] of [['https://user:secret@example.com/repo', 'main'], ['https://example.com/repo', '../bad']]) {
      await assert.rejects(associateResourceRemote(f.outside, url!, branch, run, () => {}, () => assert.fail()));
    }
    assert.equal(git('remote'), '');
  } finally {f.cleanup();}
});

for (const stage of ['journal', 'manifest', 'local'] as const) test(`association completes a prepared ${stage} transaction with matching Git configuration`, async () => {
  const f = resourceFixture();
  try {
    const path = join(f.root, 'api'), git = gitFixture(path, true);
    const data = parse(readFileSync(f.manifest, 'utf8'));
    data.resources.push({id: 'api', name: 'API', type: 'git', path: 'api'}); writeFileSync(f.manifest, stringify(data));
    const store = new ProjectResourceStore(f.manifest, undefined, at => {if (at === stage) throw new Error('interrupted write');});
    const url = 'https://example.com/api.git';
    await store.mutate({action: 'associate', id: 'api', url, expectedRevision: store.revision()});
    assert.equal(new ProjectResourceStore(f.manifest).definition('api').url, url);
    assert.equal(git('remote', 'get-url', 'origin'), url);
    assert.equal(git('config', 'branch.main.remote'), 'origin');
  } finally {f.cleanup();}
});
