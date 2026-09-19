import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {Window, type HTMLElement as HappyElement} from 'happy-dom';
import {bindProjectSidebarControls} from '../src/client/sidebar-controls.ts';

/** The official SidebarRoot DOM contract, including slot wrappers and tooltip siblings. */
function fixture(collapsed = false) {
  const window = new Window();
  const document = window.document;
  const mark = '<div data-slot="sidebar.brand.mark"><span id="mark"><svg></svg><span id="overview-label">项目概况 · 示例</span></span></div>';
  document.body.innerHTML = `<div data-slot="sidebar"><div id="official-sidebar">
    <div id="logo-row">${collapsed ? '' : `<button id="brand" aria-label="新会话">${mark}<div data-slot="sidebar.brand.name">示例</div></button>`}
      <button id="toggle" aria-label="折叠">${collapsed ? mark : ''}</button><span role="tooltip">折叠</span></div>
    <button id="new" aria-label="新会话">新会话</button><span role="tooltip">新会话</span>
    <nav><button id="third-party-panel">第三方面板</button></nav>
    <div data-slot="sidebar.workspaces"></div>
    <footer><button id="settings">设置</button><button id="third-party-action">第三方操作</button></footer>
  </div></div><button id="other-window">其他窗口</button>`;
  const element = (id: string) => document.getElementById(id)! as HappyElement;
  const counts = {officialNew: 0, projectNew: 0, overview: 0, toggle: 0, other: 0};
  // React delegates the official onClick to a root ancestor; the adapter must
  // prevent that fallback for both pointer and keyboard-generated click events.
  document.body.addEventListener('click', event => {
    const id = (event.target as unknown as HTMLElement).closest('button')?.id;
    if (id === 'brand' || id === 'new') counts.officialNew++;
    else if (id === 'toggle') counts.toggle++;
    else counts.other++;
  });
  const bind = (canStart = true) => bindProjectSidebarControls(element('mark') as unknown as HTMLElement, {
    overviewLabelId: 'overview-label', canStart,
    showOverview: () => {counts.overview++;}, startSession: () => {counts.projectNew++;},
  });
  return {window, element, counts, bind};
}

test('brand, icon and keyboard activation navigate to the overview; new session uses the Project action', async () => {
  const f = fixture();
  try {
    const dispose = f.bind();
    f.element('mark').querySelector('svg')!.dispatchEvent(new f.window.MouseEvent('click', {bubbles: true, detail: 1}));
    f.element('brand').dispatchEvent(new f.window.MouseEvent('click', {bubbles: true, detail: 0}));
    f.element('new').click();
    f.element('new').dispatchEvent(new f.window.MouseEvent('click', {bubbles: true, detail: 0}));
    assert.deepEqual(f.counts, {officialNew: 0, projectNew: 2, overview: 2, toggle: 0, other: 0});
    assert.equal(f.element('brand').getAttribute('aria-labelledby'), 'overview-label');
    for (const id of ['toggle', 'settings', 'third-party-panel', 'third-party-action', 'other-window']) f.element(id).click();
    assert.equal(f.counts.toggle, 1);
    assert.equal(f.counts.other, 4);
    dispose();
    f.element('brand').click();
    f.element('new').click();
    assert.equal(f.counts.officialNew, 2);
    assert.equal(f.element('brand').hasAttribute('aria-labelledby'), false);
  } finally {await f.window.happyDOM.close();}
});

test('the collapsed mark retains official expansion, while New Session remains project-bound', async () => {
  const f = fixture(true);
  try {
    const dispose = f.bind();
    f.element('mark').click();
    f.element('new').click();
    assert.deepEqual(f.counts, {officialNew: 0, projectNew: 1, overview: 0, toggle: 1, other: 0});
    dispose();
  } finally {await f.window.happyDOM.close();}
});

test('loading/busy state blocks new sessions and rebinding does not retain duplicate listeners', async () => {
  const f = fixture();
  try {
    let dispose = f.bind(false);
    assert.equal(f.element('new').hasAttribute('disabled'), true);
    f.element('new').click();
    assert.equal(f.counts.projectNew, 0);
    dispose();
    dispose = f.bind();
    f.element('new').click();
    assert.equal(f.counts.projectNew, 1);
    assert.equal(f.counts.officialNew, 0);
    dispose();
    assert.equal(f.element('new').hasAttribute('disabled'), false);
  } finally {await f.window.happyDOM.close();}
});
