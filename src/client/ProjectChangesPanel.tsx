import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Button, IconBranchOutline16, IconDownloadOutline16, IconRefreshOutline16, IconRightUpOutline16, Tag, Tooltip} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ResourceBranches} from '../resource-contract.ts';
import type {ProjectChangeEntry, ProjectChangeKind, ProjectChangesSnapshot} from '../project-changes.ts';
import type {ProjectLocaleKey} from '../locales.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import {ProjectCheckbox, ProjectScrollableModal, ProjectSelect, ProjectSettingRow} from './ProjectControls.tsx';
import {canUpdateResource, resourceErrorText, resourceSyncDescription, resourceSyncLabel} from './resource-ui.ts';
import type {ProjectChangesController, RepositorySyncAction} from './project-changes-controller.ts';
import type {MergeConflictRequest, MergeConflictResult} from './merge-conflict.ts';

const kindOrder: readonly ProjectChangeKind[] = ['task', 'skill', 'memory', 'mcp', 'file'];
const kindKeys = {task: 'changeKindTask', skill: 'changeKindSkill', memory: 'changeKindMemory', mcp: 'changeKindMcp', file: 'changeKindFile'} as const;
const commitNames = {task: 'Task', skill: 'Skill', memory: 'Memory', mcp: 'Mcp', file: 'File'} as const;
const statusKeys = {added: 'changeStatusAdded', untracked: 'changeStatusAdded', modified: 'changeStatusModified',
  renamed: 'changeStatusModified', conflicted: 'changeStatusModified', deleted: 'changeStatusDeleted'} as const;
type Translate = (key: ProjectLocaleKey, params?: Record<string, string | number>) => string;

/** The default commit message is derived from the selection, never typed by hand. */
function suggestMessage(entries: readonly ProjectChangeEntry[], t: Translate): string {
  if (entries.length === 0) return '';
  const kinds = kindOrder.filter(kind => entries.some(entry => entry.kind === kind));
  if (kinds.length === 1) {
    const kind = kinds[0]!;
    const base = `changeCommit${commitNames[kind]}`;
    if (entries.length > 1) return t(`${base}Many` as ProjectLocaleKey, {count: entries.length});
    const entry = entries[0]!;
    const status = entry.status === 'added' || entry.status === 'untracked' ? 'Added'
      : entry.status === 'deleted' ? 'Deleted' : 'Changed';
    return t(`${base}${status}` as ProjectLocaleKey, {name: entry.name});
  }
  return t('changeCommitMixed', {kinds: kinds.map(kind => t(kindKeys[kind])).join(t('changeKindSeparator'))});
}

/**
 * The project repository reports the same state a Git resource does, so the badge reuses the
 * resource wording instead of keeping a second, easily incomplete set of cases.
 */
function syncSummary(data: ProjectChangesSnapshot, t: CapabilityTranslate): {label: string; tone: 'neutral' | 'success' | 'warning'} {
  const sync = data.sync;
  const label = resourceSyncLabel(sync, t);
  if (!sync || sync.phase || sync.status === 'unlinked' || sync.status === 'unborn' || sync.status === 'unchecked') {
    return {label, tone: 'neutral'};
  }
  // Only a clean, up-to-date branch is good news; everything else asks the user to do something.
  const settled = sync.status === 'current' && !sync.dirty && !sync.inProgress && !sync.error;
  return {label, tone: settled ? 'success' : 'warning'};
}

function ChangeCard({entry, checked, disabled, onToggle, t}: {entry: ProjectChangeEntry; checked: boolean; disabled: boolean;
  onToggle(value: boolean): void; t: Translate}) {
  return <article className="project-mcp-card project-change-card" data-kind={entry.kind} data-selected={checked}>
    <div className="project-mcp-card-body">
      <div className="project-change-heading">
        <span className="project-change-name">{entry.name}</span>
        <Tag tone={entry.status === 'deleted' ? 'warning' : entry.status === 'added' ? 'success' : 'neutral'}>{t(statusKeys[entry.status])}</Tag>
      </div>
      {entry.description !== undefined && <code className="project-change-path">{entry.description}</code>}
      {(entry.artifacts !== undefined || entry.paths.length > 1) && <span className="project-setting-description">
        {[entry.artifacts === undefined ? undefined : t('changeArtifacts', {count: entry.artifacts}),
          entry.paths.length > 1 ? t('changeFileCount', {count: entry.paths.length}) : undefined].filter(Boolean).join(' · ')}
      </span>}
    </div>
    <div className="project-mcp-card-footer project-change-footer">
      <ProjectCheckbox checked={checked} disabled={disabled} label={entry.name} onChange={onToggle} />
      <span>{t(checked ? 'changeSelectedForCommit' : 'changeNotSelectedForCommit')}</span>
    </div>
  </article>;
}

function RepositoryDetails({open, root, data, branches, controller, busy, action, onUpdate, onClose, t}: {open: boolean; root: string;
  data: ProjectChangesSnapshot; branches?: ResourceBranches; controller: ProjectChangesController; busy: boolean;
  action?: 'commit' | RepositorySyncAction; onUpdate(): void; onClose(): void; t: CapabilityTranslate}) {
  const summary = syncSummary(data, t);
  // The project repository obeys the same rules as a Git resource, so the fast-forward button uses the
  // resource availability rule and the details explain what still blocks it.
  const updatable = canUpdateResource(data.sync);
  const behind = (data.sync?.behind ?? 0) > 0;
  return <ProjectScrollableModal open={open} title={t('changeRepositoryDetails')} closeLabel={t('close')} onClose={onClose}
    footer={<>
      <Button variant="outline" disabled={busy}
        icon={action === 'check' ? <span className="project-spinner" /> : <IconRefreshOutline16 />}
        onClick={() => void controller.sync('check', data.revision)}>{action === 'check' ? t('resourceSyncChecking') : t('resourceSyncCheck')}</Button>
      {(behind || action === 'update') && <Button variant="outline" disabled={busy || !updatable}
        icon={action === 'update' ? <span className="project-spinner" /> : <IconDownloadOutline16 />}
        onClick={onUpdate}>{action === 'update' ? t('resourceSyncUpdating') : t('resourceSyncUpdate')}</Button>}
      {(data.sync?.ahead ?? 0) > 0 && <Button variant="outline" disabled={busy}
        icon={action === 'push' ? <span className="project-spinner" /> : <IconRightUpOutline16 />}
        onClick={() => void controller.sync('push', data.revision)}>{action === 'push' ? t('resourceSyncPushing') : t('resourceSyncPush')}</Button>}
      <Button variant="primary" autoFocus onClick={onClose}>{t('close')}</Button>
    </>}>
    <div className="project-capability-form project-resource-details">
      <ProjectSettingRow title={t('resourceDirectory')} layout="stacked"><code>{root}</code></ProjectSettingRow>
      {data.url !== undefined && <ProjectSettingRow title={t('resourceUrl')} layout="stacked"><code>{data.url}</code></ProjectSettingRow>}
      <ProjectSettingRow title={t('resourceCurrentBranch')} description={t('resourceSwitchBody')}>
        {branches && branches.local.length > 0
          ? <ProjectSelect label={t('resourceCurrentBranch')} value={branches.current ?? ''}
              options={[...(branches.current ? [] : [{value: '', label: t('resourceSyncDetached')}]),
                ...branches.local.map(name => ({value: name, label: name}))]}
              onChange={value => {if (value && value !== branches.current) void controller.sync('switch', data.revision, value);}} />
          : <span>{data.branch ?? t('resourceSyncDetached')}</span>}
      </ProjectSettingRow>
      <ProjectSettingRow title={t('resourceSyncStatus')} description={resourceSyncDescription(data.sync, t)} layout="stacked"><span role="status">{summary.label}</span></ProjectSettingRow>
      <ProjectSettingRow title={t('changeCommitHint')} layout="stacked"><span className="project-setting-description">{t('changeCommitHintBody')}</span></ProjectSettingRow>
    </div>
  </ProjectScrollableModal>;
}

/**
 * The project root holds project assets, so the overview reviews assets: every changed task, Skill,
 * memory document and MCP declaration becomes a card the user decides to commit or leave alone.
 */
export function ProjectChangesPanel({controller, root, t, handoffConflict}: {controller: ProjectChangesController; root: string;
  t: CapabilityTranslate; handoffConflict?(request: MergeConflictRequest, signal?: AbortSignal): Promise<MergeConflictResult>}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {void controller.refresh();}, [controller]);
  const data = state.data;
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState(false);
  const [branches, setBranches] = useState<ResourceBranches>();
  const translate = t as unknown as Translate;
  // A new snapshot must not throw away the user's choices: keep the selection of assets that still
  // exist, and default-select only the assets that appeared since the previous snapshot. Without
  // this, any worktree change (a Skill index rewrite, a file the Agent writes) clears the ticks.
  const knownAssets = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = new Set(entries.map(entry => entry.id));
    const appeared = entries.filter(entry => !knownAssets.current.has(entry.id) && entry.kind !== 'file');
    knownAssets.current = ids;
    setSelection(current => {
      const next = new Set([...current].filter(id => ids.has(id)));
      for (const entry of appeared) next.add(entry.id);
      return next;
    });
  }, [entries]);
  useEffect(() => {if (details) void controller.branches().then(setBranches);}, [details, controller]);
  // Match the resource cards: check the remote once when the overview opens, then only on demand.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || data === undefined || !data.available || data.sync?.status !== 'unchecked') return;
    autoChecked.current = true;
    // Silent: the automatic check must not lock the toolbar or surface a page error.
    void controller.sync('check', data.revision, undefined, true);
  }, [data, controller]);
  const selected = entries.filter(entry => selection.has(entry.id));
  // One commit per asset, each carrying the message its own type derives.
  const items = selected.map(entry => ({id: entry.id, kind: entry.kind, paths: entry.paths, message: suggestMessage([entry], translate)}));
  // The exact history a commit would write, shown on demand from the submit button.
  const plan = items.map(item => item.message).join('\n');
  const toggle = (id: string, value: boolean) => setSelection(current => {
    const next = new Set(current);
    if (value) next.add(id); else next.delete(id);
    return next;
  });
  // The section heading owns the repository identity; the state itself opens the details dialog.
  const summary = data === undefined ? undefined : syncSummary(data, t);
  const heading = <div className="project-card-top">
    <div className="project-change-title">
      <h2>{t('projectChanges')}</h2>
      {data?.available === true && summary !== undefined && <Tooltip label={summary.label} side="bottom" maxWidth={480}>
        <button type="button" className="project-change-repository"
          aria-haspopup="dialog" aria-label={t('changeRepositoryDetails')} onClick={() => setDetails(true)}>
          {data.branch !== undefined && <span className="project-resource-branch"><IconBranchOutline16 /><span>{data.branch}</span></span>}
          <Tag tone={summary.tone}>{summary.label}</Tag>
        </button>
      </Tooltip>}
    </div>
    <Button variant="outline" size="sm" icon={<IconRefreshOutline16 />}
      onClick={() => {controller.clearError(); void controller.refresh();}}>{t('refresh')}</Button>
  </div>;
  if (!data) return <>{heading}{state.error
    ? <p role="alert" className="project-error">{resourceErrorText(state.error, t)}</p>
    : <p role="status">{t('loading')}</p>}</>;
  if (!data.available) return <>{heading}<p className="project-setting-description">{t('projectRepositoryUnavailable')}</p></>;
  /**
   * An update that had to merge reports what happened. A conflict changed nothing in the repository,
   * so the panel opens a prepared conversation with the conflicting paths instead of a page error.
   */
  const applyUpdate = async () => {
    const result = await controller.sync('update', data.revision);
    const merge = result?.merge;
    if (merge?.status !== 'conflict') return;
    await handoffConflict?.({files: merge.files, ...(data.branch === undefined ? {} : {branch: data.branch}),
      ...(data.sync?.upstream === undefined ? {} : {upstream: data.sync.upstream}),
      ...(data.sync?.ahead === undefined ? {} : {ahead: data.sync.ahead}),
      ...(data.sync?.behind === undefined ? {} : {behind: data.sync.behind})});
  };
  return <>
    {heading}
    {/* A failed repository action must say so: the sync state alone is easy to miss. */}
    {state.error && <p role="alert" className="project-error">{resourceErrorText(state.error, t)}</p>}
    {entries.length === 0
      ? <p className="project-setting-description">{t('changeEmpty')}</p>
      : <>
          <div className="project-change-toolbar">
            <Button variant="outline" size="sm" disabled={state.pending}
              onClick={() => setSelection(new Set(entries.map(entry => entry.id)))}>{t('changeSelectAll')}</Button>
            <Button variant="outline" size="sm" disabled={state.pending}
              onClick={() => setSelection(new Set())}>{t('changeSelectNone')}</Button>
            {/* The button already carries the count; the tooltip carries the history it would write. */}
            {/* The official Tooltip attaches to a DOM child, so the button sits in an anchor span. */}
            <Tooltip label={plan === '' ? t('changeEmpty') : plan} side="right" maxWidth={480}>
              <span className="project-mcp-action-anchor">
                <Button variant="primary" size="sm" disabled={state.pending || items.length === 0} aria-description={plan}
                  icon={state.action === 'commit' ? <span className="project-spinner" /> : undefined}
                  onClick={() => void controller.commit(items)}>
                  {state.action === 'commit' ? t('resourceSyncCommitting') : t('changeCommitSubmit', {count: items.length})}
                </Button>
              </span>
            </Tooltip>
          </div>
          {state.commitError && <p role="alert" className="project-error">{resourceErrorText(state.commitError, t)}</p>}
          {kindOrder.map(kind => {
            const group = entries.filter(entry => entry.kind === kind);
            if (group.length === 0) return null;
            return <section className="project-change-group" key={kind}>
              <div className="project-change-group-head"><h3>{t(kindKeys[kind])}</h3><span>{group.length}</span></div>
              <div className="project-mcp-grid">
                {group.map(entry => <ChangeCard key={entry.id} entry={entry} t={translate} disabled={state.pending}
                  checked={selection.has(entry.id)} onToggle={value => toggle(entry.id, value)} />)}
              </div>
            </section>;
          })}
        </>}
    <RepositoryDetails open={details} root={root} data={data} branches={branches} controller={controller} busy={state.pending}
      action={state.action} onUpdate={() => void applyUpdate()} onClose={() => setDetails(false)} t={t} />
  </>;
}
