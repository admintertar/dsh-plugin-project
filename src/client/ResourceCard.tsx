import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {Button, IconBranchOutline16, IconCheckOutline16, IconDownloadOutline16, IconFolderOpenOutline16, IconLinkOutline16, IconRefreshOutline16, IconRightUpOutline16, Modal, Tag, Tooltip} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ManagedResource, ResourceBranches, ResourceChangeStatus, ResourceChanges} from '../resource-contract.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import {ProjectScrollableModal, ProjectSelect, ProjectSettingRow} from './ProjectControls.tsx';
import {canCheckResource, canCommitResource, canPushResource, canSwitchResource, canUpdateResource, resourceErrorText, resourceSyncDescription, resourceSyncLabel} from './resource-ui.ts';

function resourceStatusLabel(item: ManagedResource) {
  return item.status === 'ready' ? 'resourceReady' : item.status === 'unbound' ? 'resourceUnbound' : item.status === 'missing' ? 'missing' : 'resourceUnavailable';
}
/** Display the resolved binding, never a possibly stale path from the shared declaration. */
function directoryLabel(item: ManagedResource, root: string, t: CapabilityTranslate): string {
  if (!item.path) return t('resourceUnbound');
  const path = item.path.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const compare = (value: string) => /^[A-Za-z]:\//.test(base) || base.startsWith('//') ? value.toLowerCase() : value;
  if (!item.external && compare(path) === compare(base)) return t('resourceProjectRoot');
  if (!item.external && compare(path).startsWith(`${compare(base)}/`)) return path.slice(base.length + 1);
  return item.external ? `${t('resourceOutside')} · ${path.split('/').at(-1) || item.path}` : item.path;
}
function repositoryLabel(url: string): string {
  let path: string;
  try {path = new URL(url).pathname;}
  catch {path = url.replace(/^[^@]+@[^:]+:/, '');}
  return path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}
/** Git's own porcelain letters; the localized name travels in the tooltip and accessible label. */
const changeLetters: Record<ResourceChangeStatus, string> = {modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflicted: 'U'};
const changeLabels = {modified: 'resourceChangeModified', added: 'resourceChangeAdded', deleted: 'resourceChangeDeleted',
  renamed: 'resourceChangeRenamed', untracked: 'resourceChangeUntracked', conflicted: 'resourceChangeConflicted'} as const;
function ResourceMetadata({icon, text, tooltip}: {icon: ReactNode; text: string; tooltip: string}) {
  const split = text.lastIndexOf('/') + 1;
  return <Tooltip label={tooltip} side="top" maxWidth={480}><div className="project-resource-metadata">
    {icon}<span className="project-resource-location">
      {split > 0 && <span className="project-resource-location-parent">{text.slice(0, split)}</span>}
      <span className="project-resource-location-name">{text.slice(split)}</span>
    </span>
  </div></Tooltip>;
}

/** Shared Agent Preset card adaptation; management actions belong to the resource page. */
export function ResourceCard({item, root, t, children, syncActions, syncError}: {item: ManagedResource; root: string; t: CapabilityTranslate; children?: ReactNode; syncError?: string;
  syncActions?: {disabled: boolean; check(): void; update(): void; push(): void; commit(message: string): Promise<boolean>; switchBranch(branch: string): void;
    loadBranches(): Promise<ResourceBranches | undefined>; loadChanges(): Promise<ResourceChanges | undefined>}}) {
  const [viewing, setViewing] = useState(false);
  const [branches, setBranches] = useState<ResourceBranches>();
  const [committing, setCommitting] = useState(false);
  const [changes, setChanges] = useState<ResourceChanges>();
  const [commitMessage, setCommitMessage] = useState('');
  const [commitError, setCommitError] = useState<string>();
  const [commitBusy, setCommitBusy] = useState(false);
  const commitFieldId = useId();
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = () => {setViewing(false); opener.current?.focus();};
  // Branch names are only needed while the details dialog is open, so read them on open.
  const showDetails = (target: HTMLButtonElement) => {
    opener.current = target; setViewing(true);
    void syncActions?.loadBranches().then(setBranches);
  };
  // A switch runs in the Host, so follow the branch the resource reports back. Without this the
  // picker keeps naming the branch the dialog was opened with while HEAD has already moved.
  const followedBranch = useRef<string>();
  useEffect(() => {
    const reported = item.git?.branch;
    if (!viewing || !branches || !reported || branches.current === reported || followedBranch.current === reported) return;
    followedBranch.current = reported;
    void syncActions?.loadBranches().then(setBranches);
  }, [viewing, branches, item.git?.branch]);
  const openCommit = (target?: HTMLButtonElement) => {
    if (target) opener.current = target;
    setCommitMessage(''); setCommitError(undefined); setCommitting(true); setChanges(undefined);
    // The commit takes the whole working tree, so show what it would include.
    void syncActions?.loadChanges().then(setChanges);
  };
  const closeCommit = () => {
    setCommitting(false);
    const target = opener.current;
    // A successful commit removes the card's commit action; only restore focus when it survives.
    if (target?.isConnected) target.focus();
  };
  // Commit needs a message, so it asks for one instead of leaving a button disabled with no reason.
  const submitCommit = async () => {
    const text = commitMessage.trim();
    if (!text) {setCommitError(t('resourceCommitMessageRequired')); return;}
    if (!syncActions) return;
    setCommitBusy(true); setCommitError(undefined);
    try {if (await syncActions.commit(text)) {closeCommit(); setCommitMessage('');}}
    finally {setCommitBusy(false);}
  };
  const gitReady = item.type === 'git' && item.status === 'ready';
  const sync = syncError ? {...item.git?.sync, status: 'error' as const, error: syncError}
    : item.git?.sync ?? (gitReady && !item.url ? {status: 'unlinked' as const} : undefined);
  const label = gitReady ? resourceSyncLabel(sync, t) : t(resourceStatusLabel(item));
  const syncDescription = resourceSyncDescription(sync, t);
  const tone = gitReady ? sync?.status === 'unlinked' || sync?.status === 'unborn' ? 'neutral' : sync?.status === 'current' && !sync.dirty && !sync.error && !sync.inProgress ? 'success' : 'warning'
    : item.status === 'ready' ? 'success' : 'warning';
  return <>
    <article className="project-mcp-card project-resource-card" aria-label={item.name}>
      <div className="project-mcp-card-body">
        <Tooltip label={item.name} side="top"><strong className="project-mcp-name">{item.name}</strong></Tooltip>
        <div className="project-summary"><Tag>{item.type === 'git' ? 'Git' : t('resourceLocal')}</Tag>
          <Tooltip label={gitReady ? `${label} · ${syncDescription}` : label} side="top"><span className="project-resource-sync-label"><Tag tone={tone}>{label}</Tag></span></Tooltip>
          {item.git?.branch && <Tooltip label={`${t('resourceCurrentBranch')}: ${item.git.branch}`} side="top">
            <span className="project-resource-branch"><IconBranchOutline16 /><span>{item.git.branch}</span></span>
          </Tooltip>}
        </div>
        <ResourceMetadata icon={<IconFolderOpenOutline16 />} text={directoryLabel(item, root, t)}
          tooltip={`${t('resourceDirectory')}: ${item.path ?? t('resourceUnbound')}${item.external ? ` · ${t('resourceExternal')}` : ''}`} />
        {item.url && <ResourceMetadata icon={<IconLinkOutline16 />} text={repositoryLabel(item.url)} tooltip={`${t('resourceUrl')}: ${item.url}`} />}
      </div>
      <div className="project-mcp-card-footer">
        <Button className="project-resource-details-action" size="sm" aria-haspopup="dialog" aria-label={`${t('resourceDetails')}: ${item.name}`}
          onClick={event => showDetails(event.currentTarget)}>{t('resourceViewDetails')}</Button>
        {syncActions && <>
          {canCheckResource(item) && <Tooltip label={t('resourceSyncCheck')} side="top"><span className="project-mcp-action-anchor"><Button className="project-mcp-action" size="sm"
            icon={<IconRefreshOutline16 />} aria-label={`${t('resourceSyncCheck')}: ${item.name}`} disabled={syncActions.disabled} onClick={syncActions.check} /></span></Tooltip>}
          <Tooltip label={canUpdateResource(sync) ? t('resourceSyncUpdate') : syncDescription} side="top"><span className="project-mcp-action-anchor"><Button className="project-mcp-action" size="sm"
            icon={<IconDownloadOutline16 />} aria-label={`${t('resourceSyncUpdate')}: ${item.name}`} disabled={syncActions.disabled || !canUpdateResource(sync)} onClick={syncActions.update} /></span></Tooltip>
          {canCommitResource(sync) && <Tooltip label={t('resourceSyncCommit')} side="top"><span className="project-mcp-action-anchor"><Button className="project-mcp-action" size="sm"
            icon={<IconCheckOutline16 />} aria-label={`${t('resourceSyncCommit')}: ${item.name}`} disabled={syncActions.disabled} onClick={event => openCommit(event.currentTarget)} /></span></Tooltip>}
          {canPushResource(sync) && <Tooltip label={t('resourceSyncPush')} side="top"><span className="project-mcp-action-anchor"><Button className="project-mcp-action" size="sm"
            icon={<IconRightUpOutline16 />} aria-label={`${t('resourceSyncPush')}: ${item.name}`} disabled={syncActions.disabled} onClick={syncActions.push} /></span></Tooltip>}
        </>}
        {children}
      </div>
    </article>
    <ProjectScrollableModal open={viewing} title={t('resourceDetails')} closeLabel={t('close')} onClose={close}
      footer={<>{syncActions && <>{canCheckResource(item) && <Button variant="outline" disabled={syncActions.disabled} onClick={syncActions.check}>{t('resourceSyncCheck')}</Button>}
        <Button variant="outline" disabled={syncActions.disabled || !canUpdateResource(sync)} onClick={syncActions.update}>{t('resourceSyncUpdate')}</Button>
        <Button variant="outline" disabled={syncActions.disabled || !canCommitResource(sync)} onClick={() => openCommit()}>{t('resourceSyncCommit')}</Button>
        {canPushResource(sync) && <Button variant="outline" disabled={syncActions.disabled} onClick={syncActions.push}>{t('resourceSyncPush')}</Button>}</>}
        <Button variant="primary" autoFocus onClick={close}>{t('close')}</Button></>}>
      <div className="project-capability-form project-resource-details">
        <ProjectSettingRow title={t('resourceName')} layout="stacked"><span>{item.name}</span></ProjectSettingRow>
        <ProjectSettingRow title={t('resourceKind')}><Tag>{item.type === 'git' ? 'Git' : t('resourceLocal')}</Tag></ProjectSettingRow>
        <ProjectSettingRow title={t('resourceStatus')}><Tag tone={item.status === 'ready' ? 'success' : 'warning'}>{t(resourceStatusLabel(item))}</Tag></ProjectSettingRow>
        <ProjectSettingRow title={t('resourceDirectory')} description={item.external ? t('resourceExternal') : undefined} layout="stacked">
          <code>{item.path ?? t('resourceUnbound')}</code>
        </ProjectSettingRow>
        {item.url && <ProjectSettingRow title={t('resourceUrl')} layout="stacked"><code>{item.url}</code></ProjectSettingRow>}
        {gitReady && branches && branches.local.length > 0
          ? <ProjectSettingRow title={t('resourceCurrentBranch')} description={t('resourceSwitchBody')}>
              <ProjectSelect label={t('resourceCurrentBranch')} value={branches.current ?? ''}
                disabled={syncActions?.disabled === true || !canSwitchResource(sync)}
                options={[...(branches.current ? [] : [{value: '', label: t('resourceSyncDetached')}]),
                  ...branches.local.map(name => ({value: name, label: name}))]}
                onChange={value => {if (value && value !== branches.current) syncActions?.switchBranch(value);}} />
            </ProjectSettingRow>
          : item.git?.branch && <ProjectSettingRow title={t('resourceCurrentBranch')} layout="stacked"><code>{item.git.branch}</code></ProjectSettingRow>}
        {gitReady && <>
          <ProjectSettingRow title={t('resourceSyncStatus')} description={syncDescription} layout="stacked"><span role="status">{label}</span></ProjectSettingRow>
          {sync?.upstream && <ProjectSettingRow title={t('resourceSyncUpstream')} layout="stacked"><code>{sync.upstream}</code></ProjectSettingRow>}
          {sync?.checkedAt && <ProjectSettingRow title={t('resourceSyncChecked')} layout="stacked"><span>{new Date(sync.checkedAt).toLocaleString()}</span></ProjectSettingRow>}
          {sync?.ahead !== undefined && <ProjectSettingRow title={t('resourceSyncComparison')}><span>{t('resourceSyncCounts', {ahead: sync.ahead, behind: sync.behind ?? 0})}</span></ProjectSettingRow>}
          <ProjectSettingRow title={t('resourceSyncWorkspace')}><span>{sync?.dirty === undefined ? t('resourceSyncUnchecked') : t(sync.dirty ? 'resourceSyncDirty' : 'resourceSyncClean')}</span></ProjectSettingRow>
        </>}
      </div>
    </ProjectScrollableModal>
    <Modal open={committing} className="project-commit-dialog" contentClassName="project-commit-dialog-content"
      title={t('resourceSyncCommit')} closeLabel={t('close')} onClose={() => {if (!commitBusy) closeCommit();}}
      footer={<><Button variant="outline" disabled={commitBusy} onClick={closeCommit}>{t('cancel')}</Button>
        <Button variant="primary" disabled={commitBusy} onClick={() => void submitCommit()}>{t('resourceSyncCommit')}</Button></>}>
      <div className="project-commit-field">
        <div className="project-commit-copy">
          <label className="project-setting-title" htmlFor={commitFieldId}>{t('resourceCommitMessage')}</label>
          <p className="project-setting-description">{t('resourceCommitBody')}</p>
        </div>
        <textarea id={commitFieldId} className="project-textarea" rows={3} maxLength={4096} autoFocus
          aria-label={`${t('resourceCommitMessage')}: ${item.name}`} value={commitMessage} disabled={commitBusy}
          onChange={event => {setCommitMessage(event.target.value); setCommitError(undefined);}} />
      </div>
      {changes && <div className="project-commit-changes">
        <div className="project-commit-changes-head">
          <span className="project-setting-title">{t('resourceCommitChanges')}</span>
          <span className="project-setting-description">{t('resourceCommitFiles', {count: changes.files.length})}</span>
        </div>
        {changes.files.length === 0 ? <p className="project-setting-description">{t('resourceCommitClean')}</p>
          : <ul className="project-commit-list">{changes.files.map(file => <li className="project-commit-file" key={`${file.status}:${file.path}`}>
              <Tooltip label={t(changeLabels[file.status])} side="top"><span className={`project-commit-status project-commit-status-${file.status}`}
                aria-label={t(changeLabels[file.status])}>{changeLetters[file.status]}</span></Tooltip>
              <code>{file.path}</code>
            </li>)}</ul>}
      </div>}
      {commitError && <p className="project-error" role="alert">{commitError}</p>}
      {syncError && <p className="project-error" role="alert">{resourceErrorText(syncError, t)}</p>}
    </Modal>
  </>;
}
