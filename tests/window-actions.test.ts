import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {Context} from '@deepseek-ai/cordis';
import {registerWindowActions} from '../src/window-actions.ts';

test('window actions require DSH authentication and same-origin JSON before native operations', async () => {
  const ctx = new Context();
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  let opens = 0;
  const focused: string[] = [];
  const presentations: {mode: string; directory?: string}[] = [];
  ctx.provide('desktopRuntime', {workspaceWindows: {
    presentation: async () => 'project',
    selectPresentation: async (mode: string, directory?: string) => {presentations.push({mode, directory});},
    list: async () => [{id: 'a', title: 'A', current: true}],
    open: async () => {opens++;}, focus: async (id: string) => {focused.push(id);},
  }});
  const server = createServer((req, res) => {void handler(req, res);});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as {port: number};
  const origin = `http://127.0.0.1:${address.port}`;
  ctx.provide('webServer', {port: address.port, register: (route: {handler: typeof handler}) => {
    handler = route.handler; return () => {};
  }} as unknown as Context['webServer']);
  ctx.provide('connection', {requestRejection: (req: IncomingMessage) => req.headers.authorization === 'fixture' ? undefined : 401} as unknown as Context['connection']);
  registerWindowActions(ctx);
  const url = origin + '/api/project/windows';
  const headers = {authorization: 'fixture', origin, 'content-type': 'application/json'};
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.deepEqual(await (await fetch(url, {headers})).json(), {enabled: true, presentation: 'project', windows: [{id: 'a', title: 'A', current: true}]});
    assert.equal((await fetch(url, {method: 'POST', headers: {...headers, origin: 'https://elsewhere.invalid'}, body: '{"action":"open"}'})).status, 403);
    assert.equal(opens, 0);
    assert.equal((await fetch(url, {method: 'POST', headers, body: '{"action":"open"}'})).status, 200);
    assert.equal(opens, 1);
    assert.equal((await fetch(url, {method: 'POST', headers, body: JSON.stringify({action: 'presentation', mode: 'project', directory: '/workspace'})})).status, 200);
    assert.deepEqual(presentations, [{mode: 'project', directory: '/workspace'}]);
    for (const body of [{action: 'presentation', mode: 'unknown'}, {action: 'presentation', mode: 'project', directory: 42}]) {
      assert.equal((await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)})).status, 422);
    }
    assert.equal(presentations.length, 1);
    assert.equal((await fetch(url, {method: 'POST', headers, body: '{"action":"focus","id":"a"}'})).status, 200);
    assert.deepEqual(focused, ['a']);
    assert.equal((await fetch(url, {method: 'POST', headers, body: '{"action":"focus","id":42}'})).status, 422);
    assert.equal((await fetch(url, {method: 'POST', headers, body: ' '.repeat(4097)})).status, 413);
    assert.deepEqual(focused, ['a']);
  } finally {await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
