import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {PROJECT_PANELS} from '../src/client/panels.ts';

test('project sidebar panels use stable namespaced identities and order', () => {
  assert.deepEqual(PROJECT_PANELS.map(panel => ({id: panel.id, view: panel.view, order: panel.order})), [
    {id: 'project.overview', view: 'overview', order: 10},
    {id: 'project.resources', view: 'resources', order: 20},
    {id: 'project.memory', view: 'memory', order: 30},
    {id: 'project.tasks', view: 'tasks', order: 40},
    {id: 'project.skills', view: 'skills', order: 50},
    {id: 'project.tools', view: 'tools', order: 55},
    {id: 'project.mcp', view: 'mcp', order: 60},
  ]);
});
