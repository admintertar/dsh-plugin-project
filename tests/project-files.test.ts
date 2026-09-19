import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectFile, createProjectInDirectory, findProjectFile, resolveProjectFile, RecentProjects} from '../src/project-files.ts';
import {readProject} from '../src/project.ts';

test('new project files initialize shareable metadata and leave memory empty until needed', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-files-')));
  try {
    const file = createProjectFile(join(root, '我的项目.agent-project'));
    const project = readProject(file);
    assert.equal(project.name, '我的项目');
    assert.equal(project.root, root);
    assert.equal(project.resources[0]?.path, root);
    assert.equal(existsSync(join(root, '.agent-project/.gitignore')), true);
    assert.equal(existsSync(join(root, 'memory')), false);
    assert.deepEqual(project.memory, []);
    for (const directory of ['tasks', 'skills', 'mcp']) {
      assert.equal(existsSync(join(root, directory)), true, `${directory} should be initialized`);
    }
    assert.equal(readFileSync(join(root, 'skills/index.yaml'), 'utf8'), 'schemaVersion: 1\nskills: {}\n');
    assert.equal(readFileSync(join(root, 'mcp/servers.yaml'), 'utf8'), 'schemaVersion: 1\nservers: []\n');
    assert.equal(resolveProjectFile(root), file);
    const original = readFileSync(file, 'utf8');
    assert.throws(() => createProjectFile(file), /EEXIST/);
    assert.equal(readFileSync(file, 'utf8'), original);
    createProjectFile(join(root, 'second.agent-project'));
    assert.throws(() => findProjectFile(root), /多个项目/);
    assert.equal(resolveProjectFile(file), file);
    const yaml = join(root, 'project.yaml');
    writeFileSync(yaml, original);
    assert.throws(() => resolveProjectFile(yaml), /请选择 .agent-project/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('creating from a folder names the project after it and preserves its workspace files', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'project-folder-')));
  const root = join(temporary, '我的项目');
  mkdirSync(root);
  writeFileSync(join(root, 'notes.md'), 'existing work');
  try {
    const file = createProjectInDirectory(root);
    assert.equal(file, join(root, '我的项目.agent-project'));
    const project = readProject(file);
    assert.equal(project.name, '我的项目');
    assert.equal(project.root, root);
    assert.equal(project.resources[0]?.path, root);
    assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'existing work');
    assert.deepEqual(readdirSync(root).sort(), ['.agent-project', '.gitignore', 'mcp', 'notes.md', 'skills', 'tasks', '我的项目.agent-project'].sort());
  } finally {rmSync(temporary, {recursive: true, force: true});}
});

test('folder creation reopens an existing project and rejects ambiguous folders without writing', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-existing-')));
  try {
    const existing = createProjectFile(join(root, 'different-name.agent-project'));
    const original = readFileSync(existing, 'utf8');
    assert.equal(createProjectInDirectory(root), existing);
    assert.equal(readFileSync(existing, 'utf8'), original);
    assert.deepEqual(readdirSync(root).sort(), ['.agent-project', '.gitignore', 'different-name.agent-project', 'mcp', 'skills', 'tasks'].sort());
    assert.throws(() => createProjectInDirectory(existing), /请选择项目文件夹/);
    createProjectFile(join(root, 'second.agent-project'));
    const before = readdirSync(root).sort();
    assert.throws(() => createProjectInDirectory(root), /多个项目/);
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.equal(readFileSync(existing, 'utf8'), original);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('recent projects persist in order, deduplicate and retain at most twelve entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-recents-'));
  try {
    const file = join(root, 'recent.json');
    const recent = new RecentProjects(file);
    for (let i = 0; i < 15; i++) recent.remember({path: `/p/${i}.agent-project`, title: String(i)});
    recent.remember({path: '/p/7.agent-project', title: 'Renamed'});
    const restored = new RecentProjects(file).list();
    assert.equal(restored.length, 12);
    assert.deepEqual(restored[0], {path: '/p/7.agent-project', title: 'Renamed', available: false});
    assert.equal(restored.filter(item => item.path === '/p/7.agent-project').length, 1);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('recent projects retain missing targets but mark them unavailable', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-recent-availability-')));
  const projectRoot = join(root, 'available');
  mkdirSync(projectRoot);
  const manifest = createProjectInDirectory(projectRoot);
  const recent = new RecentProjects(join(root, 'recent.json'));
  try {
    recent.remember({path: projectRoot, title: 'Available directory'});
    recent.remember({path: manifest, title: 'Available manifest'});
    assert.deepEqual(recent.list().map(item => item.available), [true, true]);
    rmSync(projectRoot, {recursive: true});
    const missing = recent.list();
    assert.deepEqual(missing.map(item => item.available), [false, false]);
    assert.deepEqual(missing.map(item => item.title), ['Available manifest', 'Available directory']);
  } finally {rmSync(root, {recursive: true, force: true});}
});


test('failed project initialization leaves no manifest and preserves existing workspace data', () => {
  for (const conflict of ['tasks', '.gitignore']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-create-failure-')));
    try {
      const path = join(root, conflict);
      if (conflict === 'tasks') writeFileSync(path, 'existing task data');
      else mkdirSync(path);
      writeFileSync(join(root, 'notes.md'), 'existing notes');
      assert.throws(() => createProjectInDirectory(root), /directory|EISDIR/);
      assert.equal(findProjectFile(root), undefined);
      assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'existing notes');
      if (conflict === 'tasks') assert.equal(readFileSync(path, 'utf8'), 'existing task data');
      else assert.ok(existsSync(path));
      rmSync(path, {recursive: true});
      assert.equal(readProject(createProjectInDirectory(root)).root, root);
    } finally {rmSync(root, {recursive: true, force: true});}
  }
});
