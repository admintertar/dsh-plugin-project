import {strict as assert} from 'node:assert';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {readCompatibilityPin} from '../src/desktop-runtime.ts';
import {readProjectShellRuntime, resolveProjectShell, verifyProjectShell} from '../src/project-shell-development.ts';

test('development resolves the saved independent Shell and rejects the old checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-shell-path-'));
  try {
    assert.throws(() => resolveProjectShell(root), /Run npm run setup/);
    mkdirSync(join(root, '.dev'));
    writeFileSync(join(root, '.dev/runtime-source.json'), JSON.stringify({desktop: root, edition: 'beta'}));
    assert.throws(() => resolveProjectShell(root), /Run npm run setup/, 'never falls back to the retired Desktop path');
    writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'dsh-desktop'}));
    assert.throws(() => resolveProjectShell(root, root), /independent dsh-project-desktop/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'dsh-project-desktop'}));
    writeFileSync(join(root, '.dev/runtime-source.json'), JSON.stringify({shell: root}));
    assert.equal(resolveProjectShell(root), realpathSync(root));
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('Shell validation rejects beta, altered pins, stale inventory and failed source integrity', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-shell-pin-'));
  const pin = readCompatibilityPin(process.cwd());
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(data));
  };
  const lock = {channel: 'stable', desktop: {...pin.desktop, package: 'dsh-plugin-desktop'}, harness: pin.harness.stable};
  const lockPath = join(root, 'upstream.lock.json');
  const inventory = join(root, '.upstream/desktop/vendor/dsh-runtime', lock.harness.version, 'manifest.json');
  try {
    write(join(root, 'package.json'), {name: 'dsh-project-desktop'});
    write(lockPath, lock);
    write(join(root, '.upstream/desktop/dsh-plugin-desktop/package.json'), {
      name: 'dsh-plugin-desktop', version: pin.desktop.version, dependencies: {'@deepseek-ai/dsh': lock.harness.version},
    });
    write(join(root, '.upstream/desktop/upstream.json'), {channels: {stable: {
      package: 'dsh-plugin-desktop', commit: lock.harness.commit, runtimePackageVersion: lock.harness.version,
    }}});
    write(inventory, {...lock.harness, packages: []});
    assert.deepEqual(readProjectShellRuntime(process.cwd(), root).harness, lock.harness);
    write(lockPath, {...lock, channel: 'beta'});
    assert.throws(() => readProjectShellRuntime(process.cwd(), root), /Only.*stable/);
    write(lockPath, {...lock, desktop: {...lock.desktop, commit: 'different'}});
    assert.throws(() => readProjectShellRuntime(process.cwd(), root), /pins differ/);
    write(lockPath, {...lock, harness: pin.harness.beta});
    assert.throws(() => readProjectShellRuntime(process.cwd(), root), /pins differ/);
    write(lockPath, lock);
    write(inventory, {...lock.harness, commit: 'different', packages: []});
    assert.throws(() => readProjectShellRuntime(process.cwd(), root), /inventory differs/);
    write(inventory, {...lock.harness, packages: []});
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/verify-upstream.mjs'), 'process.exit(7);');
    assert.throws(() => verifyProjectShell(process.cwd(), root), /Command failed/);
  } finally {rmSync(root, {recursive: true, force: true});}
});
