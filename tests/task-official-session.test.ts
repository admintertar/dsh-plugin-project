import {strict as assert} from 'node:assert';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire, registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {after, test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import SessionStore, {SessionId, type Session} from '@deepseek-ai/dsh-session';
import {TaskContinuationController} from '../src/client/task-continuation.ts';
import {ProjectTaskStore} from '../src/tasks.ts';
import {readProject} from '../src/project.ts';

// Probe the installed, pinned official implementations. These package-private
// test imports do not add a production dependency on non-exported DSH APIs.
const officialRoot = new URL('./', import.meta.resolve('@deepseek-ai/dsh-api-session-controller'));
// Its public /client entry is a browser-loader bundle. In this Node probe use
// the same shipped implementation modules, without filesystem aliases or mocks.
const gatewayRoot = new URL('./', import.meta.resolve('@deepseek-ai/dsh-api-gateway'));
const clientModules = registerHooks({resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === '@deepseek-ai/dsh-api-gateway/client'
    ? new URL('types/client/index.js', gatewayRoot).href : specifier, context);
}});
after(() => clientModules.deregister());
const {ClientSessions} = (await import(new URL('types/client/sessions/service.js', officialRoot).href)) as
  typeof import('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js');
const {ApiSessionAgentController} = (await import(new URL('types/agent.js', officialRoot).href)) as
  typeof import('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js');
const {SessionCommandController} = (await import(new URL('types/commands.js', officialRoot).href)) as
  typeof import('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js');
const {ApiSessionList} = (await import(new URL('types/list.js', officialRoot).href)) as
  typeof import('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/list.js');
const {SessionQueryError} = (await import(pathToFileURL(createRequire(officialRoot).resolve('@deepseek-ai/dsh-session-query')).href)) as
  {SessionQueryError: new (message: string, code: string) => Error};

test('official Session client filters create payload, retries the published identity and exposes its draft scope immediately', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-official-session-')));
  const host = new Context();
  const client = new Context();
  await host.plugin(SessionStore);
  const manifest = join(root, 'example.agent-project');
  writeFileSync(manifest, 'schemaVersion: 1\nid: official\nname: Official integration\nresources: []\nmemory: []\n');
  const tasks = new ProjectTaskStore(readProject(manifest));
  const target = tasks.create({title: '继续记录', objective: '核实现场后继续', operationId: 'target'}, {sessionId: 'original'}).task;
  const agents = new Map<string, {id: string; session: Session; ctx: Context}>();
  let creations = 0;
  const attached = new Set<string>();
  host.provide('typert', {lookups: {configure() {}}, contexts: {configureHost() {}}} as never);
  host.provide('sessionProjections', {stateOf: () => undefined} as never);
  host.provide('sessionQuery', {observeSession: async () => {throw new SessionQueryError('not found', 'SESSION_QUERY_SESSION_NOT_FOUND');}} as never);
  host.provide('agentDefaultModel', {currentSelection: () => ({provider: 'fixture', model: 'fixture'})} as never);
  host.provide('agents', {
    get: (id: string) => agents.get(id), isOwnedBy: () => false,
    create: async (input: {sessionId: string; meta: {cwd: string}}) => {
      creations++;
      const agent = {id: input.sessionId, session: host.sessions.create(SessionId(input.sessionId), {meta: input.meta}), ctx: host};
      agents.set(input.sessionId, agent);
      return {agent};
    },
  } as never);
  host.provide('workspaceRegistry', {get: (id: string) => id === 'project-workspace' ? {
    id, path: root, attachSession: async (sessionId: string) => {attached.add(sessionId);},
  } : undefined} as never);
  const commands = new SessionCommandController(host, new ApiSessionAgentController(host), root);
  const payloads: unknown[] = [];
  let loseResponse = true;
  const sessions = new ClientSessions(client, {
    session: {
      create: async (payload: Parameters<typeof commands.create>[0]) => {
        payloads.push(payload);
        const value = await commands.create(payload);
        if (loseResponse) {loseResponse = false; return {ok: false, error: {code: 'gateway/disconnected', message: 'response lost', details: {}}};}
        return {ok: true, value};
      },
      prompt: () => assert.fail('Preparing a task must not submit a prompt'),
    },
  } as never);
  const events: string[] = [];
  let draft = '';
  let sequence = 0;
  const continuation = new TaskContinuationController({
    project: () => ({id: 'official', root}), beginNavigation: () => new AbortController().signal,
    createSession: async (cwd, id) => {await sessions.create({workspaceId: 'project-workspace' as never, cwd, sessionId: SessionId(id)});},
    readTask: async id => {events.push('read'); return tasks.get(id);},
    input: id => {
      assert.ok(sessions.scope(SessionId(id)), 'official scope must resolve as soon as create returns');
      return {draft: () => draft, setDraft: text => {events.push('draft'); draft = text;}};
    },
    draft: task => `Read ${task.id} and verify current state before continuing.`,
    openSession: id => {events.push(`open:${id}`);}, id: () => `new-${++sequence}`,
  });
  try {
    await assert.rejects(continuation.continue(target), /response lost/);
    assert.equal(creations, 1);
    assert.equal(draft, '');
    const result = await continuation.continue(target);
    assert.equal(creations, 1, 'the official Host must adopt the already published Session');
    assert.deepEqual(payloads, [
      {workspaceId: 'project-workspace', sessionId: 'new-1'}, {workspaceId: 'project-workspace', sessionId: 'new-1'},
    ]);
    assert.equal(result.sessionId, 'new-1');
    assert.equal(sessions.list.getSnapshot().byId[SessionId('new-1')]?.cwd, root);
    assert.deepEqual(tasks.sources(target.id), {});
    assert.deepEqual([...attached], ['new-1']);
    assert.deepEqual(events, ['read', 'draft', 'open:new-1']);
    assert.match(draft, /verify current state/);
    assert.equal(host.sessions.get(SessionId('new-1'))?.seq, 0, 'preparation must not append user messages or start turns');
    await assert.rejects(commands.create({workspaceId: 'project-workspace' as never, cwd: root}), /not both/);
  } finally {
    continuation.dispose();
    await client.fiber.dispose();
    await host.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('official Session list includes cold project records and makes their client navigation scope available', async () => {
  const host = new Context();
  const client = new Context();
  await host.plugin(SessionStore);
  const root = '/project/cold-history';
  const cold = {id: SessionId('cold-record'), cwd: root, createdAt: 1, formatVersion: 1};
  host.provide('sessionProjections', {register() {}} as never);
  host.provide('sessionQuery', {listSessions: async () => [{header: cold}]} as never);
  const list = new ApiSessionList(host);
  const sessions = new ClientSessions(client, {session: {list: async () => ({ok: true, value: {items: await list.list()}})}} as never);
  try {
    assert.equal(host.sessions.get(cold.id), undefined);
    assert.equal(sessions.list.getSnapshot().byId[cold.id], undefined);
    await sessions.refresh();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(sessions.list.getSnapshot().byId[cold.id]?.cwd, root);
    assert.equal(sessions.list.getSnapshot().byId[cold.id]?.running, false);
    assert.ok(sessions.scope(cold.id));
    assert.equal(host.sessions.get(cold.id), undefined, 'listing and resolving a client scope must not activate the Host Session');
  } finally {
    await client.fiber.dispose();
    await host.fiber.dispose();
  }
});
