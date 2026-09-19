import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProjectMcpConfigStore} from '../src/project-mcp-config.ts';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import SessionStore, {SessionId} from '@deepseek-ai/dsh-session';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { apply } from '../src/index.ts';
import {readProject} from '../src/project.ts';
import {ProjectTaskStore} from '../src/tasks.ts';

async function mountProjectRuntime(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SkillRegistry);
}

test('host contributes Project knowledge, Task guidance, refreshed Memory, and identity protection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-host-'));
  const memory = join(root, 'memory');
  mkdirSync(memory);
  const manifestPath = join(root, 'example.agent-project');
  const manifest = 'schemaVersion: 1\nid: example\nname: Example\nresources:\n  - {id: source, name: Source, type: local, path: .}\nmemory:\n  - {id: guide, name: Guide, path: memory/guide.md}\n';
  writeFileSync(manifestPath, manifest);
  writeFileSync(join(memory, 'guide.md'), 'Keep {{literal_template}} unchanged.');
  const ctx = new Context();
  await mountProjectRuntime(ctx);
  // HTTP transport is tested by the local runtime smoke; this test exercises real prompt rendering.
  ctx.provide('webServer', {register: () => () => {}} as unknown as Context['webServer']);
  try {
    await apply(ctx, {manifestPath});
    const first = renderContextSnapshot(await ctx.systemPrompt.assemble());
    assert.match(first, /Keep \{\{literal_template\}\} unchanged\./);
    assert.match(first, /project_task_create/);
    const task = new ProjectTaskStore(readProject(manifestPath)).create({
      title: 'Persisted active work', objective: 'Keep the task visible across sessions',
      operationId: 'create-host-task',
    }, {sessionId: 'host-session'}).task;
    const withTask = renderContextSnapshot(await ctx.systemPrompt.assemble());
    assert.match(withTask, new RegExp(task.title));
    writeFileSync(join(memory, 'guide.md'), 'Updated project knowledge.');
    const second = renderContextSnapshot(await ctx.systemPrompt.assemble());
    assert.match(second, /Updated project knowledge\./);
    assert.doesNotMatch(second, /literal_template/);
    writeFileSync(manifestPath, manifest.replace('id: example', 'id: another'));
    await assert.rejects(ctx.systemPrompt.assemble(), /Restart this Project host/);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('every Session sees the same independent task candidates and survives independently corrupt task data', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-current-prompt-')));
  const manifestPath = join(root, 'current.agent-project');
  writeFileSync(manifestPath, 'schemaVersion: 1\nid: current\nname: Prompt Project\nresources: []\nmemory: []\n');
  const ctx = new Context();
  await mountProjectRuntime(ctx);
  ctx.provide('webServer', {register: () => () => {}} as unknown as Context['webServer']);
  try {
    await apply(ctx, {manifestPath});
    const tasks = new ProjectTaskStore(readProject(manifestPath));
    const a = tasks.create({title: '窗口设计 {{unexpanded}}', objective: '调查官方布局', operationId: 'prompt-a'}, {sessionId: 'session-a'}).task;
    const b = tasks.create({title: '资源修复', objective: '核对重启恢复', operationId: 'prompt-b'}, {sessionId: 'session-b'}).task;
    const assemble = async (id: string) => {
      const session = ctx.sessions.get(SessionId(id)) ?? ctx.sessions.create(SessionId(id), {meta: {cwd: root}});
      const agent = {id: SessionId(id), session} as never;
      return renderContextSnapshot(await ctx.systemPrompt.assemble({agent, scope: agent}));
    };
    const promptA = await assemble('session-a');
    const promptB = await assemble('session-b');
    assert.match(promptA, new RegExp(a.id));
    assert.match(promptA, /\{\{unexpanded\}\}/);
    assert.match(promptB, new RegExp(b.id));
    assert.match(renderContextSnapshot(await ctx.systemPrompt.assemble()), /Project candidates/);
    writeFileSync(join(root, `tasks/${a.directory}/task.md`), 'broken record');
    const corruptTask = await assemble('session-a');
    assert.match(corruptTask, /Some task records are unavailable/);
    assert.match(corruptTask, /资源修复/);
    assert.match(corruptTask, /Prompt Project/);
    writeFileSync(join(root, 'tasks/local.yaml'), 'broken local mapping');
    const corruptLocal = await assemble('session-b');
    assert.match(corruptLocal, /Some task records are unavailable/);
    assert.match(corruptLocal, /资源修复/);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }
});


test('leaving Project mode removes prompt, task tools, skills and MCP capabilities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-disabled-host-'));
  const manifestPath = join(root, 'disabled.agent-project');
  writeFileSync(manifestPath, 'schemaVersion: 1\nid: disabled\nname: Hidden Project Knowledge\nresources:\n  - {id: root, name: Root, type: local, path: .}\nmemory: []\n');
  const ctx = new Context();
  await mountProjectRuntime(ctx);
  ctx.provide('webServer', {register: () => () => {}} as unknown as Context['webServer']);
  try {
    mkdirSync(join(root, 'skills/disabled-skill'), {recursive: true});
    writeFileSync(join(root, 'skills/disabled-skill/SKILL.md'), '---\nname: disabled-skill\ndescription: Must stay disabled\n---\nDisabled.\n');
    new ProjectMcpConfigStore({root}).upsert({
      id: 'disabled', serverName: 'disabled', enabled: true, transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/project-mcp-server.mjs', import.meta.url))],
      toolCallTimeoutMs: 1000,
    });
    await apply(ctx, {manifestPath, enabled: false});
    assert.deepEqual(ctx.tools.schemas().filter(tool => tool.name.startsWith('project_task_')), []);
    assert.equal(ctx.tools.get('mcp__disabled__ping'), undefined);
    assert.equal(await ctx.skills.get('disabled-skill'), undefined);
    assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble()), /Hidden Project Knowledge|project-reference/);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }
});
