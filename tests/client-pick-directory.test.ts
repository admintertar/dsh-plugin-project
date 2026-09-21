import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createPickDirectory} from '../src/client/pick-directory.ts';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

test('the client picker keeps the official workspace flow for the native seam and refuses a missing source', async () => {
  let native = 0; let fetches = 0;
  const pick = createPickDirectory({pickDirectory: async () => {native++; return '/native/picked';}},
    (async () => {fetches++; return response({});}) as typeof fetch);
  assert.equal(await pick('native'), '/native/picked');
  assert.equal(native, 1); assert.equal(fetches, 0);
  await assert.rejects(pick(undefined), /native-picker-unavailable/);
  await assert.rejects(pick(null), /native-picker-unavailable/);
  assert.equal(native, 1); assert.equal(fetches, 0);
});

test('the client picker asks the Host for the Desktop shell chooser and reports cancel and failure', async () => {
  const seen: Array<{url: string; init?: RequestInit}> = [];
  const pick = createPickDirectory({pickDirectory: async () => {throw new Error('the native seam must not run');}},
    (async (url, init) => {seen.push({url: String(url), init}); return response({path: 'C:\\Work'});}) as typeof fetch);
  assert.equal(await pick('desktop'), 'C:\\Work');
  assert.equal(seen[0]!.url, '/api/project/pick');
  assert.equal(seen[0]!.init?.method, 'POST');
  assert.equal((seen[0]!.init?.headers as Record<string, string>)['content-type'], 'application/json');

  const cancelled = createPickDirectory({pickDirectory: async () => null}, (async () => response({path: null})) as typeof fetch);
  assert.equal(await cancelled('desktop'), null);

  const rejected = createPickDirectory({pickDirectory: async () => null}, (async () => response({error: 'native-picker-unavailable'}, 409)) as typeof fetch);
  await assert.rejects(rejected('desktop'), /native-picker-unavailable/);

  // Never surface Host text: unknown codes collapse to the generic failure.
  const hidden = createPickDirectory({pickDirectory: async () => null}, (async () => response({error: 'secret-fixture'}, 500)) as typeof fetch);
  await assert.rejects(hidden('desktop'), /operation-failed/);
});
