import {strict as assert} from 'node:assert';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {readOfficialPin} from '../src/setup-official-source.ts';
import {readProjectShellRuntime, resolveProjectShell, verifyProjectShell} from '../src/project-shell-development.ts';

test('Shell development rejects the still-community Stable lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-shell-pin-'));
  const pin = readOfficialPin(process.cwd());
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'dsh-project-desktop'}));
    assert.throws(() => resolveProjectShell(root), /Run yarn run setup/);
    writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify({channel: 'stable', desktop: {
      repository: 'https://github.com/anywhere-labs/dsh-desktop.git', commit: '0'.repeat(40), version: '2.0.15',
    }}));
    assert.throws(() => readProjectShellRuntime(process.cwd(), root), /has not migrated/);
    writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify({channel: 'stable', desktop: {
      repository: pin.repository, commit: pin.commit, version: pin.version,
      tree: pin.desktopTree, dependencyLockBlob: pin.dependencyLockBlob,
    }}));
    assert.equal(readProjectShellRuntime(process.cwd(), root).pin.commit, pin.commit);
    writeFileSync(join(root, 'scripts/verify-upstream.mjs'), 'process.exit(7);');
    assert.throws(() => verifyProjectShell(process.cwd(), root), /Command failed/);
    assert.equal(resolveProjectShell(process.cwd(), root), realpathSync(root));
  } finally {rmSync(root, {recursive: true, force: true});}
});
