import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {Window} from 'happy-dom';
import type {ProjectView} from '../src/project.ts';
import type {CapabilityState} from '../src/client/types.ts';
import {
  bindProjectPanelCount, projectPanelCount, projectPanelDisplayCount,
} from '../src/client/sidebar-counts.ts';

const project = {root: '/project', resources: [{path: '/project'}, {}, {}, {}], memory: [{}, {}]} as ProjectView;
const capabilities = {
  tasks: {loading: false, pending: false, data: {unarchivedTotal: 2, tasks: [
    {archived: false}, {archived: true}, {archived: false},
  ]}},
  skills: {loading: false, pending: false, data: {
    project: [{effective: true}, {effective: false}, {effective: true}], inherited: [{}, {}],
  }},
  tools: {loading: false, pending: false, data: {tools: [{}, {}, {}, {}, {}]}},
  mcp: {loading: false, pending: false, data: {servers: [
    {enabled: true}, {enabled: false}, {enabled: true}, {enabled: true},
  ], runtime: [
    {status: 'connected', active: true}, {status: 'disabled', active: false},
    {status: 'error', active: false}, {status: 'reconnecting', active: true},
  ]}},
} as CapabilityState;

test('Project row counts include active MCP connections and exclude failed declarations', () => {
  assert.deepEqual([
    projectPanelCount('resources', project, capabilities),
    projectPanelCount('memory', project, capabilities),
    projectPanelCount('tasks', project, capabilities),
    projectPanelCount('skills', project, capabilities),
    projectPanelCount('tools', project, capabilities),
    projectPanelCount('mcp', project, capabilities),
  ], [3, 2, 2, 4, 5, 2]);
  assert.equal(projectPanelCount('overview', project, capabilities), undefined);
});

test('catalog counts stay stable during a Session refresh and clear on failure', () => {
  const refreshing = {
    ...capabilities,
    skills: {loading: true, pending: false},
    tools: {loading: false, pending: false},
  } as CapabilityState;
  assert.equal(projectPanelDisplayCount('skills', undefined, 4, refreshing), 4);
  assert.equal(projectPanelDisplayCount('tools', undefined, 5, refreshing), 5);
  assert.equal(projectPanelDisplayCount('tools', 7, 5, refreshing), 7);
  assert.equal(projectPanelDisplayCount('resources', undefined, 3, refreshing), undefined);
  const failed = {...refreshing, skills: {...refreshing.skills, loading: false, error: 'catalog-unavailable'}};
  assert.equal(projectPanelDisplayCount('skills', undefined, 4, failed), undefined);
});

test('count is appended last on a wide official row and removed on cleanup', async () => {
  const window = new Window();
  try {
    window.document.body.innerHTML = '<button><span><span id="anchor"></span></span><span>资源</span></button>';
    const anchor = window.document.getElementById('anchor') as unknown as HTMLElement;
    const row = anchor.closest('button')!;
    const dispose = bindProjectPanelCount(anchor, 12, true);
    assert.equal(row.lastElementChild?.className, 'project-panel-count');
    assert.equal(row.lastElementChild?.textContent, '12');
    assert.equal(row.lastElementChild?.getAttribute('aria-hidden'), 'true');
    dispose();
    assert.equal(row.querySelector('.project-panel-count'), null);
  } finally {await window.happyDOM.close();}
});

test('count is omitted while data is unavailable or the official row is collapsed', async () => {
  const window = new Window();
  try {
    window.document.body.innerHTML = '<button><span id="anchor"></span></button>';
    const anchor = window.document.getElementById('anchor') as unknown as HTMLElement;
    bindProjectPanelCount(anchor, 0, false);
    bindProjectPanelCount(anchor, undefined, true);
    assert.equal(anchor.closest('button')?.querySelector('.project-panel-count'), null);
  } finally {await window.happyDOM.close();}
});
