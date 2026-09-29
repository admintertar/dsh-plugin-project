import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {readOfficialPin, setupOfficialSource, verifyOfficialSource} from '../src/setup-official-source.ts';

test('default development setup requires one clean official commit and links its packages', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-official-setup-')));
  const source = join(root, 'source');
  const repository = join(root, 'plugin');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, content);
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {encoding: 'utf8'}).trim();
  try {
    write(join(source, '.gitignore'), 'node_modules/\nlib/\n');
    for (const name of ['apps/desktop', 'apps/desktop-host', 'packages/mcp/mcp-client']) {
      write(join(source, name, 'package.json'), JSON.stringify({name, version: '0.2.0-rc.2'}));
    }
    write(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Pinned source');
    git('tag', 'dsh-v0.2.0-rc.2');
    const pin = {schemaVersion: 1, repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      tag: 'dsh-v0.2.0-rc.2', commit: git('rev-parse', 'HEAD'), version: '0.2.0-rc.2',
      desktopTree: git('rev-parse', 'HEAD:apps/desktop'), dependencyLockBlob: git('rev-parse', 'HEAD:pnpm-lock.yaml')};
    write(join(repository, 'upstream.json'), JSON.stringify(pin));
    for (const path of ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js', 'packages/mcp/mcp-client/lib/index.js']) {
      write(join(source, path), 'export {};\n');
    }
    write(join(source, 'node_modules/.pnpm/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'export {};\n');
    assert.deepEqual(readOfficialPin(repository), pin);
    assert.equal(verifyOfficialSource(repository, source).source, source);
    setupOfficialSource(repository, source);
    assert.equal(existsSync(join(repository, 'node_modules/@deepseek-ai/dsh/lib/bin.js')), true);
    assert.equal(JSON.parse(readFileSync(join(repository, '.dev/runtime-source.json'), 'utf8')).commit, pin.commit);
    write(join(source, 'apps/desktop/package.json'), JSON.stringify({version: 'changed'}));
    assert.throws(() => verifyOfficialSource(repository, source), /tracked changes/);
    git('checkout', '--', 'apps/desktop/package.json');
    write(join(source, 'pnpm-lock.yaml'), 'changed\n');
    assert.throws(() => verifyOfficialSource(repository, source), /tracked changes/);
    git('checkout', '--', 'pnpm-lock.yaml');
    write(join(repository, 'upstream.json'), JSON.stringify({...pin, desktopTree: '0'.repeat(40)}));
    assert.throws(() => verifyOfficialSource(repository, source), /Desktop source tree/);
    write(join(repository, 'upstream.json'), JSON.stringify(pin));
    write(join(source, 'extra.txt'), 'a newer checkout\n');
    git('add', 'extra.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Unpinned commit');
    assert.throws(() => verifyOfficialSource(repository, source), /checked out commit/);
    write(join(repository, 'upstream.json'), JSON.stringify({...pin, repository: 'https://github.com/anywhere-labs/dsh-desktop.git'}));
    assert.throws(() => readOfficialPin(repository), /Invalid pinned official/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('committed plugin pin names only the official source', () => {
  const pin = readOfficialPin(process.cwd());
  assert.equal(pin.repository, 'https://github.com/deepseek-ai/deepseek-harness.git');
  assert.equal(pin.version, '0.2.0-rc.2');
  assert.match(pin.commit, /^[a-f0-9]{40}$/);
  assert.match(pin.desktopTree, /^[a-f0-9]{40}$/);
  assert.match(pin.dependencyLockBlob, /^[a-f0-9]{40}$/);
});
