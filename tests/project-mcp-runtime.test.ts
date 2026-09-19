import {strict as assert} from 'node:assert';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {ToolRunContext} from '@deepseek-ai/dsh-tools';
import type {JsonValue} from '@deepseek-ai/dsh-util-values';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import type {ProjectView} from '../src/project.ts';
import {
  ProjectMcpConfigStore, type ProjectMcpServer, type ResolvedProjectMcpServer,
} from '../src/project-mcp-config.ts';
import {
  ProjectMcpRuntime, type ProjectMcpMount,
} from '../src/project-mcp-runtime.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-runtime-')));
  const project: ProjectView = {
    id: 'runtime-project', name: 'Runtime Project', description: '', root,
    resources: [{id: 'root', name: 'Root', type: 'local', path: root, status: 'ready'}], memory: [],
  };
  const store = new ProjectMcpConfigStore(project);
  return {root, project, store, cleanup: () => rmSync(root, {recursive: true, force: true})};
}

function resolved(overrides: Partial<ResolvedProjectMcpServer> = {}): ResolvedProjectMcpServer {
  return {
    id: 'fixture', serverName: 'fixture', enabled: true, transport: 'stdio', command: 'node', args: ['v1'],
    env: {}, cwd: '', toolCallTimeoutMs: 5_000, ...overrides,
  } as ResolvedProjectMcpServer;
}

function declared(overrides: Partial<ProjectMcpServer> = {}): ProjectMcpServer {
  return {
    id: 'fixture', serverName: 'fixture', enabled: true, transport: 'stdio', command: 'node', args: ['v1'],
    toolCallTimeoutMs: 5_000, ...overrides,
  } as ProjectMcpServer;
}

test('project mcp runtime starts enabled servers and skips unchanged reconciles', async () => {
  const f = fixture();
  const ctx = new Context();
  const mounted: string[] = [];
  const mount: ProjectMcpMount = async config => {
    mounted.push(config.transport === 'stdio' ? config.args[0]! : config.url);
    return {toolNames: [`mcp__${config.serverName}__ping`], dispose: async () => {}};
  };
  try {
    f.store.upsert(declared(), {env: {ALPHA: 'one', BETA: 'two'}});
    const runtime = new ProjectMcpRuntime(ctx, f.store, {mount});
    await runtime.reconcile();
    assert.deepEqual(mounted, ['v1']);
    assert.deepEqual(runtime.snapshot().map(state => [state.id, state.status, state.toolNames]), [
      ['fixture', 'connected', ['mcp__fixture__ping']],
    ]);
    f.store.upsert(declared(), {env: {BETA: 'two', ALPHA: 'one'}});
    await runtime.reconcile();
    assert.deepEqual(mounted, ['v1']);
    await runtime.dispose();
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});

test('project mcp runtime mounts a successful candidate before disposing the previous instance', async () => {
  const f = fixture();
  const ctx = new Context();
  const events: string[] = [];
  const mount: ProjectMcpMount = async config => {
    const version = config.transport === 'stdio' ? config.args[0]! : 'http';
    events.push(`mount:${version}`);
    return {
      toolNames: [`mcp__${config.serverName}__${version}`],
      dispose: async () => {events.push(`dispose:${version}`);},
    };
  };
  try {
    f.store.upsert(declared());
    const runtime = new ProjectMcpRuntime(ctx, f.store, {mount});
    await runtime.reconcile();
    f.store.upsert(declared({args: ['v2']}));
    await runtime.reconcile();
    assert.deepEqual(events, ['mount:v1', 'mount:v2', 'dispose:v1']);
    assert.deepEqual(runtime.snapshot()[0]?.toolNames, ['mcp__fixture__v2']);
    await runtime.dispose();
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});

test('project mcp runtime retains the previous instance when a candidate fails', async () => {
  const f = fixture();
  const ctx = new Context();
  const disposed: string[] = [];
  const mount: ProjectMcpMount = async config => {
    const version = config.transport === 'stdio' ? config.args[0]! : 'http';
    if (version === 'broken') throw new Error('candidate refused TOKEN_VALUE');
    return {
      toolNames: [`mcp__${config.serverName}__${version}`],
      dispose: async () => {disposed.push(version);},
    };
  };
  try {
    f.store.upsert(declared(), {env: {TOKEN: 'TOKEN_VALUE'}});
    const runtime = new ProjectMcpRuntime(ctx, f.store, {mount});
    await runtime.reconcile();
    f.store.upsert(declared({args: ['broken']}));
    await runtime.reconcile();
    assert.deepEqual(disposed, []);
    assert.equal(runtime.snapshot()[0]?.status, 'error');
    assert.equal(runtime.snapshot()[0]?.active, true, 'The previous live connection remains on');
    assert.deepEqual(runtime.snapshot()[0]?.toolNames, ['mcp__fixture__v1']);
    assert.doesNotMatch(runtime.snapshot()[0]?.lastError?.message ?? '', /TOKEN_VALUE/);

    f.store.upsert(declared({enabled: false, args: ['broken']}));
    await runtime.reconcile();
    assert.deepEqual(disposed, ['v1']);
    assert.equal(runtime.snapshot()[0]?.status, 'disabled');
    assert.equal(runtime.snapshot()[0]?.active, false);
    f.store.delete('fixture');
    await runtime.reconcile();
    assert.deepEqual(runtime.snapshot(), []);
    await runtime.dispose();
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});

test('project mcp runtime disposal waits for every mounted instance', async () => {
  const f = fixture();
  const ctx = new Context();
  let finishClosing!: () => void;
  const closing = new Promise<void>(resolve => {finishClosing = resolve;});
  let disposeStarted = false;
  let settled = false;
  try {
    f.store.upsert(declared());
    const runtime = new ProjectMcpRuntime(ctx, f.store, {mount: async () => ({
      toolNames: [],
      dispose: async () => {disposeStarted = true; await closing;},
    })});
    await runtime.reconcile();
    const disposal = runtime.dispose().then(() => {settled = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposeStarted, true);
    assert.equal(settled, false);
    finishClosing();
    await disposal;
    assert.equal(settled, true);
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});

test('project mcp runtime testConnection uses a temporary namespace and always disposes it', async () => {
  const f = fixture();
  const ctx = new Context();
  const mounted: ResolvedProjectMcpServer[] = [];
  let disposals = 0;
  const mount: ProjectMcpMount = async config => {
    mounted.push(config);
    return {
      toolNames: [`mcp__${config.serverName}__ping`],
      dispose: async () => {disposals += 1;},
    };
  };
  try {
    const runtime = new ProjectMcpRuntime(ctx, f.store, {mount});
    const result = await runtime.testConnection(resolved());
    assert.equal(result.ok, true);
    assert.equal(mounted[0]?.serverName === 'fixture', false);
    assert.deepEqual(result.toolNames, [`mcp__${mounted[0]?.serverName}__ping`]);
    assert.equal(disposals, 1);
    await runtime.dispose();
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});

test('project mcp runtime testConnection contains discovery errors and still disposes the temporary instance', async () => {
  const f = fixture();
  const ctx = new Context();
  let disposals = 0;
  try {
    const runtime = new ProjectMcpRuntime(ctx, f.store, {mount: async () => ({
      get toolNames(): readonly string[] {throw new Error('discovery exposed TOKEN_VALUE');},
      dispose: async () => {disposals += 1;},
    })});
    const result = await runtime.testConnection(resolved({env: {TOKEN: 'TOKEN_VALUE'}}));
    assert.equal(result.ok, false);
    assert.equal(disposals, 1);
    assert.doesNotMatch(result.error?.message ?? '', /TOKEN_VALUE/);
    await runtime.dispose();
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});

test('project mcp runtime mounts the real stdio client and registers its discovered tool', async () => {
  const f = fixture();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  const server = fileURLToPath(new URL('./fixtures/project-mcp-server.mjs', import.meta.url));
  try {
    f.store.upsert({
      id: 'real-fixture', serverName: 'fixture', enabled: true, transport: 'stdio',
      command: process.execPath, args: [server], toolCallTimeoutMs: 5_000,
    });
    const runtime = new ProjectMcpRuntime(ctx, f.store);
    await runtime.reconcile();
    assert.ok(ctx.tools.get('mcp__fixture__ping'));
    assert.deepEqual(runtime.snapshot()[0]?.toolNames, ['mcp__fixture__ping']);
    await runtime.dispose();
    assert.equal(ctx.tools.get('mcp__fixture__ping'), undefined);
  } finally {await ctx.fiber.dispose(); f.cleanup();}
});


async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}

for (const empty of [false, true]) {
  test(`MCP process exit updates health and permits manual reconnect (empty tools: ${empty})`, async () => {
    const f = fixture();
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime);
    const runtime = new ProjectMcpRuntime(ctx, f.store);
    try {
      const pidFile = join(f.root, 'server.pid');
      const server = fileURLToPath(new URL('./fixtures/project-mcp-server.mjs', import.meta.url));
      f.store.upsert(declared({command: process.execPath,
        args: [server, `--pid-file=${pidFile}`, ...(empty ? ['--empty'] : [])], reconnect: {enabled: false}}));
      await runtime.reconcile();
      assert.equal(runtime.snapshot()[0]?.status, 'connected');
      assert.equal(runtime.snapshot()[0]?.active, true, 'A zero-tool connection must also stay on');
      const firstPid = Number(readFileSync(pidFile, 'utf8'));
      process.kill(firstPid);
      await eventually(() => runtime.snapshot()[0]?.status === 'error', 'Exit must update health without calling a Tool');
      assert.equal(runtime.snapshot()[0]?.active, false, 'A stopped connection must turn off');
      assert.deepEqual(runtime.snapshot()[0]?.toolNames, []);
      assert.equal(ctx.tools.get('mcp__fixture__ping'), undefined);
      await runtime.reconcile();
      assert.equal(runtime.snapshot()[0]?.status, 'connected');
      assert.equal(runtime.snapshot()[0]?.active, true);
      assert.notEqual(Number(readFileSync(pidFile, 'utf8')), firstPid);
      assert.equal(Boolean(ctx.tools.get('mcp__fixture__ping')), !empty);
    } finally {await runtime.dispose(); await ctx.fiber.dispose(); f.cleanup();}
  });
}

test('MCP automatic reconnect restores tools and reports retry exhaustion', async () => {
  const f = fixture();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  const runtime = new ProjectMcpRuntime(ctx, f.store);
  try {
    const pidFile = join(f.root, 'server.pid');
    const server = fileURLToPath(new URL('./fixtures/project-mcp-server.mjs', import.meta.url));
    f.store.upsert(declared({command: process.execPath, args: [server, `--pid-file=${pidFile}`],
      reconnect: {enabled: true, initialDelayMs: 150, maxDelayMs: 30_000, maxAttempts: 1}}));
    await runtime.reconcile();
    const firstPid = Number(readFileSync(pidFile, 'utf8'));
    process.kill(firstPid);
    await eventually(() => runtime.snapshot()[0]?.status === 'reconnecting', 'Lost connection must enter backoff');
    assert.equal(runtime.snapshot()[0]?.active, true, 'Automatic reconnect remains on during backoff');
    assert.equal(ctx.tools.get('mcp__fixture__ping'), undefined);
    await runtime.reconcile();
    assert.equal(Number(readFileSync(pidFile, 'utf8')), firstPid, 'Reconcile must not bypass automatic backoff');
    await eventually(() => runtime.snapshot()[0]?.status === 'connected', 'Reconnect must restore healthy state');
    assert.equal(runtime.snapshot()[0]?.active, true);
    assert.ok(ctx.tools.get('mcp__fixture__ping'));
    const secondPid = Number(readFileSync(pidFile, 'utf8'));
    assert.notEqual(firstPid, secondPid);
    process.kill(secondPid);
    await eventually(() => runtime.snapshot()[0]?.status === 'error', 'Crash loop must exhaust the retry budget');
    assert.equal(runtime.snapshot()[0]?.active, false, 'Exhausted reconnect must turn off');
    assert.equal(ctx.tools.get('mcp__fixture__ping'), undefined);
  } finally {await runtime.dispose(); await ctx.fiber.dispose(); f.cleanup();}
});

test('MCP image results use the Host attachment store and model metadata', async () => {
  const f = fixture();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  let saves = 0;
  ctx.provide('attachments', {async saveImages() {saves += 1; return [{id: 'fixture-image'}];}} as unknown as Context['attachments']);
  ctx.provide('llm', {async resolveModelInfo() {return {inputModalities: ['image']};}} as unknown as Context['llm']);
  const runtime = new ProjectMcpRuntime(ctx, f.store);
  try {
    const server = fileURLToPath(new URL('./fixtures/project-mcp-server.mjs', import.meta.url));
    f.store.upsert(declared({command: process.execPath, args: [server, '--image']}));
    await runtime.reconcile();
    const definition = ctx.tools.get('mcp__fixture__ping')!;
    const execution = {signal: new AbortController().signal,
      agent: {session: {requestHeader: () => ({config: {provider: 'fixture', model: 'fixture'}})}, options: {}},
    } as unknown as ToolRunContext;
    const value = await definition.execute({}, execution) as JsonValue;
    const content = definition.output.render({}, value);
    const result = definition.finalizeContent!(execution, {isError: false, value, content});
    assert.equal(saves, 1);
    assert.equal(result?.[0]?.type, 'image');
  } finally {await runtime.dispose(); await ctx.fiber.dispose(); f.cleanup();}
});

test('runtime disposal waits for connection tests and rejects new tests after closing', async () => {
  const f = fixture();
  const ctx = new Context();
  let finishMount!: () => void;
  let disposed = false;
  let stopped = false;
  const ready = new Promise<void>(resolve => {finishMount = resolve;});
  const runtime = new ProjectMcpRuntime(ctx, f.store, {mount: async () => {
    await ready;
    return {toolNames: [], dispose: async () => {disposed = true;}};
  }});
  try {
    const probe = runtime.testConnection(resolved());
    const stopping = runtime.dispose().then(() => {stopped = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    await assert.rejects(runtime.testConnection(resolved()), /disposed/);
    finishMount();
    await Promise.all([probe, stopping]);
    assert.equal(disposed, true);
    assert.equal(stopped, true);
  } finally {finishMount(); await runtime.dispose(); await ctx.fiber.dispose(); f.cleanup();}
});


test('previous connection refresh cannot hide a failed configuration replacement', async () => {
  const f = fixture();
  const ctx = new Context();
  let refresh!: () => void;
  const runtime = new ProjectMcpRuntime(ctx, f.store, {mount: async config => {
    if (config.transport === 'stdio' && config.args[0] === 'broken') throw new Error('replacement failed');
    return {toolNames: ['old-tool'], subscribe: listener => {refresh = listener; return () => {};}, dispose: async () => {}};
  }});
  try {
    f.store.upsert(declared());
    await runtime.reconcile();
    f.store.upsert(declared({args: ['broken']}));
    await runtime.reconcile();
    refresh();
    assert.equal(runtime.snapshot()[0]?.status, 'error');
    assert.equal(runtime.snapshot()[0]?.active, true);
    assert.match(runtime.snapshot()[0]?.lastError?.message ?? '', /replacement failed/);
    assert.deepEqual(runtime.snapshot()[0]?.toolNames, ['old-tool']);
    f.store.upsert(declared());
    await runtime.reconcile();
    assert.equal(runtime.snapshot()[0]?.status, 'connected');
    assert.equal(runtime.snapshot()[0]?.lastError, undefined);
    f.store.upsert(declared({args: ['broken']}));
    await runtime.reconcile();
    f.store.upsert(declared({args: ['fixed']}));
    await runtime.reconcile();
    assert.equal(runtime.snapshot()[0]?.status, 'connected');
    assert.equal(runtime.snapshot()[0]?.lastError, undefined);
  } finally {await runtime.dispose(); await ctx.fiber.dispose(); f.cleanup();}
});
