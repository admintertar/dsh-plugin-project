import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopProjectPaths} from '../src/desktop-development.ts';

test('native storage follows the canonical Project path and separates editions and Projects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'project-desktop-paths-'));
  try {
    mkdirSync(join(directory, 'project'));
    writeFileSync(join(directory, 'project/manifest.yaml'), 'fixture');
    symlinkSync(join(directory, 'project'), join(directory, 'alias'));
    writeFileSync(join(directory, 'other.yaml'), 'fixture');
    const root = join(directory, 'data');
    const first = desktopProjectPaths(root, join(directory, 'project/manifest.yaml'), 'beta');
    assert.deepEqual(first, desktopProjectPaths(root, join(directory, 'alias/manifest.yaml'), 'beta'));
    const stable = desktopProjectPaths(root, join(directory, 'project/manifest.yaml'), 'stable');
    const other = desktopProjectPaths(root, join(directory, 'other.yaml'), 'beta');
    assert.notEqual(first.home, stable.home);
    assert.notEqual(first.userData, stable.userData);
    assert.notEqual(first.home, other.home);
    assert.notEqual(first.userData, other.userData);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
