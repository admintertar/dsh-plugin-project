import {useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction} from 'react';
import {Button, IconSearchOutline16, Input, Tag, writeClipboard} from '@deepseek-ai/dsh-client-ui-primitives';
import type {TaskSidebarRequest} from './task-sidebar-controller.ts';
import type {TaskDetail} from '../api-types.ts';
import type {ProjectTaskDiagnostic, ProjectTaskStatus, TaskEntry, TaskRecord, TaskReference} from '../task-contract.ts';
import type {ProjectCapabilityController} from './controller.ts';
import {CapabilityError, useCapability, type CapabilityTranslate} from './capability-ui.tsx';
import {ProjectSelect, ProjectSwitch} from './ProjectControls.tsx';
import type {TaskViewState} from './task-view.ts';

const statusKeys = {active: 'taskActive', blocked: 'taskBlocked', completed: 'taskCompleted', cancelled: 'taskCancelled'} as const;
const phaseKeys = {investigation: 'taskPhaseInvestigation', design: 'taskPhaseDesign', implementation: 'taskPhaseImplementation', review: 'taskPhaseReview', validation: 'taskPhaseValidation'} as const;
const entryKeys = {progress: 'taskProgress', decision: 'taskDecision', scope: 'taskScopeChange', verification: 'taskVerification', completion: 'taskCompletion'} as const;
const basisKeys = {'user-request': 'taskUserRequest', 'agent-proposal': 'taskAgentProposal', observation: 'taskObservation'} as const;
const verificationKeys = {passed: 'taskVerificationPassed', failed: 'taskVerificationFailed', 'not-run': 'taskVerificationNotRun', 'not-applicable': 'taskVerificationNotApplicable'} as const;
const diagnosticKeys = {'invalid-task': 'taskDiagnosticInvalid', 'size-limit': 'taskDiagnosticSize'} as const;

function safeUrl(value: string): string | undefined {
  try {const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;}
  catch {return undefined;}
}
function TextList({items}: {items?: string[]}) {
  return items?.length ? <ul className="project-task-text-list">{items.map((text, index) => <li className="project-prose" key={index}>{text}</li>)}</ul> : null;
}
function TaskSection({title, children}: {title: string; children: ReactNode}) {
  return <section className="project-task-section"><h3>{title}</h3>{children}</section>;
}
function Diagnostics({items, t}: {items: ProjectTaskDiagnostic[]; t: CapabilityTranslate}) {
  if (!items.length) return null;
  return <section className="project-task-diagnostics" role="status" aria-label={t('taskDiagnostics')}>
    <h3>{t('taskDiagnostics')}</h3><ul>{items.map((item, index) => <li key={`${item.path}-${item.code}-${index}`}>
      <code>{item.path}</code><span>{t(diagnosticKeys[item.code])}</span>
    </li>)}</ul>
  </section>;
}
function Verification({entry, t}: {entry: TaskEntry; t: CapabilityTranslate}) {
  const value = entry.verification;
  if (!value) return null;
  return <div className="project-task-verification">
    <Tag tone={value.result === 'passed' ? 'success' : value.result === 'failed' ? 'danger' : 'neutral'}>{t(verificationKeys[value.result])}</Tag>
    <p className="project-prose"><strong>{t('taskVerificationMethod')}: </strong>{value.method}</p>
    <p className="project-prose"><strong>{t('taskVerificationCoverage')}: </strong>{value.coverage}</p>
    {value.reason && <p className="project-prose"><strong>{t('taskChangeReason')}: </strong>{value.reason}</p>}
  </div>;
}

export interface TaskContinueResult {sessionId?: string; draftPreserved?: boolean; cancelled?: boolean; suggestedDraft?: string}
export interface TasksPanelProps {
  controller: ProjectCapabilityController; t: CapabilityTranslate;
  openFile(request: TaskSidebarRequest, opener?: HTMLElement): void;
  openSession(id: string): void;
  startSession(): void; sessionTitle(id: string): string; canOpenSession(id: string): boolean;
  continueTask(task: Pick<TaskRecord, 'id' | 'title' | 'status'>, signal?: AbortSignal): Promise<TaskContinueResult>;
}

/** Tasks and file previews are independent of conversations. */
export function TasksPanel({controller, t, openSession, startSession, sessionTitle, canOpenSession, continueTask, openFile}: TasksPanelProps) {
  const state = useCapability(controller, 'tasks');
  const view = useSyncExternalStore(controller.taskView.subscribe, controller.taskView.getSnapshot);
  const {showingDetail: mobileDetail, query, filter, showArchived, pages, selectedId, detail, detailLoading, detailError} = view;
  const setView = <K extends keyof TaskViewState,>(key: K, value: SetStateAction<TaskViewState[K]>) => {
    controller.taskView.update(draft => {draft[key] = typeof value === 'function' ? value(draft[key]) : value;});
  };
  const setMobileDetail = (value: boolean) => setView('showingDetail', value);
  const setQuery = (value: string) => setView('query', value);
  const setFilter = (value: TaskViewState['filter']) => setView('filter', value);
  const setShowArchived = (value: boolean) => setView('showArchived', value);
  const setPages = (value: SetStateAction<TaskViewState['pages']>) => setView('pages', value);
  const setSelectedId = (value: string | undefined) => setView('selectedId', value);
  const setDetail = (value: SetStateAction<TaskDetail | undefined>) => setView('detail', value);
  const setDetailLoading = (value: boolean) => setView('detailLoading', value);
  const setDetailError = (value: string | undefined) => setView('detailError', value);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<TaskContinueResult>();
  const [copied, setCopied] = useState(false);
  const detailRequest = useRef(0);
  const historyRequest = useRef(false);
  const prepareRequest = useRef(false);
  const preparationAbort = useRef<AbortController>();
  const mounted = useRef(true);
  const listElement = useRef<HTMLDivElement>(null);
  const detailElement = useRef<HTMLElement>(null);
  const visible = state.data?.tasks ?? [];
  const selected = selectedId ?? visible[0]?.id;
  const selectedRevision = visible.find(task => task.id === selected)?.revision;
  const cursor = pages[pages.length - 1];
  const current = detail?.task.id === selected ? detail : undefined;
  const task = current?.task;
  const date = (value: string) => new Date(value).toLocaleString(t('dateLocale'));
  const reportError = (error: unknown) => setDetailError(error instanceof Error ? error.message : 'operation-failed');

  useLayoutEffect(() => {
    if (listElement.current) listElement.current.scrollTop = controller.taskView.scroll.list;
    if (detailElement.current && selected) detailElement.current.scrollTop = controller.taskView.scroll.details.get(selected) ?? 0;
  }, [controller, selected, !!current, mobileDetail]);

  useEffect(() => {mounted.current = true; return () => {mounted.current = false; detailRequest.current++;};}, []);
  // Selection and panel lifetime cancel navigation, while background record refreshes do not.
  useEffect(() => () => {preparationAbort.current?.abort();}, [selected]);
  useEffect(() => {
    controller.setTaskQuery({query: query.trim() || undefined, status: filter === 'all' ? undefined : filter, includeArchived: showArchived, cursor});
    void controller.refresh('tasks');
  }, [controller, query, filter, showArchived, cursor]);
  useEffect(() => {
    const request = ++detailRequest.current;
    historyRequest.current = false;
    setHistoryLoading(false); setDetailError(undefined); setPrepared(undefined); setCopied(false);
    if (!selected) {setDetail(undefined); setDetailLoading(false); return;}
    setDetailLoading(true);
    void controller.getTask(selected).then(value => {
      if (mounted.current && detailRequest.current === request) setDetail(value);
    }).catch(error => {if (mounted.current && detailRequest.current === request) reportError(error);})
      .finally(() => {if (mounted.current && detailRequest.current === request) setDetailLoading(false);});
    return () => {if (detailRequest.current === request) detailRequest.current++;};
  }, [controller, selected, selectedRevision, query, filter, showArchived, cursor]);

  const selectTask = (id: string) => controller.taskView.select(id);
  const resetQuery = () => {
    controller.taskView.scroll.list = 0;
    controller.taskView.update(draft => {draft.pages = [undefined]; draft.selectedId = undefined; draft.detail = undefined; draft.showingDetail = false;});
  };
  const changePage = (next: Array<string | undefined>) => {
    controller.taskView.scroll.list = 0;
    controller.taskView.update(draft => {draft.pages = next; draft.selectedId = undefined; draft.detail = undefined;});
  };
  const reloadDetail = async () => {
    if (!selected) return;
    const request = ++detailRequest.current;
    historyRequest.current = false; setHistoryLoading(false); setDetailLoading(true); setDetailError(undefined);
    try {const value = await controller.getTask(selected); if (mounted.current && detailRequest.current === request) setDetail(value);}
    catch (error) {if (mounted.current && detailRequest.current === request) reportError(error);}
    finally {if (mounted.current && detailRequest.current === request) setDetailLoading(false);}
  };
  const loadEarlier = async () => {
    if (!current?.entriesNextCursor || historyRequest.current) return;
    historyRequest.current = true; setHistoryLoading(true); setDetailError(undefined);
    const request = detailRequest.current;
    const revision = current.task.revision;
    try {
      const older = await controller.getTask(current.task.id, {cursor: current.entriesNextCursor});
      if (!mounted.current || detailRequest.current !== request) return;
      if (older.task.revision !== revision) throw new Error('task-revision-conflict');
      setDetail(previous => {
        if (!previous || previous.task.id !== older.task.id || previous.task.revision !== revision) return previous;
        const known = new Set(previous.task.entries.map(entry => entry.id));
        return {...previous, entriesNextCursor: older.entriesNextCursor,
          sourceSessionIds: {...previous.sourceSessionIds, ...older.sourceSessionIds},
          task: {...previous.task, entries: [...previous.task.entries, ...older.task.entries.filter(entry => !known.has(entry.id))]}};
      });
    } catch (error) {if (mounted.current && detailRequest.current === request) reportError(error);}
    finally {if (mounted.current && detailRequest.current === request) {historyRequest.current = false; setHistoryLoading(false);}}
  };
  const prepare = async () => {
    if (!task || prepareRequest.current) return;
    const abort = new AbortController();
    preparationAbort.current = abort;
    prepareRequest.current = true; setPreparing(true); setDetailError(undefined); setPrepared(undefined);
    const request = detailRequest.current;
    try {const result = await continueTask(task, abort.signal); if (mounted.current && detailRequest.current === request && !abort.signal.aborted && !result.cancelled) setPrepared(result);}
    catch (error) {if (mounted.current && detailRequest.current === request) reportError(error);}
    finally {prepareRequest.current = false; if (preparationAbort.current === abort) preparationAbort.current = undefined; if (mounted.current) setPreparing(false);}
  };
  const readFile = (kind: 'artifact'|'reference', index: number) => {
    if (!task) return;
    const item = kind === 'artifact' ? task.artifacts[index] : task.references[index];
    if (item?.type !== 'file') return;
    setSelectedId(task.id);
    setMobileDetail(true); // Keep the selected task visible when the frame makes room for the Sidebar.
    openFile({id: task.id, kind, index, revision: task.revision, path: item.path}, document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  };
  const readCommit = (index: number, opener: HTMLElement) => {
    const artifact = task?.artifacts[index]; if (!task || artifact?.type !== 'commit') return;
    setSelectedId(task.id); setMobileDetail(true);
    openFile({id: task.id, index, revision: task.revision, kind: 'commit', repository: artifact.repository,
      commit: artifact.commit, title: artifact.description ?? artifact.commit.slice(0, 12)}, opener);
  };
  const renderReference = (reference: TaskReference, index: number): ReactNode => {
    if (reference.type === 'file') {
      const path = current?.referencePaths[index];
      return <><Button variant="ghost" disabled={!path} title={path ? reference.path : t('taskReferenceUnavailable')} onClick={() => path && readFile('reference', index)}>{reference.label}</Button>{!path && <span className="project-meta">{t('taskReferenceUnavailable')}</span>}</>;
    }
    if (reference.type === 'url') return safeUrl(reference.url) ? <a href={safeUrl(reference.url)} target="_blank" rel="noopener noreferrer">{reference.label}</a> : <span>{reference.label} · {reference.url}</span>;
    if (reference.type === 'task') return <Button variant="ghost" onClick={() => selectTask(reference.taskId)}>{reference.label}</Button>;
    return <span className="project-prose"><strong>{reference.label}</strong> · {reference.text}</span>;
  };
  const referencesById = (ids: string[]) => <ul className="project-artifacts">{ids.map(id => {
    const index = task?.references.findIndex(reference => reference.id === id) ?? -1;
    const reference = task?.references[index];
    return <li key={id}>{reference ? renderReference(reference, index) : <span>{id} · {t('taskReferenceUnavailable')}</span>}</li>;
  })}</ul>;
  const error = detailError ?? state.error;
  // Polling keeps the current list usable. Initial/query loading belongs in
  // the list, so transient status text never changes the filter row's width.
  const listLoading = state.loading && !state.data;

  return <div className={`project-tasks${mobileDetail ? ' showing-detail' : ''}`}>
    {error === 'task-revision-conflict' || error === 'task-cursor-conflict' ? <p role="alert" className="project-error">{t('taskRevisionConflict')}
      {(state.error === 'task-cursor-conflict' || state.error === 'task-revision-conflict') && <Button variant="outline" size="sm" onClick={() => {resetQuery(); void controller.refresh('tasks');}}>{t('taskRefresh')}</Button>}
    </p> : <CapabilityError error={error} t={t} />}
    <div className="project-capability-toolbar project-task-toolbar">
      <Input icon={<IconSearchOutline16 />} value={query} onChange={event => {setQuery(event.target.value); resetQuery();}} placeholder={t('searchTasks')} aria-label={t('searchTasks')} />
      <ProjectSelect label={t('allStatuses')} value={filter} onChange={value => {setFilter(value); resetQuery();}}
        options={[{value: 'all', label: t('allStatuses')}, ...Object.entries(statusKeys).map(([value, key]) => ({value: value as ProjectTaskStatus, label: t(key)}))]} />
      <div className="project-toolbar-toggle"><span>{t('showArchived')}</span><ProjectSwitch checked={showArchived} onChange={value => {setShowArchived(value); resetQuery();}} label={t('showArchived')} /></div>
    </div>
    <Diagnostics items={state.data?.diagnostics ?? []} t={t} />
    <nav className="project-task-navigation" aria-label={t('taskNavigation')}>
      {mobileDetail ? <Button variant="outline" size="sm" onClick={() => setMobileDetail(false)}>{t('taskBackToList')}</Button>
        : <Button variant="outline" size="sm" disabled={!selected} onClick={() => setMobileDetail(true)}>{t('taskBackToDetail')}</Button>}
      <span title={task?.title}>{task?.title ?? visible.find(item => item.id === selected)?.title}</span>
    </nav>
    {state.data && state.data.total === 0 && !selectedId && !query.trim() && filter === 'all' && !showArchived ? <section className="project-card project-empty-state">
      <h2>{t('emptyTasks')}</h2><p>{t('emptyTasksBody')}</p><Button variant="primary" onClick={startSession}>{t('newSession')}</Button>
    </section> : <div className="project-capability-layout">
      <div className="project-task-roster"><div ref={listElement} className="project-capability-list" aria-label={t('tasks')}
        aria-busy={listLoading}
        onScroll={event => {if (!mobileDetail || event.currentTarget.clientHeight) controller.taskView.scroll.list = event.currentTarget.scrollTop;}}>
        {listLoading && <p role="status">{t('capabilityLoading')}</p>}
        {visible.length === 0 && !listLoading && <p>{t('noMatchingTasks')}</p>}
        {visible.map(item => <Button variant="outline" key={item.id} className="project-task-choice" aria-pressed={item.id === selected} onClick={() => selectTask(item.id)}>
          <strong>{item.title}</strong><span><Tag tone={item.status === 'completed' ? 'success' : item.status === 'blocked' ? 'warning' : 'neutral'}>{t(statusKeys[item.status])}</Tag>{item.phase && <Tag>{t(phaseKeys[item.phase])}</Tag>}{item.archived && <Tag>{t('archivedTask')}</Tag>}</span>
          {(item.summary || item.objective) && <span className="project-task-excerpt">{item.summary || item.objective}</span>}
          <small>{date(item.updatedAt)}</small>
        </Button>)}
      </div><nav className="project-task-pagination" aria-label={t('tasks')}>
        {state.data && <span className="project-meta">{t('taskPage', {count: state.data.total})}</span>}
        <div className="project-card-actions"><Button variant="outline" size="sm" disabled={listLoading || pages.length < 2} onClick={() => changePage(pages.slice(0, -1))}>{t('previousTaskPage')}</Button>
          <Button variant="outline" size="sm" disabled={listLoading || !state.data?.nextCursor} onClick={() => changePage([...pages, state.data?.nextCursor])}>{t('nextTaskPage')}</Button></div>
      </nav></div>
      {task && current ? <article ref={detailElement} className="project-card project-task-detail" aria-busy={detailLoading}
        onScroll={event => {if (event.currentTarget.clientHeight) controller.taskView.scroll.details.set(task.id, event.currentTarget.scrollTop);}}>
        <div className="project-card-top"><h2>{task.title}</h2><div className="project-card-actions">
          <Button variant="outline" size="sm" disabled={state.pending || detailLoading} onClick={() => {
            const request = detailRequest.current;
            setPages([undefined]); setSelectedId(task.id);
            controller.setTaskQuery({query: query.trim() || undefined, status: filter === 'all' ? undefined : filter, includeArchived: showArchived, cursor: undefined});
            void controller.mutate('tasks', {action: 'archive', id: task.id, archived: !task.archived, expectedRevision: task.revision, operationId: crypto.randomUUID()})
              .then(saved => {if (saved && mounted.current && detailRequest.current === request) void reloadDetail();});
          }}>{t(task.archived ? 'restoreTask' : 'archiveTask')}</Button>
          <Button variant="outline" size="sm" disabled={detailLoading} onClick={() => {void reloadDetail();}}>{t('taskRefresh')}</Button>
        </div></div>
        <div className="project-task-tags"><Tag tone={task.status === 'completed' ? 'success' : task.status === 'blocked' ? 'warning' : 'neutral'}>{t(statusKeys[task.status])}</Tag>{task.phase && <Tag>{t(phaseKeys[task.phase])}</Tag>}{task.archived && <Tag>{t('archivedTask')}</Tag>}</div>
        <p className="project-meta">{t('updatedAt', {time: date(task.updatedAt)})}</p>
        <div className="project-card-actions"><Button variant="primary" disabled={preparing || detailLoading} onClick={() => {void prepare();}}>{t(preparing ? 'taskPreparing' : 'continueTask')}</Button></div>
        {prepared && <div className="project-task-prepared" role="status"><p>{t(prepared.draftPreserved ? 'taskDraftPreserved' : 'taskPrepared')}</p>
          {prepared.draftPreserved && prepared.suggestedDraft && <><p className="project-prose">{prepared.suggestedDraft}</p><Button variant="outline" onClick={() => {void writeClipboard(prepared.suggestedDraft!).then(() => setCopied(true)).catch(reportError);}}>{t(copied ? 'taskDraftCopied' : 'taskCopyDraft')}</Button></>}
        </div>}
        <Diagnostics items={current.diagnostics} t={t} />
        <TaskSection title={t('taskObjective')}><p className="project-prose">{task.objective}</p></TaskSection>
        {task.brief?.currentBehavior && <TaskSection title={t('taskCurrentBehavior')}><p className="project-prose">{task.brief.currentBehavior}</p></TaskSection>}
        {task.brief?.scope && <TaskSection title={t('taskScope')}><p className="project-prose">{task.brief.scope}</p></TaskSection>}
        {!!task.brief?.constraints?.length && <TaskSection title={t('taskConstraints')}><TextList items={task.brief.constraints} /></TaskSection>}
        {!!task.brief?.outOfScope?.length && <TaskSection title={t('taskOutOfScope')}><TextList items={task.brief.outOfScope} /></TaskSection>}
        {task.summary && <TaskSection title={t('taskSummary')}><p className="project-prose">{task.summary}</p></TaskSection>}
        {task.blockedReason && <TaskSection title={t('blockedReason')}><p className="project-prose">{task.blockedReason}</p></TaskSection>}
        {!!task.questions?.length && <TaskSection title={t('taskQuestions')}><TextList items={task.questions} /></TaskSection>}
        {(task.handoff?.nextSteps?.length || task.handoff?.readBefore?.length || task.handoff?.verifyBefore?.length) ? <TaskSection title={t('taskHandoff')}>
          {!!task.handoff.nextSteps?.length && <><h4>{t('taskNextSteps')}</h4><TextList items={task.handoff.nextSteps} /></>}
          {!!task.handoff.readBefore?.length && <><h4>{t('taskReadBefore')}</h4>{referencesById(task.handoff.readBefore)}</>}
          {!!task.handoff.verifyBefore?.length && <><h4>{t('taskVerifyBefore')}</h4><TextList items={task.handoff.verifyBefore} /></>}
        </TaskSection> : null}
        <TaskSection title={t('taskCriteria')}>
          {!task.brief?.acceptanceCriteria?.length && <p className="project-meta">{t('taskNoCriteria')}</p>}
          <ul className="project-task-criteria">{task.brief?.acceptanceCriteria?.map(criterion => <li key={criterion.id}>
            <p className="project-prose">{criterion.text}</p><div className="project-task-tags"><Tag>{t(criterion.required ? 'taskRequired' : 'taskOptional')}</Tag><span className="project-meta">{t('taskCriterionVersion', {version: criterion.version})}</span></div>
            {current.verification[criterion.id] ? <Verification entry={current.verification[criterion.id]!} t={t} /> : <p className="project-meta">{t('taskNoVerification')}</p>}
          </li>)}</ul>
        </TaskSection>
        {!!task.entries.length && <TaskSection title={t('taskHistory')}>
          <ol className="project-task-history">{task.entries.map(entry => {
            const sourceId = current.sourceSessionIds[entry.id];
            return <li key={entry.id} id={`project-task-entry-${entry.id}`}>
              <div className="project-task-tags"><Tag>{t(entryKeys[entry.kind])}</Tag>{entry.basis && <Tag tone="quiet">{t(basisKeys[entry.basis])}</Tag>}<time className="project-meta" dateTime={entry.createdAt}>{date(entry.createdAt)}</time></div>
              <p className="project-prose">{entry.content}</p>
              {entry.reason && <p className="project-prose"><strong>{t('taskChangeReason')}: </strong>{entry.reason}</p>}
              {entry.supersedes && <p className="project-meta">{t('taskSupersedes', {id: entry.supersedes})}</p>}
              {entry.verification && <Verification entry={entry} t={t} />}
              {!!entry.verificationEntryIds?.length && <p className="project-meta">{t('taskCompletionEvidence', {ids: entry.verificationEntryIds.join(', ')})}</p>}
              {!!entry.referenceIds?.length && referencesById(entry.referenceIds)}
              {sourceId && canOpenSession(sourceId) ? <Button variant="ghost" size="sm" onClick={() => openSession(sourceId)}>{t('viewSession')} · {current.participants.find(item => item.sessionId === sourceId)?.title ?? sessionTitle(sourceId)}</Button> : null}
            </li>;
          })}</ol>
          {current.entriesNextCursor && <Button variant="outline" disabled={historyLoading || detailLoading} onClick={() => {void loadEarlier();}}>{t(historyLoading ? 'capabilityLoading' : 'taskLoadEarlier')}</Button>}
        </TaskSection>}
        {!!task.artifacts.length && <TaskSection title={t('taskArtifacts')}>
          <ul className="project-artifacts">{task.artifacts.map((artifact, index) => <li key={index}>
            {artifact.type === 'file' ? <><Button variant="ghost" disabled={!current.artifactPaths[index]} title={!current.artifactPaths[index] ? t('artifactUnavailable') : artifact.path} onClick={() => readFile('artifact', index)}>{artifact.description ?? artifact.path}</Button>{!current.artifactPaths[index] && <span className="project-meta">{t('artifactUnavailable')}</span>}</>
              : artifact.type === 'url' && safeUrl(artifact.url) ? <a href={safeUrl(artifact.url)} target="_blank" rel="noopener noreferrer">{artifact.description ?? artifact.url}</a>
                : artifact.type === 'commit' ? <Button variant="ghost" aria-label={t('taskCommitOpen', {commit: artifact.commit.slice(0, 12)})}
                  onClick={event => readCommit(index, event.currentTarget)}>{artifact.description && `${artifact.description} · `}{artifact.commit.slice(0, 12)}</Button> : <span>{artifact.type === 'url' ? artifact.url : artifact.description}</span>}
          </li>)}</ul>
        </TaskSection>}
        {!!task.references.length && <TaskSection title={t('taskReferences')}><ul className="project-artifacts">{task.references.map((reference, index) => <li key={reference.id}>{renderReference(reference, index)}</li>)}</ul></TaskSection>}
        {!!current.participants.some(item => item.availability === 'available') && <TaskSection title={t('linkedSessions')}>
          <ul className="project-task-participants">{current.participants.map((participant, index) => <li key={participant.sessionId ?? index}>
            {participant.availability === 'available' && participant.sessionId && canOpenSession(participant.sessionId)
              ? <Button variant="outline" onClick={() => openSession(participant.sessionId!)}>{t('viewSession')} · {participant.title ?? sessionTitle(participant.sessionId)}</Button>
              : <span className="project-meta">{t(participant.availability === 'archived' ? 'taskSessionArchived' : 'taskSessionUnavailable')}</span>}

          </li>)}</ul>
        </TaskSection>}
      </article> : <div className="project-card project-task-detail"><p role={detailLoading ? 'status' : undefined}>{t(detailLoading ? 'capabilityLoading' : 'selectTask')}</p>{selected && detailError && <Button variant="outline" onClick={() => {void reloadDetail();}}>{t('taskRefresh')}</Button>}</div>}
    </div>}
  </div>;
}
