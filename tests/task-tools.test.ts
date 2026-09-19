import {strict as assert} from 'node:assert';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore, {SessionId, type Session} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-present/types';
import ToolRuntime, {type ToolExecutionResult} from '@deepseek-ai/dsh-tools';
import {readProject} from '../src/project.ts';
import {ProjectTaskStore} from '../src/tasks.ts';
import {PROJECT_TASK_CONTEXT_LIMIT, projectTaskContext, registerProjectTaskTools} from '../src/task-tools.ts';
import type {TaskDetail, TaskListPage, TaskMutationResult} from '../src/task-contract.ts';

const signal = new AbortController().signal;

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-task-tools-')));
  const manifest = join(root, 'tools.agent-project');
  writeFileSync(manifest, 'schemaVersion: 1\nid: tools\nname: Tool Project\nresources:\n  - {id: root, name: Root, type: local, path: .}\nmemory: []\n');
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  const store = () => new ProjectTaskStore(readProject(manifest));
  registerProjectTaskTools(ctx, store);
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
    callId: `project-call-${++call}` as never, name, arguments: args, signal,
    ...(sessionId === undefined ? {} : {agent: {id: SessionId(sessionId), session: session(sessionId)} as never}),
  });
  let operation = 0;
  const create = async (title: string, sessionId = 'session-a') => value<TaskMutationResult>(await execute('project_task_create', {
    title, objective: `委托：${title}`, operationId: `create-${++operation}`,
  }, sessionId));
  return {root, ctx, session, execute, store, create, cleanup: async () => {
    await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }};
}

function value<T>(result: ToolExecutionResult): T {
  assert.equal(result.isError, false, JSON.stringify(result.content));
  if (result.isError) throw new Error('Expected a successful Project Task Tool result');
  return result.value as T;
}
function error(result: ToolExecutionResult, pattern: RegExp) {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), pattern);
}

test('source locations come from the runtime Session log and remain machine-local', async () => {
  const f = await fixture();
  try {
    const input = {title: '来源核对', objective: '保留原始依据', operationId: 'source-create',
      entries: [{id: 'user-decision', kind: 'decision', content: '使用官方设置布局', basis: 'user-request'}]};
    const source = f.session('session-a').append('tool/call', {
      turn: 1, step: 1, callId: 'project-call-1' as never, name: 'project_task_create', arguments: JSON.stringify(input),
    });
    const created = value<TaskMutationResult>(await f.execute('project_task_create', input, 'session-a'));
    assert.deepEqual(f.store().sources(created.task.id)?.['user-decision'], {
      sessionId: 'session-a', eventId: `${source.seq}:${source.time}`,
    });
    const shared = readFileSync(join(f.root, `tasks/${created.task.directory}/task.md`), 'utf8');
    assert.doesNotMatch(shared, /session-a|project-call-1/);
    value(await f.execute('project_task_create', input, 'session-a'));
    assert.equal(f.store().sources(created.task.id)?.['user-decision']?.eventId, `${source.seq}:${source.time}`);
    error(await f.execute('project_task_create', {...input, operationId: 'spoof', sessionId: 'another'}, 'session-a'), /sessionId|Unrecognized/);
  } finally {await f.cleanup();}
});

test('completion through the real ToolRuntime requires evidence for the commissioned design result', async () => {
  const f = await fixture();
  try {
    const created = value<TaskMutationResult>(await f.execute('project_task_create', {
      title: '设计记录', objective: '完成产品方向文档', phase: 'design', operationId: 'create-design',
      brief: {acceptanceCriteria: [{id: 'design', text: '文档说明目标、范围与接续行为'}]},
    }, 'session-a'));
    error(await f.execute('project_task_update', {
      id: created.task.id, operationId: 'premature', expectedRevision: created.task.revision, status: 'completed', handoff: null, summary: '完成',
    }, 'session-a'), /completion|verification|验收|Completion/);
    const completion = value<TaskMutationResult>(await f.execute('project_task_update', {
      id: created.task.id, operationId: 'complete-design', expectedRevision: created.task.revision, status: 'completed', handoff: null,
      summary: '产品方向文档已通过核对；功能实现尚未开始。',
      entries: [
        {id: 'design-check', kind: 'verification', content: '逐项核对文档', basis: 'observation', verification: {
          criterionId: 'design', criterionVersion: 1, method: '人工核对目标、范围和接续章节', result: 'passed', coverage: '设计文档'}},
        {id: 'design-delivery', kind: 'completion', content: '交付设计文档', verificationEntryIds: ['design-check']},
      ],
    }, 'session-a'));
    assert.equal(completion.task.status, 'completed');
    assert.equal(completion.task.phase, 'design');
    f.session('session-a').append('deliverables/presented', {turn: 1, callId: 'after-completion' as never, files: [{path: 'design.md'}]});
    assert.equal(f.store().get(created.task.id).revision, completion.task.revision);
    assert.equal(f.store().get(created.task.id).status, 'completed');
    error(await f.execute('project_task_update', {
      id: created.task.id, operationId: 'extend-scope', expectedRevision: completion.task.revision, objective: '实现全部功能',
      changeReason: '新委托', entries: [{id: 'new-scope', kind: 'scope', content: '扩展到实现', reason: '新委托'}],
    }, 'session-a'), /active|reopen|completed/);
  } finally {await f.cleanup();}
});

test('tool search and history are bounded, revision-bound, and retain full saved Chinese content', async () => {
  const f = await fixture();
  try {
    const long = '滚动条出现前后正文宽度和左侧坐标保持一致。'.repeat(200);
    const created = value<TaskMutationResult>(await f.execute('project_task_create', {
      title: '滚动条核对', objective: long, summary: long, operationId: 'long-create',
      entries: Array.from({length: 25}, (_, i) => ({id: `progress-${i}`, kind: 'progress', content: `记录 ${i}`})),
    }, 'session-a'));
    await f.create('资源调查');
    const page = value<TaskListPage>(await f.execute('project_task_list', {query: '滚动条', limit: 1}));
    assert.equal(page.tasks.length, 1);
    assert.equal(page.tasks[0]?.id, created.task.id);
    assert.equal(page.tasks[0]?.truncated, true);
    assert.ok((page.tasks[0]?.summary?.length ?? 0) < long.length);
    const overview = value<TaskDetail>(await f.execute('project_task_get', {id: created.task.id}));
    assert.equal(overview.task.summary, long);
    assert.equal(overview.task.entries.length, 20);
    assert.ok(overview.entriesNextCursor);
    const older = value<{entries: unknown[]}>(await f.execute('project_task_get', {
      id: created.task.id, scope: 'entries', cursor: overview.entriesNextCursor,
    }));
    assert.equal(older.entries.length, 5);
    value(await f.execute('project_task_update', {id: created.task.id, operationId: 'new-progress', expectedRevision: created.task.revision, summary: '已更新'}, 'session-a'));
    error(await f.execute('project_task_get', {id: created.task.id, scope: 'entries', cursor: overview.entriesNextCursor}), /cursor|revision|changed|conflict/);
    error(await f.execute('project_task_list', {limit: 51}), /50/);
  } finally {await f.cleanup();}
});


test('four explicit Task tools never bind conversations or infer Deliverable ownership', async () => {
  const f = await fixture(); try {
    assert.deepEqual(f.ctx.tools.schemas().map(tool => tool.name).sort(), ['project_task_create', 'project_task_get', 'project_task_list', 'project_task_update']);
    const a = await f.create('Independent A'); const b = await f.create('Independent B', 'session-b');
    f.session('session-a').append('deliverables/presented', {turn: 1, callId: 'file' as never, files: [{path: 'report.md'}]});
    assert.equal(f.store().get(a.task.id).revision, a.task.revision); assert.equal(f.store().get(b.task.id).revision, b.task.revision);
    const listed = value<TaskListPage>(await f.execute('project_task_list', {})); assert.deepEqual(listed.diagnostics, []);
    value(await f.execute('project_task_update', {id: a.task.id, operationId: 'other-person', expectedRevision: a.task.revision, summary: 'continued'}, 'session-b'));
    assert.equal(value<TaskDetail>(await f.execute('project_task_get', {id: a.task.id})).task.summary, 'continued');
    error(await f.execute('project_task_get', {current: true}), /id|current|Unrecognized/);
    error(await f.execute('project_task_create', {title: 'Invalid', objective: 'No owner', operationId: 'none'}), /owning Session/);
    f.session('foreign', tmpdir()); error(await f.execute('project_task_update', {id: a.task.id, operationId: 'foreign', expectedRevision: a.task.revision}, 'foreign'), /Project root/);
  } finally {await f.cleanup();}
});
test('task context is project based and bounded, with no session pointer or local-map dependency', async () => {
  const f = await fixture(); try {
    await f.create('Shared candidate');
    writeFileSync(join(f.root, 'tasks/local.yaml'), 'bad: [');
    const context = projectTaskContext(f.store()); assert.match(context, /Shared candidate/); assert.ok(context.length <= PROJECT_TASK_CONTEXT_LIMIT);
    assert.doesNotMatch(context, /bindingRevision|Current task:/);
  } finally {await f.cleanup();}
});
