import {strict as assert} from 'node:assert';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore, {SessionId, type Session} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-present/types';
import ToolRuntime, {type ToolExecutionResult} from '@deepseek-ai/dsh-tools';
import {readProject} from '../src/project.ts';
import {registerProjectMemoryTools} from '../src/memory-tools.ts';

const signal = new AbortController().signal;

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-memory-tools-')));
  const manifest = join(root, 'memory.agent-project');
  writeFileSync(manifest, 'schemaVersion: 1\nid: memory\nname: Memory Project\nresources:\n  - {id: root, name: Root, type: local, path: .}\nmemory: []\n');
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  registerProjectMemoryTools(ctx, () => readProject(manifest).root, manifest);
  const sessions = new Map<string, Session>();
  const session = (id: string, cwd = root) => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const created = ctx.sessions.create(SessionId(id), {meta: {cwd}});
    sessions.set(id, created);
    return created;
  };
  let call = 0;
  const execute = (name: string, args: unknown, sessionId?: string) => ctx.tools.execute({
    callId: `memory-call-${++call}` as never, name, arguments: args, signal,
    ...(sessionId === undefined ? {} : {agent: {id: SessionId(sessionId), session: session(sessionId)} as never}),
  });
  return {root, manifest, ctx, session, execute, cleanup: async () => {
    await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }};
}

function value<T>(result: ToolExecutionResult): T {
  assert.equal(result.isError, false, JSON.stringify(result.content));
  if (result.isError) throw new Error('Expected a successful Project Memory Tool result');
  return result.value as T;
}
function error(result: ToolExecutionResult, pattern: RegExp) {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), pattern);
}

test('memory tools create, list, update and delete declared documents', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.ctx.tools.schemas().map(tool => tool.name).sort(),
      ['project_memory_create', 'project_memory_delete', 'project_memory_list', 'project_memory_update']);
    const created = value<{memory: Array<{id: string; name: string; path: string; bytes: number}>}>(await f.execute('project_memory_create',
      {id: 'release', name: 'Release checklist', content: '# Release\n'}, 'session-a'));
    assert.deepEqual(created.memory, [{id: 'release', name: 'Release checklist', path: 'memory/release.md', bytes: 10}]);
    assert.equal(readFileSync(join(f.root, 'memory', 'release.md'), 'utf8'), '# Release\n');

    const listed = value<{memory: unknown[]}>(await f.execute('project_memory_list', {}));
    assert.equal(listed.memory.length, 1);
    assert.deepEqual(readProject(f.manifest).memory.map(item => item.content), ['# Release\n']);

    const updated = value<{memory: Array<{bytes: number}>}>(await f.execute('project_memory_update',
      {id: 'release', content: '# Release 2\n'}, 'session-a'));
    assert.equal(updated.memory[0]?.bytes, 12);
    assert.equal(readFileSync(join(f.root, 'memory', 'release.md'), 'utf8'), '# Release 2\n');

    value(await f.execute('project_memory_delete', {id: 'release'}, 'session-a'));
    assert.equal(existsSync(join(f.root, 'memory', 'release.md')), false);
    assert.deepEqual(readProject(f.manifest).memory, []);
    error(await f.execute('project_memory_delete', {id: 'release'}, 'session-a'), /Unknown project memory/);
  } finally {await f.cleanup();}
});

test('memory tools stay scoped to the owning Project root and reject invalid writes', async () => {
  const f = await fixture();
  try {
    error(await f.execute('project_memory_create', {name: 'No owner', content: 'x'}), /owning Session/);
    f.session('foreign', tmpdir());
    error(await f.execute('project_memory_create', {name: 'Foreign', content: 'x'}, 'foreign'), /Project root/);
    error(await f.execute('project_memory_create', {id: 'bad id', name: 'Bad', content: 'x'}, 'session-a'), /Invalid|regex|id/);
    error(await f.execute('project_memory_create', {name: 'Huge', content: '中'.repeat(22_000)}, 'session-a'), /64 KB/);
    error(await f.execute('project_memory_create', {id: 'escape', name: 'Escape', path: 'memory/../escape.md', content: 'x'}, 'session-a'),
      /relative to the project root under memory/);
    assert.deepEqual(readProject(f.manifest).memory, []);
    assert.equal(existsSync(join(f.root, 'escape.md')), false);
  } finally {await f.cleanup();}
});
