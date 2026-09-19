import {useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {Button, IconEditOutline16, IconFolderOpenOutline16, IconTrashOutline16,
  IconWarningOutline16, Input, Modal, Tooltip} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ResourceView} from '../project.ts';
import type {ResourceInspection, ManagedResource} from '../resource-contract.ts';
import {validResourceUrl} from '../resource-contract.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import {ProjectScrollableModal, ProjectSelect, ProjectSettingRow, ProjectSettingsCard} from './ProjectControls.tsx';
import type {ResourceController} from './resource-controller.ts';
import {ResourceCard} from './ResourceCard.tsx';
import {canCheckResource, resourceErrorText as errorText} from './resource-ui.ts';
import {managedResources} from '../resource-scope.ts';
const operationLabels = {cloning: 'resourceCloning', cancelling: 'resourceCancelling', cancelled: 'resourceCancelled', failed: 'resourceCloneFailed',
  pending: 'resourcePending', completed: 'resourceCompleted', interrupted: 'resourceInterrupted'} as const;

interface Draft {
  mode: 'add' | 'edit' | 'bind' | 'clone' | 'associate'; source: 'local' | 'git'; type: 'local' | 'git'; item?: ManagedResource;
  name: string; url: string; path: string; branch: string; inspection?: ResourceInspection;
  originChoice: '' | 'keep' | 'replace'; revision: string; requestId: string; named: boolean; targeted: boolean;
}
/** Repository names only suggest a new project-relative target; the Host validates the final path. */
function suggestedName(url: string): string {
  const segment = url.replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') ?? '';
  try {return decodeURIComponent(segment).replace(/[\\/:\u0000-\u001f]/g, '-').replace(/^\.+$/, '').slice(0, 120);} catch {return '';}
}
function IconAction({label, icon, disabled, action}: {label: string; icon: ReactNode; disabled?: boolean; action(event: React.MouseEvent<HTMLButtonElement>): void}) {
  return <Tooltip label={label} side="top" disabled={disabled}><span className="project-mcp-action-anchor">
    <Button className="project-mcp-action" size="sm" icon={icon} aria-label={label} disabled={disabled} onClick={action} />
  </span></Tooltip>;
}

export function ResourcesPanel({controller, root, pickDirectory, t}: {controller: ResourceController; root: string; pickDirectory(): Promise<string | null>; t: CapabilityTranslate}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const resources = state.data && managedResources(state.data.resources, root);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<{item: ManagedResource; revision: string} | null>(null);
  const [details, setDetails] = useState<{name: string; error: string} | null>(null);
  const [formError, setFormError] = useState<string>();
  const [selecting, setSelecting] = useState(false);
  const sequence = useRef(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const formId = useId(); const fieldId = (name: string) => `${formId}-${name}`;
  const busy = Boolean(draft && state.pending.includes(draft.item?.id ?? 'add'));
  const cloneActive = state.data?.operations.some(item => item.status === 'cloning' || item.status === 'cancelling') ?? false;
  useEffect(() => {
    void controller.refresh(); const timer = setInterval(() => {if (!document.hidden && !controller.getSnapshot().loading) void controller.refresh();}, 2000);
    return () => {clearInterval(timer); sequence.current++;};
  }, [controller]);
  const close = () => {
    sequence.current++; setDraft(null); setRemoving(null); setDetails(null);
    (opener.current?.isConnected ? opener.current : toolbar.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  };
  const open = (event: React.MouseEvent<HTMLButtonElement>, mode: Draft['mode'], item?: ManagedResource) => {
    if (!state.data) return;
    opener.current = event.currentTarget; sequence.current++; setSelecting(false); setFormError(undefined); controller.clearError();
    setDraft({mode, source: mode === 'clone' ? 'git' : 'local', type: item?.type ?? 'local', item,
      name: item?.name ?? '', url: item?.url ?? '', path: mode === 'clone'
        ? (!item?.bound && !item?.external ? item?.declaredPath : undefined) ?? `resources/${suggestedName(item?.url ?? '') || 'repository'}` : '',
      branch: mode === 'associate' ? '' : item?.branch ?? '', originChoice: '', revision: state.data.revision, requestId: crypto.randomUUID(), named: Boolean(item), targeted: Boolean(item)});
  };
  const update = (patch: Partial<Draft>) => {setDraft(previous => previous && {...previous, ...patch}); setFormError(undefined);};
  const pick = async () => {
    const current = ++sequence.current; setSelecting(true); setFormError(undefined);
    try {
      const path = await pickDirectory();
      if (path === null || sequence.current !== current) return;
      const inspection = await controller.inspect(path);
      if (sequence.current !== current) return;
      setDraft(previous => previous && {...previous, inspection, originChoice: '',
        ...(previous.mode === 'add' && !inspection.git?.url ? {type: 'local' as const} : {}),
        ...(previous.mode === 'add' && !previous.named ? {name: inspection.name} : {})});
    } catch (error) {if (sequence.current === current) setFormError(error instanceof Error ? error.message : 'operation-failed');}
    finally {if (sequence.current === current) setSelecting(false);}
  };
  const save = async () => {
    if (!draft || !form.current?.reportValidity()) return;
    let ok: boolean;
    if (draft.mode === 'bind') {
      if (!draft.inspection || (originMismatch && !draft.originChoice)) return;
      ok = await controller.mutate({action: 'bind', id: draft.item!.id, path: draft.inspection.path, expectedRevision: draft.revision,
        ...(draft.originChoice ? {originChoice: draft.originChoice} : {})});
    } else if (draft.mode === 'associate') {
      if (!validResourceUrl(draft.url)) {setFormError('resource-url-invalid'); return;}
      ok = await controller.mutate({action: 'associate', id: draft.item!.id, url: draft.url,
        branch: draft.branch || undefined, expectedRevision: draft.revision});
    } else if (draft.mode === 'edit') {
      if (draft.type === 'git' && draft.item?.url && !validResourceUrl(draft.url)) {setFormError('resource-url-invalid'); return;}
      ok = await controller.mutate({action: 'edit', id: draft.item!.id, name: draft.name, expectedRevision: draft.revision,
        ...(draft.type === 'git' && draft.item?.url ? {url: draft.url, branch: draft.branch || undefined} : {})});
    } else if (draft.source === 'git') {
      if (!validResourceUrl(draft.url)) {setFormError('resource-url-invalid'); return;}
      ok = await controller.clone({requestId: draft.requestId, expectedRevision: draft.revision, id: draft.item?.id,
        name: draft.name, url: draft.url, path: draft.path, branch: draft.branch || undefined});
    } else {
      if (!draft.inspection) return;
      ok = await controller.mutate({action: 'addLocal', expectedRevision: draft.revision, name: draft.name, path: draft.inspection.path,
        type: draft.type, ...(draft.type === 'git' ? {url: draft.inspection.git?.url} : {})});
    }
    if (ok) close();
  };
  const originMismatch = draft?.mode === 'bind' && draft.item?.type === 'git' && draft.inspection !== undefined
    && draft.inspection.git?.url !== draft.item.url;
  const cloneForm = draft?.mode === 'clone' || (draft?.mode === 'add' && draft.source === 'git');
  const directoryForm = draft?.mode === 'bind' || (draft?.mode === 'add' && draft.source === 'local');
  const draftError = formError ?? state.error;
  const reconfirm = async () => {
    await controller.refresh(); const current = controller.getSnapshot().data;
    if (current) {update({revision: current.revision}); if (removing) setRemoving({...removing, revision: current.revision}); controller.clearError();}
  };
  return <>
    {state.error && !draft && !removing && <p className="project-error" role="alert">{errorText(state.error, t)}</p>}
    <div ref={toolbar} className="project-capability-toolbar"><Button variant="primary" disabled={!state.data} onClick={event => open(event, 'add')}>{t('addResource')}</Button></div>
    {resources?.length === 0 && <p>{t('resourceEmpty')}</p>}
    <div className="project-mcp-grid">{resources?.map(item => {
      const locked = state.pending.includes(item.id) || Boolean(item.git?.sync?.phase) || state.data!.operations.some(op => op.resourceId === item.id && (op.status === 'cloning' || op.status === 'cancelling'));
      return <ResourceCard key={item.id} item={item} root={root} t={t} syncError={state.syncErrors[item.id]}
        syncActions={canCheckResource(item) ? {disabled: locked || !state.data?.canClone,
          check: () => void controller.sync(item.id, 'check', state.data!.revision),
          update: () => void controller.sync(item.id, 'update', state.data!.revision)} : undefined}>
          {item.git?.diagnostic && <span className="project-mcp-error-anchor"><IconAction label={errorText(item.git.diagnostic, t)} icon={<IconWarningOutline16 />}
            action={event => {opener.current = event.currentTarget; setDetails({name: item.name, error: item.git!.diagnostic!});}} /></span>}
          {item.type === 'git' && item.status === 'ready' && (!item.url || ['unlinked', 'no-upstream'].includes(item.git?.sync?.status ?? '')) &&
            <Button size="sm" disabled={locked || !state.data?.canClone} onClick={event => open(event, 'associate', item)}>
              {t(item.git?.sync?.status === 'no-upstream' ? 'resourceSetTracking' : 'resourceAssociate')}</Button>}
          {item.type === 'git' && item.url && item.status !== 'ready' && !item.external && <Button size="sm" disabled={locked || cloneActive || !state.data?.canClone}
            onClick={event => open(event, 'clone', item)}>{t('resourceClone')}</Button>}
          <IconAction label={`${t('bindResource')}: ${item.name}`} icon={<IconFolderOpenOutline16 />} disabled={locked || !state.data?.canPick} action={event => open(event, 'bind', item)} />
          <IconAction label={`${t('editResource')}: ${item.name}`} icon={<IconEditOutline16 />} disabled={locked} action={event => open(event, 'edit', item)} />
          <IconAction label={`${t('removeResource')}: ${item.name}`} icon={<IconTrashOutline16 />} disabled={locked} action={event => {
            opener.current = event.currentTarget; controller.clearError(); setRemoving({item, revision: state.data!.revision});
          }} />
      </ResourceCard>;
    })}</div>
    {Boolean(state.data?.operations.length) && <section className="project-resource-operations"><h2>{t('resourceOperations')}</h2>
      {[...(state.data?.operations ?? [])].reverse().map(operation => <div className="project-resource-operation" key={operation.id}>
        <div><strong>{operation.name}</strong><p role={operation.status === 'cloning' || operation.status === 'cancelling' ? 'status' : undefined}>{t(operationLabels[operation.status])}
          {operation.status === 'cloning' && operation.phase && ` · ${t(operation.phase === 'receiving' ? 'resourceReceiving' : operation.phase === 'resolving' ? 'resourceResolving' : 'resourceCheckout')} ${operation.percent ?? 0}%`}</p>
          <code>{operation.target}</code>
          {['failed', 'cancelled', 'interrupted'].includes(operation.status) && <p className="project-meta">{t('resourceRetained')}</p>}
        </div>
        <div className="project-resource-operation-actions">
          {operation.error && <IconAction label={errorText(operation.error, t)} icon={<IconWarningOutline16 />} action={event => {
            opener.current = event.currentTarget; setDetails({name: operation.name, error: operation.error!});
          }} />}
          {(operation.status === 'cloning' || operation.status === 'cancelling') && <Button variant="outline" size="sm" disabled={state.pending.includes(operation.id) || operation.status === 'cancelling'}
            onClick={() => void controller.operation(operation.id, 'cancel')}>{t('cancel')}</Button>}
          {(operation.status === 'pending' || operation.status === 'interrupted') && <Button variant="outline" size="sm" disabled={state.pending.includes(operation.id) || cloneActive}
            onClick={() => void controller.operation(operation.id, 'register', state.data!.revision)}>{t('resourceRegister')}</Button>}
        </div>
      </div>)}
    </section>}
    <ProjectScrollableModal open={draft !== null}
      title={t(draft?.mode === 'associate' ? 'resourceAssociate' : draft?.mode === 'edit' ? 'editResource' : draft?.mode === 'bind' ? 'bindResource' : draft?.mode === 'clone' ? 'resourceClone' : 'addResource')}
      closeLabel={t('close')} onClose={() => {if (!busy) close();}}
      footer={<><Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={formId} disabled={busy || selecting || (directoryForm && (!draft?.inspection || !state.data?.canPick))
          || Boolean(originMismatch && !draft?.originChoice) || Boolean(cloneForm && (cloneActive || !state.data?.canClone))}>
          {t(busy ? 'saving' : cloneForm ? 'resourceClone' : 'save')}</Button></>}>
      {draft && <form ref={form} id={formId} className="project-capability-form" onSubmit={event => {event.preventDefault(); void save();}}>
        <fieldset disabled={busy}>
          {draft.mode === 'add' && <ProjectSettingRow title={t('resourceSource')}><ProjectSelect label={t('resourceSource')} value={draft.source}
            options={[{value: 'local', label: t('resourceLocal')}, {value: 'git', label: t('resourceGit')}]}
            onChange={source => {sequence.current++; setSelecting(false); update({source});}} /></ProjectSettingRow>}
          {directoryForm && <>
            {draft.mode === 'bind' && <ProjectSettingRow title={t('resourceOldDirectory')} layout="stacked"><code>{draft.item?.path ?? t('resourceUnbound')}</code></ProjectSettingRow>}
            <ProjectSettingRow title={t(draft.mode === 'bind' ? 'resourceNewDirectory' : 'resourceDirectory')}
              description={t(draft.mode === 'bind' ? 'resourceBindBody' : 'resourceReferenceBody')} layout="stacked">
              <div className="project-resource-directory"><code>{draft.inspection?.path ?? t('resourceUnbound')}</code>
                <Button variant="outline" disabled={selecting || !state.data?.canPick} onClick={() => void pick()}>{t(selecting ? 'loading' : 'resourceChoose')}</Button></div>
              {!state.data?.canPick && <p className="project-meta">{t('nativePickerUnavailable')}</p>}
              {draft.inspection?.external && <p className="project-meta">{t('resourceExternal')}</p>}
              {draft.inspection?.duplicateId && draft.inspection.duplicateId !== draft.item?.id && <p className="project-error">{t('resourceErrorDuplicate')}</p>}
            </ProjectSettingRow>
            {draft.mode === 'add' && draft.inspection?.git?.url && <ProjectSettingRow title={t('resourceKind')} description={t('resourceDetected')}><ProjectSelect label={t('resourceKind')} value={draft.type}
              options={[{value: 'local', label: t('resourceLocal')}, {value: 'git', label: t('resourceGit')}]}
              onChange={type => update({type})} /></ProjectSettingRow>}
            {originMismatch && <ProjectSettingRow title={t('resourceOriginChoice')} description={t('resourceOriginBody')}><ProjectSelect label={t('resourceOriginChoice')} value={draft.originChoice}
              options={[{value: '', label: t('resourceOriginChoice')}, {value: 'keep', label: t('resourceKeepOrigin')},
                ...(draft.inspection?.git?.url ? [{value: 'replace' as const, label: t('resourceReplaceOrigin')}] : [])]}
              onChange={originChoice => update({originChoice})} /></ProjectSettingRow>}
          </>}
          {draft.mode === 'associate' && <ProjectSettingRow title={t('resourceDirectory')} description={t('resourceAssociateBody')} layout="stacked"><code>{draft.item?.path}</code></ProjectSettingRow>}
          {draft.mode !== 'bind' && draft.mode !== 'associate' && <ProjectSettingRow title={t('resourceName')} htmlFor={fieldId('name')} layout="input">
            <Input id={fieldId('name')} value={draft.name} required maxLength={160} onChange={event => update({name: event.target.value, named: true})} />
          </ProjectSettingRow>}
          {(cloneForm || draft.mode === 'associate' || (draft.mode === 'edit' && draft.type === 'git' && draft.item?.url)) && <>
            <ProjectSettingRow title={t('resourceUrl')} description={t('resourceUrlBody')} htmlFor={fieldId('url')} layout="input">
              <Input id={fieldId('url')} value={draft.url} required maxLength={4096} spellCheck={false} autoComplete="off" onChange={event => {
                const url = event.target.value; const name = suggestedName(url);
                update({url, ...(!draft.named ? {name} : {}), ...(!draft.targeted ? {path: name ? `resources/${name}` : ''} : {})});
              }} />
            </ProjectSettingRow>
            {cloneForm && <ProjectSettingRow title={t('resourceTarget')} description={t('resourceTargetBody')} htmlFor={fieldId('target')} layout="input">
              <Input id={fieldId('target')} value={draft.path} required maxLength={8000} spellCheck={false} onChange={event => update({path: event.target.value, targeted: true})} />
            </ProjectSettingRow>}
            {draft.mode === 'associate' ? <ProjectSettingRow title={t('resourceSyncUpstream')} description={t('resourceAssociateBranchBody')} htmlFor={fieldId('branch')} layout="input">
              <Input id={fieldId('branch')} value={draft.branch} maxLength={255} onChange={event => update({branch: event.target.value})} />
            </ProjectSettingRow> : <ProjectSettingsCard title={t('resourceAdvanced')} description={t('resourceAdvancedBody')}><ProjectSettingRow title={t('resourceBranch')}
              description={t('resourceBranchBody')} htmlFor={fieldId('branch')} layout="input"><Input id={fieldId('branch')} value={draft.branch} maxLength={255}
                onChange={event => update({branch: event.target.value})} /></ProjectSettingRow></ProjectSettingsCard>}
            {cloneForm && !state.data?.canClone && <p className="project-meta">{t('resourceNoGit')}</p>}
          </>}
        </fieldset>
        {draftError && <p className="project-error" role="alert">{errorText(draftError, t)}</p>}
        {state.error === 'revision-conflict' && <div><p>{t('resourceReconfirmBody')}</p><Button variant="outline" onClick={() => void reconfirm()}>{t('resourceReconfirm')}</Button></div>}
      </form>}
    </ProjectScrollableModal>
    <Modal open={removing !== null} title={t('removeResource')} closeLabel={t('close')} onClose={() => {if (!state.pending.includes(removing?.item.id ?? '')) close();}}
      footer={<><Button variant="outline" disabled={state.pending.includes(removing?.item.id ?? '')} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={state.pending.includes(removing?.item.id ?? '')} onClick={() => {
          if (removing) void controller.mutate({action: 'remove', id: removing.item.id, expectedRevision: removing.revision}).then(ok => {if (ok) close();});
        }}>{t('removeResource')}</Button></>}>
      <p>{t('resourceRemoveBody', {name: removing?.item.name ?? ''})}</p>
      {state.error && <p className="project-error" role="alert">{errorText(state.error, t)}</p>}
      {state.error === 'revision-conflict' && <Button variant="outline" onClick={() => void reconfirm()}>{t('resourceReconfirm')}</Button>}
    </Modal>
    <Modal open={details !== null} title={details?.name ?? ''} closeLabel={t('close')} onClose={close}
      footer={<Button variant="primary" onClick={close}>{t('close')}</Button>}>
      <p>{details && errorText(details.error, t)}</p>
    </Modal>
  </>;
}

export function ResourcesOverview({controller, resources, root, t}: {
  controller: ResourceController; resources: ResourceView[]; root: string; t: CapabilityTranslate;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {void controller.refresh();}, [controller]);
  const items = managedResources(state.data?.resources ?? resources, root);
  return items.length === 0 ? <p>{t('resourceEmpty')}</p> : <div className="project-mcp-grid">
    {items.map(item => <ResourceCard key={item.id} item={item} root={root} t={t} syncError={state.syncErrors[item.id]} />)}
  </div>;
}
