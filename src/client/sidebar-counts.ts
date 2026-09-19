import type {ProjectView} from '../project.ts';
import {managedResources} from '../resource-scope.ts';
import type {CapabilityState} from './types.ts';
import type {ProjectPanelView} from './panels.ts';

/** Count available Project capabilities on the official rows. */
export function projectPanelCount(
  view: ProjectPanelView,
  project: ProjectView | undefined,
  capabilities: CapabilityState,
): number | undefined {
  switch (view) {
    case 'overview': return undefined;
    case 'resources': return project && managedResources(project.resources, project.root).length;
    case 'memory': return project?.memory.length;
    case 'tasks': return capabilities.tasks.data?.unarchivedTotal;
    case 'skills': return capabilities.skills.data === undefined ? undefined
      : capabilities.skills.data.project.filter(skill => skill.effective).length
        + capabilities.skills.data.inherited.length;
    case 'tools': return capabilities.tools.data?.tools.length;
    case 'mcp': return capabilities.mcp.data?.runtime.filter(server => server.active).length;
  }
}

/**
 * Keep only catalog-backed counts stable while a Session switch fetches the
 * replacement catalog. Errors clear the retained value; other rows never use
 * stale data because their sources are not invalidated by Session changes.
 */
export function projectPanelDisplayCount(
  view: ProjectPanelView,
  current: number | undefined,
  previous: number | undefined,
  capabilities: CapabilityState,
): number | undefined {
  if (current !== undefined) return current;
  if (view !== 'skills' && view !== 'tools') return undefined;
  return capabilities[view].error === undefined ? previous : undefined;
}

/**
 * Attach a Project-owned count as the final flex item of an official panel row.
 * The icon occupant is a stable row-local anchor even though SidebarRoot does
 * not expose a trailing Slot in the pinned DSH release.
 */
export function bindProjectPanelCount(
  anchor: HTMLElement,
  count: number | undefined,
  wide: boolean,
): () => void {
  const row = anchor.closest('button');
  if (row === null || count === undefined || !wide) return () => {};
  const badge = anchor.ownerDocument.createElement('span');
  badge.className = 'project-panel-count';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = String(count);
  row.append(badge);
  return () => {badge.remove();};
}
