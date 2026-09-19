/**
 * Project Session browser viewing state.
 *
 * This is the Project-scoped counterpart of the official Workspace browser
 * store. The grouping state is intentionally absent: a Project window always
 * renders the official flat Session list for exactly one Project root.
 */
import {defineStore, type EngineStoreHandle} from '@deepseek-ai/dsh-client-store';
import type {ProjectSessionOrder} from './session-browser.ts';

interface ProjectSessionViewState {
  /** Session order behavior shared by Project windows. */
  orderBy: ProjectSessionOrder;
  /** Editable flat-list order keyed by the Project root. */
  sessionOrderByProject: Record<string, string[]>;
  /** Last timestamps observed for one-time recent-activity promotion. */
  sessionUpdatedAtByProject: Record<string, Record<string, number>>;
}

type ProjectSessionViewActions = {
  setOrderBy: (draft: ProjectSessionViewState, mode: ProjectSessionOrder) => void;
  syncSessionOrder: (
    draft: ProjectSessionViewState,
    projectRoot: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void;
  setSessionOrder: (draft: ProjectSessionViewState, projectRoot: string, order: string[]) => void;
};

/** Create one renderer-owned, reload-persistent Project Session view store. */
export function createProjectSessionViewStore(): EngineStoreHandle<
  ProjectSessionViewState,
  ProjectSessionViewActions
> {
  return defineStore({
    init: (): ProjectSessionViewState => ({
      orderBy: 'updated',
      sessionOrderByProject: {},
      sessionUpdatedAtByProject: {},
    }),
    persist: 'dsh.project.sessions.view.v1',
    actions: {
      setOrderBy: (draft, mode: ProjectSessionOrder) => {draft.orderBy = mode;},
      syncSessionOrder: (draft, projectRoot: string, order: string[], updatedAt: Record<string, number>) => {
        draft.sessionOrderByProject[projectRoot] = order;
        draft.sessionUpdatedAtByProject[projectRoot] = updatedAt;
      },
      setSessionOrder: (draft, projectRoot: string, order: string[]) => {
        draft.sessionOrderByProject[projectRoot] = order;
      },
    },
  });
}
