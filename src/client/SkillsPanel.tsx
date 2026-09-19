import {useState} from 'react';
import {Button, Modal, Tag} from '@deepseek-ai/dsh-client-ui-primitives';
import {ProjectSwitch} from './ProjectControls.tsx';
import type {ProjectCapabilityController} from './controller.ts';
import {CapabilityError, CatalogContext, useCapability, type CapabilityTranslate} from './capability-ui.tsx';
import type {ProjectLocaleKey} from '../locales.ts';

const sourceLabels: Record<string, ProjectLocaleKey> = {
  bundled: 'skillSourceBundled', 'project-dsh': 'skillSourceWorkspaceDsh', 'project-agents': 'skillSourceWorkspaceAgents',
  'user-dsh': 'skillSourceUserDsh', 'user-agents': 'skillSourceUserAgents', runtime: 'skillSourceRuntime', custom: 'skillSourceCustom',
};

export function SkillsPanel({controller, t, pickDirectory}: {controller: ProjectCapabilityController; t: CapabilityTranslate; pickDirectory(): Promise<string | null>}) {
  const state = useCapability(controller, 'skills');
  const [confirm, setConfirm] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pendingSkills, setPendingSkills] = useState<Set<string>>(() => new Set());
  const busy = state.pending || picking;
  return <>
    <CapabilityError error={state.error} t={t} />
    <CatalogContext context={state.data?.context} t={t} />
    <div className="project-capability-toolbar"><Button variant="primary" disabled={busy || !state.data?.canImport} onClick={() => setConfirm(true)}>{t('importSkill')}</Button>
      {state.data && !state.data.canImport && <span>{t('nativePickerUnavailable')}</span>}{state.loading && <span role="status">{t('capabilityLoading')}</span>}</div>
    {state.data?.diagnostic && <p role="alert" className="project-error">{t('skillIndexInvalid')}</p>}
    <section className="project-skill-group"><h2>{t('projectSkills')}</h2>
      {state.data?.project.length === 0 && <p>{t('emptyProjectSkills')}</p>}
      <div className="project-skill-grid">{state.data?.project.map(skill => <article className="project-skill-card" key={skill.name} aria-label={skill.name}>
        <div className="project-skill-card-body">
          <div className="project-card-top"><div className="project-skill-heading"><strong className="project-skill-name">{skill.name}</strong><Tag tone={skill.enabled ? 'success' : 'neutral'}>{t(skill.enabled ? 'enabled' : 'disabled')}</Tag></div><ProjectSwitch checked={skill.enabled} label={t('toggleSkill', {name: skill.name})} disabled={busy || pendingSkills.has(skill.name)}
            onChange={enabled => {
              setPendingSkills(previous => new Set(previous).add(skill.name));
              void controller.mutate('skills', {action: 'enable', name: skill.name, enabled}, {scope: 'item'})
                .finally(() => setPendingSkills(previous => {const next = new Set(previous); next.delete(skill.name); return next;}));
            }} /></div>
          <p className="project-skill-description">{skill.description}</p>{skill.whenToUse && <p className="project-skill-usage">{skill.whenToUse}</p>}
          {skill.enabled && !skill.effective && <div className="project-skill-tags"><Tag>{t('skillNotEffective')}</Tag></div>}
        </div>
      </article>)}</div>
    </section>
    <section className="project-skill-group"><h2>{t('inheritedSkills')}</h2>
      {state.data?.inherited.length === 0 && <p>{t('emptyInheritedSkills')}</p>}
      <div className="project-skill-grid">{state.data?.inherited.map(skill => <article className="project-skill-card" key={`${skill.provider}:${skill.name}`} aria-label={skill.name}>
        <div className="project-skill-card-body">
          <div className="project-card-top"><strong className="project-skill-name">{skill.name}</strong><Tag>{t('readonlySkill')}</Tag></div>
          <p className="project-skill-description">{skill.description}</p>{skill.whenToUse && <p className="project-skill-usage">{skill.whenToUse}</p>}
          <small className="project-skill-meta">{t('source')} · {sourceLabels[skill.source] ? t(sourceLabels[skill.source]!) : skill.source} · {skill.provider}</small>
          <div className="project-skill-tags">{skill.invocation.modelInvocable && <Tag>{t('skillModelInvocation')}</Tag>}{skill.invocation.userInvocable && <Tag>{t('skillUserInvocation')}</Tag>}</div>
        </div>
      </article>)}</div>
    </section>
    <Modal open={confirm} title={t('importSkill')} closeLabel={t('close')} onClose={() => {if (!busy) setConfirm(false);}}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => {
        setPicking(true); void controller.importSkill(pickDirectory).then(ok => {if (ok) setConfirm(false);}).finally(() => setPicking(false));
      }}>{t('selectSkillFolder')}</Button></>}>
      <p>{t('skillTrust')}</p><CapabilityError error={state.error} t={t} />
    </Modal>
  </>;
}
