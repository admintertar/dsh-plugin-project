import {useRef, useState, type ReactNode} from 'react';
import {Button, IconBranchOutline16, IconDownloadOutline16, IconFolderOpenOutline16, IconLinkOutline16, IconRefreshOutline16, Tag, Tooltip} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ManagedResource} from '../resource-contract.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import {ProjectScrollableModal, ProjectSettingRow} from './ProjectControls.tsx';
import {canUpdateResource, resourceErrorText, resourceSyncLabel} from './resource-ui.ts';

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
  syncActions?: {disabled: boolean; check(): void; update(): void}}) {
  const [viewing, setViewing] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = () => {setViewing(false); opener.current?.focus();};
  const gitReady = item.type === 'git' && item.status === 'ready';
  const sync = syncError ? {...item.git?.sync, status: 'error' as const, error: syncError}
    : item.git?.sync ?? (gitReady && !item.url ? {status: 'unlinked' as const} : undefined);
  const label = gitReady ? resourceSyncLabel(sync, t) : t(resourceStatusLabel(item));
  const syncDescription = sync?.error ? resourceErrorText(sync.error, t) : sync?.status === 'unlinked' ? t('resourceSyncUnlinkedBody')
    : sync?.status === 'unborn' ? t('resourceSyncUnbornBody')
    : sync?.status === 'no-upstream' ? t('resourceSyncNoUpstreamBody') : sync?.inProgress ? t('resourceSyncInProgressBody')
    : sync?.status === 'diverged' ? t('resourceSyncDivergedBody') : sync?.dirty ? t('resourceSyncDirtyBody')
    : sync?.status === 'detached' ? t('resourceSyncDetachedBody') : t('resourceSyncBody');
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
          onClick={event => {opener.current = event.currentTarget; setViewing(true);}}>{t('resourceViewDetails')}</Button>
        {syncActions && <>
          <Tooltip label={t('resourceSyncCheck')} side="top"><span className="project-mcp-action-anchor"><Button className="project-mcp-action" size="sm"
            icon={<IconRefreshOutline16 />} aria-label={`${t('resourceSyncCheck')}: ${item.name}`} disabled={syncActions.disabled} onClick={syncActions.check} /></span></Tooltip>
          <Tooltip label={canUpdateResource(sync) ? t('resourceSyncUpdate') : syncDescription} side="top"><span className="project-mcp-action-anchor"><Button className="project-mcp-action" size="sm"
            icon={<IconDownloadOutline16 />} aria-label={`${t('resourceSyncUpdate')}: ${item.name}`} disabled={syncActions.disabled || !canUpdateResource(sync)} onClick={syncActions.update} /></span></Tooltip>
        </>}
        {children}
      </div>
    </article>
    <ProjectScrollableModal open={viewing} title={t('resourceDetails')} closeLabel={t('close')} onClose={close}
      footer={<>{syncActions && <><Button variant="outline" disabled={syncActions.disabled} onClick={syncActions.check}>{t('resourceSyncCheck')}</Button>
        <Button variant="outline" disabled={syncActions.disabled || !canUpdateResource(sync)} onClick={syncActions.update}>{t('resourceSyncUpdate')}</Button></>}
        <Button variant="primary" autoFocus onClick={close}>{t('close')}</Button></>}>
      <div className="project-capability-form project-resource-details">
        <ProjectSettingRow title={t('resourceName')} layout="stacked"><span>{item.name}</span></ProjectSettingRow>
        <ProjectSettingRow title={t('resourceKind')}><Tag>{item.type === 'git' ? 'Git' : t('resourceLocal')}</Tag></ProjectSettingRow>
        <ProjectSettingRow title={t('resourceStatus')}><Tag tone={item.status === 'ready' ? 'success' : 'warning'}>{t(resourceStatusLabel(item))}</Tag></ProjectSettingRow>
        <ProjectSettingRow title={t('resourceDirectory')} description={item.external ? t('resourceExternal') : undefined} layout="stacked">
          <code>{item.path ?? t('resourceUnbound')}</code>
        </ProjectSettingRow>
        {item.url && <ProjectSettingRow title={t('resourceUrl')} layout="stacked"><code>{item.url}</code></ProjectSettingRow>}
        {item.git?.branch && <ProjectSettingRow title={t('resourceCurrentBranch')} layout="stacked"><code>{item.git.branch}</code></ProjectSettingRow>}
        {gitReady && <>
          <ProjectSettingRow title={t('resourceSyncStatus')} description={syncDescription} layout="stacked"><span role="status">{label}</span></ProjectSettingRow>
          {sync?.upstream && <ProjectSettingRow title={t('resourceSyncUpstream')} layout="stacked"><code>{sync.upstream}</code></ProjectSettingRow>}
          {sync?.checkedAt && <ProjectSettingRow title={t('resourceSyncChecked')} layout="stacked"><span>{new Date(sync.checkedAt).toLocaleString()}</span></ProjectSettingRow>}
          {sync?.ahead !== undefined && <ProjectSettingRow title={t('resourceSyncComparison')}><span>{t('resourceSyncCounts', {ahead: sync.ahead, behind: sync.behind ?? 0})}</span></ProjectSettingRow>}
          <ProjectSettingRow title={t('resourceSyncWorkspace')}><span>{sync?.dirty === undefined ? t('resourceSyncUnchecked') : t(sync.dirty ? 'resourceSyncDirty' : 'resourceSyncClean')}</span></ProjectSettingRow>
        </>}
      </div>
    </ProjectScrollableModal>
  </>;
}
