import {createSnapshotStore, defineStore, type StoreHandle, type StoreInstance} from '@deepseek-ai/dsh-client-store';
import {sessionFileAddress} from '@deepseek-ai/dsh-util-workspace-path';
import {findTabPane, type PaneId, type TabId} from '@deepseek-ai/dsh-client-ui-dockkit';
import type {SessionId} from '@deepseek-ai/dsh-session/types';
import type {SidebarRightState, SurfaceActions, TabOccurrence, SidebarRightOpenTabOptions} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import {TASK_PREVIEW_SCOPE, type TaskPreviewRequest} from './task-preview.tsx';
import type {TaskCommitPreviewRequest} from './task-commit-view.ts';
export type TaskSidebarRequest = TaskPreviewRequest | TaskCommitPreviewRequest;

type SidebarActions = {[K in keyof SurfaceActions]: (draft: SidebarRightState, ...args: Parameters<SurfaceActions[K]>) => void};
export type SidebarHandle = StoreHandle<SidebarRightState, SidebarActions>;
type SidebarInstance = StoreInstance<SidebarRightState, SidebarActions>;

/** Independent root store using the installed Sidebar's own layout actions.
 * The opaque UI key only indexes this store; it never enters Session services.
 */
export class TaskSidebarController {
  readonly store: SidebarHandle;
  private instance?: SidebarInstance;
  private unsubscribe?: () => void;
  private files = new Map<string, TaskSidebarRequest>();
  private occurrences = new Map<TabId, {value: TabOccurrence; abort: AbortController}>();
  private opener?: HTMLElement;
  private expanded = false;

  constructor(source: SidebarHandle, private guideTitle: () => string) {
    const handle = defineStore({...source.spec, persist: undefined});
    // The Slot runtime creates/caches the root instance. The Tasks main seat
    // and window rightbar share this handle, retaining it across unmounts.
    this.store = {...handle, create: scopeKey => {
      const instance = handle.create(scopeKey);
      this.unsubscribe?.();
      this.instance = instance;
      this.unsubscribe = instance.subscribe(this.sync);
      return instance;
    }};
  }

  private sync = () => {
    const layout = this.instance?.getSnapshot().bySession[TASK_PREVIEW_SCOPE]?.layout;
    const tabs = layout?.tabs ?? {};
    for (const [id, occurrence] of this.occurrences) if (!tabs[id]) {
      occurrence.abort.abort(); this.occurrences.delete(id);
    }
    for (const tab of Object.values(tabs)) if (!this.occurrences.has(tab.id)) {
      const abort = new AbortController();
      const placement = (options?: {paneId?: PaneId; replaceTab?: boolean; revealIfOpened?: boolean}) => ({
        paneId: options?.paneId ?? (options?.replaceTab ? undefined : findTabPane(this.instance!.getSnapshot().bySession[TASK_PREVIEW_SCOPE]!.layout, tab.id)?.id),
        replaceTab: options?.replaceTab ? tab.id : undefined, revealIfOpened: options?.revealIfOpened,
      });
      this.occurrences.set(tab.id, {abort, value: {
        sessionId: TASK_PREVIEW_SCOPE as SessionId, tabId: tab.id, signal: abort.signal,
        navigation: createSnapshotStore({address: tab.contentId, revision: 1, params: undefined}),
        tabActions: {
          close: () => this.closeTab(tab.id),
          openResource: (address, options) => {
            const file = this.files.get(address);
            if (!file) throw new Error('task-file-unavailable');
            this.open(file, undefined, placement(options));
          },
          openTab: (kind, options) => this.openTab(kind, placement(options)),
        },
      }});
    }
    const addresses = new Set(Object.values(tabs).map(tab => tab.contentId));
    for (const address of this.files.keys()) if (!addresses.has(address)) this.files.delete(address);
    if (this.expanded && !layout?.expanded && this.opener?.isConnected) this.opener.focus();
    this.expanded = layout?.expanded ?? false;
  };

  open(request: TaskSidebarRequest, opener?: HTMLElement, placement?: SidebarRightOpenTabOptions) {
    if (!this.instance) throw new Error('task-preview-unavailable');
    const address = sessionFileAddress(TASK_PREVIEW_SCOPE, `${request.id}/${request.revision}/${request.kind}/${request.index}/${request.kind === 'commit' ? request.commit : request.path}`);
    this.files.set(address, request);
    this.opener = opener;
    this.instance.actions.openContent(TASK_PREVIEW_SCOPE, {kind: 'text', contentId: address,
      title: request.kind === 'commit' ? request.commit.slice(0, 12) : request.path.split('/').pop() ?? request.path, ...placement}, () => {});
  }

  openTab = (kind: string, options?: SidebarRightOpenTabOptions) => {
    // ui-sidebar-right/contract/seed's guide identity. Tasks offers no Session
    // guide entries (terminal, explorer, etc.), only the current task's materials.
    if (kind !== 'guide') throw new Error('task-preview-unavailable');
    this.instance?.actions.openContent(TASK_PREVIEW_SCOPE, {kind, contentId: 'sidebar://guide', title: this.guideTitle(), ...options}, () => {});
  };
  openFromGuide(id: TabId, request: TaskSidebarRequest, opener?: HTMLElement) {
    const layout = this.instance?.getSnapshot().bySession[TASK_PREVIEW_SCOPE]?.layout;
    if (!layout?.tabs[id]) return;
    // Let the official replacement planner choose placement, including the
    // special case where a guide has been moved into a floating pane.
    this.open(request, opener, {replaceTab: id});
  }
  closeTab = (id: TabId) => {this.instance?.actions.closeTab(TASK_PREVIEW_SCOPE, id);};
  collapse = () => {this.instance?.actions.setExpanded(TASK_PREVIEW_SCOPE, false);};
  occurrence = (tab: {id: TabId}): TabOccurrence => {
    const occurrence = this.occurrences.get(tab.id);
    if (!occurrence) throw new Error('task-preview-unavailable');
    return occurrence.value;
  };
  request(id: TabId): TaskSidebarRequest | undefined {
    const tab = this.instance?.getSnapshot().bySession[TASK_PREVIEW_SCOPE]?.layout.tabs[id];
    return tab && this.files.get(tab.contentId);
  }
  dispose() {
    this.unsubscribe?.();
    for (const occurrence of this.occurrences.values()) occurrence.abort.abort();
    this.occurrences.clear(); this.files.clear(); this.instance = undefined;
  }
}
