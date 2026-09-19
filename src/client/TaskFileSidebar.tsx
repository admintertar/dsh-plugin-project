import {useEffect, type ComponentType} from 'react';
import {FileTypeIcon, classifyFileType, IconBranchOutline16} from '@deepseek-ai/dsh-client-ui-primitives';
import type {Context} from '@deepseek-ai/cordis';
import type {PropsRenderSlots, SlotMap} from '@deepseek-ai/dsh-client-ui-slots';
import type {RightbarSeatProps, SidebarRightInjected, UseSidebarRightTabInfo} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import {TASK_PREVIEW_SCOPE, taskPreviewSlot} from './task-preview.tsx';
import {TaskSidebarController, type SidebarHandle} from './task-sidebar-controller.ts';
import type {ProjectCapabilityController} from './controller.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import {TaskMaterialGuide} from './TaskMaterialGuide.tsx';
import {TaskCommitPreview} from './TaskCommitPreview.tsx';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'project.task.sidebar-toggle': {kind: 'single'; scope: 'root'};
  }
}

type TabContext = SlotMap['sidebar.right.pane.tab']['hookContext'];
type SidebarProps = Omit<RightbarSeatProps, 'renderSlot'> & PropsRenderSlots<'project.task.preview'> & {
  sidebar: TaskSidebarController; official: ComponentType<RightbarSeatProps>;
  tabInfo(context: TabContext): UseSidebarRightTabInfo;
  capabilities: ProjectCapabilityController; projectText: CapabilityTranslate;
};

/** Rehost the actual RightbarSeat, including slide, fullscreen, float and
 * collapse behavior. AppFrame owns geometry and its native resize handle.
 * Only store scope and task-file dispatch differ from the chat Sidebar.
 */
function TaskFileSidebar({sidebar, official: OfficialSidebar, tabInfo, capabilities, projectText, renderSlot, ...props}: SidebarProps) {
  const expanded = props.useStore(state => state.bySession[TASK_PREVIEW_SCOPE]?.layout.expanded ?? false);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Portaled menus can keep focus on their trigger. Let the official
      // overlay consume Escape before considering the window's Sidebar.
      if ([...document.querySelectorAll('[role="dialog"], [role="menu"]')].some(element => element.getClientRects().length > 0)) return;
      event.preventDefault(); sidebar.collapse();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [expanded, sidebar]);
  const renderOfficial: RightbarSeatProps['renderSlot'] = ((name: string, _owner: unknown, options: {hookContext: TabContext}) => {
    if (name === 'sidebar.right.tab.menu.item') return null;
    const request = sidebar.request(options.hookContext.tabId);
    if (request?.kind === 'commit') {
      if (name === 'sidebar.right.pane.tab.title') return <><IconBranchOutline16 /><span>{request.commit.slice(0, 12)}</span></>;
      return <TaskCommitPreview view={capabilities.taskCommitView(request, sidebar.occurrence({id: options.hookContext.tabId}).signal)} t={projectText} />;
    }
    if (name === 'sidebar.right.pane.tab.title') return request
      ? <><FileTypeIcon kind={classifyFileType(request.path)} size={16} /><span>{request.path.split('/').pop()}</span></> : projectText('taskMaterials');
    return request ? <div className="project-task-official-document">{renderSlot('project.task.preview', {request}, {hookContext: tabInfo(options.hookContext)})}</div>
      : <TaskMaterialGuide controller={capabilities} t={projectText}
        openFile={(request, opener) => sidebar.openFromGuide(options.hookContext.tabId, request, opener)} />;
  }) as RightbarSeatProps['renderSlot'];
  return <OfficialSidebar {...props} renderSlot={renderOfficial} />;
}

/** The installed Sidebar is private; use its official Slot registration
 * rather than copying its component/CSS or creating a Session for task files.
 */
export function createTaskSidebar(ctx: Context, capabilities: ProjectCapabilityController) {
  const seat = ctx.slots.entriesOfSlot('rightbar.session').find(entry => entry.locale === 'sidebarRight');
  const expand = ctx.slots.entriesOfSlot('conversation.session.header.corner').find(entry => entry.locale === 'sidebarRight' && entry.store === seat?.store);
  const declaration = seat?.store;
  const factory = (seat?.children?.['sidebar.right.pane.tab']?.inject as SlotMap['sidebar.right.pane.tab']['inject'] | undefined)?.hooks.tabInfo;
  if (!seat || !declaration || !expand || !factory) throw new Error('Official task Sidebar integration is unavailable');
  const source = (typeof declaration === 'function' ? declaration() : declaration) as SidebarHandle;
  const projectText = ctx.locale.bind('project');
  const sidebar = new TaskSidebarController(source, () => projectText('taskMaterials'));
  const official = seat.component as ComponentType<RightbarSeatProps>;
  const OfficialExpand = expand.component as ComponentType<Pick<RightbarSeatProps, 'sessionId'|'useStore'|'actions'|'t'>>;
  const tabTypes = Object.freeze([]);
  // Beta accepts a close hook; stable closes through the same store action
  // and ignores the extra prop. Store commits release occurrences in both.
  const injected: SidebarRightInjected & {closeTab: TaskSidebarController['closeTab']} = {
    syncPresentation: ({shown, track, fullscreen}) => {if (shown) ctx.layout.openRightbar(track, fullscreen); else ctx.layout.closeRightbar();},
    bindService: () => () => {}, // Never bind this root store to the Session controller.
    openTab: sidebar.openTab, closeTab: sidebar.closeTab, occurrence: sidebar.occurrence,
    hooks: {tabTypes: {getSnapshot: () => tabTypes, subscribe: () => () => {}}},
    keyedHooks: {tabNavigation: id => sidebar.occurrence({id: id as never}).navigation},
  };
  ctx.slots.inject('project.task.sidebar-toggle', () => ctx.slots.register({
    name: 'project.task.sidebar-toggle', store: sidebar.store, locale: 'sidebarRight',
  }, (props: Pick<RightbarSeatProps, 'useStore'|'actions'|'t'>) => <OfficialExpand {...props} sessionId={TASK_PREVIEW_SCOPE as never} />));
  ctx.effect(() => () => sidebar.dispose(), 'project: task Sidebar lifetime');
  return Object.assign(sidebar, {mount: () => ctx.slots.register({
    name: 'rightbar', priority: -100, store: sidebar.store, locale: 'sidebarRight',
    children: {'project.task.preview': taskPreviewSlot},
    inject: () => ({...injected, sidebar, official, sessionId: TASK_PREVIEW_SCOPE,
      tabInfo: (context: TabContext) => factory({sessionId: TASK_PREVIEW_SCOPE} as never, context),
      capabilities, projectText,
    }),
  } as never, TaskFileSidebar as never)});
}
