import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {MergeConflictController} from '../src/client/merge-conflict.ts';

/** A project window double: every dependency the handoff touches is observable in `calls`. */
function harness(draft = '', hasProject = true) {
  const calls: string[] = [];
  let text = draft;
  const controller = new MergeConflictController({
    project: () => hasProject ? {id: 'p', root: '/project'} : undefined,
    beginNavigation: () => new AbortController().signal,
    createSession: async (root, sessionId) => {calls.push(`create:${root}:${sessionId}`);},
    input: () => ({draft: () => text, canFill: () => true,
      setDraft: value => {text = value; calls.push('setDraft');},
      notifyPreserved: value => {calls.push(`notify:${value}`);}}),
    draft: (request, current) => `files=${request.files.join(',')} root=${current.root}`,
    openSession: id => {calls.push(`open:${id}`);},
    id: () => 'session-1',
  });
  return {controller, calls, draft: () => text};
}

test('a conflicting merge becomes a prepared conversation the user submits', async () => {
  const h = harness();
  const result = await h.controller.handoff({files: ['tasks/A/task.md', 'skills/index.yaml'], upstream: 'origin/master', ahead: 1, behind: 3});
  // The session is created, the composer draft carries the task, and the window opens it.
  assert.deepEqual(h.calls, ['create:/project:session-1', 'setDraft', 'open:session-1']);
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.draftPreserved, false);
  assert.equal(h.draft(), 'files=tasks/A/task.md,skills/index.yaml root=/project');
  h.controller.dispose();
});

test('an existing draft is never overwritten by the conflict handoff', async () => {
  const h = harness('half-written message');
  const result = await h.controller.handoff({files: ['tasks/A/task.md']});
  assert.equal(result.draftPreserved, true);
  assert.equal(h.draft(), 'half-written message');
  // The prepared text is offered instead of being dropped, exactly like the task handoff.
  assert.equal(h.calls.some(call => call.startsWith('notify:files=tasks/A/task.md')), true);
  assert.deepEqual(h.calls.filter(call => call === 'setDraft'), []);
  h.controller.dispose();
});

test('the same conflict reuses one conversation while it is being prepared', async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.controller.handoff({files: ['tasks/A/task.md']}),
    h.controller.handoff({files: ['tasks/A/task.md']}),
  ]);
  assert.equal(h.calls.filter(call => call.startsWith('create:')).length, 1);
  assert.equal(first.sessionId, second.sessionId);
  h.controller.dispose();
});

test('a handoff without a project is cancelled instead of creating a session', async () => {
  const h = harness('', false);
  assert.deepEqual(await h.controller.handoff({files: ['tasks/A/task.md']}), {cancelled: true});
  assert.deepEqual(h.calls, []);
  h.controller.dispose();
});
