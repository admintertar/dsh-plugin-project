import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {loadProjectWindowState} from '../src/client/window-state.ts';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

test('window startup recovers from network and Host errors before returning the actual mode', async () => {
  const ctx = new Context();
  let attempts = 0;
  try {
    const state = await loadProjectWindowState(ctx, {retryDelaysMs: [0, 0], request: async (url, init) => {
      assert.equal(url, '/api/project/windows');
      assert.equal(init?.signal?.aborted, false);
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      if (attempts === 2) return response({}, 503);
      return response({enabled: true, presentation: 'project'});
    }});
    assert.deepEqual(state, {enabled: true, presentation: 'project'});
    assert.equal(attempts, 3);
  } finally {await ctx.fiber.dispose();}
});

test('window startup retains Web and non-Project Desktop modes and calls fetch without a receiver', async t => {
  const ctx = new Context();
  let state: {enabled: boolean; presentation?: string} = {enabled: false};
  t.mock.method(globalThis, 'fetch', async function(this: unknown) {
    assert.ok(this === undefined || this === globalThis);
    return response(state);
  });
  try {
    assert.deepEqual(await loadProjectWindowState(ctx), state);
    state = {enabled: true, presentation: 'advanced'};
    assert.deepEqual(await loadProjectWindowState(ctx), state);
  } finally {await ctx.fiber.dispose();}
});

test('window startup stops after its retry budget and never fabricates a fallback mode', async () => {
  const ctx = new Context();
  let attempts = 0;
  try {
    await assert.rejects(loadProjectWindowState(ctx, {retryDelaysMs: [0, 0], request: async () => {
      attempts++; return response({}, 503);
    }}), /HTTP 503/);
    assert.equal(attempts, 3);
  } finally {await ctx.fiber.dispose();}
});

test('window startup does not retry permanent HTTP errors or malformed mode responses', async () => {
  const ctx = new Context();
  try {
    for (const candidate of [response({}, 401), response({}, 403), response({}, 404), response({}, 422),
      response({enabled: 'false'}), response({enabled: true, presentation: 1}), response(null), new Response('invalid JSON')]) {
      let attempts = 0;
      await assert.rejects(loadProjectWindowState(ctx, {retryDelaysMs: [0], request: async () => {
        attempts++; return candidate;
      }}), /HTTP|Invalid window state/);
      assert.equal(attempts, 1);
    }
  } finally {await ctx.fiber.dispose();}
});

test('window startup retries request timeouts and HTTP 408/429', async () => {
  const ctx = new Context();
  let attempts = 0;
  let firstSignal: AbortSignal | undefined;
  try {
    const state = await loadProjectWindowState(ctx, {timeoutMs: 15, retryDelaysMs: [0, 0, 0], request: async (_url, init) => {
      if (++attempts === 1) {
        firstSignal = init!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          firstSignal!.addEventListener('abort', () => reject(firstSignal!.reason), {once: true});
        });
      }
      if (attempts === 2) return response({}, 408);
      if (attempts === 3) return response({}, 429);
      return response({enabled: false});
    }});
    assert.equal(firstSignal?.aborted, true);
    assert.deepEqual(state, {enabled: false});
    assert.equal(attempts, 4);
  } finally {await ctx.fiber.dispose();}
});

test('disposing a plugin cancels an in-flight startup without registering a mode', {timeout: 2000}, async () => {
  const ctx = new Context();
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => {notifyStarted = resolve;});
  let state: unknown = 'pending';
  let requestSignal: AbortSignal | undefined;
  const fiber = ctx.plugin(async inner => {
    state = await loadProjectWindowState(inner, {request: async (_url, init) => {
      requestSignal = init!.signal!;
      notifyStarted();
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), {once: true});
      });
    }});
  });
  try {
    await started;
    await fiber.dispose();
    assert.equal(requestSignal?.aborted, true);
    assert.equal(state, undefined);
  } finally {await ctx.fiber.dispose();}
});

test('disposing a plugin cancels a scheduled startup retry', {timeout: 2000}, async () => {
  const ctx = new Context();
  let notifyFailed!: () => void;
  const failed = new Promise<void>(resolve => {notifyFailed = resolve;});
  let attempts = 0;
  let state: unknown = 'pending';
  const fiber = ctx.plugin(async inner => {
    state = await loadProjectWindowState(inner, {retryDelaysMs: [10_000], request: async () => {
      attempts++;
      notifyFailed();
      return response({}, 503);
    }});
  });
  try {
    await failed;
    await new Promise(resolve => setTimeout(resolve, 0));
    await fiber.dispose();
    assert.equal(state, undefined);
    assert.equal(attempts, 1);
  } finally {await ctx.fiber.dispose();}
});
