import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {Window} from 'happy-dom';
import {
  PROJECT_PANEL_SWITCHING_ATTRIBUTE,
  ProjectPanelTransition,
  type ProjectPanelFrameHost,
} from '../src/client/panel-transition.ts';

function fixture() {
  const window = new Window();
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const frames: ProjectPanelFrameHost = {
    requestAnimationFrame(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {callbacks.delete(id);},
  };
  const transition = new ProjectPanelTransition(window.document as unknown as Document, frames);
  const flush = () => {
    const pending = [...callbacks.entries()];
    callbacks.clear();
    for (const [, callback] of pending) callback(0);
  };
  return {window, callbacks, transition, flush};
}

test('project panel geometry remains instant through one painted frame', async () => {
  const f = fixture();
  try {
    f.transition.suppress();
    assert.equal(f.window.document.documentElement.hasAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE), true);
    f.flush();
    assert.equal(f.window.document.documentElement.hasAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE), true);
    f.flush();
    assert.equal(f.window.document.documentElement.hasAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE), false);
  } finally {f.transition.dispose(); await f.window.happyDOM.close();}
});

test('a later panel change restarts the two-frame window and dispose clears it', async () => {
  const f = fixture();
  try {
    f.transition.suppress();
    f.flush();
    f.transition.suppress();
    assert.equal(f.callbacks.size, 1);
    f.flush();
    assert.equal(f.window.document.documentElement.hasAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE), true);
    f.transition.dispose();
    assert.equal(f.callbacks.size, 0);
    assert.equal(f.window.document.documentElement.hasAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE), false);
  } finally {f.transition.dispose(); await f.window.happyDOM.close();}
});
