import {useEffect, useId, useState, useSyncExternalStore} from 'react';
import {Button, Input} from '@deepseek-ai/dsh-client-ui-primitives';
import type {GitAuthRequest} from '../resource-auth-contract.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';
import type {ResourceAuthController} from './resource-auth-controller.ts';
import {ProjectScrollableModal, ProjectSelect, ProjectSettingRow} from './ProjectControls.tsx';
import {resourceErrorText} from './resource-ui.ts';

/** Official ProviderEditor password Input and settings rows; secrets stay inside this mounted form. */
function AuthForm({controller, request, t}: {controller: ResourceAuthController; request: GitAuthRequest; t: CapabilityTranslate}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [key, setKey] = useState('');
  const [path, setPath] = useState('');
  const id = useId(); const ssh = request.kind === 'ssh';
  useEffect(() => {if (ssh) void controller.loadKeys();}, [controller, ssh]);
  const cancel = () => {if (!state.busy) {setSecret(''); void controller.answer(request.id, null);}};
  return <ProjectScrollableModal open title={t('gitAuthTitle', {name: request.name})} closeLabel={t('close')} onClose={cancel}
    footer={<><Button variant="outline" disabled={state.busy} onClick={cancel}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form={id} disabled={state.busy}>{t(state.busy ? 'saving' : 'gitAuthContinue')}</Button></>}>
    <form id={id} className="project-capability-form project-resource-details" onSubmit={event => {
      event.preventDefault();
      if (state.busy) return;
      const credential = ssh ? {kind: 'ssh' as const, keyPath: key && key !== 'custom' ? key : path, passphrase: secret}
        : {kind: 'https' as const, username, password: secret};
      void controller.answer(request.id, credential).then(ok => {if (ok) setSecret('');});
    }}>
      <fieldset disabled={state.busy}>
        <ProjectSettingRow title={t('resourceUrl')} layout="stacked"><code>{request.url}</code></ProjectSettingRow>
        <p className="project-meta">{t('gitAuthOnce')}</p>
        {ssh ? <>
          <ProjectSettingRow title={t('gitAuthKey')} description={t('gitAuthKeyBody')}>
            <ProjectSelect label={t('gitAuthKey')} value={key} disabled={state.busy} onChange={value => {setKey(value); setSecret('');}}
              options={[{value: '', label: t('gitAuthChooseKey')}, ...state.keys.map(item => ({value: item.path, label: item.name})),
                {value: 'custom', label: t('gitAuthCustomKey')}]} />
          </ProjectSettingRow>
          {(!key || key === 'custom') ? <ProjectSettingRow title={t('gitAuthKeyPath')} htmlFor={`${id}-path`} layout="input">
            <Input id={`${id}-path`} autoFocus value={path} required maxLength={8192} spellCheck={false} autoComplete="off"
              onChange={event => setPath(event.target.value)} placeholder="/Users/name/.ssh/id_ed25519" />
          </ProjectSettingRow> : <ProjectSettingRow title={t('gitAuthKeyPath')} layout="stacked"><code>{key}</code></ProjectSettingRow>}
          <ProjectSettingRow title={t('gitAuthPassphrase')} description={t('gitAuthPassphraseBody')} htmlFor={`${id}-secret`} layout="input">
            <Input id={`${id}-secret`} type="password" value={secret} maxLength={8192} autoComplete="off" onChange={event => setSecret(event.target.value)} />
          </ProjectSettingRow>
        </> : <>
          <ProjectSettingRow title={t('gitAuthUsername')} htmlFor={`${id}-user`} layout="input">
            <Input id={`${id}-user`} autoFocus value={username} required maxLength={8192} autoComplete="username" spellCheck={false} onChange={event => setUsername(event.target.value)} />
          </ProjectSettingRow>
          <ProjectSettingRow title={t('gitAuthPassword')} description={t('gitAuthPasswordBody')} htmlFor={`${id}-secret`} layout="input">
            <Input id={`${id}-secret`} type="password" value={secret} required maxLength={8192} autoComplete="off" onChange={event => setSecret(event.target.value)} />
          </ProjectSettingRow>
        </>}
      </fieldset>
      {request.retry && <p className="project-error" role="alert">{t('gitAuthRetry')}</p>}
      {state.error && <p className="project-error" role="alert">{resourceErrorText(state.error, t)}</p>}
    </form>
  </ProjectScrollableModal>;
}

export function ResourceAuthDialog({controller, t}: {controller: ResourceAuthController; t: CapabilityTranslate}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.refresh();
    const timer = setInterval(() => {if (!document.hidden) void controller.refresh();}, 1000);
    return () => clearInterval(timer);
  }, [controller]);
  const request = state.requests[0];
  return request ? <AuthForm key={request.id} controller={controller} request={request} t={t} /> : null;
}
