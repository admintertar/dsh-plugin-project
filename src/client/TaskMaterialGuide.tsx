import {useSyncExternalStore} from 'react';
import {Button, FileTypeIcon, classifyFileType, IconBranchOutline16} from '@deepseek-ai/dsh-client-ui-primitives';
import type {TaskSidebarRequest} from './task-sidebar-controller.ts';
import type {ProjectCapabilityController} from './controller.ts';
import {CapabilityError, type CapabilityTranslate} from './capability-ui.tsx';

function safeUrl(value: string): string | undefined {
  try {const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;}
  catch {return undefined;}
}

/** The official guide's task-specific content uses shared Buttons and icons.
 * Opening a file replaces this guide in its own pane, like the official guide.
 */
export function TaskMaterialGuide({controller, openFile, t}: {
  controller: ProjectCapabilityController; t: CapabilityTranslate;
  openFile(request: TaskSidebarRequest, opener: HTMLElement): void;
}) {
  const view = useSyncExternalStore(controller.taskView.subscribe, controller.taskView.getSnapshot);
  const detail = !view.selectedId || view.detail?.task.id === view.selectedId ? view.detail : undefined;
  const task = detail?.task;
  const file = (path: string, label: string, kind: 'artifact'|'reference', index: number, available: boolean) => <>
    <Button variant="outline" className="project-task-material-file" disabled={!available || view.detailLoading || !!view.detailError}
      icon={<FileTypeIcon kind={classifyFileType(path)} size={16} />} title={label === path ? path : `${label}\n${path}`}
      onClick={event => {if (task) openFile({id: task.id, revision: task.revision, kind, index, path}, event.currentTarget);}}>
      <span>{label}</span>
    </Button>
    <small className="project-meta">{available ? path : t(kind === 'artifact' ? 'artifactUnavailable' : 'taskReferenceUnavailable')}</small>
  </>;
  return <section className="project-task-materials" aria-label={t('taskMaterials')} aria-busy={view.detailLoading}>
    <header><h2>{task?.title ?? t('taskMaterials')}</h2><p className="project-meta">{t('taskMaterialsHint')}</p></header>
    <CapabilityError error={view.detailError} t={t} />
    {!task || !detail ? <p role={view.detailLoading ? 'status' : undefined}>{t(view.detailLoading ? 'capabilityLoading' : 'selectTask')}</p> : <>
      <section><h3>{t('taskArtifacts')}</h3>
        {!task.artifacts.length && <p className="project-meta">{t('taskNoArtifacts')}</p>}
        <ul>{task.artifacts.map((item, index) => <li key={index}>
          {item.type === 'file' ? file(item.path, item.description ?? item.path.split('/').pop()!, 'artifact', index, !!detail.artifactPaths[index])
            : item.type === 'url' ? safeUrl(item.url) ? <a href={safeUrl(item.url)} target="_blank" rel="noopener noreferrer">{item.description ?? item.url}</a> : <span>{item.description ?? item.url}</span>
              : item.type === 'commit' ? <><Button variant="outline" className="project-task-material-file" icon={<IconBranchOutline16 />}
                disabled={view.detailLoading || !!view.detailError} aria-label={t('taskCommitOpen', {commit: item.commit.slice(0, 12)})}
                onClick={event => openFile({id: task.id, index, revision: task.revision, kind: 'commit', repository: item.repository,
                  commit: item.commit, title: item.description ?? item.commit.slice(0, 12)}, event.currentTarget)}><span>{item.description ?? item.commit.slice(0, 12)}</span></Button><small className="project-meta">{item.commit.slice(0, 12)}</small></>
                : <span className="project-prose">{item.description}</span>}
        </li>)}</ul>
      </section>
      <section><h3>{t('taskReferences')}</h3>
        {!task.references.length && <p className="project-meta">{t('taskNoReferences')}</p>}
        <ul>{task.references.map((item, index) => <li key={item.id}>
          {item.type === 'file' ? file(item.path, item.label, 'reference', index, !!detail.referencePaths[index])
            : item.type === 'url' ? safeUrl(item.url) ? <a href={safeUrl(item.url)} target="_blank" rel="noopener noreferrer">{item.label}</a> : <span>{item.label} · {item.url}</span>
              : item.type === 'task' ? <Button variant="outline" title={item.label} onClick={() => controller.taskView.select(item.taskId)}><span>{item.label}</span></Button>
                : <><strong>{item.label}</strong><span className="project-prose">{item.text}</span></>}
        </li>)}</ul>
      </section>
    </>}
  </section>;
}
