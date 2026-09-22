import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Button, IconBranchOutline16, IconRefreshOutline16, IconRightUpOutline16, Tag, Tooltip} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ResourceBranches} from '../resource-contract.ts';
import type {ProjectChangeEntry, ProjectChangeKind, ProjectChangesSnapshot} from '../project-changes.ts';
import type {ProjectLocaleKey} from '../locales.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import {ProjectCheckbox, ProjectScrollableModal, ProjectSelect, ProjectSettingRow} from './ProjectControls.tsx';
import {resourceErrorText} from './resource-ui.ts';
import type {ProjectChangesController} from './project-changes-controller.ts';

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

function syncSummary(data: ProjectChangesSnapshot, t: CapabilityTranslate): {label: string; tone: 'neutral' | 'success' | 'warning'} {
  const tr = t as unknown as Translate;
  const sync = data.sync;
  if (!sync) return {label: tr('resourceSyncUnchecked'), tone: 'neutral'};
  if (sync.error) return {label: resourceErrorText(sync.error, t), tone: 'warning'};
  if (sync.status === 'error') return {label: tr('resourceSyncError'), tone: 'warning'};
  if (sync.status === 'no-upstream') return {label: tr('resourceSyncNoUpstream'), tone: 'warning'};
  if (sync.status === 'detached') return {label: tr('resourceSyncDetached'), tone: 'warning'};
  if (sync.behind) return {label: tr('resourceSyncBehind', {count: sync.behind}), tone: 'warning'};
  if (sync.ahead) return {label: tr('resourceSyncAhead', {count: sync.ahead}), tone: 'warning'};
  if (sync.status === 'unchecked') return {label: tr('resourceSyncUnchecked'), tone: 'neutral'};
  if (sync.dirty) return {label: tr('resourceSyncDirty'), tone: 'warning'};
  return {label: tr('resourceSyncCurrent'), tone: 'success'};
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
      {entry.shared && <p className="project-setting-description">{t('changeSharedFile')}</p>}
    </div>
    <div className="project-mcp-card-footer project-change-footer">
      <ProjectCheckbox checked={checked} disabled={disabled} label={entry.name} onChange={onToggle} />
      <span>{t(checked ? 'changeSelectedForCommit' : 'changeNotSelectedForCommit')}</span>
    </div>
  </article>;
}

function RepositoryDetails({open, root, data, branches, controller, onClose, t}: {open: boolean; root: string;
  data: ProjectChangesSnapshot; branches?: ResourceBranches; controller: ProjectChangesController; onClose(): void; t: CapabilityTranslate}) {
  const summary = syncSummary(data, t);
  return <ProjectScrollableModal open={open} title={t('changeRepositoryDetails')} closeLabel={t('close')} onClose={onClose}
    footer={<>
      <Button variant="outline" icon={<IconRefreshOutline16 />}
        onClick={() => void controller.sync('check', data.revision)}>{t('resourceSyncCheck')}</Button>
      {(data.sync?.ahead ?? 0) > 0 && <Button variant="outline" icon={<IconRightUpOutline16 />}
        onClick={() => void controller.sync('push', data.revision)}>{t('resourceSyncPush')}</Button>}
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
      <ProjectSettingRow title={t('resourceSyncStatus')} layout="stacked"><span role="status">{summary.label}</span></ProjectSettingRow>
      <ProjectSettingRow title={t('changeCommitHint')} layout="stacked"><span className="project-setting-description">{t('changeCommitHintBody')}</span></ProjectSettingRow>
    </div>
  </ProjectScrollableModal>;
}

/**
 * The project root holds project assets, so the overview reviews assets: every changed task, Skill,
 * memory document and MCP declaration becomes a card the user decides to commit or leave alone.
 */
export function ProjectChangesPanel({controller, root, t}: {controller: ProjectChangesController; root: string; t: CapabilityTranslate}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {void controller.refresh();}, [controller]);
  const data = state.data;
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState(false);
  const [branches, setBranches] = useState<ResourceBranches>();
  const translate = t as unknown as Translate;
  // A new snapshot is a new set of assets: re-select the project assets for the next review.
  useEffect(() => {setSelection(new Set(entries.filter(entry => entry.kind !== 'file').map(entry => entry.id)));}, [entries]);
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
  const items = selected.map(entry => ({paths: entry.paths, message: suggestMessage([entry], translate)}));
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
      {data?.available === true && summary !== undefined && <button type="button" className="project-change-repository"
        aria-haspopup="dialog" aria-label={t('changeRepositoryDetails')} onClick={() => setDetails(true)}>
        {data.branch !== undefined && <span className="project-resource-branch"><IconBranchOutline16 /><span>{data.branch}</span></span>}
        <Tag tone={summary.tone}>{summary.label}</Tag>
      </button>}
    </div>
    <Button variant="outline" size="sm" icon={<IconRefreshOutline16 />}
      onClick={() => {controller.clearError(); void controller.refresh();}}>{t('refresh')}</Button>
  </div>;
  if (!data) return <>{heading}{state.error
    ? <p role="alert" className="project-error">{resourceErrorText(state.error, t)}</p>
    : <p role="status">{t('loading')}</p>}</>;
  if (!data.available) return <>{heading}<p className="project-setting-description">{t('projectRepositoryUnavailable')}</p></>;
  return <>
    {heading}
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
                  onClick={() => void controller.commit(items)}>{t('changeCommitSubmit', {count: items.length})}</Button>
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
          {state.commitError && <p role="alert" className="project-error">{resourceErrorText(state.commitError, t)}</p>}
        </>}
    <RepositoryDetails open={details} root={root} data={data} branches={branches} controller={controller}
      onClose={() => setDetails(false)} t={t} />
  </>;
}
