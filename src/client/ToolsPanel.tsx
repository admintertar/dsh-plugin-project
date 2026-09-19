import {useRef, useState} from 'react';
import {Button, IconSearchOutline16, Input, Tag} from '@deepseek-ai/dsh-client-ui-primitives';
import type {ProjectCapabilityController} from './controller.ts';
import {CapabilityError, CatalogContext, useCapability, type CapabilityTranslate} from './capability-ui.tsx';
import {ProjectScrollableModal} from './ProjectControls.tsx';

/** The registry has already applied preset restrictions and scoped shadowing. */
export function ToolsPanel({controller, t}: {controller: ProjectCapabilityController; t: CapabilityTranslate}) {
  const state = useCapability(controller, 'tools');
  const [query, setQuery] = useState('');
  const [viewedTool, setViewedTool] = useState<{name: string; description: string} | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeDescription = () => {setViewedTool(null); opener.current?.focus();};
  const needle = query.trim().toLocaleLowerCase();
  const tools = state.data?.tools.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(needle)) ?? [];
  return <>
    <CapabilityError error={state.error} t={t} /><CatalogContext context={state.data?.context} t={t} />
    <p>{t('toolsBody')}</p>
    <div className="project-capability-toolbar"><Input icon={<IconSearchOutline16 />} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('searchTools')} aria-label={t('searchTools')} />
      {state.loading && <span role="status">{t('capabilityLoading')}</span>}</div>
    {state.data?.context.kind === 'session' && tools.length === 0 && <p>{t(needle ? 'noMatchingTools' : 'emptyTools')}</p>}
    {(['project', 'mcp', 'dsh'] as const).map(group => {
      const entries = tools.filter(tool => tool.group === group);
      if (!entries.length) return null;
      // AgentPresetSection's private card presentation; opening reads a tool, never invokes it.
      return <section className="project-tool-group" key={group}><h2>{t(group === 'dsh' ? 'dshTools' : group === 'project' ? 'projectTools' : 'mcpTools')} <Tag>{entries.length}</Tag></h2>
        <ul className="project-tool-grid">{entries.map(tool => <li className="project-tool-card" key={tool.name}>
          <Button className="project-tool-main" aria-haspopup="dialog" aria-label={`${t('toolDescription')}: ${tool.name}`} onClick={event => {opener.current = event.currentTarget; setViewedTool(tool);}}>
            <span className="project-tool-name">{tool.name}</span><span className="project-tool-description">{tool.description}</span>
          </Button>
        </li>)}</ul>
      </section>;
    })}
    <ProjectScrollableModal open={viewedTool !== null} onClose={closeDescription} title={viewedTool?.name ?? ''}
      description={t('toolDescription')} closeLabel={t('close')}
      footer={<Button variant="outline" autoFocus onClick={closeDescription}>{t('close')}</Button>}>
      <p className="project-tool-full-description">{viewedTool?.description}</p>
    </ProjectScrollableModal>
  </>;
}
