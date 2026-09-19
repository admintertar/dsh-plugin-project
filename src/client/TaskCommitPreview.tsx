import {useEffect, useSyncExternalStore} from 'react';
import {Button, DiffBlock, DisclosureRow, FileTypeIcon, classifyFileType, Tag} from '@deepseek-ai/dsh-client-ui-primitives';
import {commitWebUrl} from '../task-commit-contract.ts';
import type {TaskCommitView} from './task-commit-view.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';

const errorKeys = {
  'task-commit-resource-unavailable': 'taskCommitResourceMissing', 'task-commit-resource-ambiguous': 'taskCommitResourceAmbiguous',
  'task-commit-origin-mismatch': 'taskCommitOriginMismatch', 'task-commit-state-changed': 'taskCommitChanged',
  'task-revision-conflict': 'taskCommitChanged', 'task-not-found': 'taskCommitChanged',
  'task-commit-too-large': 'taskCommitTooLarge', 'task-commit-fetch-failed': 'taskCommitFetchFailed',
  'task-commit-timeout': 'taskCommitTimeout', 'task-commit-auth': 'taskCommitAuth', 'task-commit-no-git': 'taskCommitNoGit',
  'task-commit-host-unverified': 'gitAuthHost', 'task-commit-auth-remote-changed': 'gitAuthRemoteChanged',
  unauthorized: 'authenticationError',
} as const;
const statuses = {A: 'taskCommitAdded', D: 'taskCommitDeleted', M: 'taskCommitModified', R: 'taskCommitRenamed', C: 'taskCommitCopied', T: 'taskCommitType'} as const;

/** Official inline diff + disclosure primitives, hosted by the task's existing RightbarSeat. */
export function TaskCommitPreview({view, t}: {view: TaskCommitView; t: CapabilityTranslate}) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  useEffect(() => {if (!view.getSnapshot().data && !view.getSnapshot().error) void view.load();}, [view]);
  const {data, loading, fetching, error, selected, diff, fileError, loadingFile} = state;
  const remote = commitWebUrl(view.request.repository, view.request.commit);
  const errorText = (code: string) => t(errorKeys[code as keyof typeof errorKeys] ?? 'taskCommitFailed');
  const missing = data && data.state !== 'ready';
  const labels = {copy: t('copy'), copied: t('copied'), collapse: t('taskCommitCollapse'), collapseAria: t('taskCommitCollapse'),
    expand: (count: number) => t('taskCommitExpand', {count}), expandAria: (count: number) => t('taskCommitExpand', {count}),
    files: (count: number) => t('taskCommitDiffFiles', {count})};
  return <section className="project-task-commit" aria-label={t('taskCommitPreview')} aria-busy={loading}>
    <header>
      <h2>{view.request.title}</h2>
      <p className="project-meta">{data?.resourceName ?? view.request.repository.replace(/\.git$/, '').split('/').pop()} · <code>{view.request.commit.slice(0, 12)}</code></p>
      <div className="project-task-commit-actions">
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void view.load()}>{t('refresh')}</Button>
        {remote && <a href={remote} target="_blank" rel="noopener noreferrer">{t('taskCommitRemote')}</a>}
      </div>
    </header>
    {loading && <p role="status">{t(fetching ? 'taskCommitFetching' : 'capabilityLoading')}</p>}
    {error && <p role="alert" className="project-error">{errorText(error)}</p>}
    {missing && <div className="project-task-commit-missing">
      <p>{t(data.state === 'parent-missing' ? 'taskCommitParentMissing' : 'taskCommitMissing')}</p>
      <p className="project-meta">{t('taskCommitFetchHint')}</p>
      <Button variant="primary" disabled={loading} onClick={() => void view.load(true)}>{t('taskCommitFetch')}</Button>
    </div>}
    {data?.message && <p className="project-prose">{data.message}</p>}
    {data?.author && <p className="project-meta">{data.author}{data.authoredAt && ` · ${new Date(data.authoredAt).toLocaleString(t('dateLocale'))}`}</p>}
    {data?.state === 'ready' && <>
      <p className="project-meta">{data.parents[0] ? t('taskCommitFirstParent', {commit: data.parents[0].slice(0, 12)}) : t('taskCommitRoot')}</p>
      <h3>{t('taskCommitFiles', {count: data.files.length})}</h3>
      {data.files.length === 0 && <p>{t('taskCommitEmpty')}</p>}
      <div className="project-task-commit-files">{data.files.map(file => <DisclosureRow key={file.index}
        className="project-task-commit-file" titleClassName="project-task-commit-path"
        icon={<FileTypeIcon kind={classifyFileType(file.path)} size={16} />} title={file.path}
        open={selected === file.index} expandable={!loading} expandOnRowClick keepContentWhenOpen
        onToggle={() => void view.select(file.index)} collapsedContent={<Tag>{t(statuses[file.status])}</Tag>}>
        <p className="project-meta"><code>{file.path}</code></p>
        {file.previousPath && <p className="project-meta">{file.previousPath} → {file.path}</p>}
        {file.oldMode !== file.newMode && <p className="project-meta">{t('taskCommitMode', {old: file.oldMode, next: file.newMode})}</p>}
        {loadingFile && <p role="status">{t('capabilityLoading')}</p>}
        {fileError && <><p role="alert" className="project-error">{errorText(fileError)}</p><Button size="sm" onClick={() => void view.retryFile()}>{t('retry')}</Button></>}
        {diff?.oldNoNewline && <p className="project-meta">{t('taskCommitOldNoNewline')}</p>}
        {diff?.newNoNewline && <p className="project-meta">{t('taskCommitNewNoNewline')}</p>}
        {diff && (diff.kind === 'text' ? diff.changes.length ? diff.changes.map((change, index) => <DiffBlock key={index}
          diffs={[{path: `${file.path} · ${t('taskCommitLines', {old: change.oldLine, next: change.newLine})}`, oldText: change.oldText, newText: change.newText}]} labels={labels} maxLines={40} />)
          : <p className="project-meta">{t('taskCommitNoTextChange')}</p>
          : <><p className="project-meta">{t(diff.kind === 'binary' ? 'taskCommitBinary' : diff.kind === 'large' ? 'taskCommitLargeFile' : 'taskCommitSubmodule')}</p>
            {diff.kind === 'submodule' && <p className="project-meta"><code>{diff.oldObject.slice(0, 12)} → {diff.newObject.slice(0, 12)}</code></p>}</>)}
      </DisclosureRow>)}</div>
    </>}
  </section>;
}
