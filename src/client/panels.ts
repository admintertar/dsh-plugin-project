import type {MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {ProjectLocaleKey} from '../locales.ts';

export type ProjectPanelView = 'overview' | 'resources' | 'memory' | 'tasks' | 'skills' | 'tools' | 'mcp';

/** Stable Project navigation contribution paired with a keyed main panel. */
export interface ProjectPanelDefinition {
  id: MainPanelId;
  view: ProjectPanelView;
  order: number;
  label: ProjectLocaleKey;
}

/** Project-owned entries share the official sidebar's id-to-main-panel convention. */
export const PROJECT_PANELS: readonly ProjectPanelDefinition[] = [
  {id: 'project.overview' as MainPanelId, view: 'overview', order: 10, label: 'overview'},
  {id: 'project.resources' as MainPanelId, view: 'resources', order: 20, label: 'resources'},
  {id: 'project.memory' as MainPanelId, view: 'memory', order: 30, label: 'memory'},
  {id: 'project.tasks' as MainPanelId, view: 'tasks', order: 40, label: 'tasks'},
  {id: 'project.skills' as MainPanelId, view: 'skills', order: 50, label: 'skills'},
  {id: 'project.tools' as MainPanelId, view: 'tools', order: 55, label: 'tools'},
  {id: 'project.mcp' as MainPanelId, view: 'mcp', order: 60, label: 'mcp'},
];
