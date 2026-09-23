import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {Window} from 'happy-dom';
import {
  PROJECT_SCROLLBAR_IDLE_MS, PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE, PROJECT_SCROLL_SURFACE_SELECTORS,
  ProjectScrollbarAutoHide, type ProjectScrollbarTimerHost,
} from '../src/client/scrollbar-auto-hide.ts';

function fixture() {
  const window = new Window();
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const timers: ProjectScrollbarTimerHost = {
    setTimeout(callback) {const id = nextId++; callbacks.set(id, callback); return id;},
    clearTimeout(id) {callbacks.delete(id);},
  };
  const autoHide = new ProjectScrollbarAutoHide(window.document as unknown as Document, timers);
  const surface = (className: string) => {
    const element = window.document.createElement('div');
    element.className = className;
    window.document.body.append(element);
    return element;
  };
  /** happy-dom keeps real ms timers; flush the captured callbacks instead. */
  const idle = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return {window, callbacks, autoHide, surface, idle};
}

test('a real scroll shows the surface thumb and the idle delay fades it again', async () => {
  const f = fixture();
  try {
    const panel = f.surface('project-panel');
    // The whole selector list must parse; the panel is one of its members.
    assert.equal(panel.matches(PROJECT_SCROLL_SURFACE_SELECTORS.join(',')), true);
    assert.equal(panel.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
    panel.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(panel.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), true);
    assert.equal(f.callbacks.size, 1);
    f.idle();
    assert.equal(panel.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
  } finally {f.autoHide.dispose(); await f.window.happyDOM.close();}
});

test('a later scroll restarts the idle delay instead of fading early', async () => {
  const f = fixture();
  try {
    const list = f.surface('project-session-list');
    list.dispatchEvent(new f.window.Event('scroll'));
    const first = [...f.callbacks.keys()][0]!;
    list.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(f.callbacks.has(first), false);
    assert.equal(f.callbacks.size, 1);
    assert.equal(list.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), true);
    f.idle();
    assert.equal(list.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
  } finally {f.autoHide.dispose(); await f.window.happyDOM.close();}
});

test('surfaces outside the plugin scroll list keep the official scrollbar', async () => {
  const f = fixture();
  try {
    const official = f.surface('official-chat-surface');
    official.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(official.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
    assert.equal(f.callbacks.size, 0);
    // A document-level scroll (no element target) is ignored without throwing.
    f.window.document.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(f.callbacks.size, 0);
  } finally {f.autoHide.dispose(); await f.window.happyDOM.close();}
});

test('dispose clears pending timers, marks and the capture listener', async () => {
  const f = fixture();
  try {
    const materials = f.surface('project-task-materials');
    materials.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(f.callbacks.size, 1);
    f.autoHide.dispose();
    assert.equal(materials.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
    assert.equal(f.callbacks.size, 0);
    materials.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(materials.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
  } finally {await f.window.happyDOM.close();}
});

test('a nested task pane only matches through its plugin ancestor', async () => {
  const f = fixture();
  try {
    const detached = f.surface('project-task-detail');
    detached.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(detached.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), false);
    const tasks = f.surface('project-tasks');
    const detail = f.window.document.createElement('div');
    detail.className = 'project-task-detail';
    tasks.append(detail);
    detail.dispatchEvent(new f.window.Event('scroll'));
    assert.equal(detail.hasAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE), true);
  } finally {f.autoHide.dispose(); await f.window.happyDOM.close();}
});

test('the idle delay is the documented 800ms', () => {
  assert.equal(PROJECT_SCROLLBAR_IDLE_MS, 800);
});
