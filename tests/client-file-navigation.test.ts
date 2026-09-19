import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {openSessionResource} from '../src/client/file-navigation.ts';

test('project file navigation opens a fresh rightbar without requiring an existing active tab', async () => {
  let calls = 0;
  await openSessionResource({sessionId: 'target', currentSession: () => 'target', cancelled: () => false,
    nextFrame: async () => {}, openResource: () => {calls++;}});
  assert.equal(calls, 1);
});

test('project file navigation waits for the selected Session seat and stops on cancellation or resource errors', async () => {
  let frames = 0;
  let calls = 0;
  await openSessionResource({sessionId: 'target', currentSession: () => frames === 1 ? 'previous' : 'target', cancelled: () => false,
    nextFrame: async () => {frames++;}, openResource: () => {
      if (++calls === 1) throw new Error('sidebarRight: no session surface is mounted');
    }});
  assert.equal(frames, 3);
  assert.equal(calls, 2);
  await openSessionResource({sessionId: 'target', currentSession: () => 'target', cancelled: () => true,
    nextFrame: async () => {}, openResource: () => assert.fail('cancelled navigation must not open a file')});
  await assert.rejects(openSessionResource({sessionId: 'target', currentSession: () => 'target', cancelled: () => false,
    nextFrame: async () => {}, openResource: () => {throw new Error('unknown resource');}}), /unknown resource/);
  await assert.rejects(openSessionResource({sessionId: 'target', currentSession: () => undefined, cancelled: () => false,
    timeoutMs: 0, openResource: () => assert.fail('no selected Session')}), /preview-unavailable/);
});
