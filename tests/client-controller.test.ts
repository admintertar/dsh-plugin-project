import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {ProjectCapabilityController} from '../src/client/controller.ts';

const empty = {version: 'v1', tasks: [], invalidTaskCount: 0, diagnostics: [], total: 0, unarchivedTotal: 0};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('task filtering invalidates stale pages and preserves query parameters during archive', async () => {
  let first!: (value: Response) => void;
  const calls: string[] = [];
  const controller = new ProjectCapabilityController((async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Promise<Response>(resolve => {first = resolve;});
    return response({...empty, version: 'filtered'});
  }) as typeof fetch);
  try {
    const old = controller.refresh('tasks');
    controller.setTaskQuery({query: '弹窗', status: 'active', includeArchived: true});
    assert.equal(controller.getSnapshot().tasks.data, undefined);
    await controller.refresh('tasks');
    first(response({...empty, version: 'obsolete'})); await old;
    assert.equal(controller.getSnapshot().tasks.data?.version, 'filtered');
    await controller.mutate('tasks', {action: 'archive', id: 'a', archived: true, operationId: 'a', expectedRevision: 'a'.repeat(64)});
    for (const url of calls.slice(1)) {
      const params = new URL(url, 'http://localhost').searchParams;
      assert.equal(params.get('query'), '弹窗');
      assert.equal(params.get('status'), 'active');
      assert.equal(params.get('includeArchived'), 'true');
    }
  } finally {controller.dispose();}
});

test('project client controller calls browser fetch with a valid receiver', async t => {
  t.mock.method(globalThis, 'fetch', async function(this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return response(empty);
  });
  const controller = new ProjectCapabilityController();
  try {
    await controller.refresh('tasks');
    assert.equal(controller.getSnapshot().tasks.error, undefined);
    assert.deepEqual(controller.getSnapshot().tasks.data, empty);
  } finally {controller.dispose();}
});

test('project client controller isolates views and ignores a superseded refresh even if fetch ignores abort', async () => {
  let resolveFirst!: (value: Response) => void;
  let firstSignal: AbortSignal | undefined;
  let requests = 0;
  const controller = new ProjectCapabilityController((async (url, init) => {
    if (String(url).endsWith('skills')) return response({error: 'broken configuration with secret-fixture'}, 422);
    if (++requests === 1) {
      firstSignal = init?.signal as AbortSignal;
      return new Promise<Response>(resolve => {resolveFirst = resolve;});
    }
    return response({...empty, version: 'fresh'});
  }) as typeof fetch);
  try {
    const first = controller.refresh('tasks');
    await controller.refresh('tasks');
    assert.equal(firstSignal?.aborted, true);
    resolveFirst(response({...empty, version: 'stale'}));
    await first;
    assert.equal(controller.getSnapshot().tasks.data?.version, 'fresh');
    await controller.refresh('skills');
    assert.equal(controller.getSnapshot().tasks.data?.version, 'fresh');
    assert.equal(controller.getSnapshot().skills.error, 'operation-failed');
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /secret-fixture/);
  } finally {controller.dispose();}
});

test('project client controller applies mutation snapshots and retains previous data on error', async () => {
  let fail = false;
  const methods: string[] = [];
  const controller = new ProjectCapabilityController((async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    if (fail) return response({error: 'operation-failed'}, 422);
    return response({...empty, version: init?.method === 'POST' ? 'updated' : 'initial'});
  }) as typeof fetch);
  try {
    await controller.refresh('tasks');
    assert.equal(await controller.mutate('tasks', {action: 'archive', id: 'task', archived: true, operationId: 'archive', expectedRevision: 'a'.repeat(64)}), true);
    assert.equal(controller.getSnapshot().tasks.data?.version, 'updated');
    fail = true;
    assert.equal(await controller.mutate('tasks', {action: 'archive', id: 'task', archived: false, operationId: 'restore', expectedRevision: 'b'.repeat(64)}), false);
    assert.equal(controller.getSnapshot().tasks.data?.version, 'updated');
    assert.equal(controller.getSnapshot().tasks.error, 'operation-failed');
    assert.deepEqual(methods, ['GET', 'POST', 'POST']);
  } finally {controller.dispose();}
});

test('item mutations can run together without setting the page-wide pending state', async () => {
  const pending: Array<(value: Response) => void> = [];
  const controller = new ProjectCapabilityController((async (_url, init) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => pending.push(resolve));
    return response({version: 'initial', project: [], inherited: []});
  }) as typeof fetch);
  try {
    const first = controller.mutate('skills', {action: 'enable', name: 'one', enabled: false}, {scope: 'item'});
    const second = controller.mutate('skills', {action: 'enable', name: 'two', enabled: false}, {scope: 'item'});
    assert.equal(controller.getSnapshot().skills.pending, false);
    assert.equal(pending.length, 2);
    pending[0]!(response({version: 'one', project: [], inherited: []}));
    pending[1]!(response({version: 'two', project: [], inherited: []}));
    assert.equal(await first, true);
    assert.equal(await second, true);
  } finally {controller.dispose();}
});

test('project client controller cancels Skill import and keeps MCP secrets out of view snapshots', async () => {
  const calls: string[] = [];
  const controller = new ProjectCapabilityController((async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.local.env.TOKEN, 'secret-fixture');
    if (body.action === 'test') return response({ok: true, toolNames: ['ping']});
    return response({version: 'saved', servers: [], runtime: []});
  }) as typeof fetch);
  try {
    assert.equal(await controller.importSkill(async () => null), false);
    assert.deepEqual(calls, []);
    const candidate = {action: 'upsert' as const, server: {id: 'fixture', serverName: 'fixture', transport: 'stdio' as const,
      command: 'node', args: [], enabled: true, toolCallTimeoutMs: 1000}, local: {env: {TOKEN: 'secret-fixture'}}};
    assert.equal((await controller.testMcp(candidate)).ok, true);
    assert.equal(await controller.mutate('mcp', candidate), true);
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /secret-fixture|TOKEN/);
    assert.equal(controller.getSnapshot().mcp.data?.version, 'saved');
  } finally {controller.dispose();}
});

test('project client controller prevents stale GET from overwriting a mutation and aborts on disposal', async () => {
  let resolveGet!: (value: Response) => void;
  let getSignal: AbortSignal | undefined;
  const controller = new ProjectCapabilityController((async (_url, init) => {
    if (init?.method === 'POST') return response({...empty, version: 'saved'});
    getSignal = init?.signal as AbortSignal;
    return new Promise<Response>(resolve => {resolveGet = resolve;});
  }) as typeof fetch);
  const get = controller.refresh('tasks');
  await controller.mutate('tasks', {action: 'archive', id: 'task', archived: true, operationId: 'archive', expectedRevision: 'a'.repeat(64)});
  resolveGet(response({...empty, version: 'stale'}));
  await get;
  assert.equal(controller.getSnapshot().tasks.data?.version, 'saved');
  const pending = controller.refresh('tasks');
  controller.dispose();
  assert.equal(getSignal?.aborted, true);
  resolveGet(response(empty));
  await pending;
  assert.equal(controller.getSnapshot().tasks.data?.version, 'saved');
});

test('session switches immediately clear catalogs and ignore stale requests, including same-session preset changes', async () => {
  const pending: Array<{url: string; resolve(value: Response): void; signal: AbortSignal}> = [];
  const controller = new ProjectCapabilityController((async (url, init) => {
    if (String(url).endsWith('tasks')) return response(empty);
    return new Promise<Response>(resolve => pending.push({url: String(url), resolve, signal: init?.signal as AbortSignal}));
  }) as typeof fetch);
  const settle = async (calls: typeof pending, version: string) => {
    calls.forEach(call => call.resolve(response({version, tools: [], project: [], inherited: []})));
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    await controller.refresh('tasks');
    controller.setSession('first');
    const first = pending.splice(0);
    assert.equal(first.length, 2);
    assert.ok(first.every(call => call.url.endsWith('?sessionId=first')));
    controller.setSession('second');
    assert.ok(first.every(call => call.signal.aborted));
    assert.equal(controller.getSnapshot().skills.data, undefined);
    assert.equal(controller.getSnapshot().tools.data, undefined);
    const second = pending.splice(0);
    await settle(second, 'second'); await settle(first, 'stale');
    assert.equal(controller.getSnapshot().tools.data?.version, 'second');
    assert.equal(controller.getSnapshot().skills.data?.version, 'second');
    controller.setSession('second');
    assert.equal(pending.length, 0, 'streaming list updates with the same selection do not refetch');
    controller.invalidateCatalogs();
    assert.equal(controller.getSnapshot().tools.data, undefined);
    await settle(pending.splice(0), 'new-preset');
    assert.equal(controller.getSnapshot().tools.data?.version, 'new-preset');
    assert.equal(controller.getSnapshot().tasks.data?.version, 'v1');
    controller.setSession(undefined);
    const project = pending.splice(0);
    assert.ok(project.every(call => !call.url.includes('?')));
    await settle(project, 'project');
  } finally {controller.dispose();}
});

test('a Skill mutation finishing after a Session switch refreshes the new catalog without publishing the old one', async () => {
  let resolveMutation!: (value: Response) => void;
  const seen: Array<string | undefined> = [];
  const controller = new ProjectCapabilityController((async (url, init) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => {resolveMutation = resolve;});
    return response({version: String(url).includes('second') ? 'second' : 'first', tools: [], project: [], inherited: []});
  }) as typeof fetch);
  try {
    controller.setSession('first');
    await controller.refresh('skills');
    const mutation = controller.mutate('skills', {action: 'enable', name: 'skill', enabled: false});
    controller.setSession('second');
    controller.subscribe(() => seen.push(controller.getSnapshot().skills.data?.version));
    assert.equal(controller.getSnapshot().skills.data, undefined);
    assert.equal(controller.getSnapshot().skills.pending, true);
    resolveMutation(response({version: 'old-mutation'}));
    assert.equal(await mutation, true, 'the project-wide write is still acknowledged');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(controller.getSnapshot().skills.data?.version, 'second');
    assert.ok(!seen.includes('old-mutation'));
  } finally {controller.dispose();}
});
