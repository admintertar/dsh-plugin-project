import {strict as assert} from 'node:assert';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {appendGitignoreRules, atomicWriteFile, exclusiveAtomicWriteFile} from '../src/atomic-file.ts';
import {ensureProjectLayout} from '../src/project-layout.ts';

function fixture(): {root: string; cleanup(): void} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-layout-')));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test('project capability directories are created without replacing existing content', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '.gitignore'), 'dist/\n');
    const layout = ensureProjectLayout(f.root);
    assert.equal(layout.tasks, join(f.root, 'tasks'));
    assert.equal(layout.skills, join(f.root, 'skills'));
    assert.equal(layout.mcp, join(f.root, 'mcp'));
    assert.equal(readFileSync(layout.skillIndex, 'utf8'), 'schemaVersion: 1\nskills: {}\n');
    assert.equal(readFileSync(layout.mcpServers, 'utf8'), 'schemaVersion: 1\nservers: []\n');
    const ignored = readFileSync(join(f.root, '.gitignore'), 'utf8');
    assert.match(ignored, /^dist\/$/m);
    assert.equal(existsSync(layout.memory), false);
    const metadataIgnore = join(layout.metadata, '.gitignore');
    assert.match(readFileSync(metadataIgnore, 'utf8'), /^\/task-sources\.yaml$/m);
    assert.match(ignored, /^mcp\/local\.yaml$/m);

    writeFileSync(layout.skillIndex, 'schemaVersion: 1\nskills:\n  keep: false\n');
    ensureProjectLayout(f.root);
    assert.match(readFileSync(layout.skillIndex, 'utf8'), /keep: false/);
    assert.equal(readFileSync(metadataIgnore, 'utf8').match(/\/task-sources\.yaml/g)?.length, 1);
  } finally {f.cleanup();}
});

test('Git includes memory and shared metadata while excluding machine and recovery records', () => {
  const f = fixture();
  try {
    const layout = ensureProjectLayout(f.root);
    mkdirSync(layout.memory);
    writeFileSync(join(layout.memory, 'guide.md'), '# Shared knowledge');
    for (const name of ['shared.yaml', 'local.yaml', 'task-sources.yaml', 'resource-transaction.json']) {
      writeFileSync(join(layout.metadata, name), 'fixture');
    }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], {cwd: f.root, encoding: 'utf8'}).trim();
    git('init', '--quiet');
    git('add', '--', '.agent-project', 'memory');
    assert.deepEqual(git('ls-files').split('\n'), ['.agent-project/.gitignore', '.agent-project/shared.yaml', 'memory/guide.md']);
  } finally {f.cleanup();}
});

test('initialization refuses redirected metadata and memory directories without writing through links', () => {
  for (const name of ['.agent-project', 'memory', '.agent-project/.gitignore']) {
    const f = fixture(); const outside = fixture();
    try {
      if (name.includes('/')) mkdirSync(join(f.root, '.agent-project'));
      symlinkSync(outside.root, join(f.root, name));
      assert.throws(() => ensureProjectLayout(f.root), /real project directory|regular file/);
      assert.equal(existsSync(join(f.root, 'tasks')), false);
      assert.equal(existsSync(join(outside.root, '.gitignore')), false);
    } finally {f.cleanup(); outside.cleanup();}
  }
});

test('an existing non-directory capability target fails without mutation', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'tasks'), 'keep');
    assert.throws(() => ensureProjectLayout(f.root), /tasks.*directory/i);
    assert.equal(readFileSync(join(f.root, 'tasks'), 'utf8'), 'keep');
    assert.equal(existsSync(join(f.root, 'skills')), false);
  } finally {f.cleanup();}
});

test('appending ignore rules preserves existing permissions even under a stricter umask', {skip: process.platform === 'win32'}, () => {
  const f = fixture();
  const previousUmask = process.umask(0o077);
  try {
    const path = join(f.root, '.gitignore');
    for (const mode of [0o644, 0o600, 0o664]) {
      writeFileSync(path, '# Keep this comment\ndist/');
      chmodSync(path, mode);
      appendGitignoreRules(f.root, ['tasks/local.yaml', 'mcp/local.yaml']);
      assert.equal(statSync(path).mode & 0o777, mode);
      assert.equal(readFileSync(path, 'utf8'), '# Keep this comment\ndist/\ntasks/local.yaml\nmcp/local.yaml\n');
      const before = statSync(path);
      appendGitignoreRules(f.root, ['tasks/local.yaml', 'mcp/local.yaml']);
      assert.equal(statSync(path).ino, before.ino, 'an unchanged ignore file is not replaced');
    }
  } finally {process.umask(previousUmask); f.cleanup();}
});

test('an equivalent anchored ignore rule is not appended again', () => {
  const f = fixture();
  try {
    const path = join(f.root, '.gitignore');
    // A separator inside the pattern already anchors it, so the leading slash is redundant.
    writeFileSync(path, '.DS_Store\n/mcp/local.yaml\n/tasks/.write-lock\n');
    appendGitignoreRules(f.root, ['mcp/local.yaml', 'tasks/.write-lock', 'tasks/.write-lock.recovery']);
    assert.equal(readFileSync(path, 'utf8'), '.DS_Store\n/mcp/local.yaml\n/tasks/.write-lock\ntasks/.write-lock.recovery\n');
  } finally {f.cleanup();}
});

test('an unanchored rule stays distinct from the same anchored rule', () => {
  const f = fixture();
  try {
    const path = join(f.root, '.gitignore');
    writeFileSync(path, '/local.yaml\n');
    appendGitignoreRules(f.root, ['local.yaml']);
    assert.equal(readFileSync(path, 'utf8'), '/local.yaml\nlocal.yaml\n');
  } finally {f.cleanup();}
});

test('a project using the anchored rules is left unchanged when reopened', () => {
  const f = fixture();
  try {
    const path = join(f.root, '.gitignore');
    writeFileSync(path, '.DS_Store\n/mcp/local.yaml\n/tasks/.write-lock\n/tasks/.write-lock.recovery\n');
    const before = readFileSync(path, 'utf8');
    ensureProjectLayout(f.root);
    appendGitignoreRules(f.root, ['tasks/.write-lock', 'tasks/.write-lock.recovery']);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {f.cleanup();}
});

test('a new gitignore respects umask without changing private file defaults', {skip: process.platform === 'win32'}, () => {
  const f = fixture();
  const previousUmask = process.umask(0o022);
  try {
    const layout = ensureProjectLayout(f.root);
    assert.equal(statSync(join(f.root, '.gitignore')).mode & 0o777, 0o644);
    assert.equal(statSync(layout.skillIndex).mode & 0o777, 0o600);
    assert.equal(statSync(layout.mcpServers).mode & 0o777, 0o600);
  } finally {process.umask(previousUmask); f.cleanup();}
});

test('atomic writes replace files and exclusive writes preserve an existing target', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'state.yaml');
    exclusiveAtomicWriteFile(path, 'first\n');
    assert.equal(readFileSync(path, 'utf8'), 'first\n');
    assert.throws(() => exclusiveAtomicWriteFile(path, 'second\n'));
    assert.equal(readFileSync(path, 'utf8'), 'first\n');
    atomicWriteFile(path, 'third\n', 0o600);
    assert.equal(readFileSync(path, 'utf8'), 'third\n');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {f.cleanup();}
});
