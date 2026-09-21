import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createServer, request, type IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse, stringify} from 'yaml';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore, {SessionId} from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {createScope, bindScopeParent} from '@deepseek-ai/dsh-scope';
import type {WebRoute} from '@deepseek-ai/dsh-host-webserver';
import {createProjectFile} from '../src/project-files.ts';
import {readProject, updateProjectMemory} from '../src/project.ts';
import {ProjectTaskStore} from '../src/tasks.ts';
import {ProjectSkillService} from '../src/project-skills.ts';
import {ProjectMcpConfigStore, type ProjectMcpServer} from '../src/project-mcp-config.ts';
import {ProjectMcpRuntime, type ProjectMcpMount} from '../src/project-mcp-runtime.ts';
import {registerProjectApi} from '../src/project-api.ts';
import {gitFixture} from './fixtures/resources.ts';
import {ProjectResourceStore} from '../src/project-resources.ts';

const declaration: ProjectMcpServer = {id: 'fixture', serverName: 'fixture', transport: 'stdio', enabled: true,
  command: 'fixture', args: [], toolCallTimeoutMs: 1000};

/** Exercise official exact Session reads without requiring a full-text search backend. */
class CatalogSessionQuery extends SessionQuery {
  async searchSessions(): Promise<never> {throw new Error('Catalog reads must not search Sessions');}
  async searchEvents(): Promise<never> {throw new Error('Catalog reads must not search events');}
}

async function fixture(mount: ProjectMcpMount = async () => ({toolNames: ['fixture-tool'], dispose: async () => {}})) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-api-')));
  const manifest = createProjectFile(join(root, 'test.agent-project'));
  mkdirSync(join(root, 'memory'));
  const memoryPath = join(root, 'memory', 'guide.md');
  writeFileSync(memoryPath, '# Original\n');
  const manifestData = parse(readFileSync(manifest, 'utf8'));
  manifestData.memory = [{id: 'guide', name: 'Guide', path: 'memory/guide.md'}];
  writeFileSync(manifest, stringify(manifestData));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(SessionStore);
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(ToolRuntime);
  let nativePicker = true;
  let desktopPicker: (() => Promise<string | null>) | undefined;
  ctx.provide('directoryPicker', {capability: () => ({kind: nativePicker ? 'native' : 'browse'})});
  // The Desktop shell bridges its own Electron chooser here; Windows pins browse and relies on it.
  ctx.provide('desktopRuntime', {get pickDirectory() {return desktopPicker;}});
  const routes = new Map<string, WebRoute>();
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (route === undefined) {res.writeHead(404); res.end(); return;}
    void route.handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  const origin = `http://127.0.0.1:${port}`;
  ctx.provide('webServer', {port, register: (route: WebRoute) => {
    routes.set(route.path, route); return () => {routes.delete(route.path);};
  }} as unknown as Context['webServer']);
  ctx.provide('connection', {requestRejection: (req: IncomingMessage) => req.headers.authorization === 'fixture' ? undefined : 401} as unknown as Context['connection']);
  const read = () => readProject(manifest);
  const tasks = new ProjectTaskStore(read());
  const skills = new ProjectSkillService(ctx, read(), {watch: false});
  const mcpStore = new ProjectMcpConfigStore(read());
  const mcp = new ProjectMcpRuntime(ctx, mcpStore, {mount});
  const closeApi = registerProjectApi(ctx, read, {tasks: () => tasks, skills, mcpStore, mcp},
    (id, content) => updateProjectMemory(manifest, id, content));
  const headers = {authorization: 'fixture', origin, 'content-type': 'application/json'};
  const get = (path: string) => fetch(origin + '/api/project/' + path, {headers});
  const post = (path: string, body: unknown) => fetch(origin + '/api/project/' + path, {method: 'POST', headers, body: JSON.stringify(body)});
  return {root, manifest, memoryPath, ctx, tasks, skills, mcpStore, mcp, origin, headers, get, post, closeApi,
    setNativePicker: (value: boolean) => {nativePicker = value;},
    setDesktopPicker: (picker?: () => Promise<string | null>) => {desktopPicker = picker;}, cleanup: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeApi(); await mcp.dispose(); await skills.dispose(); await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }};
}

test('project api authenticates every route and rejects invalid write envelopes before mutation', async () => {
  let mounts = 0;
  const f = await fixture(async () => {mounts++; return {toolNames: [], dispose: async () => {}};});
  try {
    for (const path of ['snapshot', 'tasks', 'skills', 'tools', 'mcp']) {
      const url = f.origin + '/api/project/' + path;
      assert.equal((await fetch(url)).status, 401);
      const denied = await fetch(url, {method: 'DELETE', headers: f.headers});
      assert.equal(denied.status, 405);
      assert.match(denied.headers.get('allow') ?? '', /GET/);
      assert.equal((await f.get(path)).status, 200);
      if (path === 'snapshot' || path === 'tools') {
        assert.equal((await f.post(path, {})).status, 405);
        continue;
      }
      for (const headers of [{...f.headers, origin: 'http://localhost:1234'}, {...f.headers, 'content-type': 'text/plain'}]) {
        assert.equal((await fetch(url, {method: 'POST', headers, body: '{}'})).status, 403);
      }
      assert.equal((await fetch(url, {method: 'POST', headers: f.headers, body: ' '.repeat(65537)})).status, 413);
      const invalid = await fetch(url, {method: 'POST', headers: f.headers, body: '{ secret-fixture' });
      assert.equal(invalid.status, 422);
      assert.doesNotMatch(await invalid.text(), /secret-fixture/);
      assert.equal((await f.post(path, {action: 'unknown'})).status, 422);
    }
    assert.equal(mounts, 0);
    assert.deepEqual(f.mcpStore.list(), []);
    // The Desktop chooser route is POST-only, same-origin JSON and authenticated like every other write.
    const pick = f.origin + '/api/project/pick';
    assert.equal((await fetch(pick, {method: 'POST'})).status, 401);
    assert.equal((await fetch(pick, {method: 'POST', headers: {...f.headers, origin: 'http://localhost:1234'}, body: '{}'})).status, 403);
    assert.equal((await fetch(pick, {method: 'POST', headers: {...f.headers, 'content-type': 'text/plain'}, body: '{}'})).status, 403);
    assert.equal((await f.get('pick')).status, 405);
  } finally {await f.cleanup();}
});

test('project api saves Markdown memory and enforces authentication, identity and UTF-8 byte limits', async () => {
  const f = await fixture();
  try {
    const url = f.origin + '/api/project/memory';
    assert.equal((await fetch(url, {method: 'POST'})).status, 401);
    assert.equal((await f.get('memory')).status, 405);
    assert.equal((await f.post('memory', {action: 'update', id: 'missing', content: 'nope'})).status, 422);
    assert.equal(readFileSync(f.memoryPath, 'utf8'), '# Original\n');

    const markdown = '# Updated\n\n- **parsed**\n\n```ts\nconst answer = 42\n```\n';
    const saved = await f.post('memory', {action: 'update', id: 'guide', content: markdown});
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).memory[0].content, markdown);
    assert.equal(readFileSync(f.memoryPath, 'utf8'), markdown);

    const oversized = await f.post('memory', {action: 'update', id: 'guide', content: '中'.repeat(22_000)});
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {error: 'body-too-large'});
    assert.equal(readFileSync(f.memoryPath, 'utf8'), markdown);
  } finally {await f.cleanup();}
});

test('task API resolves genuine persisted Sessions without activating them after restart', async () => {
  const f = await fixture();
  const writer = new Context();
  try {
    await writer.plugin(SessionStore);
    const persistenceRoot = join(f.root, '.agent-project', 'session-fixture');
    await writer.plugin(JsonlSessionPersistence, {root: persistenceRoot, compression: 'none'});
    const cold = writer.sessions.prepare(undefined, {meta: {cwd: f.root}});
    const handle = await writer.sessionPersistence.create(cold.header);
    await handle.flush();
    await handle.close();
    await writer.fiber.dispose();
    await f.ctx.plugin(JsonlSessionPersistence, {root: persistenceRoot, compression: 'none'});
    await f.ctx.plugin(SessionProjectionRegistry);
    await f.ctx.plugin(CatalogSessionQuery);
    assert.equal(f.ctx.sessions.get(cold.id), undefined);
    const task = f.tasks.create({title: 'Cold history', objective: 'Keep the previous work findable',
      operationId: 'cold-task', entries: [{id: 'origin', kind: 'progress', content: 'Original context'}]}, {sessionId: String(cold.id)}).task;
    const response = await f.get(`tasks/detail?id=${task.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).participants.map((item: {sessionId: string; availability: string}) =>
      [item.sessionId, item.availability]), [[String(cold.id), 'available']]);
    assert.equal((await f.get(`tasks/binding?sessionId=${cold.id}`)).status, 404);
    assert.equal(f.ctx.sessions.get(cold.id), undefined, 'read-only history must not activate an Agent');
  } finally {await writer.fiber.dispose(); await f.cleanup();}
});

test('project api exposes Task artifacts and Project sessions, and archives without changing completion', async () => {
  const f = await fixture();
  try {
    const session = f.ctx.sessions.create(undefined, {meta: {cwd: f.root}});
    const foreign = f.ctx.sessions.create(undefined, {meta: {cwd: tmpdir()}});
    const task = f.tasks.create({title: 'Review', objective: 'Ship work', operationId: 'create', entries: [{id: 'origin', kind: 'progress', content: 'Source'}]}, {sessionId: String(session.id)}).task;
    writeFileSync(join(f.root, 'report.md'), 'Report');
    const updated = f.tasks.update(task.id, {operationId: 'artifacts', expectedRevision: task.revision,
      artifacts: [{type: 'file', path: 'artifacts/report.md', source: {path: 'report.md'}}], entries: [{id: 'foreign-origin', kind: 'progress', content: 'Cannot expose another project'}]}, {sessionId: String(foreign.id)}).task;
    mkdirSync(join(f.root, 'tasks/broken')); writeFileSync(join(f.root, 'tasks/broken/task.md'), 'not a task');
    const data = await (await f.get('tasks')).json();
    assert.equal(data.tasks[0].entries, undefined, 'list contains short summaries only');
    const detail = await (await f.get(`tasks/detail?id=${task.id}`)).json();
    assert.deepEqual(detail.participants.filter((item: {availability: string}) => item.availability === 'available').map((item: {sessionId: string}) => item.sessionId), [String(session.id)]);
    assert.equal(detail.participants.find((item: {availability: string}) => item.availability === 'unavailable').sessionId, undefined);
    assert.deepEqual(detail.artifactPaths, [join(f.root, 'tasks', task.directory, 'artifacts/report.md')]);
    assert.equal(data.invalidTaskCount, 1);
    assert.ok(data.version);
    const archived = await (await f.post('tasks?includeArchived=true', {action: 'archive', id: task.id, archived: true,
      operationId: 'archive', expectedRevision: updated.revision})).json();
    assert.equal(archived.tasks[0].archived, true);
    assert.equal(archived.tasks[0].status, 'active');
    assert.equal((await f.post('tasks', {action: 'archive', id: task.id, archived: false,
      operationId: 'restore', expectedRevision: f.tasks.get(task.id).revision})).status, 200);
    assert.equal(f.tasks.get(task.id).archived, false);
  } finally {await f.cleanup();}
});

test('task file API previews without sessions, requires authentication and rejects arbitrary paths', async () => {
  const f = await fixture(); try {
    const task = f.tasks.create({title: 'Portable', objective: 'Read file', operationId: 'portable'}).task;
    writeFileSync(join(f.root, 'tasks', task.directory, 'artifacts', 'report.sql'), 'SELECT 1;');
    const saved = f.tasks.update(task.id, {operationId: 'file', expectedRevision: task.revision, artifacts: [{type: 'file', path: 'artifacts/report.sql'}]}).task;
    const query = `tasks/file?id=${task.id}&kind=artifact&index=0&revision=${saved.revision}`;
    assert.equal((await fetch(f.origin + '/api/project/' + query)).status, 401);
    const file = await (await f.get(query)).json(); assert.equal(file.text, 'SELECT 1;'); assert.equal(file.name, 'report.sql');
    assert.match(file.version, /^[a-f0-9]{64}$/);
    writeFileSync(join(f.root, 'tasks', task.directory, 'artifacts', 'report.sql'), 'SELECT 2;');
    const refreshed = await (await f.get(query)).json(); assert.equal(refreshed.text, 'SELECT 2;'); assert.notEqual(refreshed.version, file.version);
    assert.equal((await f.get(query + '&path=/etc/passwd')).status, 422);
    assert.equal((await f.get(query.replace('index=0', 'index=1'))).status, 404);
    assert.equal((await f.get(query.replace(saved.revision, task.revision))).status, 409);
    assert.deepEqual((await (await f.get(`tasks/detail?id=${task.id}`)).json()).participants, []);
    assert.equal((await f.get('tasks/binding?sessionId=none')).status, 404);
  } finally {await f.cleanup();}
});

test('task commit API authenticates reads and fetches and accepts only recorded artifact authority', async () => {
  const f = await fixture(); try {
    const directory = join(f.root, 'repository'); const git = gitFixture(directory);
    git('remote', 'add', 'origin', 'https://example.com/org/repo.git');
    const resources = new ProjectResourceStore(f.manifest);
    await resources.mutate({action: 'addLocal', expectedRevision: resources.revision(), name: 'Repo', path: directory, type: 'git', url: 'https://example.com/org/repo.git'});
    const task = f.tasks.create({title: 'Commit artifact', objective: 'Preview code', operationId: 'commit-task'}).task;
    const saved = f.tasks.update(task.id, {operationId: 'commit-artifact', expectedRevision: task.revision,
      artifacts: [{type: 'commit', repository: 'https://example.com/org/repo', commit: git('rev-parse', 'HEAD')}]}).task;
    const body = {id: task.id, index: 0, revision: saved.revision};
    const query = `tasks/commit?${new URLSearchParams({...body, index: '0'})}`;
    for (const [path, method] of [[query, 'GET'], ['tasks/commit/fetch', 'POST']]) {
      assert.equal((await fetch(`${f.origin}/api/project/${path}`, {method})).status, 401);
      assert.equal((await fetch(`${f.origin}/api/project/${path}`, {method: 'DELETE', headers: f.headers})).status, 405);
    }
    const preview = await (await f.get(query + '&file=0')).json();
    assert.equal(preview.state, 'ready'); assert.equal(preview.diff.added, 1); assert.equal(preview.files[0].path, 'README.md');
    assert.equal((await f.get(query + '&path=/etc/passwd')).status, 422);
    assert.equal((await f.get(query + '&commit=' + 'a'.repeat(40))).status, 422);
    assert.equal((await f.get(query + '&file=-1')).status, 422);
    assert.equal((await f.get(query.replace(saved.revision, task.revision))).status, 409);
    assert.equal((await f.post('tasks/commit/fetch', {...body, url: 'https://other.example/repo'})).status, 422);
    assert.equal((await f.post('tasks/commit/fetch', {...body, index: 1})).status, 404);
    assert.equal((await fetch(f.origin + '/api/project/tasks/commit/fetch', {method: 'POST', headers: {...f.headers, origin: 'https://evil.invalid'}, body: JSON.stringify(body)})).status, 403);
    assert.equal((await fetch(f.origin + '/api/project/tasks/commit/fetch', {method: 'POST', headers: f.headers, body: ' '.repeat(65537)})).status, 413);
  } finally {await f.cleanup();}
});

test('task HTML preview reads bounded related assets without Session file authority', async () => {
  const f = await fixture(); try {
    const task = f.tasks.create({title: 'HTML', objective: 'Preview assets', operationId: 'html'}).task;
    const directory = join(f.root, 'tasks', task.directory, 'artifacts');
    writeFileSync(join(directory, 'report.html'), '<script src="./app.js"></script>');
    writeFileSync(join(directory, 'app.js'), 'document.body.textContent="ready";');
    const saved = f.tasks.update(task.id, {operationId: 'html-file', expectedRevision: task.revision,
      artifacts: [{type: 'file', path: 'artifacts/report.html'}]}).task;
    const query = `tasks/file?id=${task.id}&kind=artifact&index=0&revision=${saved.revision}`;
    assert.equal(Buffer.from((await (await f.get(query + '&related=./app.js')).json()).base64, 'base64').toString(), 'document.body.textContent="ready";');
    for (const path of ['../outside.js', '/etc/test.js', 'https://example.com/app.js', 'secret.yaml', 'app.js?query']) {
      assert.equal((await f.get(query + '&related=' + encodeURIComponent(path))).status, 422);
    }
    assert.equal((await f.get(query + '&related=missing.css')).status, 404);
    symlinkSync(join(directory, 'app.js'), join(directory, 'link.js'));
    assert.equal((await f.get(query + '&related=link.js')).status, 404);
    symlinkSync(f.root, join(directory, 'outside'));
    writeFileSync(join(f.root, 'outside.css'), 'body {}');
    assert.equal((await f.get(query + '&related=outside/outside.css')).status, 404);
    writeFileSync(join(directory, 'large.css'), Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.equal((await f.get(query + '&related=large.css')).status, 413);
    assert.equal((await f.get(query.replace(saved.revision, task.revision) + '&related=app.js')).status, 409);
  } finally {await f.cleanup();}
});

test('task API rejects stale writes and resets pagination after a committed archive', async () => {
  const f = await fixture();
  try {
    const a = f.tasks.create({title: 'A', objective: 'Review A', operationId: 'a'}, {sessionId: 'session-a'}).task;
    f.tasks.create({title: 'B', objective: 'Review B', operationId: 'b'}, {sessionId: 'session-b'});
    const page = await (await f.get('tasks?limit=1')).json();
    assert.ok(page.nextCursor);
    const action = {action: 'archive', id: a.id, archived: true, operationId: 'archive', expectedRevision: a.revision};
    assert.equal((await f.post('tasks?unknown=true', action)).status, 422);
    assert.equal(f.tasks.get(a.id).archived, false, 'invalid query rejected before mutation');
    const saved = await f.post(`tasks?limit=1&cursor=${page.nextCursor}`, action);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).total, 1);
    const stale = await f.post('tasks', {...action, archived: false, operationId: 'stale'});
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {error: 'task-revision-conflict'});
    assert.equal(f.tasks.get(a.id).archived, true);
    assert.equal((await f.get('tasks/detail?id=missing')).status, 404);
  } finally {await f.cleanup();}
});

test('task API isolates a damaged local map and bounds list results', async () => {
  const f = await fixture();
  try {
    const task = f.tasks.create({title: 'Scope review', objective: 'Inspect a long record', operationId: 'a',
      summary: '进展'.repeat(10_000)}, {sessionId: 'local-session'}).task;
    const response = await (await f.get('tasks?query=scope&limit=1')).json();
    assert.equal(response.tasks.length, 1);
    assert.ok(response.tasks[0].summary.length < 1000);
    assert.equal(response.tasks[0].truncated, true);
    mkdirSync(join(f.root, '.agent-project'), {recursive: true}); writeFileSync(f.tasks.layout.taskSources, 'malformed: [private-fixture');
    const listed = await (await f.get('tasks')).json();
    assert.equal(listed.tasks[0].id, task.id);
    assert.deepEqual(listed.diagnostics, []);
    assert.doesNotMatch(JSON.stringify(listed), /private-fixture/);
    const detail = await (await f.get(`tasks/detail?id=${task.id}`)).json();
    assert.equal(detail.task.summary.length, 20_000);
    assert.deepEqual(detail.diagnostics, []);
  } finally {await f.cleanup();}
});

test('project api imports and toggles a real Skill Provider', async () => {
  const f = await fixture();
  const source = mkdtempSync(join(tmpdir(), 'project-api-skill-'));
  try {
    const bundle = join(source, 'api-skill'); mkdirSync(bundle);
    writeFileSync(join(bundle, 'SKILL.md'), '---\nname: api-skill\ndescription: API fixture\n---\nUse this skill.');
    assert.equal((await f.post('skills', {action: 'import', path: bundle})).status, 200);
    assert.ok(await f.ctx.skills.get('api-skill'));
    const data = await (await f.post('skills', {action: 'enable', name: 'api-skill', enabled: false})).json();
    assert.equal(data.project[0].enabled, false);
    assert.equal(await f.ctx.skills.get('api-skill'), undefined);
    assert.equal(data.canImport, true); assert.equal(data.pickSource, 'native');
    // The native seam keeps its own client flow, so the Desktop chooser route stays closed.
    assert.equal((await f.post('pick', {})).status, 409);
    f.setNativePicker(false);
    const unavailable = await (await f.get('skills')).json();
    assert.equal(unavailable.canImport, false); assert.equal(unavailable.pickSource, null);
    assert.equal((await f.post('skills', {action: 'import', path: bundle})).status, 409);
    // A Desktop shell that pins browse still bridges its own chooser into this Host.
    const desktopBundle = join(source, 'desktop-skill'); mkdirSync(desktopBundle);
    writeFileSync(join(desktopBundle, 'SKILL.md'), '---\nname: desktop-skill\ndescription: Desktop fixture\n---\nUse this skill.');
    f.setDesktopPicker(async () => desktopBundle);
    const desktop = await (await f.get('skills')).json();
    assert.equal(desktop.canImport, true); assert.equal(desktop.pickSource, 'desktop');
    const picked = await f.post('pick', {});
    assert.equal(picked.status, 200); assert.deepEqual(await picked.json(), {path: desktopBundle});
    assert.equal((await f.post('skills', {action: 'import', path: desktopBundle})).status, 200);
    assert.ok(await f.ctx.skills.get('desktop-skill'));
    // Cancelling the Desktop chooser reports a null path instead of an error.
    f.setDesktopPicker(async () => null);
    assert.deepEqual(await (await f.post('pick', {})).json(), {path: null});
  } finally {await f.cleanup(); rmSync(source, {recursive: true, force: true});}
});

test('project api preserves, replaces and clears MCP secrets; testing never writes or changes live tools', async () => {
  const f = await fixture(async config => {
    if (config.transport === 'stdio' && config.command === 'broken') throw new Error('server echoed private-fixture');
    return {toolNames: ['ready'], dispose: async () => {}};
  });
  try {
    assert.equal((await f.post('mcp', {action: 'upsert', server: declaration, local: {env: {TOKEN: 'private-fixture'}, cwd: '/private-fixture'}})).status, 200);
    const before = [f.mcpStore.layout.mcpServers, f.mcpStore.layout.mcpLocal].map(path => readFileSync(path, 'utf8'));
    const tested = await f.post('mcp', {action: 'test', server: {...declaration, command: 'broken'}});
    assert.equal(tested.status, 200);
    const text = await tested.text(); assert.doesNotMatch(text, /private-fixture/); assert.equal(JSON.parse(text).ok, false);
    assert.deepEqual([f.mcpStore.layout.mcpServers, f.mcpStore.layout.mcpLocal].map(path => readFileSync(path, 'utf8')), before);
    assert.equal(f.mcp.snapshot()[0]?.status, 'connected');
    const saved = await f.post('mcp', {action: 'upsert', server: {...declaration, command: 'broken'}});
    assert.equal(saved.status, 200);
    const snapshot = await saved.json();
    assert.equal(snapshot.runtime[0].status, 'error');
    assert.equal(snapshot.runtime[0].active, true, 'The retained connection stays on after candidate failure');
    assert.doesNotMatch(JSON.stringify(snapshot), /private-fixture/);
    assert.match(readFileSync(f.mcpStore.layout.mcpLocal, 'utf8'), /private-fixture/);
    await f.post('mcp', {action: 'upsert', server: declaration, local: {env: {TOKEN: 'replacement-fixture'}}});
    assert.doesNotMatch(readFileSync(f.mcpStore.layout.mcpLocal, 'utf8'), /private-fixture|cwd:/);
    await f.post('mcp', {action: 'upsert', server: declaration, local: {}});
    assert.equal(f.mcpStore.get(declaration.id)?.hasEnvironment, false);
    assert.equal((await f.post('mcp', {action: 'delete', id: declaration.id})).status, 200);
    assert.deepEqual(f.mcp.snapshot(), []);
    writeFileSync(f.mcpStore.layout.mcpLocal, 'invalid: [private-fixture');
    const bad = await f.get('mcp'); assert.equal(bad.status, 422); assert.doesNotMatch(await bad.text(), /private-fixture|stack/);
  } finally {await f.cleanup();}
});

test('project api reports a failed MCP as off and retries the same declaration on explicit enable', async () => {
  let available = false;
  let attempts = 0;
  const f = await fixture(async () => {
    attempts += 1;
    if (!available) throw new Error('connection refused');
    return {toolNames: [], dispose: async () => {}};
  });
  try {
    const failed = await (await f.post('mcp', {action: 'upsert', server: declaration})).json();
    assert.equal(failed.runtime[0].status, 'error');
    assert.equal(failed.runtime[0].active, false);
    assert.equal(failed.servers[0].enabled, true, 'Local failure does not rewrite shared startup intent');
    available = true;
    const observed = await (await f.get('mcp')).json();
    assert.equal(observed.runtime[0].active, false);
    assert.equal(attempts, 1, 'Polling must not restart a stopped connection');

    const retried = await (await f.post('mcp', {action: 'upsert', server: declaration})).json();
    assert.equal(attempts, 2);
    assert.equal(retried.runtime[0].status, 'connected');
    assert.equal(retried.runtime[0].active, true, 'Successful zero-tool servers still turn on');
    assert.deepEqual(retried.runtime[0].toolNames, []);
    const disabled = await (await f.post('mcp', {action: 'upsert', server: {...declaration, enabled: false}})).json();
    assert.equal(disabled.runtime[0].active, false);
    assert.equal(disabled.runtime[0].status, 'disabled');
  } finally {await f.cleanup();}
});

test('project api serializes MCP persistence together with connection replacement', async () => {
  let release!: () => void;
  let mounting!: () => void;
  const started = new Promise<void>(resolve => {mounting = resolve;});
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const f = await fixture(async () => {mounting(); await blocked; return {toolNames: [], dispose: async () => {}};});
  try {
    const first = f.post('mcp', {action: 'upsert', server: declaration});
    await started;
    const second = f.post('mcp', {action: 'delete', id: declaration.id});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.mcpStore.list().length, 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.deepEqual(f.mcpStore.list(), []);
    assert.deepEqual(f.mcp.snapshot(), []);
  } finally {release(); await f.cleanup();}
});

test('project api rejects oversized chunked bodies without destroying the error response', async () => {
  const f = await fixture();
  try {
    const response = await new Promise<{status: number | undefined; body: string}>((resolve, reject) => {
      const req = request(f.origin + '/api/project/mcp', {method: 'POST', headers: f.headers}, res => {
        let body = '';
        res.on('data', chunk => {body += chunk;});
        res.on('end', () => resolve({status: res.statusCode, body}));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(' '.repeat(32768));
      req.end(' '.repeat(32769));
    });
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), {error: 'body-too-large'});
    assert.deepEqual(f.mcpStore.list(), []);
  } finally {await f.cleanup();}
});

test('project api shutdown waits for the active mutation and rejects late writes', async () => {
  let release!: () => void;
  let mounting!: () => void;
  const started = new Promise<void>(resolve => {mounting = resolve;});
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const f = await fixture(async () => {mounting(); await blocked; return {toolNames: [], dispose: async () => {}};});
  try {
    const active = f.post('mcp', {action: 'upsert', server: declaration});
    await started;
    let closed = false;
    const closing = f.closeApi().then(() => {closed = true;});
    assert.equal((await f.post('mcp', {action: 'delete', id: declaration.id})).status, 503);
    assert.equal(closed, false);
    release();
    assert.equal((await active).status, 200);
    await closing;
    assert.equal(f.mcpStore.list().length, 1);
  } finally {release(); await f.cleanup();}
});

/** Fake the Session reader/roster only; catalogs use actual DSH scoped registries. */
function sessionCatalogFixture(ctx: Context, root: string) {
  let preset = 'standard';
  let mounts = 0;
  let released = 0;
  const keys = {standard: {}, minimal: {}};
  const scopes = {standard: createScope(ctx, keys.standard), minimal: createScope(ctx, keys.minimal)};
  const live: {ctx: Context} = {ctx: scopes.standard.ctx};
  let active = false;
  ctx.provide('agents', {get: () => active ? live : undefined} as unknown as Context['agents']);
  ctx.provide('sessionQuery', {observeSession: async (id: string) => {
    if (id === 'missing') throw {code: 'SESSION_QUERY_SESSION_NOT_FOUND'};
    return {header: {cwd: id === 'foreign' ? tmpdir() : root}, projections: {values: {agentPreset: preset}},
      [Symbol.dispose]: () => {released++;}};
  }} as unknown as Context['sessionQuery']);
  ctx.provide('agentPresets', {defaultId: 'standard', standingKeyFor: async (id: string) => {
    mounts++;
    if (id !== 'standard' && id !== 'minimal') throw new Error('bad preset private-fixture');
    return keys[id];
  }, serviceFor: (_agent: unknown, name: 'skills' | 'tools') => live.ctx.get(name)} as unknown as Context['agentPresets']);
  const register = (target: Context, name: string, description = name) => target.get('tools')!.register({
    name, description, parameters: {type: 'object', properties: {}}, output: {schema: {type: 'null'}, render: () => []},
    async execute() {throw new Error('catalogs must not execute a tool');},
  });
  return {scopes, register, get mounts() {return mounts;}, get released() {return released;},
    select: (id: string) => {preset = id;}, activate: (inner: Context) => {live.ctx = inner; active = true; bindScopeParent(live, keys.standard);}};
}

test('session catalogs include preset skills, tool restrictions and shadowing without creating Agents', async () => {
  const f = await fixture();
  try {
    const c = sessionCatalogFixture(f.ctx, f.root);
    c.scopes.standard.ctx.get('skills')!.register({name: 'bundled-skill', source: 'bundled', description: 'Preset skill', content: 'Body'});
    c.scopes.minimal.ctx.get('skills')!.register({name: 'minimal-skill', source: 'runtime', description: 'Minimal skill', content: 'Body'});
    c.register(f.ctx, 'read_file', 'Global reader');
    c.register(f.ctx, 'project_task_list');
    c.register(f.ctx, 'mcp__fixture__ping');
    c.register(c.scopes.standard.ctx, 'read_file', 'Preset reader');
    c.register(c.scopes.minimal.ctx, 'shell');
    c.scopes.minimal.ctx.get('tools')!.restrict({allow: []});
    assert.deepEqual((await (await f.get('tools')).json()).tools, []);
    assert.deepEqual((await (await f.get('skills')).json()).inherited, []);
    const tools = await (await f.get('tools?sessionId=cold')).json();
    assert.equal(tools.context.agentPreset, 'standard');
    assert.deepEqual(tools.tools, [
      {name: 'mcp__fixture__ping', description: 'mcp__fixture__ping', group: 'mcp'},
      {name: 'project_task_list', description: 'project_task_list', group: 'project'},
      {name: 'read_file', description: 'Preset reader', group: 'dsh'},
    ]);
    const skills = await (await f.get('skills?sessionId=cold')).json();
    assert.deepEqual(skills.inherited.map((s: {name: string}) => s.name), ['bundled-skill']);
    assert.equal(skills.inherited[0].source, 'bundled');
    assert.equal(skills.inherited[0].readonly, true);
    c.select('minimal');
    assert.deepEqual((await (await f.get('tools?sessionId=cold')).json()).tools.map((t: {name: string}) => t.name), ['shell']);
    assert.deepEqual((await (await f.get('skills?sessionId=cold')).json()).inherited.map((s: {name: string}) => s.name), ['minimal-skill']);
    assert.equal(f.ctx.sessions.list().length, 0, 'catalog reads did not create a Session');
    assert.equal(c.mounts, c.released);
  } finally {await f.cleanup();}
});

test('session catalogs accept opaque DSH identities while preserving Project boundaries', async () => {
  const f = await fixture();
  try {
    // Use the official reader and projections so accepted IDs follow DSH's
    // actual Session contract, including exact URL-decoded identity matching.
    await f.ctx.plugin(SessionProjectionRegistry);
    await f.ctx.plugin(CatalogSessionQuery, {});
    mkdirSync(join(f.root, 'skills/fixture-skill'));
    writeFileSync(join(f.root, 'skills/fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture\n---\nBody');
    for (const id of ['review.demo', 'review:demo', '会话/评审?step=1&tag=+%#', 's'.repeat(129), ' review ']) {
      f.ctx.sessions.create(SessionId(id), {meta: {cwd: f.root}});
      for (const view of ['skills', 'tools']) {
        const response = await f.get(`${view}?sessionId=${encodeURIComponent(id)}`);
        assert.equal(response.status, 200, `${view} accepts ${id}`);
        const data = await response.json();
        assert.equal(data.context.kind, 'session');
        assert.equal(data.context.sessionId, id);
      }
    }
    const saved = await f.post('skills?sessionId=review%3Ademo', {action: 'enable', name: 'fixture-skill', enabled: false});
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).project[0].enabled, false);

    f.ctx.sessions.create(SessionId('foreign:demo'), {meta: {cwd: tmpdir()}});
    for (const id of ['foreign:demo', 'missing.demo', '../foreign']) {
      for (const view of ['skills', 'tools']) {
        const response = await f.get(`${view}?sessionId=${encodeURIComponent(id)}`);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {error: 'project-session-unavailable'});
      }
      assert.equal((await f.post(`skills?sessionId=${encodeURIComponent(id)}`, {
        action: 'enable', name: 'fixture-skill', enabled: true,
      })).status, 404);
    }
    assert.equal((await f.skills.snapshot()).project[0]?.enabled, false);
  } finally {await f.cleanup();}
});

test('session catalog authorization and Project root checks precede preset mounting and Skill writes', async () => {
  const f = await fixture();
  try {
    const c = sessionCatalogFixture(f.ctx, f.root);
    mkdirSync(join(f.root, 'skills/fixture-skill'));
    writeFileSync(join(f.root, 'skills/fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture\n---\nBody');
    for (const view of ['skills', 'tools']) {
      assert.equal((await fetch(f.origin + `/api/project/${view}?sessionId=cold`)).status, 401);
      for (const id of ['foreign', 'missing']) {
        assert.equal((await f.get(`${view}?sessionId=${id}`)).status, 404);
      }
      for (const query of ['sessionId=', 'sessionId=cold&sessionId=foreign']) {
        assert.equal((await f.get(`${view}?${query}`)).status, 422);
      }
    }
    assert.equal((await f.post('skills?sessionId=foreign', {action: 'enable', name: 'fixture-skill', enabled: false})).status, 404);
    assert.equal((await f.skills.snapshot()).project[0]?.enabled, true);
    assert.equal(c.mounts, 0);
    c.select('unknown');
    const unavailable = await f.get('tools?sessionId=cold');
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {error: 'catalog-unavailable'});
  } finally {await f.cleanup();}
});

test('live Session catalogs read isolated preset services and Skill writes keep the selected scope', async () => {
  const f = await fixture();
  const isolated = new Context();
  await isolated.plugin(SystemPrompt, {}); await isolated.plugin(SkillRegistry); await isolated.plugin(ToolRuntime);
  try {
    const c = sessionCatalogFixture(f.ctx, f.root);
    isolated.skills.register({name: 'isolated-skill', description: 'Isolated', source: 'bundled', content: 'Body'});
    c.register(isolated, 'isolated_tool');
    c.activate(isolated);
    mkdirSync(join(f.root, 'skills/fixture-skill'));
    writeFileSync(join(f.root, 'skills/fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture\n---\nBody');
    const snapshot = await (await f.post('skills?sessionId=live', {action: 'enable', name: 'fixture-skill', enabled: true})).json();
    assert.equal(snapshot.context.sessionId, 'live');
    assert.equal(snapshot.project[0].effective, false, 'enabled Project skill is absent from the isolated registry');
    assert.equal(snapshot.inherited[0].name, 'isolated-skill');
    assert.deepEqual((await (await f.get('tools?sessionId=live')).json()).tools.map((t: {name: string}) => t.name), ['isolated_tool']);
    assert.equal(c.mounts, 0, 'live registry reads need no standing mount');
  } finally {await isolated.fiber.dispose(); await f.cleanup();}
});
