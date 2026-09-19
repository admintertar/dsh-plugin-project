import {strict as assert} from 'node:assert';
import {cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {stringify} from 'yaml';
import {atomicWriteFile} from '../src/atomic-file.ts';
import type {ProjectView} from '../src/project.ts';
import {ProjectTaskStore, taskVerifications, type CreateProjectTask, type TaskEntryInput, type TaskRecord, type UpdateProjectTask} from '../src/tasks.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-tasks-')));
  const backend = join(root, 'backend'); mkdirSync(backend);
  const project: ProjectView = {id: 'task-project', name: 'Task Project', description: '', root, resources: [{id: 'backend', name: 'Backend', type: 'local', path: backend, status: 'ready'}], memory: []};
  let tick = 0; let id = 0; let operation = 0;
  const store = new ProjectTaskStore(project, {clock: () => new Date(Date.UTC(2026, 8, 17, 0, 0, tick++)), idGenerator: () => `task-${++id}`});
  function create(input: Partial<CreateProjectTask> = {}, session = 'owner'): TaskRecord {
    return store.create({title: '调查弹窗', objective: '确定滚动条是否挤动内容', operationId: `op-${++operation}`, ...input}, {sessionId: session}).task;
  }
  function update(task: TaskRecord, patch: Omit<UpdateProjectTask, 'expectedRevision'|'operationId'>, session = 'owner'): TaskRecord {
    return store.update(task.id, {operationId: `op-${++operation}`, expectedRevision: store.get(task.id).revision, ...patch}, {sessionId: session}).task;
  }
  return {root, backend, project, store, create, update, cleanup: () => rmSync(root, {recursive: true, force: true})};
}
const scope = (id = 'scope'): TaskEntryInput => ({id, kind: 'scope', content: '本轮增加观察标准', reason: '用户追加要求', basis: 'user-request'});
const check = (id: string, version = 1, result: 'passed'|'failed'|'not-run'|'not-applicable' = 'passed'): TaskEntryInput => ({id, kind: 'verification', content: '核对正文尺寸', basis: 'observation', verification: {criterionId: 'width', criterionVersion: version, method: '测量', result, coverage: '溢出及无溢出', ...(result === 'not-run' || result === 'not-applicable' ? {reason: '待确认适用环境'} : {})}});
const completion = (id: string, checks: string[]): TaskEntryInput => ({id, kind: 'completion', content: '调查结论已交付', verificationEntryIds: checks});

test('records survive reload; shared files omit local Session identities and receipts are private to Store', () => {
  const f = fixture(); try {
    const created = f.create({brief: {scope: '仅调查'}, phase: 'investigation'});
    const updated = f.update(created, {summary: '已定位右侧槽', questions: ['系统滚动条宽度？'], references: [{id: 'rules', type: 'note', label: '布局规范', text: '沿用官方留白'}], handoff: {nextSteps: ['测量正文'], readBefore: ['rules'], verifyBefore: ['确认系统滚动条偏好']}, entries: [{id: 'decision', kind: 'decision', content: '保留官方布局', basis: 'user-request'}]}, 'second-session');
    const reloaded = new ProjectTaskStore(f.project).get(created.id);
    assert.deepEqual(reloaded, updated);
    assert.equal(reloaded.entries[0]?.createdAt, updated.updatedAt);
    assert.equal('operations' in reloaded, false);
    assert.equal('criterionVersions' in reloaded, false);
    const shared = readFileSync(join(f.root, 'tasks', created.directory, 'task.md'), 'utf8');
    assert.doesNotMatch(shared, /second-session|sessionId|operationId/);
    assert.equal(f.store.sources(created.id).decision?.sessionId, 'second-session');
    assert.equal(statSync(f.store.layout.taskSources).mode & 0o777, 0o600);
  } finally {f.cleanup();}
});

test('revision conflicts, external edits and same-operation retries never replace newer work', () => {
  const f = fixture(); try {
    const task = f.create();
    const request = {operationId: 'save-a', expectedRevision: task.revision, summary: '最新结论', entries: [{id: 'first', kind: 'progress' as const, content: '已调查'}]};
    const saved = f.store.update(task.id, request, {sessionId: 'owner'}).task;
    assert.throws(() => f.store.update(task.id, {operationId: 'save-b', expectedRevision: task.revision, summary: '旧结论'}, {sessionId: 'other'}), /revision conflict/);
    assert.equal(f.store.update(task.id, request, {sessionId: 'owner'}).task.entries.length, 1);
    assert.throws(() => f.store.update(task.id, {...request, summary: '同id不同内容'}, {sessionId: 'owner'}), /operationId/);
    const path = join(f.store.layout.tasks, task.directory, 'task.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('最新结论', '手工修订'));
    assert.throws(() => f.store.update(task.id, {operationId: 'after-external', expectedRevision: saved.revision, summary: '不能覆盖'}, {sessionId: 'owner'}), /revision conflict/);
    assert.equal(f.store.get(task.id).summary, '手工修订');
    assert.throws(() => f.store.setArchived(task.id, true, {operationId: 'archive', expectedRevision: saved.revision}), /revision conflict/);
  } finally {f.cleanup();}
});

test('field omission preserves, explicit null clears, and entries cannot be overwritten', () => {
  const f = fixture(); try {
    let task = f.create({phase: 'investigation', summary: '初始', questions: ['未知'], handoff: {nextSteps: ['观察']}, brief: {currentBehavior: '正文漂移'}});
    task = f.update(task, {summary: null, phase: null, handoff: null, questions: [], brief: {currentBehavior: null}, entries: [{id: 'note', kind: 'decision', content: '先调查'}]});
    assert.equal(task.summary, undefined); assert.equal(task.phase, undefined); assert.equal(task.handoff, undefined); assert.deepEqual(task.questions, []);
    assert.equal(task.brief?.currentBehavior, undefined);
    assert.throws(() => f.update(task, {entries: [{id: 'note', kind: 'decision', content: '覆盖'}]}), /Duplicate Task entry/);
    task = f.update(task, {entries: [{id: 'correction', kind: 'decision', content: '范围已修正', supersedes: 'note'}]});
    assert.equal(task.entries.length, 2);
    assert.throws(() => f.update(task, {handoff: {readBefore: ['missing']}}), /Unknown Task reference/);
  } finally {f.cleanup();}
});

test('completion requires current acceptance evidence; changed scope invalidates older passed evidence', () => {
  const f = fixture(); try {
    let task = f.create({phase: 'investigation', brief: {scope: '仅调查布局', acceptanceCriteria: [{id: 'width', text: '给出正文宽度结论'}]}});
    assert.throws(() => f.update(task, {status: 'completed', handoff: null, summary: '好了'}), /completion entry/);
    task = f.update(task, {entries: [check('v1')]});
    task = f.update(task, {status: 'completed', handoff: null, summary: '已给出有依据的布局结论', entries: [completion('done1', ['v1'])]});
    assert.equal(task.phase, 'investigation'); assert.equal(task.status, 'completed');
    assert.throws(() => f.update(task, {objective: '还要实施修复', changeReason: '用户追加', entries: [scope('new-scope')]}), /explicit active rework/);
    task = f.update(task, {status: 'active', brief: {scope: '调查和实施'}, changeReason: '用户追加实施', entries: [scope('new-scope')]});
    assert.equal(task.brief?.acceptanceCriteria?.[0]?.version, 2);
    assert.deepEqual(taskVerifications(task), {});
    assert.throws(() => f.update(task, {status: 'completed', handoff: null, summary: '完成', entries: [completion('bad-completion', ['v1'])]}), /not passed/);
    task = f.update(task, {entries: [check('v2', 2)]});
    task = f.update(task, {status: 'completed', handoff: null, summary: '本轮实施已验证', entries: [completion('done2', ['v2'])]});
    assert.equal(task.status, 'completed');
  } finally {f.cleanup();}
});

test('latest failed verification and superseded checks cannot hide behind an earlier pass', () => {
  const f = fixture(); try {
    let task = f.create({brief: {acceptanceCriteria: [{id: 'width', text: '宽度稳定'}]}});
    task = f.update(task, {entries: [check('passed')]});
    task = f.update(task, {entries: [check('failed', 1, 'failed')]});
    assert.equal(taskVerifications(task).width?.id, 'failed');
    assert.throws(() => f.update(task, {status: 'completed', handoff: null, summary: '完成', entries: [completion('done', ['passed'])]}), /not passed/);
    task = f.update(task, {entries: [{...check('new-passed'), supersedes: 'failed'}]});
    task = f.update(task, {status: 'completed', handoff: null, summary: '已验证', entries: [completion('done', ['new-passed'])]});
    assert.throws(() => f.update(task, {entries: [check('late-failure', 1, 'failed')]}), /explicitly reopen/);
    task = f.update(task, {status: 'active', changeReason: '新发现回归', entries: [check('late-failure', 1, 'failed')]});
    assert.equal(task.status, 'active');
    assert.equal(taskVerifications(task).width?.id, 'late-failure');
  } finally {f.cleanup();}
});

test('removed then restored criterion identities get a fresh version', () => {
  const f = fixture(); try {
    let task = f.create({brief: {acceptanceCriteria: [{id: 'width', text: '宽度稳定'}]}});
    task = f.update(task, {entries: [check('old-pass')]});
    task = f.update(task, {brief: {acceptanceCriteria: []}, changeReason: '暂缓', entries: [scope('remove')]});
    task = f.update(task, {brief: {acceptanceCriteria: [{id: 'width', text: '宽度稳定'}]}, changeReason: '恢复', entries: [scope('restore')]});
    assert.equal(task.brief?.acceptanceCriteria?.[0]?.version, 2);
    assert.deepEqual(taskVerifications(task), {});
  } finally {f.cleanup();}
});

test('overview and history pages are bounded, newest-first and bound to file revision', () => {
  const f = fixture(); try {
    let task = f.create({objective: '界'.repeat(1_000), summary: '文'.repeat(1_000), brief: {acceptanceCriteria: [{id: 'width', text: '宽度结论'}]}});
    task = f.update(task, {entries: [check('old-check'), ...Array.from({length: 54}, (_, i) => ({id: `progress-${i}`, kind: 'progress' as const, content: `进展 ${i}`}))]});
    const detail = f.store.detail(task.id); assert.equal(detail.task.entries.length, 20); assert.equal(detail.totalEntries, 55);
    assert.equal(detail.task.entries[0]?.id, 'progress-53'); assert.equal(detail.verification.width?.id, 'old-check');
    const next = f.store.detail(task.id, {cursor: detail.entriesNextCursor}); assert.equal(next.task.entries[0]?.id, 'progress-33');
    const row = f.store.listPage().tasks[0]!; assert.equal(row.truncated, true); assert.equal(row.objective.length, 300); assert.equal(row.summary?.length, 300); assert.equal('entries' in row, false);
    f.update(task, {summary: '新概况'});
    assert.throws(() => f.store.detail(task.id, {cursor: next.entriesNextCursor}), /revision conflict/);
    assert.throws(() => f.store.listPage({limit: 51}));
    for (let i = 0; i < 21; i++) f.create({title: `记录 ${i}`}, `session-${i}`);
    const page = f.store.listPage(); assert.equal(page.tasks.length, 20); assert.equal(page.total, 22); assert.equal(page.unarchivedTotal, 22);
    assert.equal(f.store.listPage({cursor: page.nextCursor}).tasks.length, 2);
    assert.equal(f.store.listPage({query: '记录 20'}).total, 1);
  } finally {f.cleanup();}
});

test('failed Task commit leaves files unchanged; only confirmed dead lock owners are recovered', () => {
  const f = fixture(); try {
    const task = f.create(); const path = join(f.store.layout.tasks, task.directory, 'task.md'); const before = readFileSync(path);
    const failed = new ProjectTaskStore(f.project, {writeFile: () => {throw new Error('simulated Task IO failure');}});
    assert.throws(() => failed.update(task.id, {operationId: 'io-error', expectedRevision: task.revision, summary: '未保存'}, {sessionId: 'owner'}), /simulated/);
    assert.deepEqual(readFileSync(path), before);
    const lock = join(f.store.layout.tasks, '.write-lock');
    writeFileSync(lock, JSON.stringify({host: hostname(), pid: process.pid, token: 'live'}));
    assert.throws(() => f.update(task, {summary: '不得抢锁'}), /lock is busy/);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'live');
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {encoding: 'utf8'});
    assert.equal(child.status, 0);
    writeFileSync(lock, JSON.stringify({host: hostname(), pid: Number(child.stdout.trim()), token: 'dead'}));
    assert.equal(f.update(task, {summary: '恢复退出持有者后的写入'}).summary, '恢复退出持有者后的写入');
    assert.equal(existsSync(lock), false);
  } finally {f.cleanup();}
});


test('portable bundles survive project relocation and missing or corrupt conversation sources', () => {
  const f = fixture(); const moved = realpathSync(mkdtempSync(join(tmpdir(), 'moved-tasks-')));
  try {
    let task = f.create({title: '独立任务', entries: [{id: 'origin', kind: 'progress', content: '来源摘要可以独立阅读'}]});
    const file = join(f.root, 'tasks', task.directory, 'artifacts/report.md'); writeFileSync(file, '# result');
    task = f.update(task, {artifacts: [{type: 'file', path: 'artifacts/report.md'}]});
    cpSync(join(f.root, 'tasks'), join(moved, 'tasks'), {recursive: true});
    const store = new ProjectTaskStore({...f.project, root: moved, resources: []});
    const read = store.get(task.id); assert.equal(read.directory, '独立任务'); assert.deepEqual(store.sources(task.id), {});
    assert.equal(readFileSync(store.artifactPath(read, read.artifacts[0]!)!, 'utf8'), '# result');
    mkdirSync(join(moved, '.agent-project'), {recursive: true}); writeFileSync(store.layout.taskSources, 'broken: [');
    const saved = store.update(task.id, {operationId: 'on-another-machine', expectedRevision: read.revision, summary: '继续完成'}, {sessionId: 'new-person'});
    assert.equal(saved.task.summary, '继续完成'); assert.deepEqual(saved.diagnostics, []); assert.equal(readFileSync(store.layout.taskSources, 'utf8'), 'broken: [');
  } finally {f.cleanup(); rmSync(moved, {recursive: true, force: true});}
});
test('create retries across conversations reuse identity; names are safe, distinct and stable on rename', () => {
  const f = fixture(); try {
    const input = {title: '../同名/任务', objective: 'work', operationId: 'unique'};
    const a = f.store.create(input, {sessionId: 'a'}).task;
    const retry = f.store.create(input, {sessionId: 'b'}); assert.equal(retry.replayed, true); assert.equal(retry.task.id, a.id);
    const b = f.create({title: input.title}); assert.notEqual(a.directory, b.directory); assert.ok(!a.directory.includes('/'));
    assert.equal(f.update(a, {title: '新标题'}).directory, a.directory);
    assert.throws(() => f.store.create({...input, title: 'conflict'}), /operationId/);
    writeFileSync(join(f.store.layout.tasks, 'old.md'), '---\nschemaVersion: 2\n---\nold');
    assert.equal(f.store.list().tasks.length, 2, 'old flat records are not loaded');
  } finally {f.cleanup();}
});
test('artifact files are explicitly copied into tasks and survive Resource removal; bad paths fail immediately', () => {
  const f = fixture(); try {
    let task = f.create(); writeFileSync(join(f.backend, 'report.sql'), 'CREATE TABLE example(id INT);');
    task = f.update(task, {artifacts: [{type: 'file', path: 'artifacts/report.sql', source: {resourceId: 'backend', path: 'report.sql'}}]});
    assert.equal(task.artifacts.length, 1); assert.ok(f.store.artifactPath(task, task.artifacts[0]!));
    task = f.update(task, {artifacts: [{type: 'file', path: 'artifacts/report.sql', description: 'corrected label'}]}); assert.equal(task.artifacts.length, 1);
    rmSync(f.backend, {recursive: true});
    const detached = new ProjectTaskStore({...f.project, resources: []}); assert.ok(detached.artifactPath(task, task.artifacts[0]!));
    for (const path of ['report.sql', '../outside', 'artifacts/../task.md', '/absolute', 'artifacts/missing']) assert.throws(() => f.update(task, {artifacts: [{type: 'file', path}]}));
    symlinkSync(tmpdir(), join(f.root, 'tasks', task.directory, 'artifacts/link'));
    assert.throws(() => f.update(task, {artifacts: [{type: 'file', path: 'artifacts/link/secret'}]}), /symbolic link/);
    const commit = {type: 'commit' as const, repository: 'https://example.com/repo.git', commit: 'a'.repeat(40), description: 'code changes'};
    for (const length of [7, 39, 41, 63, 65]) assert.throws(() => f.update(task, {artifacts: [{...commit, commit: 'a'.repeat(length)}]}));
    task = f.update(task, {artifacts: [commit]}); assert.deepEqual(task.artifacts[1], commit);
    task = f.update(task, {removeArtifacts: ['artifacts/report.sql']}); assert.equal(task.artifacts.length, 1);
    assert.ok(existsSync(join(f.root, 'tasks', task.directory, 'artifacts/report.sql')), 'index correction never deletes user files');
  } finally {f.cleanup();}
});
test('completion requires an explicit current handoff; references can be corrected without deleting history', () => {
  const f = fixture(); try {
    let task = f.create({handoff: {nextSteps: ['old step']}, brief: {acceptanceCriteria: [{id: 'width', text: 'result'}]}, references: [{id: 'doc', type: 'note', label: 'old', text: 'old'}]});
    task = f.update(task, {entries: [check('pass'), {id: 'point', kind: 'progress', content: 'read', referenceIds: ['doc']}], references: [{id: 'doc', type: 'note', label: 'corrected', text: 'corrected'}]});
    assert.equal(task.references[0]?.label, 'corrected');
    assert.throws(() => f.update(task, {removeReferences: ['doc']}), /Unknown Task reference/);
    assert.throws(() => f.update(task, {status: 'completed', summary: 'done', entries: [completion('done', ['pass'])]}), /refreshed handoff/);
    assert.equal(f.update(task, {status: 'completed', handoff: null, summary: 'done', entries: [completion('done', ['pass'])]}).handoff, undefined);
  } finally {f.cleanup();}
});
test('size limits, damaged records, duplicate ids and symlinks are isolated', () => {
  const f = fixture(); const other = fixture(); try {
    const task = f.create(); const file = join(f.root, 'tasks', task.directory, 'task.md'); const before = readFileSync(file);
    assert.throws(() => f.update(task, {summary: '界'.repeat(50000)}), /128 KiB/); assert.deepEqual(readFileSync(file), before);
    mkdirSync(join(f.root, 'tasks/broken')); writeFileSync(join(f.root, 'tasks/broken/task.md'), 'broken');
    assert.equal(f.store.list().diagnostics.length, 1); assert.equal(f.store.get(task.id).id, task.id);
    const foreign = other.create(); symlinkSync(join(other.root, 'tasks', foreign.directory), join(f.root, 'tasks/linked'));
    assert.equal(f.store.list().tasks.length, 1); assert.equal(f.store.list().diagnostics.length, 2);
    mkdirSync(join(f.root, 'tasks/copy')); writeFileSync(join(f.root, 'tasks/copy/task.md'), before.toString().replace('directory: '+task.directory, 'directory: copy'));
    assert.throws(() => f.store.get(task.id), /Duplicate task/); assert.equal(f.store.list().tasks.length, 0);
  } finally {f.cleanup(); other.cleanup();}
});
