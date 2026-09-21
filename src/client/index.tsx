import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {managedResources} from '../resource-scope.ts';
import {
  Button, HoverCard, Input, Menu, Modal, ReferenceIcon, StateDot, Tag, Tooltip,
  IconAlarmClockOutline16, IconArchiveOutline20, IconBranchOutline16, IconCloseFill14,
  IconEditOutline16, IconEllipsisOutline16, IconFolderOpenOutline16, IconNewChatOutline16,
  IconApiOutline14, IconListPenOutline16, IconSkillOutline16,
  IconPersonalizationOutline16, IconRefreshOutline16,
  IconSearchOutline16, relativeTime, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {
  ISessions, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {SessionId} from '@deepseek-ai/dsh-session/types';
import type { PropsRuntime, PropsLocale, PropsStore, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type { ProjectView } from '../project.ts';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import {en, zh} from '../locales.ts';
import {PROJECT_PANELS, type ProjectPanelView} from './panels.ts';
import {bindProjectSidebarControls} from './sidebar-controls.ts';
import {bindProjectPanelCount, projectPanelCount, projectPanelDisplayCount} from './sidebar-counts.ts';
import {
  nextProjectSessionOrder, projectSessionDropAnchor, projectSessionRows, projectSessionSearch,
  sanitizeProjectSessionQuery, type ProjectSessionOrder,
} from './session-browser.ts';
import {createProjectSessionViewStore} from './session-browser-store.ts';
import { styles } from './styles.ts';
import {ProjectCapabilityController} from './controller.ts';
import {TasksPanel} from './TasksPanel.tsx';
import {registerTaskPreview} from './task-preview.tsx';
import {createTaskSidebar} from './TaskFileSidebar.tsx';
import {SkillsPanel} from './SkillsPanel.tsx';
import {ToolsPanel} from './ToolsPanel.tsx';
import type {} from '@deepseek-ai/dsh-agent-presets/types';
import {McpPanel} from './McpPanel.tsx';
import {MemoryPanel} from './MemoryPanel.tsx';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import {loadProjectWindowState} from './window-state.ts';
import {ResourceController} from './resource-controller.ts';
import {ResourcesOverview, ResourcesPanel} from './ResourcesPanel.tsx';
import {ResourceAuthDialog} from './ResourceAuthDialog.tsx';
import {TaskContinuationController, type ContinueTask, type TaskContinuationResult} from './task-continuation.ts';
import {ProjectPanelTransition} from './panel-transition.ts';
import {createPickDirectory, type PickDirectory} from './pick-directory.ts';

export const inject = ['slots', 'sessions', 'layout', 'workspaces', 'uiWorkspace', 'locale', 'sidebarRight', 'remote', 'conversation', 'documentPreviews'];
interface State {project?: ProjectView; error?: string; busy: boolean}
interface Controller {
  capabilities: ProjectCapabilityController;
  resources: ResourceController;
  taskSidebar: ReturnType<typeof createTaskSidebar>;
  pickDirectory: PickDirectory;
  sessionTitle(id: string): string;
  canOpenSession(id: string): boolean;
  getSnapshot(): State;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  saveMemory(id: string, content: string): Promise<void>;
  suppressPanelTransition(): void;
  show(panelId: MainPanelId): void;
  start(): Promise<void>;
  continueTask(task: ContinueTask, signal?: AbortSignal): Promise<TaskContinuationResult>;
  open(id: SessionId): void;
  search(query: string, signal: AbortSignal): Promise<{items: readonly SessionSearchResultItem[]; hasMore: boolean}>;
  rename(id: SessionId, title: string): Promise<void>;
  fork(id: SessionId): Promise<void>;
  archive(id: SessionId): Promise<void>;
  readonly searchResultLimit: number;
}
const initialPanel = PROJECT_PANELS[0]!.id;

export async function apply(ctx: Context): Promise<void> {
  // Host and Client entrypoints share one TypeScript program in this package;
  // narrow the Client face explicitly because both runtimes call the service `sessions`.
  const sessions = ctx.sessions as unknown as ISessions;
  ctx.effect(() => ctx.locale.register('project', {en, zh}), 'project: locale dictionaries');
  const t = ctx.locale.bind('project');
  const native = await loadProjectWindowState(ctx).catch(() => {throw new Error(t('presentationError'));});
  if (native === undefined) return;
  if (native.enabled) {
    const select = async (mode: string) => {
      const snapshot = sessions.list.getSnapshot();
      const current = snapshot.current ? snapshot.byId[snapshot.current] : undefined;
      const directory = current?.cwd ?? ctx.workspaces.list.getSnapshot().items[0]?.path;
      const response = await fetch('/api/project/windows', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({action: 'presentation', mode, directory})});
      if (!response.ok) throw new Error((await response.json()).error ?? t('switchError'));
    };
    ctx.inject(['desktopPresentationModes'], inner => {
      const modes = inner.get('desktopPresentationModes') as {register(value: {
        id: string; title: string; description: string; active: boolean;
        select(): Promise<void>; leave(mode: string): Promise<void>;
      }): () => void};
      inner.effect(() => modes.register({id: 'project', get title() {return t('projectMode');},
        get description() {return t('projectModeBody');},
        active: native.presentation === 'project', select: () => select('project'), leave: select}), 'project: presentation setting');
    });
    if (native.presentation !== 'project') return;
  }
  const capabilities = new ProjectCapabilityController();
  registerTaskPreview(ctx, capabilities);
  const taskSidebar = createTaskSidebar(ctx, capabilities);
  const panelTransition = new ProjectPanelTransition(document);
  const resources = new ResourceController(() => {void controller.refresh(); void capabilities.refresh('tasks');});
  let state: State = {busy: false};
  let disposed = false;
  let request: AbortController | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => {
    if (disposed) return;
    state = {...state, ...patch};
    listeners.forEach(listener => listener());
  };
  /** Resolve a mutable Session only after enforcing the current Project-window boundary. */
  const requireProjectSession = (id: SessionId): SessionSummary => {
    const session = sessions.list.getSnapshot().byId[id];
    if (session === undefined || session.cwd !== state.project?.root) {
      throw new Error(`Session "${id}" does not belong to the current Project`);
    }
    return session;
  };
  const canOpenSession = (id: string) => {
    const session = sessions.list.getSnapshot().byId[id as SessionId];
    return session !== undefined && session.cwd === state.project?.root && session.origin !== 'subagent'
      && !ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(id as SessionId);
  };
  const continuation = new TaskContinuationController({
    project: () => state.project,
    beginNavigation: () => ctx.layout.beginNavigation(),
    createSession: async (root, sessionId) => {
      const workspace = await ctx.workspaces.create({path: root});
      await sessions.create({workspaceId: workspace.workspaceId, cwd: root, sessionId: sessionId as SessionId});
    },
    readTask: async id => (await capabilities.getTask(id)).task,
    input: id => {
      const scope = sessions.scope(id as SessionId);
      if (!scope) throw new Error('project-session-unavailable');
      const input = ctx.conversation.input.for(scope);
      return {draft: () => input.state.getSnapshot().draft, setDraft: text => input.setDraft(text),
        canFill: () => {const state = input.state.getSnapshot(); return state.phase === 'plain' && state.attachmentIds.length === 0;},
        notifyPreserved: text => input.notify('info', `${t('taskDraftPreservedNotice')}\n\n${text}`)};
    },
    draft: task => t(task.status === 'completed' || task.status === 'cancelled' ? 'taskReviewDraft' : 'taskContinueDraft', {title: task.title, id: task.id}),
    openSession: id => ctx.uiWorkspace.openSession(id as SessionId),
  });
  const controller: Controller = {
    continueTask: (task, signal) => continuation.continue(task, signal),
    canOpenSession,
    capabilities,
    resources,
    taskSidebar,
    pickDirectory: createPickDirectory(ctx.uiWorkspace),
    sessionTitle: id => sessions.list.getSnapshot().byId[id as SessionId]?.displayTitle ?? id,
    getSnapshot: () => state,
    subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    async refresh() {
      request?.abort();
      const current = request = new AbortController();
      try {
        const response = await fetch('/api/project/snapshot', {signal: current.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        update({project: data, error: undefined});
      } catch (error) {
        if (!current.signal.aborted) update({project: undefined, error: error instanceof Error ? error.message : String(error)});
      }
    },
    async saveMemory(id, content) {
      const response = await fetch('/api/project/memory', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({action: 'update', id, content})});
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'operation-failed');
      update({project: data, error: undefined});
    },
    suppressPanelTransition: panelTransition.suppress,
    show(panelId) {panelTransition.suppress(); ctx.layout.selectPanel(panelId);},
    async start() {
      if (!state.project || state.busy) return;
      const root = state.project.root;
      update({busy: true, error: undefined});
      try {
        const workspace = await ctx.workspaces.create({path: root});
        if (disposed) return;
        // Official navigation reuses the selected blank Session for this
        // Workspace, so repeated clicks do not create empty Session records.
        await ctx.uiWorkspace.openWorkspace(workspace.workspaceId);
      } catch (error) {update({error: error instanceof Error ? error.message : String(error)});}
      finally {update({busy: false});}
    },
    open(id) {
      const snapshot = sessions.list.getSnapshot();
      const item = snapshot.ids.map(key => snapshot.byId[key]).find(session => session?.id === id);
      if (item && canOpenSession(id)) ctx.uiWorkspace.openSession(item.id);
    },
    async search(query, signal) {
      const result = await sessions.search(query, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    async rename(id, title) {
      requireProjectSession(id);
      const session = sessions.binding(id)?.session;
      if (session === undefined) throw new Error(`Unknown Session "${id}"`);
      const result = await session.rename(title);
      if (!result.ok) throw new Error(result.error.message);
    },
    async fork(id) {
      requireProjectSession(id);
      await ctx.uiWorkspace.forkSession(id);
    },
    async archive(id) {
      requireProjectSession(id);
      await ctx.uiWorkspace.archiveSession(id);
    },
    searchResultLimit: sessions.searchResultLimit,
  };
  ctx.effect(() => {
    const element = document.createElement('style');
    element.textContent = styles;
    document.head.append(element);
    return () => {disposed = true; request?.abort(); continuation.dispose(); capabilities.dispose(); resources.dispose(); panelTransition.dispose(); listeners.clear(); element.remove();};
  }, 'project: client lifecycle');
  // The official sidebar remains the sole owner of child-slot declarations,
  // panel metadata, collapse animation and settings/footer contributions.
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark', priority: -100, locale: 'project',
    inject: () => ({controller}),
  }, ProjectBrandMark));
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name', priority: -100, locale: 'project',
    inject: () => ({controller}),
  }, ProjectBrandName));
  ctx.slots.inject('sidebar.panellist', function* () {
    for (const definition of PROJECT_PANELS) {
      yield ctx.slots.register({
        name: 'sidebar.panellist', id: definition.id, order: definition.order,
        label: () => t(definition.label), inject: () => ({controller, view: definition.view}),
      }, ProjectPanelIcon);
    }
  });
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces', priority: -100, locale: 'project',
    store: createProjectSessionViewStore(),
    inject: () => ({controller}),
  }, ProjectSessionBrowser));
  ctx.slots.inject('main', function* () {
    for (const definition of PROJECT_PANELS) {
      yield ctx.slots.register({
        name: 'main', key: definition.id, locale: 'project',
        ...(definition.view === 'tasks' ? {store: taskSidebar.store, children: {'project.task.sidebar-toggle': {kind: 'single', scope: 'root'}} as const} : {}),
        inject: () => ({controller, view: definition.view}),
      }, ProjectPanel);
    }
    ctx.layout.selectPanel(initialPanel);
  });
  ctx.effect(() => {
    const refresh = () => {if (!document.hidden) {void capabilities.refreshAll(); void resources.refresh();}};
    const timer = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => {clearInterval(timer); window.removeEventListener('focus', refresh);};
  }, 'project: capability refresh');
  ctx.effect(() => ctx.workspaces.list.subscribe(() => update({})), 'project: navigation availability');
  ctx.effect(() => {
    const syncSession = () => {
      capabilities.setSession(sessions.list.getSnapshot().current ?? undefined);
      update({}); // Cold history can arrive after Task detail while current is unchanged.
    };
    const remove = sessions.list.subscribe(syncSession);
    syncSession();
    return remove;
  }, 'project: active session catalogs');
  ctx.remote.$on('agent-preset/selected', (id) => {
    if (id === sessions.list.getSnapshot().current) capabilities.invalidateCatalogs();
  });
  ctx.on('connection/reset', () => capabilities.invalidateCatalogs());
  void capabilities.refreshAll();
  void resources.refresh();
  void controller.refresh();
}

function useProject(controller: Controller) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
/** Brand contents use official slots; only the two missing action seams need an adapter. */
function ProjectBrandMark({t, controller, size}: PropsRuntime<'sidebar.brand.mark'> & PropsLocale<'project'> & {controller: Controller}) {
  const {project, busy} = useProject(controller);
  const mark = useRef<HTMLSpanElement>(null);
  const labelId = useId();
  const canStart = Boolean(project) && !busy;
  useLayoutEffect(() => {
    if (!mark.current) return;
    return bindProjectSidebarControls(mark.current, {overviewLabelId: labelId, canStart,
      showOverview: () => controller.show(initialPanel), startSession: () => {void controller.start();}});
  }, [controller, labelId, canStart]);
  return <span ref={mark} className="project-brand-mark"><IconFolderOpenOutline16 size={size} />
    <span id={labelId} className="project-visually-hidden">{t('overview')} · {project?.name ?? t('loading')}</span>
  </span>;
}

function ProjectBrandName({t, controller}: PropsRuntime<'sidebar.brand.name'> & PropsLocale<'project'> & {controller: Controller}) {
  const {project} = useProject(controller);
  return <span className="project-brand-title">{project?.name ?? t('loading')}</span>;
}

type ProjectPanelIconProps = PropsRuntime<'sidebar.panellist'> & {controller: Controller; view: ProjectPanelView};
function ProjectPanelIcon({controller, view, size}: ProjectPanelIconProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const previousCount = useRef<number | undefined>(undefined);
  const {project} = useProject(controller);
  const capabilities = useSyncExternalStore(
    controller.capabilities.subscribe,
    controller.capabilities.getSnapshot,
    controller.capabilities.getSnapshot,
  );
  const count = projectPanelDisplayCount(
    view,
    projectPanelCount(view, project, capabilities),
    previousCount.current,
    capabilities,
  );
  // Commit the visible value only after React accepts this render. During the
  // next Session's catalog request it remains available without changing the
  // Controller's deliberately invalidated skills/tools snapshots.
  useLayoutEffect(() => {previousCount.current = count;}, [count]);
  // The official SidebarRoot passes 16 in its wide row and 18 in its rail.
  // Rebinding on that prop removes the appended node before the rail settles.
  useLayoutEffect(() => {
    if (anchor.current === null) return;
    return bindProjectPanelCount(anchor.current, count, size === 16);
  }, [count, size]);
  const icon = view === 'overview' ? <IconFolderOpenOutline16 size={size} />
    : view === 'resources' ? <ReferenceIcon kind="folder" size={size} />
      : view === 'memory' ? <ReferenceIcon kind="file" size={size} />
        : view === 'tasks' ? <IconListPenOutline16 size={size} />
          : view === 'skills' ? <IconSkillOutline16 size={size} />
            : view === 'tools' ? <IconPersonalizationOutline16 size={size} />
              : <IconApiOutline14 size={size} />;
  return <span ref={anchor} className="project-panel-icon">{icon}</span>;
}

type ProjectSessionBrowserProps = PropsRuntime<'sidebar.workspaces'>
  & PropsStore<ReturnType<typeof createProjectSessionViewStore>>
  & PropsLocale<'project'>
  & {controller: Controller};
type ProjectTranslate = ProjectSessionBrowserProps['t'];
type PendingKind = 'approval' | 'plan-review' | 'question';
interface ProjectSessionStatus {state: StateDotState; label: string}
interface ProjectSessionDrag {
  sessionId: SessionId;
  over: {id: SessionId; half: 'before' | 'after'} | null;
}
interface RemoteSearch {
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: readonly SessionSearchResultItem[];
  hasMore: boolean;
}

/**
 * Keep a native row drag valid while the pointer crosses list gaps or the
 * bottom fade. The row still owns the actual insertion marker and commit.
 */
function useProjectSessionDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const acceptDrag = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    };
    const acceptDrop = (event: DragEvent) => {event.preventDefault();};
    document.addEventListener('dragover', acceptDrag);
    document.addEventListener('drop', acceptDrop);
    return () => {
      document.removeEventListener('dragover', acceptDrag);
      document.removeEventListener('drop', acceptDrop);
    };
  }, [active]);
}

/** Only official pending-interaction kinds have dedicated Session-row presentation. */
function visiblePendingKind(kind: string | undefined): PendingKind | undefined {
  return kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : undefined;
}

/** Index running uninterrupted subagent descendants under every parent Session. */
function runningSubagentCounts(byId: Readonly<Record<SessionId, SessionSummary>>): ReadonlyMap<SessionId, number> {
  const counts = new Map<SessionId, number>();
  for (const descendant of Object.values(byId)) {
    if (descendant.origin !== 'subagent' || !descendant.running) continue;
    const seen = new Set<SessionId>();
    let current: SessionSummary | undefined = descendant;
    while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      counts.set(current.parentId, (counts.get(current.parentId) ?? 0) + 1);
      current = byId[current.parentId];
    }
  }
  return counts;
}

/** Official Session status precedence: attention, activity, descendants, completion, idle. */
function projectSessionStatuses(
  session: SessionSummary, pending: PendingKind | undefined, runningSubagents: number, t: ProjectTranslate,
): readonly [ProjectSessionStatus, ...ProjectSessionStatus[]] {
  const descendant = runningSubagents === 0 ? undefined : {
    state: 'ongoing' as const,
    label: t(runningSubagents === 1 ? 'statusSubagentOne' : 'statusSubagentOther', {count: runningSubagents}),
  };
  const attention = pending === undefined ? undefined : {
    state: 'warning' as const,
    label: t(pending === 'approval' ? 'statusWaitingApproval'
      : pending === 'plan-review' ? 'statusPlanReview' : 'statusWaitingAnswer'),
  };
  if (attention !== undefined) return descendant === undefined ? [attention] : [attention, descendant];
  if (session.running) {
    const running = {state: 'ongoing' as const, label: t('statusRunning')};
    return descendant === undefined ? [running] : [running, descendant];
  }
  if (descendant !== undefined) return [descendant];
  if (session.completed === true) return [{state: 'done', label: t('statusCompleted')}];
  // Official rows model idle as a hidden `done` dot; the label remains
  // available in the hover card and to assistive technology.
  return [{state: 'done', label: t('statusIdle')}];
}

/** Localized compact relative time used in the official row's trailing cell. */
function projectSessionTime(updatedAt: number, now: number, t: ProjectTranslate): string {
  const {unit, n} = relativeTime(updatedAt, now);
  if (unit === 'now') return t('timeNow');
  return t(unit === 'minutes' ? 'timeMinutes' : unit === 'hours' ? 'timeHours'
    : unit === 'days' ? 'timeDays' : unit === 'months' ? 'timeMonths' : 'timeYears', {count: n});
}

/** Hover cards add the localized “ago” wrapper around non-current buckets. */
function projectSessionHoverTime(updatedAt: number, now: number, t: ProjectTranslate): string {
  const value = projectSessionTime(updatedAt, now, t);
  return relativeTime(updatedAt, now).unit === 'now' ? value : t('timeAgo', {time: value});
}

/** Pointer half used by manual-order drag markers and insert-before resolution. */
function projectSessionRowHalf(event: {clientY: number; currentTarget: HTMLElement}): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function ProjectOrderMenu({orderBy, onPick, t}: {
  orderBy: ProjectSessionOrder; onPick(order: ProjectSessionOrder): void; t: ProjectTranslate;
}) {
  const [open, setOpen] = useState(false);
  return <Menu
    open={open}
    onClose={() => {setOpen(false);}}
    items={[
      {type: 'label', id: 'order-label', text: t('orderBy')},
      {id: 'manual', label: t('orderManual')},
      {id: 'updated', label: t('orderUpdated')},
    ]}
    selectedId={orderBy}
    onSelect={id => {
      if (id === 'manual' || id === 'updated') onPick(id);
      setOpen(false);
    }}
    align="end"
    dense
    portal
    anchor={<Tooltip label={t('viewOptions')} side="bottom" delayMs={500}>
      <button type="button" className="project-session-icon-button" aria-label={t('viewOptions')} onClick={() => {setOpen(value => !value);}}><IconPersonalizationOutline16 /></button>
    </Tooltip>}
  />;
}

/** One official-style Project Session row, without a surrounding Workspace row. */
function ProjectSessionRow({
  session, selected, pending, runningSubagents, now, draggable, dragActive, marker,
  onOpen, onRename, onFork, onArchive, onReveal, onDragStart, onDragHover, onDrop, onDragEnd, t,
}: {
  session: SessionSummary; selected: boolean; pending?: PendingKind; runningSubagents: number; now: number;
  draggable: boolean; dragActive: boolean; marker: 'before' | 'after' | null;
  onOpen(): void; onRename(): void; onFork(): void; onArchive(): void;
  onReveal?: (() => void) | undefined;
  onDragStart(): void; onDragHover(half: 'before' | 'after'): void;
  onDrop(half: 'before' | 'after'): void; onDragEnd(): void; t: ProjectTranslate;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (onReveal === undefined) return;
    rowRef.current?.scrollIntoView({block: 'nearest'});
    onReveal();
  }, [onReveal]);
  const title = session.blank ? t('newSession') : session.displayTitle;
  const statuses = projectSessionStatuses(session, pending, runningSubagents, t);
  const primary = statuses[0];
  const showStatus = primary.state !== 'done' || session.completed === true;
  const schedule = session.projectionValues as {schedule?: readonly unknown[]} | undefined;
  const hasSchedule = (schedule?.schedule?.length ?? 0) > 0;
  const ownRow = <div
    ref={rowRef}
    className={`project-session-row${selected ? ' selected' : ''}${menuOpen ? ' menu-open' : ''}${marker === null ? '' : ` drop-${marker}`}`}
    role="treeitem"
    aria-selected={selected}
    onClick={onOpen}
    draggable={draggable}
    onDragStart={draggable ? event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', session.id);
      onDragStart();
    } : undefined}
    onDragEnd={draggable ? onDragEnd : undefined}
    onDragOver={draggable ? event => {
      if (!dragActive) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      onDragHover(projectSessionRowHalf(event));
    } : undefined}
    onDrop={draggable ? event => {
      if (!dragActive) return;
      event.preventDefault();
      onDrop(projectSessionRowHalf(event));
    } : undefined}
  >
    {showStatus && <span className="project-session-status"><StateDot state={primary.state} />{statuses.map(status => <span className="project-visually-hidden" key={status.label}>{status.label}</span>)}</span>}
    <span className={`project-session-title${showStatus ? '' : ' no-status'}`}>{title}</span>
    {hasSchedule && <span className="project-session-schedule" role="img" aria-label={t('scheduleActive')} title={t('scheduleActive')}><IconAlarmClockOutline16 /></span>}
    {!session.blank && <span className="project-session-time">{projectSessionTime(session.updatedAt, now, t)}</span>}
    {!session.blank && <span className="project-session-actions"><Menu
      open={menuOpen}
      onClose={() => {setMenuOpen(false);}}
      items={[
        {id: 'rename', label: t('rename'), icon: <IconEditOutline16 />},
        {id: 'fork', label: t('forkSession'), icon: <IconBranchOutline16 />},
        {id: 'archive', label: t('archiveSession'), icon: <IconArchiveOutline20 size={16} />},
      ]}
      onSelect={id => {
        setMenuOpen(false);
        if (id === 'rename') onRename();
        if (id === 'fork') onFork();
        if (id === 'archive') onArchive();
      }}
      portal
      closeOnPointerLeave
      anchor={<button type="button" className="project-session-row-action" aria-label={t('sessionActions', {name: title})} onClick={event => {event.stopPropagation(); setMenuOpen(value => !value);}}><IconEllipsisOutline16 /></button>}
    /></span>}
  </div>;
  return <HoverCard
    anchor={ownRow}
    content={<div className="project-session-hover"><strong>{title}</strong>{!session.blank && <span>{projectSessionHoverTime(session.updatedAt, now, t)}</span>}{statuses.map(status => <span className="project-session-hover-status" key={status.label}><StateDot state={status.state} />{status.label}</span>)}</div>}
    disabled={menuOpen || dragActive}
    copyText={session.blank ? undefined : session.displayTitle}
    copyLabel={t('copy')}
    copiedLabel={t('copied')}
  />;
}

/** Compact search result copied from the official flat browser without Workspace metadata. */
function ProjectSearchResult({session, snippet, selected, pending, runningSubagents, onOpen, t}: {
  session: SessionSummary; snippet?: string; selected: boolean; pending?: PendingKind;
  runningSubagents: number; onOpen(): void; t: ProjectTranslate;
}) {
  const statuses = projectSessionStatuses(session, pending, runningSubagents, t);
  const primary = statuses[0];
  const schedule = session.projectionValues as {schedule?: readonly unknown[]} | undefined;
  const hasSchedule = (schedule?.schedule?.length ?? 0) > 0;
  return <button type="button" className={`project-session-search-result${selected ? ' selected' : ''}`} role="treeitem" aria-selected={selected} onClick={onOpen}>
    <span className="project-session-search-heading">
      <span className="project-session-status">{(primary.state !== 'done' || session.completed === true) && <><StateDot state={primary.state} />{statuses.map(status => <span className="project-visually-hidden" key={status.label}>{status.label}</span>)}</>}</span>
      <span className="project-session-search-title">{session.displayTitle}</span>
      {hasSchedule && <span className="project-session-schedule search" role="img" aria-label={t('scheduleActive')} title={t('scheduleActive')}><IconAlarmClockOutline16 /></span>}
    </span>
    {snippet !== undefined && <span className="project-session-search-meta"><span className="project-session-search-snippet">{snippet}</span></span>}
  </button>;
}

/**
 * Project-mode copy of the official flat Workspace browser: same Session
 * controls and rows, with the Workspace grouping layer removed and all data
 * constrained to `session.cwd === project.root`.
 */
function ProjectSessionBrowser({
  t, controller, wide, expandSidebar, usePanelInfo, useSessions, useWorkspaces, useSessionPendingInteraction,
  useStore, actions,
}: ProjectSessionBrowserProps) {
  const {project, error} = useProject(controller);
  const list = useSessions(snapshot => snapshot);
  const workspaces = useWorkspaces(snapshot => snapshot);
  const pendingInteractions = useSessionPendingInteraction(snapshot => snapshot);
  const panelActive = usePanelInfo(info => info.activePanelId !== null);
  const projectRoot = project?.root;
  const orderBy = useStore(state => state.orderBy);
  const sessionOrderByProject = useStore(state => state.sessionOrderByProject);
  const sessionUpdatedAtByProject = useStore(state => state.sessionUpdatedAtByProject);
  const storedOrder = projectRoot === undefined ? undefined : sessionOrderByProject[projectRoot];
  const storedUpdatedAt = projectRoot === undefined ? undefined : sessionUpdatedAtByProject[projectRoot];
  const baseRows = useMemo(() => projectRoot === undefined ? [] : projectSessionRows({
    list, projectRoot, archivedIds: workspaces.archivedSessionIds,
  }), [list, projectRoot, workspaces.archivedSessionIds]);
  const rows = useMemo(() => projectRoot === undefined ? [] : projectSessionRows({
    list, projectRoot, archivedIds: workspaces.archivedSessionIds, viewOrder: storedOrder,
  }), [list, projectRoot, storedOrder, workspaces.archivedSessionIds]);
  const runningDescendants = useMemo(() => runningSubagentCounts(list.byId), [list.byId]);
  const previousOrderBy = useRef(orderBy);
  useEffect(() => {
    if (projectRoot === undefined || list.phase !== 'ready') return;
    const switchedToUpdated = previousOrderBy.current !== 'updated' && orderBy === 'updated';
    previousOrderBy.current = orderBy;
    const next = nextProjectSessionOrder({
      sessions: baseRows,
      previousOrder: storedOrder,
      previousUpdatedAt: storedUpdatedAt ?? {},
      orderBy,
      sortByRecency: orderBy === 'updated' && (storedOrder === undefined || switchedToUpdated),
    });
    if (next.changed) {
      actions.syncSessionOrder(projectRoot, next.order.map(id => id as string), next.updatedAt);
    }
  }, [actions.syncSessionOrder, baseRows, list.phase, orderBy, projectRoot, storedOrder, storedUpdatedAt]);
  const currentBlankSessionId = projectRoot === undefined || list.current === undefined
    || list.byId[list.current]?.blank !== true || list.byId[list.current]?.cwd !== projectRoot
    ? undefined
    : list.current;
  useEffect(() => {
    if (projectRoot === undefined || currentBlankSessionId === undefined || storedOrder?.[0] === currentBlankSessionId) return;
    actions.setSessionOrder(projectRoot, [
      currentBlankSessionId,
      ...(storedOrder ?? []).filter(id => id !== currentBlankSessionId),
    ]);
  }, [actions.setSessionOrder, currentBlankSessionId, projectRoot, storedOrder]);
  const [query, setQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [revealSessionId, setRevealSessionId] = useState<SessionId | undefined>(undefined);
  const [searchOnExpand, setSearchOnExpand] = useState(false);
  const normalizedQuery = sanitizeProjectSessionQuery(query).trim();
  const [remoteSearch, setRemoteSearch] = useState<RemoteSearch>({query: '', status: 'idle', items: [], hasMore: false});
  const searchRoot = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [drag, setDrag] = useState<ProjectSessionDrag | null>(null);
  const dropCommitted = useRef(false);
  useProjectSessionDragAcceptance(drag !== null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (!wide || !searchOnExpand) return;
    const timer = window.setTimeout(() => {
      searchInput.current?.focus({preventScroll: true});
      setSearchOnExpand(false);
    }, 300);
    return () => {window.clearTimeout(timer);};
  }, [searchOnExpand, wide]);
  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return;
    searchInput.current?.focus({preventScroll: true});
  }, [searchExpanded, searchOnExpand, wide]);
  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return;
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target)) return;
      searchInput.current?.blur();
      if (normalizedQuery === '') setSearchExpanded(false);
    };
    document.addEventListener('click', dismiss);
    return () => {document.removeEventListener('click', dismiss);};
  }, [normalizedQuery, searchExpanded, searchOnExpand, wide]);
  useEffect(() => {
    if (normalizedQuery === '') {
      setRemoteSearch({query: '', status: 'idle', items: [], hasMore: false});
      return;
    }
    const abort = new AbortController();
    setRemoteSearch({query: normalizedQuery, status: 'loading', items: [], hasMore: false});
    const timer = window.setTimeout(() => {
      controller.search(normalizedQuery, abort.signal).then(result => {
        if (!abort.signal.aborted) setRemoteSearch({query: normalizedQuery, status: 'ready', ...result});
      }).catch(() => {
        if (!abort.signal.aborted) setRemoteSearch({query: normalizedQuery, status: 'error', items: [], hasMore: false});
      });
    }, 250);
    return () => {window.clearTimeout(timer); abort.abort();};
  }, [controller, normalizedQuery]);
  useEffect(() => {
    if (normalizedQuery !== '') setRevealSessionId(undefined);
  }, [normalizedQuery]);

  const content = remoteSearch.query === normalizedQuery
    ? {items: remoteSearch.items, hasMore: remoteSearch.hasMore}
    : {items: [], hasMore: false};
  const search = useMemo(() => projectSessionSearch(rows, normalizedQuery, content, controller.searchResultLimit),
    [content.hasMore, content.items, controller.searchResultLimit, normalizedQuery, rows]);
  const now = Date.now();
  const renameBlocked = renaming || renameTarget === null || renameDraft.trim() === '';
  const closeRename = () => {
    if (renaming) return;
    setRenameTarget(null);
    setRenameError(null);
  };
  const confirmRename = () => {
    if (renameBlocked || renameTarget === null) return;
    setRenaming(true);
    setRenameError(null);
    controller.rename(renameTarget.id, renameDraft.trim()).then(() => {
      setRenaming(false);
      setRenameTarget(null);
    }).catch(reason => {
      setRenaming(false);
      setRenameError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const openSearchResult = (id: SessionId) => {
    setRevealSessionId(id);
    setQuery('');
    setSearchExpanded(false);
    controller.open(id);
  };
  /** Official flat-list drag commit, with the Project root as its order account. */
  const commitDrop = (activeDrag: ProjectSessionDrag, over: NonNullable<ProjectSessionDrag['over']>) => {
    if (dropCommitted.current || projectRoot === undefined) return;
    dropCommitted.current = true;
    setDrag(null);
    const orderedIds = rows.map(row => row.id);
    const anchor = projectSessionDropAnchor(orderedIds, activeDrag.sessionId, over.id, over.half);
    if (anchor === null) return;
    const nextOrder = orderedIds.filter(id => id !== activeDrag.sessionId);
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor);
    nextOrder.splice(insertAt < 0 ? nextOrder.length : insertAt, 0, activeDrag.sessionId);
    if (nextOrder.every((id, index) => id === orderedIds[index])) return;
    actions.setSessionOrder(projectRoot, nextOrder.map(id => id as string));
  };

  return <section className={`project-session-browser${wide ? '' : ' rail'}`} aria-label={t('sessions')}>
    {wide ? <div className="project-session-header">
      <span className={`project-section-label${searchExpanded ? ' hidden' : ''}`}>{t('sessions')}</span>
      <div className={`project-session-search-slot${searchExpanded ? ' expanded' : ''}`}><div
        ref={searchRoot}
        className={`project-session-search${searchExpanded ? ' expanded' : ''}`}
        onClick={() => {setSearchExpanded(true); searchInput.current?.focus();}}
      >
        <Tooltip label={t('searchSessions')} side="bottom" delayMs={500} disabled={searchExpanded}><button type="button" className="project-session-search-button" aria-label={t('searchSessions')} aria-expanded={searchExpanded} onClick={() => {setSearchExpanded(true);}}><IconSearchOutline16 size={searchExpanded ? 11 : 14} /></button></Tooltip>
        <input
          ref={searchInput}
          className="project-session-search-input"
          type="text"
          placeholder={t('searchPlaceholder')}
          maxLength={500}
          value={query}
          tabIndex={searchExpanded ? 0 : -1}
          onChange={event => {setQuery(sanitizeProjectSessionQuery(event.target.value));}}
          onKeyDown={event => {if (event.key === 'Escape') {setQuery(''); setSearchExpanded(false);}}}
        />
        {searchExpanded && <button type="button" className="project-session-search-clear" aria-label={t('searchClear')} onClick={event => {event.stopPropagation(); setQuery(''); setSearchExpanded(false);}}><IconCloseFill14 /></button>}
      </div></div>
      <div className={`project-session-header-actions${searchExpanded ? ' hidden' : ''}`}><ProjectOrderMenu orderBy={orderBy} onPick={actions.setOrderBy} t={t} /></div>
    </div> : <div className="project-session-rail-search"><Tooltip label={t('searchSessions')}><button type="button" className="project-session-search-button" aria-label={t('searchSessions')} onClick={() => {setSearchExpanded(true); setSearchOnExpand(true); expandSidebar();}}><IconSearchOutline16 size={18} /></button></Tooltip></div>}

    <div className="project-session-list-area">
      {wide && <div className="project-session-tree-body">
        <div className={`project-session-list${normalizedQuery === '' ? ' flat' : ' search'}`} role="tree" aria-label={normalizedQuery === '' ? t('sessions') : t('searchResults')}>
          {normalizedQuery !== '' ? <>
            {search.items.map(item => <ProjectSearchResult
              key={item.session.id}
              session={item.session}
              snippet={item.snippet}
              selected={!panelActive && item.session.id === list.current}
              pending={visiblePendingKind(pendingInteractions.get(item.session.id)?.kind)}
              runningSubagents={runningDescendants.get(item.session.id) ?? 0}
              onOpen={() => {openSearchResult(item.session.id);}}
              t={t}
            />)}
            {remoteSearch.status === 'loading' && <div className="project-session-search-status" role="status">{t('searchPending')}</div>}
            {remoteSearch.status === 'error' && <div className="project-session-search-warning" role="status">{t('searchUnavailable')}</div>}
            {remoteSearch.status !== 'loading' && search.items.length === 0 && <div className="project-session-empty">{t('searchNoMatches')}</div>}
            {search.hasMore && <div className="project-session-search-status">{t('searchHasMore', {count: controller.searchResultLimit})}</div>}
          </> : <>
            {rows.length === 0 && <div className="project-session-empty">{t('emptySessions')}</div>}
            {rows.map(session => {
              const marker = drag?.over?.id === session.id ? drag.over.half : null;
              return <ProjectSessionRow
                key={session.id}
                session={session}
                selected={!panelActive && session.id === list.current}
                pending={visiblePendingKind(pendingInteractions.get(session.id)?.kind)}
                runningSubagents={runningDescendants.get(session.id) ?? 0}
                now={now}
                draggable
                dragActive={drag !== null}
                marker={marker}
                onOpen={() => {controller.open(session.id);}}
                onRename={() => {setRenameTarget(session); setRenameDraft(session.displayTitle); setRenameError(null);}}
                onFork={() => {void controller.fork(session.id).catch(reason => {console.warn('Project Session fork rejected:', reason);});}}
                onArchive={() => {void controller.archive(session.id).catch(reason => {console.warn('Project Session archive rejected:', reason);});}}
                onReveal={session.id === revealSessionId
                  ? () => {setRevealSessionId(current => current === session.id ? undefined : current);}
                  : undefined}
                onDragStart={() => {
                  dropCommitted.current = false;
                  setDrag({sessionId: session.id, over: null});
                }}
                onDragHover={half => {setDrag(current => current === null ? null : {...current, over: {id: session.id, half}});}}
                onDrop={half => {if (drag !== null) commitDrop(drag, {id: session.id, half});}}
                onDragEnd={() => {
                  if (drag?.over !== null && drag?.over !== undefined) commitDrop(drag, drag.over);
                  else setDrag(null);
                  dropCommitted.current = false;
                }}
                t={t}
              />;
            })}
          </>}
        </div>
        <span className="project-session-fade" />
      </div>}
    </div>
    {error && <p role="alert" className="project-error">{error}</p>}
    <Modal
      open={renameTarget !== null}
      onClose={closeRename}
      closeLabel={t('close')}
      title={t('renameSession')}
      footer={<><Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button><Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>{t('rename')}</Button></>}
    >
      <Input
        className="project-session-rename-input"
        value={renameDraft}
        aria-label={t('sessionName')}
        autoFocus
        disabled={renaming}
        onFocus={event => {event.target.select();}}
        onChange={event => {setRenameDraft(event.target.value); setRenameError(null);}}
        onCompositionStart={() => {composing.current = true;}}
        onCompositionEnd={() => {composing.current = false;}}
        onKeyDown={event => {if (event.key === 'Enter' && !composing.current) {event.preventDefault(); confirmRename();}}}
      />
      {renameError !== null && <div className="project-session-rename-error" role="alert">{renameError}</div>}
    </Modal>
  </section>;
}

function ProjectPanel({controller, view, t, renderSlot}: {controller: Controller; view: ProjectPanelView} & PropsLocale<'project'> & PropsRenderSlots<'project.task.sidebar-toggle'>) {
  const {project, error, busy} = useProject(controller);
  useLayoutEffect(() => {
    controller.suppressPanelTransition();
    return controller.suppressPanelTransition;
  }, [controller]);
  useEffect(() => {void controller.refresh();}, [controller]);
  useLayoutEffect(() => view === 'tasks' ? controller.taskSidebar.mount() : undefined, [controller, view]);
  if (!project) return <main className="project-panel"><p role={error ? 'alert' : 'status'}>{error ?? t('loading')}</p><Button variant="outline" onClick={() => void controller.refresh()}>{t('retry')}</Button></main>;
  const definition = PROJECT_PANELS.find(panel => panel.view === view)!;
  const resourceCount = managedResources(project.resources, project.root).length;
  return <main className={`project-panel${view === 'tasks' ? ' project-tasks-panel' : ''}`}>
    <header><div><p className="project-eyebrow">{t('projectMode')} · {project.id}</p><h1>{view === 'overview' ? project.name : t(definition.label)}</h1><p>{project.description}</p></div><div className="project-panel-actions"><Button variant="outline" size="sm" icon={<IconRefreshOutline16 />} onClick={() => {void controller.refresh(); if (view === 'resources' || view === 'overview') {controller.resources.clearError(); void controller.resources.refresh();} if (view === 'tasks' || view === 'skills' || view === 'tools' || view === 'mcp') void controller.capabilities.refresh(view);}}>{t('refresh')}</Button>{view === 'tasks' && renderSlot('project.task.sidebar-toggle', {})}</div></header>
    {error && <p role="alert" className="project-error">{error}</p>}
    {view === 'overview' && <>
      <div className="project-summary"><Tag tone="neutral">{t(resourceCount === 1 ? 'resourceCountOne' : 'resourcesCount', {count: resourceCount})}</Tag><Tag tone="neutral">{t(project.memory.length === 1 ? 'memoryCountOne' : 'memoryCount', {count: project.memory.length})}</Tag></div>
      <section className="project-card"><h2>{t('environment')}</h2><p>{t('environmentBody')}</p><code>{project.root}</code><div className="project-card-actions"><Button variant="primary" icon={<IconNewChatOutline16 />} disabled={busy} onClick={() => void controller.start()}>{busy ? t('creating') : t('startSession')}</Button></div></section>
    </>}
    {view === 'overview' && <section><div className="project-card-top"><h2>{t('resources')}</h2><Button variant="outline" size="sm" onClick={() => controller.show('project.resources' as MainPanelId)}>{t('resourceManage')}</Button></div><ResourcesOverview controller={controller.resources} resources={project.resources} root={project.root} t={t} /></section>}
    {view === 'resources' && <ResourcesPanel controller={controller.resources} root={project.root} pickDirectory={controller.pickDirectory} t={t} />}
    {view === 'memory' && <MemoryPanel memory={project.memory} save={controller.saveMemory} t={t} />}
    {view === 'tasks' && <TasksPanel openFile={(request, opener) => controller.taskSidebar.open(request, opener)} controller={controller.capabilities} t={t} openSession={id => controller.open(id as SessionId)} startSession={() => {void controller.start();}} sessionTitle={controller.sessionTitle} canOpenSession={controller.canOpenSession} continueTask={controller.continueTask} />}
    {view === 'skills' && <SkillsPanel controller={controller.capabilities} t={t} pickDirectory={controller.pickDirectory} />}
    {view === 'tools' && <ToolsPanel controller={controller.capabilities} t={t} />}
    {view === 'mcp' && <McpPanel controller={controller.capabilities} t={t} />}
    <ResourceAuthDialog controller={controller.resources.auth} t={t} />
  </main>;
}
