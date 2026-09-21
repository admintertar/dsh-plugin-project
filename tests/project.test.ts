import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { projectContext, readProject, updateProjectMemory } from '../src/project.ts';
import {Context} from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {ProjectTaskStore} from '../src/tasks.ts';
import {ProjectSkillService} from '../src/project-skills.ts';
import {ProjectMcpConfigStore} from '../src/project-mcp-config.ts';

test('Demo Web capabilities survive reopening without rewriting project files', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-example-reopen-')));
  const ctx = new Context();
  let skills: ProjectSkillService | undefined;
  try {
    cpSync(resolve('examples/demo-web'), root, {recursive: true});
    for (const path of ['tasks/.gitkeep', 'skills/index.yaml', 'mcp/servers.yaml']) assert.ok(existsSync(join(root, path)), path);
    const project = readProject(join(root, 'demo-web.agent-project'));
    const tasks = new ProjectTaskStore(project);
    const task = tasks.create({title: 'Keep this task', objective: 'Persist through a Host restart',
      operationId: 'create',
      brief: {acceptanceCriteria: [{id: 'saved', text: 'A persistent record is available'}]}}, {sessionId: 'local-session'}).task;
    const completed = tasks.update(task.id, {operationId: 'complete', expectedRevision: task.revision,
      status: 'completed', handoff: null, summary: 'Saved', entries: [
        {id: 'check', kind: 'verification', content: 'Read the saved record', verification: {criterionId: 'saved', criterionVersion: 1,
          method: 'Read record through Store', result: 'passed', coverage: 'Persisted record'}},
        {id: 'done', kind: 'completion', content: 'The record is saved', verificationEntryIds: ['check']},
      ]}, {sessionId: 'local-session'}).task;
    tasks.setArchived(task.id, true, {operationId: 'archive', expectedRevision: completed.revision});
    mkdirSync(join(root, 'skills/reopen-skill'));
    writeFileSync(join(root, 'skills/reopen-skill/SKILL.md'), '---\nname: reopen-skill\ndescription: Reopen fixture\n---\nRead local files.\n');
    await ctx.plugin(SkillRegistry);
    skills = new ProjectSkillService(ctx, project, {watch: false});
    await skills.setEnabled('reopen-skill', false);
    const mcp = new ProjectMcpConfigStore(project);
    mcp.upsert({id: 'local', serverName: 'local', transport: 'stdio', command: 'node', args: [], enabled: false, toolCallTimeoutMs: 1000}, {env: {FIXTURE: 'test-value'}});
    const paths = ['demo-web.agent-project', '.gitignore', `tasks/${task.directory}/task.md`, '.agent-project/task-sources.yaml',
      'skills/index.yaml', 'skills/reopen-skill/SKILL.md', 'mcp/servers.yaml', 'mcp/local.yaml'];
    const snapshot = () => paths.map(path => ({path, content: readFileSync(join(root, path), 'utf8'), mtime: statSync(join(root, path)).mtimeMs}));
    const before = snapshot();
    await skills.dispose();
    const reopened = readProject(join(root, 'demo-web.agent-project'));
    const reopenedTasks = new ProjectTaskStore(reopened);
    skills = new ProjectSkillService(ctx, reopened, {watch: false});
    assert.equal(reopenedTasks.get(task.id).status, 'completed');
    assert.equal(reopenedTasks.get(task.id).archived, true);
    assert.equal(reopenedTasks.sources(task.id).check?.sessionId, 'local-session');
    assert.equal((await skills.snapshot()).project.find(skill => skill.name === 'reopen-skill')?.enabled, false);
    assert.equal(new ProjectMcpConfigStore(reopened).list().find(server => server.id === 'local')?.hasEnvironment, true);
    assert.deepEqual(snapshot(), before);
  } finally {await skills?.dispose(); await ctx.fiber.dispose(); rmSync(root, {recursive: true, force: true});}
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-plugin-'));
  const metadata = join(root, '.agent-project');
  mkdirSync(metadata);
  const memory = join(root, 'memory');
  mkdirSync(memory);
  mkdirSync(join(root, 'backend'));
  const manifest = join(root, 'example.agent-project');
  const data = {schemaVersion: 1, id: 'example', name: 'Example', resources: [{id: 'backend', name: 'Backend', type: 'local', path: 'backend'}], memory: [] as {id: string; name: string; path: string}[]};
  return {root, metadata, memory, manifest, data, save: () => writeFileSync(manifest, stringify(data)), cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test('two projects contribute only their own resource and memory context', () => {
  const first = projectContext(readProject(resolve('examples/demo-web/demo-web.agent-project')));
  const second = projectContext(readProject(resolve('examples/research/research.agent-project')));
  assert.match(first, /DEMO_WEB_ONLY_CONTEXT/);
  assert.doesNotMatch(first, /RESEARCH_ONLY_CONTEXT/);
  assert.match(second, /RESEARCH_ONLY_CONTEXT/);
  assert.doesNotMatch(second, /DEMO_WEB_ONLY_CONTEXT/);
});
test('local resource bindings override paths without changing portable metadata', () => {
  const f = fixture();
  try {
    f.save();
    mkdirSync(join(f.root, 'elsewhere'));
    // Local and portable resource paths use the same Project-root anchor.
    writeFileSync(join(f.metadata, 'local.yaml'), stringify({resources: {backend: 'elsewhere'}}));
    assert.equal(readProject(f.manifest).resources[0]?.path, realpathSync(join(f.root, 'elsewhere')));
  } finally {f.cleanup();}
});
test('duplicate resource identities fail before a Project becomes available', () => {
  const f = fixture();
  try {f.data.resources.push({...f.data.resources[0]!}); f.save(); assert.throws(() => readProject(f.manifest), /Duplicate resources id/);}
  finally {f.cleanup();}
});
test('a missing resource is visible instead of being silently omitted', () => {
  const f = fixture();
  try {f.data.resources[0]!.path = 'missing'; f.save(); assert.equal(readProject(f.manifest).resources[0]?.status, 'missing');}
  finally {f.cleanup();}
});
test('memory cannot follow a symlink outside the project memory directory', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'outside.md'), 'unrelated data');
    symlinkSync(join(f.root, 'outside.md'), join(f.memory, 'linked.md'));
    f.data.memory.push({id: 'linked', name: 'Linked', path: 'memory/linked.md'});
    f.save();
    assert.throws(() => readProject(f.manifest), /outside the project memory directory/);
    assert.throws(() => updateProjectMemory(f.manifest, 'linked', 'overwrite'), /outside the project memory directory/);
    assert.equal(readFileSync(join(f.root, 'outside.md'), 'utf8'), 'unrelated data');
  } finally {f.cleanup();}
});
test('memory edits atomically replace only the configured file and preserve its mode', () => {
  const f = fixture();
  try {
    const path = join(f.memory, 'guide.md');
    writeFileSync(path, '# Original\n', {mode: 0o640});
    f.data.memory.push({id: 'guide', name: 'Guide', path: 'memory/guide.md'});
    f.save();
    const updated = updateProjectMemory(f.manifest, 'guide', '# Updated\n\n- one\n');
    assert.equal(updated.memory[0]?.content, '# Updated\n\n- one\n');
    assert.equal(readFileSync(path, 'utf8'), '# Updated\n\n- one\n');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.throws(() => updateProjectMemory(f.manifest, 'missing', 'nope'), /Unknown project memory/);
    assert.equal(readFileSync(path, 'utf8'), '# Updated\n\n- one\n');
  } finally {f.cleanup();}
});
test('memory reads only root memory files and rejects legacy, absolute and traversal paths', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.metadata, 'memory'));
    writeFileSync(join(f.metadata, 'memory/guide.md'), 'Legacy content');
    writeFileSync(join(f.memory, 'guide.md'), 'Root memory content');
    const item = {id: 'guide', name: 'Guide', path: 'memory/guide.md'};
    f.data.memory.push(item); f.save();
    assert.equal(readProject(f.manifest).memory[0]?.content, 'Root memory content');
    for (const path of ['guide.md', '.agent-project/memory/guide.md', 'memory/../.agent-project/memory/guide.md',
      'memory//guide.md', 'memory/./guide.md', 'memory\\guide.md', join(f.memory, 'guide.md'), 'C:/memory/guide.md']) {
      item.path = path; f.save();
      assert.throws(() => readProject(f.manifest), /relative to the project root under memory/);
      assert.throws(() => updateProjectMemory(f.manifest, item.id, 'overwrite'), /relative to the project root under memory/);
    }
    assert.equal(readFileSync(join(f.memory, 'guide.md'), 'utf8'), 'Root memory content');
    assert.equal(readFileSync(join(f.metadata, 'memory/guide.md'), 'utf8'), 'Legacy content');
  } finally {f.cleanup();}
});
test('the memory directory itself cannot redirect reads or writes through a symlink', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.memory, 'guide.md'), 'Preserve');
    const moved = join(f.root, 'redirected');
    renameSync(f.memory, moved); symlinkSync(moved, f.memory, 'dir');
    f.data.memory.push({id: 'guide', name: 'Guide', path: 'memory/guide.md'}); f.save();
    assert.throws(() => readProject(f.manifest), /outside the project memory directory/);
    assert.throws(() => updateProjectMemory(f.manifest, 'guide', 'overwrite'), /outside the project memory directory/);
    assert.equal(readFileSync(join(moved, 'guide.md'), 'utf8'), 'Preserve');
  } finally {f.cleanup();}
});
test('memory edits enforce UTF-8 document and aggregate byte limits before writing', () => {
  const f = fixture();
  try {
    const first = join(f.memory, 'first.md');
    const second = join(f.memory, 'second.md');
    const third = join(f.memory, 'third.md');
    writeFileSync(first, 'first');
    writeFileSync(second, 'x'.repeat(64_000));
    writeFileSync(third, 'x');
    f.data.memory.push({id: 'first', name: 'First', path: 'memory/first.md'}, {id: 'second', name: 'Second', path: 'memory/second.md'},
      {id: 'third', name: 'Third', path: 'memory/third.md'});
    f.save();
    assert.throws(() => updateProjectMemory(f.manifest, 'first', '中'.repeat(22_000)), /64 KB/);
    assert.equal(readFileSync(first, 'utf8'), 'first');
    assert.throws(() => updateProjectMemory(f.manifest, 'first', 'x'.repeat(64_000)), /128 KB/);
    assert.equal(readFileSync(first, 'utf8'), 'first');
  } finally {f.cleanup();}
});
test('an invalid local binding is not silently ignored', () => {
  const f = fixture();
  try {f.save(); writeFileSync(join(f.metadata, 'local.yaml'), 'resources:\n  unknown: elsewhere\n'); assert.throws(() => readProject(f.manifest), /Unknown local resource/);}
  finally {f.cleanup();}
});
