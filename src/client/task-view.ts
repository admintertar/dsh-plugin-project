import {createSnapshotStore} from '@deepseek-ai/dsh-client-store';
import type {TaskDetail} from '../api-types.ts';
import type {ProjectTaskStatus} from '../task-contract.ts';

/** Window-local navigation survives panel unmounts, independently of documents. */
export interface TaskViewState {
  query: string; filter: ProjectTaskStatus | 'all'; showArchived: boolean;
  pages: Array<string | undefined>; selectedId?: string; showingDetail: boolean;
  detail?: TaskDetail; detailLoading: boolean; detailError?: string;
}
export function createTaskView() {
  const store = createSnapshotStore<TaskViewState>({query: '', filter: 'all', showArchived: false,
    pages: [undefined], showingDetail: false, detailLoading: false});
  const scroll = {list: 0, details: new Map<string, number>()};
  return {...store, scroll,
    select(id: string) {
      store.update(state => {state.selectedId = id; state.showingDetail = true; state.detailError = undefined;
        if (state.detail?.task.id !== id) {state.detail = undefined; state.detailLoading = true;}});
    },
  };
}
