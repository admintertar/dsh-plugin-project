import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse, stringify} from 'yaml';
import {ResourceCloneManager} from '../src/resource-clones.ts';
import {ResourceSyncManager} from '../src/resource-sync.ts';
import {runResourceGit} from '../src/resource-git.ts';
import {changeSignature, mapProjectChanges, parseMcpServers, safeChangePath} from '../src/project-changes.ts';
import {ProjectMcpConfigStore} from '../src/project-mcp-config.ts';
import {stageSkillIndex} from '../src/project-staging.ts';
import {gitFixture, resourceFixture} from './fixtures/resources.ts';

/** A project root that is a Git working tree with a clean baseline commit. */
function fixture() {
  const f = resourceFixture();
  const git = gitFixture(f.root);
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'baseline');
  git('remote', 'add', 'origin', 'https://example.com/project.git');
  const clones = new ResourceCloneManager(f.store, f.runtime, runResourceGit);
  const sync = new ResourceSyncManager(clones, runResourceGit, {intervalMs: 0});
  return {...f, git, sync, cleanup: async () => {await sync.dispose(); await clones.dispose(); f.cleanup();}};
}

test('project changes are grouped into assets and unknown paths stay visible', () => {
  const entries = mapProjectChanges([
    {path: 'tasks/Alpha/', status: 'untracked'},
    {path: 'tasks/Beta/task.md', status: 'modified'},
    {path: 'tasks/Beta/artifacts/shot.png', status: 'added'},
    {path: 'skills/index.yaml', status: 'modified'},
    {path: 'skills/demo/SKILL.md', status: 'untracked'},
    {path: 'memory/working-agreements.md', status: 'modified'},
    {path: 'AGENT.md', status: 'modified'},
  ], {
    memory: [{id: 'working-agreements', name: '工作约定', path: 'memory/working-agreements.md'}],
    tasks: [{directory: 'Alpha', title: '第一条任务', artifactCount: 0}, {directory: 'Beta', title: '第二条任务', artifactCount: 3}],
  });
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get('task:Alpha')?.name, '第一条任务');
  assert.equal(byId.get('task:Alpha')?.status, 'added');
  assert.deepEqual(byId.get('task:Alpha')?.paths, ['tasks/Alpha']);
  assert.equal(byId.get('task:Beta')?.status, 'modified');
  assert.equal(byId.get('task:Beta')?.artifacts, 3);
  assert.deepEqual(byId.get('task:Beta')?.paths, ['tasks/Beta/artifacts/shot.png', 'tasks/Beta/task.md']);
  assert.equal(byId.get('skill:demo')?.kind, 'skill');
  assert.equal(byId.get('skill:demo')?.status, 'added');
  assert.equal(byId.get('skill:index.yaml')?.status, 'modified');
  assert.equal(byId.get('memory:working-agreements')?.name, '工作约定');
  assert.equal(byId.get('file:AGENT.md')?.kind, 'file');
  // Groups keep the review's order: tasks, skills, memory, MCP, other files.
  assert.deepEqual(entries.map(entry => entry.kind), ['task', 'task', 'skill', 'skill', 'memory', 'file']);
});

test('a fully deleted asset reports deletion while a partially deleted one reports an update', () => {
  const entries = mapProjectChanges([
    {path: 'tasks/Gone/task.md', status: 'deleted'},
    {path: 'tasks/Gone/artifacts/x.png', status: 'deleted'},
    {path: 'tasks/Kept/task.md', status: 'deleted'},
    {path: 'tasks/Kept/new.md', status: 'added'},
  ], {memory: [], tasks: []});
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get('task:Gone')?.status, 'deleted');
  // Without a parseable task record the directory name still identifies the asset.
  assert.equal(byId.get('task:Gone')?.name, 'Gone');
  assert.equal(byId.get('task:Kept')?.status, 'modified');
});

test('MCP declarations become one entry per server, each owning its own file', () => {
  const head = parseMcpServers([
    {path: 'mcp/servers/a.yaml', text: 'id: a\nserverName: alpha\nenabled: true\n'},
    {path: 'mcp/servers/b.yaml', text: 'id: b\nserverName: beta\nenabled: true\n'}]);
  const working = parseMcpServers([
    {path: 'mcp/servers/a.yaml', text: 'id: a\nserverName: alpha\nenabled: false\n'},
    {path: 'mcp/servers/c.yaml', text: 'id: c\nserverName: gamma\nenabled: true\n'}]);
  assert.deepEqual(head.map(server => server.id), ['a', 'b']);
  const entries = mapProjectChanges([{path: 'mcp/servers/a.yaml', status: 'modified'}],
    {memory: [], tasks: [], mcpHead: head, mcpWorking: working});
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get('mcp:a')?.status, 'modified');
  assert.equal(byId.get('mcp:b')?.status, 'deleted');
  assert.equal(byId.get('mcp:c')?.status, 'added');
  assert.equal(byId.get('mcp:c')?.name, 'gamma');
  // Every declaration reports exactly the file it lives in, so one selection never stages another.
  assert.deepEqual(byId.get('mcp:a')?.paths, ['mcp/servers/a.yaml']);
  assert.deepEqual(byId.get('mcp:b')?.paths, ['mcp/servers/b.yaml']);
  assert.deepEqual(byId.get('mcp:c')?.paths, ['mcp/servers/c.yaml']);
});

test('the retired single declaration file is skipped instead of becoming an asset', () => {
  assert.deepEqual(mapProjectChanges([{path: 'mcp/servers.yaml', status: 'deleted'}], {memory: [], tasks: []}), []);
  assert.deepEqual(mapProjectChanges([{path: 'mcp/servers.yaml', status: 'modified'}], {memory: [], tasks: []}), []);
});

test('a declaration change with no server-level difference still appears in the review', () => {
  const servers = parseMcpServers([{path: 'mcp/servers/a.yaml', text: 'id: a\nserverName: alpha\n'}]);
  const entries = mapProjectChanges([{path: 'mcp/servers.yaml', status: 'modified'}],
    {memory: [], tasks: [], mcpHead: servers, mcpWorking: servers});
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, 'mcp:mcp/servers.yaml');
  assert.equal(entries[0]?.status, 'modified');
});

test('only repository-relative project paths can be staged', () => {
  assert.equal(safeChangePath('tasks/Alpha'), 'tasks/Alpha');
  assert.equal(safeChangePath('tasks/Alpha/'), 'tasks/Alpha');
  assert.equal(safeChangePath('./memory/x.md'), 'memory/x.md');
  assert.equal(safeChangePath('tasks\\Alpha'), 'tasks/Alpha');
  assert.equal(safeChangePath('/etc/passwd'), undefined);
  assert.equal(safeChangePath('../outside'), undefined);
  assert.equal(safeChangePath('tasks/../../etc'), undefined);
  assert.equal(safeChangePath('C:/windows'), undefined);
  assert.equal(safeChangePath('tasks/ke\u0000pt'), undefined);
  assert.equal(safeChangePath('tasks//x'), undefined);
  assert.equal(safeChangePath(''), undefined);
});

test('declaration signatures ignore key order but not values', () => {
  assert.equal(changeSignature({a: 1, b: [2, {c: 3, d: 4}]}), changeSignature({b: [2, {d: 4, c: 3}], a: 1}));
  assert.notEqual(changeSignature({a: 1}), changeSignature({a: 2}));
});

test('a non-ASCII asset directory arrives as a real path, not as Git octal escapes', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'tasks', '中文任务'), {recursive: true});
    writeFileSync(join(f.root, 'tasks', '中文任务', 'task.md'), '---\nschemaVersion: 3\n---\n');
    const changes = await f.sync.projectRootChanges();
    assert.deepEqual(changes.files.map(file => file.path), ['tasks/中文任务/task.md']);
    const entries = mapProjectChanges(changes.files, {memory: [], tasks: []});
    assert.equal(entries[0]?.id, 'task:中文任务');
    assert.equal(entries[0]?.kind, 'task');
  } finally {await f.cleanup();}
});

test('committing a selection stages only the selected asset paths', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'tasks', 'Alpha'), {recursive: true});
    writeFileSync(join(f.root, 'tasks', 'Alpha', 'task.md'), '---\nschemaVersion: 3\n---\n');
    writeFileSync(join(f.root, 'AGENT.md'), '# changed\n');
    const revision = (await f.sync.projectRootStatus()).revision;
    await f.sync.commitProjectSelection([{paths: ['tasks/Alpha'], message: 'feat(task): record "Alpha"'}], revision);
    assert.equal(f.git('log', '-1', '--pretty=%s'), 'feat(task): record "Alpha"');
    assert.deepEqual(f.git('show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean), ['tasks/Alpha/task.md']);
    // The unselected change is still waiting in the working tree.
    assert.equal(f.git('status', '--porcelain').includes('AGENT.md'), true);
  } finally {await f.cleanup();}
});

test('each selected asset becomes its own commit, in review order', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'tasks', 'Alpha'), {recursive: true});
    writeFileSync(join(f.root, 'tasks', 'Alpha', 'task.md'), '---\nschemaVersion: 3\n---\n');
    mkdirSync(join(f.root, 'skills', 'demo'), {recursive: true});
    writeFileSync(join(f.root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
    const revision = (await f.sync.projectRootStatus()).revision;
    const committed = await f.sync.commitProjectSelection([
      {paths: ['tasks/Alpha'], message: 'feat(task): record "Alpha"'},
      {paths: ['skills/demo'], message: 'feat(skills): add demo'},
    ], revision);
    assert.equal(committed, 2);
    assert.deepEqual(f.git('log', '-2', '--pretty=%s').split('\n'),
      ['feat(skills): add demo', 'feat(task): record "Alpha"']);
    // Each commit owns exactly its own asset, never the whole selection.
    assert.deepEqual(f.git('show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean), ['skills/demo/SKILL.md']);
    assert.deepEqual(f.git('show', '--name-only', '--pretty=format:', 'HEAD~1').split('\n').filter(Boolean), ['tasks/Alpha/task.md']);
  } finally {await f.cleanup();}
});

test('a selection is refused for unsafe paths, an empty selection, a missing message and a staged index', async () => {
  const f = fixture();
  try {
    const revision = (await f.sync.projectRootStatus()).revision;
    await assert.rejects(() => f.sync.commitProjectSelection([{paths: ['/etc/passwd'], message: 'chore: x'}], revision),
      (error: Error) => error.message === 'resource-target-invalid');
    await assert.rejects(() => f.sync.commitProjectSelection([], revision),
      (error: Error) => error.message === 'resource-target-invalid');
    await assert.rejects(() => f.sync.commitProjectSelection([{paths: ['AGENT.md'], message: ''}], revision),
      (error: Error) => error.message === 'git-commit-message-required');
    await assert.rejects(() => f.sync.commitProjectSelection([{paths: ['AGENT.md'], message: 'chore: x'}], 'a'.repeat(64)),
      (error: Error) => error.message === 'revision-conflict');
    // A pre-staged change is refused instead of being folded into this commit.
    writeFileSync(join(f.root, 'AGENT.md'), '# staged\n');
    f.git('add', 'AGENT.md');
    await assert.rejects(() => f.sync.commitProjectSelection([{paths: ['AGENT.md'], message: 'chore: x'}], revision),
      (error: Error) => error.message === 'git-index-dirty');
    assert.equal(f.git('log', '-1', '--pretty=%s'), 'baseline');
  } finally {await f.cleanup();}
});

test('an existing single-file declaration is migrated to one file per server', async () => {
  const f = fixture();
  try {
    const legacy = join(f.root, 'mcp', 'servers.yaml');
    mkdirSync(join(f.root, 'mcp'), {recursive: true});
    writeFileSync(legacy, stringify({schemaVersion: 1, servers: [
      {id: 'alpha', serverName: 'alpha', enabled: true},
      {id: 'beta', serverName: 'beta', enabled: false},
    ]}, {lineWidth: 0}));
    // Opening the project constructs the store, which retires the single file.
    const store = new ProjectMcpConfigStore({root: f.root});
    assert.equal(existsSync(legacy), false);
    assert.deepEqual(store.list().map(server => server.id), ['alpha', 'beta']);
    assert.deepEqual(store.get('beta'), {id: 'beta', serverName: 'beta', enabled: false,
      hasEnvironment: false, hasHeaders: false, hasCwd: false});
    // Idempotent: opening again finds the same declarations and nothing left to migrate.
    const reopened = new ProjectMcpConfigStore({root: f.root});
    assert.deepEqual(reopened.list().map(server => server.id), ['alpha', 'beta']);
    assert.equal(existsSync(legacy), false);
  } finally {await f.cleanup();}
});

test('committing one Skill keeps the other Skills at the committed state', async () => {
  const f = fixture();
  try {
    const index = join(f.root, 'skills', 'index.yaml');
    mkdirSync(join(f.root, 'skills'), {recursive: true});
    const document = (alpha: boolean, beta: boolean) => stringify({schemaVersion: 1, skills: {
      alpha: {enabled: alpha}, beta: {enabled: beta}}}, {lineWidth: 0});
    writeFileSync(index, document(true, true));
    f.git('add', '-A');
    f.git('commit', '-m', 'chore: seed skills');
    writeFileSync(index, document(false, false));
    const revision = (await f.sync.projectRootStatus()).revision;
    await f.sync.commitProjectSelection([{paths: ['skills/index.yaml'], message: 'docs(skills): disable alpha'}], revision,
      async (_item, _index, readHead) => [stageSkillIndex(await readHead('skills/index.yaml'), readFileSync(index, 'utf8'), 'alpha')]);
    const committed = parse(f.git('show', 'HEAD:skills/index.yaml')) as {skills: Record<string, {enabled: boolean}>};
    assert.deepEqual(committed.skills, {alpha: {enabled: false}, beta: {enabled: true}});
    const worktree = parse(readFileSync(index, 'utf8')) as {skills: Record<string, {enabled: boolean}>};
    assert.deepEqual(worktree.skills, {alpha: {enabled: false}, beta: {enabled: false}});
  } finally {await f.cleanup();}
});
