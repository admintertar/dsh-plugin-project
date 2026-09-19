import {useId, useRef, useState} from 'react';
import {Button, IconEditOutline16, IconTrashOutline16, IconWarningOutline16, Input, Modal, Tag, Tooltip} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ProjectCapabilityController} from './controller.ts';
import type {McpAction, ProjectMcpServer, ProjectMcpServerView, ProjectMcpConnectionTestResult} from './types.ts';
import {CapabilityError, useCapability, type CapabilityTranslate} from './capability-ui.tsx';
import {ProjectAddButton, ProjectScrollableModal, ProjectSelect, ProjectSettingRow, ProjectSettingsCard, ProjectSwitch} from './ProjectControls.tsx';

interface Draft {
  editing: boolean; id: string; serverName: string; enabled: boolean; transport: 'stdio' | 'streamable-http';
  command: string; args: string; url: string; timeout: number;
  localMode: 'preserve' | 'replace' | 'clear'; values: Array<{key: string; value: string}>; cwd: string;
  reconnect: boolean; initialDelay: number; maxDelay: number; maxAttempts: number;
}
/** GET presence flags are view metadata, never part of a saved declaration. */
export function publicMcpServer(view: ProjectMcpServerView): ProjectMcpServer {
  const {hasEnvironment: _env, hasHeaders: _headers, hasCwd: _cwd, ...server} = view;
  return server;
}
function draftFor(server?: ProjectMcpServerView): Draft {
  return {editing: server !== undefined, id: server?.id ?? '', serverName: server?.serverName ?? '', enabled: server?.enabled ?? true,
    transport: server?.transport ?? 'stdio', command: server?.transport === 'stdio' ? server.command : '',
    args: server?.transport === 'stdio' ? JSON.stringify(server.args, null, 2) : '[]',
    url: server?.transport === 'streamable-http' ? server.url : '', timeout: (server?.toolCallTimeoutMs ?? 30_000) / 1000,
    localMode: server ? 'preserve' : 'replace', values: [], cwd: '', reconnect: server?.reconnect?.enabled ?? true,
    initialDelay: server?.reconnect?.initialDelayMs ?? 500, maxDelay: server?.reconnect?.maxDelayMs ?? 30_000,
    maxAttempts: server?.reconnect?.maxAttempts ?? 10};
}
function candidate(draft: Draft): Extract<McpAction, {action: 'upsert'}> {
  let args: unknown = [];
  if (draft.transport === 'stdio') {
    try {args = JSON.parse(draft.args);}
    catch {throw new Error('argumentsInvalid');}
    if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== 'string')) throw new Error('argumentsInvalid');
  }
  const common = {id: draft.id, serverName: draft.serverName, enabled: draft.enabled, toolCallTimeoutMs: Math.round(draft.timeout * 1000),
    reconnect: {enabled: draft.reconnect, initialDelayMs: draft.initialDelay, maxDelayMs: draft.maxDelay, maxAttempts: draft.maxAttempts}};
  if (draft.initialDelay > draft.maxDelay) throw new Error('invalidMcpForm');
  const server: ProjectMcpServer = draft.transport === 'stdio' ? {...common, transport: 'stdio', command: draft.command, args: args as string[]}
    : {...common, transport: 'streamable-http', url: draft.url};
  if (draft.localMode === 'preserve') return {action: 'upsert', server};
  if (draft.localMode === 'clear') return {action: 'upsert', server, local: {}};
  const names = draft.values.map(row => row.key);
  if (names.some(name => name.length === 0) || new Set(names).size !== names.length) throw new Error('invalidLocalValues');
  const values = Object.fromEntries(draft.values.map(row => [row.key, row.value]));
  return {action: 'upsert', server, local: draft.transport === 'stdio'
    ? {...(names.length ? {env: values} : {}), ...(draft.cwd ? {cwd: draft.cwd} : {})}
    : names.length ? {headers: values} : {}};
}

export function McpPanel({controller, t}: {controller: ProjectCapabilityController; t: CapabilityTranslate}) {
  const state = useCapability(controller, 'mcp');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<ProjectMcpServerView | null>(null);
  const [errorDetails, setErrorDetails] = useState<{server: ProjectMcpServerView; reconnecting: boolean} | null>(null);
  const errorOpener = useRef<HTMLButtonElement | null>(null);
  const closeError = () => {setErrorDetails(null); errorOpener.current?.focus();};
  const [tested, setTested] = useState<ProjectMcpConnectionTestResult>();
  const [formError, setFormError] = useState<'argumentsInvalid' | 'invalidLocalValues' | 'invalidMcpForm'>();
  const [testing, setTesting] = useState(false);
  const [pendingServers, setPendingServers] = useState<Set<string>>(() => new Set());
  const form = useRef<HTMLFormElement>(null);
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;
  const update = (patch: Partial<Draft>) => {setDraft(value => value && {...value, ...patch}); setTested(undefined); setFormError(undefined);};
  const parse = () => {
    if (!draft || !form.current?.reportValidity()) return;
    try {return candidate(draft);}
    catch (error) {setFormError(error instanceof Error && (error.message === 'argumentsInvalid' || error.message === 'invalidLocalValues') ? error.message : 'invalidMcpForm');}
  };
  const save = async () => {const value = parse(); if (value && await controller.mutate('mcp', value)) setDraft(null);};
  const edit = (server?: ProjectMcpServerView) => {setDraft(draftFor(server)); setTested(undefined); setFormError(undefined);};
  const busy = state.pending || testing;
  return <>
    <CapabilityError error={state.error} t={t} />
    <div className="project-capability-toolbar"><Button variant="primary" disabled={busy} onClick={() => edit()}>{t('addMcp')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => {void controller.mutate('mcp', {action: 'reload'});}}>{t('reloadMcp')}</Button>
      {state.loading && <span role="status">{t('capabilityLoading')}</span>}</div>
    {state.data?.servers.length === 0 && <section className="project-card project-empty-state"><h2>{t('emptyMcp')}</h2></section>}
    <div className="project-mcp-grid">{state.data?.servers.map(server => {
      const runtime = state.data?.runtime.find(item => item.id === server.id);
      const status = runtime?.status ?? 'error';
      const active = runtime?.active ?? false;
      const hasError = status === 'error' || runtime?.lastError !== undefined;
      const toolNames = runtime?.toolNames ?? [];
      // AgentPresetSection's private card chrome; keep service controls separate from its body.
      return <article className="project-mcp-card" key={server.id} aria-label={server.serverName}>
        <div className="project-mcp-card-body">
          <div className="project-card-top"><strong className="project-mcp-name">{server.serverName}</strong><ProjectSwitch checked={active} disabled={busy || pendingServers.has(server.id)} label={t('toggleMcp', {name: server.serverName})}
            onChange={enabled => {
              setPendingServers(previous => new Set(previous).add(server.id));
              void controller.mutate('mcp', {action: 'upsert', server: {...publicMcpServer(server), enabled}}, {scope: 'item'})
                .finally(() => setPendingServers(previous => {const next = new Set(previous); next.delete(server.id); return next;}));
            }} /></div>
          <div className="project-summary"><Tag>{server.transport === 'stdio' ? 'stdio' : 'Streamable HTTP'}</Tag><Tag tone={status === 'connected' ? 'success' : status === 'error' || status === 'reconnecting' ? 'warning' : 'neutral'}>
            {t(status === 'connected' ? 'connected' : status === 'disabled' ? 'disabled' : status === 'reconnecting' ? 'mcpReconnecting' : 'mcpError')}</Tag></div>
          <div className="project-mcp-metadata">
            <code className="project-mcp-endpoint" title={server.transport === 'stdio' ? server.command : server.url}>{server.transport === 'stdio' ? server.command : server.url}</code>
            {(server.hasEnvironment || server.hasHeaders || server.hasCwd) && <span className="project-mcp-local">{t('localConfigured')}</span>}
          </div>
          {/* A compact two-line viewport keeps zero, one and many tools from changing the card's height. */}
          <div className="project-mcp-tools" role="region" aria-label={t('mcpTools')} tabIndex={toolNames.length ? 0 : undefined}>
            {toolNames.length === 0 ? <p className="project-mcp-local">{t('noMcpTools')}</p>
              : <ul aria-label={t('toolCount', {count: toolNames.length})}>{toolNames.map(name => <li key={name}><code>{name}</code></li>)}</ul>}
          </div>
        </div>
        <div className="project-mcp-card-footer">
          {/* Pinned Button does not forward refs; Tooltip needs a DOM anchor for positioning. */}
          {hasError && <Tooltip label={t(status === 'reconnecting' ? 'mcpReconnectingBody' : 'mcpConnectionError')} side="top" maxWidth={320} disabled={errorDetails !== null}>
            <span className="project-mcp-action-anchor project-mcp-error-anchor"><Button size="sm" icon={<IconWarningOutline16 className="project-mcp-error-icon" />} aria-label={`${t('mcpErrorDetails')}: ${server.serverName}`} aria-haspopup="dialog"
              onClick={event => {errorOpener.current = event.currentTarget; setErrorDetails({server, reconnecting: status === 'reconnecting'});}} /></span>
          </Tooltip>}
          <Tooltip label={t('edit')} side="top" delayMs={400} disabled={busy}><span className="project-mcp-action-anchor">
            <Button className="project-mcp-action" size="sm" icon={<IconEditOutline16 />} disabled={busy} aria-label={`${t('edit')}: ${server.serverName}`} onClick={() => edit(server)} />
          </span></Tooltip>
          <Tooltip label={t('delete')} side="top" delayMs={400} disabled={busy}><span className="project-mcp-action-anchor">
            <Button className="project-mcp-action project-mcp-action-danger" size="sm" icon={<IconTrashOutline16 />} disabled={busy} aria-label={`${t('delete')}: ${server.serverName}`} onClick={() => setRemoving(server)} />
          </span></Tooltip>
        </div>
      </article>;
    })}</div>
    <ProjectScrollableModal open={draft !== null}
      title={t(draft?.editing ? 'editMcp' : 'addMcp')} closeLabel={t('close')} onClose={() => {if (!busy) setDraft(null);}}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>{t('cancel')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => {
          const value = parse(); if (!value) return;
          setTesting(true); void controller.testMcp(value).then(setTested).finally(() => setTesting(false));
        }}>{t(testing ? 'testingConnection' : 'testConnection')}</Button><Button variant="primary" disabled={busy} type="submit" form="project-mcp-form">{t(state.pending && !testing ? 'saving' : 'save')}</Button></>}>
      {draft && <form ref={form} id="project-mcp-form" className="project-capability-form" onSubmit={event => {event.preventDefault(); void save();}}>
        <fieldset disabled={busy}>
          <ProjectSettingRow title={t('serverId')} description={t('serverIdBody')} htmlFor={fieldId('id')} layout="input">
            <Input id={fieldId('id')} aria-describedby={`${fieldId('id')}-description`} value={draft.id} disabled={draft.editing} required maxLength={64} pattern={'[A-Za-z0-9][A-Za-z0-9_\\-]*'} onChange={event => update({id: event.target.value})} />
          </ProjectSettingRow>
          <ProjectSettingRow title={t('serverName')} description={t('serverNameBody')} htmlFor={fieldId('name')} layout="input">
            <Input id={fieldId('name')} aria-describedby={`${fieldId('name')}-description`} value={draft.serverName} required maxLength={32} pattern={'[A-Za-z0-9_\\-]+'} onChange={event => update({serverName: event.target.value})} />
          </ProjectSettingRow>
          <ProjectSettingRow title={t('transport')}><ProjectSelect label={t('transport')} value={draft.transport} disabled={busy}
            options={[{value: 'stdio', label: 'stdio'}, {value: 'streamable-http', label: 'Streamable HTTP'}]}
            onChange={transport => update({transport, localMode: 'clear', values: [], cwd: ''})} /></ProjectSettingRow>
          <ProjectSettingRow title={t('callTimeout')} htmlFor={fieldId('timeout')} layout="input">
            <Input id={fieldId('timeout')} type="number" min={0.1} max={600} step={0.1} required value={draft.timeout} onChange={event => update({timeout: Number(event.target.value)})} />
          </ProjectSettingRow>
          <ProjectSettingRow title={t('enableMcp')} description={t('enableMcpBody')}>
            <ProjectSwitch label={t('enableMcp')} title={t('enableMcpBody')} checked={draft.enabled} disabled={busy} onChange={enabled => update({enabled})} />
          </ProjectSettingRow>
          {draft.transport === 'stdio' ? <>
            <ProjectSettingRow title={t('command')} htmlFor={fieldId('command')} layout="input">
              <Input id={fieldId('command')} value={draft.command} required maxLength={4000} onChange={event => update({command: event.target.value})} />
            </ProjectSettingRow>
            <ProjectSettingRow title={t('arguments')} htmlFor={fieldId('args')} layout="stacked">
              <textarea id={fieldId('args')} className="project-textarea" value={draft.args} rows={3} spellCheck={false} onChange={event => update({args: event.target.value})} />
            </ProjectSettingRow>
          </> : <ProjectSettingRow title={t('serverUrl')} htmlFor={fieldId('url')} layout="input">
            <Input id={fieldId('url')} type="url" required maxLength={8000} pattern="https?://.*" value={draft.url} onChange={event => update({url: event.target.value})} />
          </ProjectSettingRow>}
          <ProjectSettingRow title={t('localSettings')} description={t('localSettingsBody')}><ProjectSelect label={t('localSettings')} value={draft.localMode} disabled={busy}
            options={[{value: 'preserve', label: t('preserveLocal')}, {value: 'replace', label: t('replaceLocal')}, {value: 'clear', label: t('clearLocal')}]}
            onChange={localMode => update({localMode, values: [], cwd: ''})} /></ProjectSettingRow>
          {draft.localMode === 'replace' && <>
            {draft.transport === 'stdio' && <ProjectSettingRow title={t('workingDirectory')} htmlFor={fieldId('cwd')} layout="input">
              <Input id={fieldId('cwd')} value={draft.cwd} maxLength={8000} onChange={event => update({cwd: event.target.value})} />
            </ProjectSettingRow>}
            <ProjectSettingRow title={t(draft.transport === 'stdio' ? 'environmentVariables' : 'httpHeaders')} layout="stacked">
              <div className="project-secret-list">{draft.values.map((row, index) => <div className="project-secret-row" key={index}>
                <Input aria-label={`${t('key')} ${index + 1}`} placeholder={t('key')} value={row.key} maxLength={256} required autoComplete="off" onChange={event => update({values: draft.values.map((item, i) => i === index ? {...item, key: event.target.value} : item)})} />
                <Input aria-label={`${t('secretValue')} ${index + 1}`} placeholder={t('secretValue')} type="password" autoComplete="new-password" value={row.value} maxLength={32768} onChange={event => update({values: draft.values.map((item, i) => i === index ? {...item, value: event.target.value} : item)})} />
                <Button type="button" variant="ghost" size="sm" className="project-remove-value" aria-label={t('removeValue')} onClick={() => update({values: draft.values.filter((_, i) => i !== index)})}><IconTrashOutline16 /></Button>
              </div>)}
                <ProjectAddButton onClick={() => update({values: [...draft.values, {key: '', value: ''}]})}>{t('addValue')}</ProjectAddButton>
              </div>
            </ProjectSettingRow>
          </>}
          <div className="project-mcp-reconnect"><ProjectSettingsCard title={t('reconnectOptions')} description={t('reconnectOptionsBody')} disabled={busy}>
            <ProjectSettingRow title={t('autoReconnect')}><ProjectSwitch checked={draft.reconnect} label={t('autoReconnect')} disabled={busy} onChange={reconnect => update({reconnect})} /></ProjectSettingRow>
            <ProjectSettingRow title={t('initialDelay')} htmlFor={fieldId('initialDelay')} layout="input">
              <Input id={fieldId('initialDelay')} type="number" min={1} max={2147483647} required value={draft.initialDelay} onChange={event => update({initialDelay: Number(event.target.value)})} />
            </ProjectSettingRow>
            <ProjectSettingRow title={t('maxDelay')} htmlFor={fieldId('maxDelay')} layout="input">
              <Input id={fieldId('maxDelay')} type="number" min={draft.initialDelay} max={2147483647} required value={draft.maxDelay} onChange={event => update({maxDelay: Number(event.target.value)})} />
            </ProjectSettingRow>
            <ProjectSettingRow title={t('maxAttempts')} htmlFor={fieldId('maxAttempts')} layout="input">
              <Input id={fieldId('maxAttempts')} type="number" min={1} max={1000} required value={draft.maxAttempts} onChange={event => update({maxAttempts: Number(event.target.value)})} />
            </ProjectSettingRow>
          </ProjectSettingsCard></div>
        </fieldset>
        {formError && <p role="alert" className="project-error">{t(formError)}</p>}
        <CapabilityError error={state.error} t={t} />
        {tested && <p role="status" className={tested.ok ? 'project-form-success' : 'project-error'}>{t(tested.ok ? 'mcpTestPassed' : 'mcpTestFailed', {count: tested.toolNames.length})}</p>}
      </form>}
    </ProjectScrollableModal>
    <Modal open={errorDetails !== null} title={t('mcpErrorDetails')} description={errorDetails?.server.serverName ?? ''} closeLabel={t('close')} onClose={closeError}
      footer={<Button variant="outline" autoFocus onClick={closeError}>{t('close')}</Button>}>
      <p>{t(errorDetails?.reconnecting ? 'mcpReconnectingBody' : 'mcpConnectionError')}</p>
      {errorDetails?.server.transport === 'stdio' && !errorDetails.server.hasEnvironment && <p>{t('mcpLocalEnvironmentHint')}</p>}
    </Modal>
    <Modal open={removing !== null} title={t('deleteMcpTitle')} closeLabel={t('close')} onClose={() => {if (!busy) setRemoving(null);}}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => {
        if (removing) void controller.mutate('mcp', {action: 'delete', id: removing.id}).then(ok => {if (ok) setRemoving(null);});
      }}>{t('delete')}</Button></>}><p>{t('deleteMcpBody', {name: removing?.serverName ?? ''})}</p><CapabilityError error={state.error} t={t} /></Modal>
  </>;
}
