import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {readCompatibilityPin} from '../src/desktop-runtime.ts';
import {exportOfficialRuntime} from '../src/official-runtime-development.ts';

test('official runtime export uses the exact commit, excludes unrelated files and rejects invalid pins', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-official-runtime-')));
  const desktop = join(root, 'desktop');
  const repository = join(root, 'plugin');
  const pin = readCompatibilityPin(process.cwd());
  const runtime = pin.harness.stable;
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(value));
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', desktop, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  try {
    write(join(desktop, 'dsh-plugin-desktop/package.json'), {
      name: 'dsh-plugin-desktop', version: pin.desktop.version, dependencies: {'@deepseek-ai/dsh': runtime.version},
    });
    write(join(desktop, 'upstream.json'), {channels: {stable: {
      package: 'dsh-plugin-desktop', commit: runtime.commit, runtimePackageVersion: runtime.version,
    }}});
    const inventory = `vendor/dsh-runtime/${runtime.version}/manifest.json`;
    write(join(desktop, inventory), {...runtime, packages: []});
    write(join(desktop, 'unrelated.json'), {excluded: true});
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
    pin.desktop.commit = git('rev-parse', 'HEAD');
    write(join(repository, 'upstream.json'), pin);
    // A dirty source checkout must neither affect the export nor be changed by it.
    write(join(desktop, inventory), {dirty: true});
    const prepared = exportOfficialRuntime(repository, desktop);
    assert.deepEqual(prepared.harness, runtime);
    assert.equal(prepared.desktopSource, desktop);
    assert.equal(existsSync(join(prepared.snapshot, 'unrelated.json')), false);
    assert.equal(existsSync(join(prepared.snapshot, '.git')), false);
    assert.equal(existsSync(join(prepared.snapshot, 'runtime.tar')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(desktop, inventory), 'utf8')), {dirty: true});
    pin.desktop.commit = '1'.repeat(40);
    write(join(repository, 'upstream.json'), pin);
    assert.throws(() => exportOfficialRuntime(repository, desktop));
    // Metadata mismatch must remove only its newly allocated snapshot.
    pin.desktop.commit = git('rev-parse', 'HEAD');
    pin.desktop.version = '999.0.0';
    write(join(repository, 'upstream.json'), pin);
    assert.throws(() => exportOfficialRuntime(repository, desktop), /Desktop version differs/);
    assert.equal(readdirSync(join(repository, '.dev')).length, 1);
  } finally {rmSync(root, {recursive: true, force: true});}
});
