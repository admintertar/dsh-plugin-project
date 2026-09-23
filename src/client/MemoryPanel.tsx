import {useEffect, useId, useMemo, useState} from 'react';
import {
  Button, IconCheckOutline16, IconCloseOutline16, IconEditOutline16, IconTrashOutline16, Input, MarkdownText, Modal, Tooltip,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {PropsLocale} from '@deepseek-ai/dsh-client-ui-slots';
import type {MemoryView} from '../project.ts';
import {ProjectAddButton, ProjectScrollableModal, ProjectSettingRow} from './ProjectControls.tsx';

const MEMORY_BYTES_LIMIT = 64_000;
type EditError = 'memoryTooLarge' | 'memorySaveError';
type CreateError = 'memoryTooLarge' | 'memoryCreateError';
type DeleteError = 'memoryDeleteError';

function MemoryDocument({item, labels, save, onRemove, disabled, t}: {
  item: MemoryView;
  labels: MarkdownLabels;
  save(id: string, content: string): Promise<void>;
  onRemove(item: MemoryView): void;
  disabled: boolean;
} & PropsLocale<'project'>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<EditError>();
  const bytes = useMemo(() => new TextEncoder().encode(draft).length, [draft]);

  useEffect(() => {
    if (!editing) setDraft(item.content);
  }, [editing, item.content]);

  const cancel = () => {
    if (saving) return;
    setDraft(item.content);
    setError(undefined);
    setEditing(false);
  };
  const submit = async () => {
    if (saving || draft === item.content) return;
    if (bytes > MEMORY_BYTES_LIMIT) {setError('memoryTooLarge'); return;}
    setSaving(true);
    setError(undefined);
    try {
      await save(item.id, draft);
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === 'body-too-large' ? 'memoryTooLarge' : 'memorySaveError');
    } finally {setSaving(false);}
  };

  return <article className="project-card project-memory-card">
    <div className="project-memory-header">
      <h2>{item.name}</h2>
      {!editing && <div className="project-memory-actions">
        <Tooltip label={t('edit')} side="top" delayMs={400} disabled={disabled}><span className="project-memory-action-anchor">
          <Button size="sm" icon={<IconEditOutline16 />} disabled={disabled}
            aria-label={t('editMemory', {name: item.name})} onClick={() => {setDraft(item.content); setError(undefined); setEditing(true);}} />
        </span></Tooltip>
        <Tooltip label={t('delete')} side="top" delayMs={400} disabled={disabled}><span className="project-memory-action-anchor">
          <Button size="sm" icon={<IconTrashOutline16 />} disabled={disabled}
            aria-label={t('deleteMemory', {name: item.name})} onClick={() => onRemove(item)} />
        </span></Tooltip>
      </div>}
    </div>
    {editing ? <form className="project-memory-editor" onSubmit={event => {event.preventDefault(); void submit();}}>
      {/* DSH has no public Textarea primitive in this pinned version; this follows its Input token contract. */}
      <textarea value={draft} aria-label={t('memoryEditor', {name: item.name})} autoFocus disabled={saving}
        spellCheck={false} onChange={event => {setDraft(event.target.value); setError(undefined);}}
        onKeyDown={event => {if (event.key === 'Escape') cancel();}} />
      <div className="project-memory-editor-footer">
        <span className={bytes > MEMORY_BYTES_LIMIT ? 'project-error' : undefined}>{t('memorySize', {count: bytes.toLocaleString()})}</span>
        <div className="project-memory-editor-actions">
          <Button type="button" variant="outline" icon={<IconCloseOutline16 />} disabled={saving} onClick={cancel}>{t('cancel')}</Button>
          <Button type="submit" variant="primary" icon={<IconCheckOutline16 />} disabled={saving || draft === item.content || bytes > MEMORY_BYTES_LIMIT}>
            {t(saving ? 'saving' : 'save')}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="project-error">{t(error)}</p>}
    </form> : <div className="project-memory-markdown"><MarkdownText text={item.content} labels={labels} /></div>}
  </article>;
}

/** One short, full-width field row plus the Markdown source, matching the shared settings form. */
function CreateMemoryDialog({open, create, onClose, t}: {
  open: boolean;
  create(name: string, content: string): Promise<void>;
  onClose(): void;
} & PropsLocale<'project'>) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<CreateError>();
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const formId = useId();
  const fieldId = (field: string) => `${formId}-${field}`;

  const close = () => {
    if (saving) return;
    setName('');
    setContent('');
    setError(undefined);
    onClose();
  };
  const submit = async () => {
    if (saving || !name.trim()) return;
    if (bytes > MEMORY_BYTES_LIMIT) {setError('memoryTooLarge'); return;}
    setSaving(true);
    setError(undefined);
    try {
      await create(name.trim(), content);
      setName('');
      setContent('');
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && reason.message === 'body-too-large' ? 'memoryTooLarge' : 'memoryCreateError');
    } finally {setSaving(false);}
  };

  return <ProjectScrollableModal open={open} title={t('addMemory')} closeLabel={t('close')} onClose={close}
    footer={<><Button variant="outline" disabled={saving} onClick={close}>{t('cancel')}</Button>
      <Button type="submit" form={`${formId}-form`} variant="primary" disabled={saving || !name.trim() || bytes > MEMORY_BYTES_LIMIT}>
        {t(saving ? 'saving' : 'createMemory')}
      </Button></>}>
    <form id={`${formId}-form`} className="project-capability-form" onSubmit={event => {event.preventDefault(); void submit();}}>
      <fieldset disabled={saving}>
        <ProjectSettingRow title={t('memoryName')} description={t('memoryNameBody')} htmlFor={fieldId('name')} layout="input">
          <Input id={fieldId('name')} aria-describedby={`${fieldId('name')}-description`} value={name} required maxLength={160}
            autoFocus onChange={event => {setName(event.target.value); setError(undefined);}} />
        </ProjectSettingRow>
        <ProjectSettingRow title={t('memoryContent')} description={t('memoryContentBody')} htmlFor={fieldId('content')} layout="stacked">
          <textarea id={fieldId('content')} className="project-textarea project-memory-create-source" rows={14}
            aria-describedby={`${fieldId('content')}-description`} value={content} spellCheck={false}
            onChange={event => {setContent(event.target.value); setError(undefined);}} />
          <span className={`project-memory-create-size${bytes > MEMORY_BYTES_LIMIT ? ' project-error' : ''}`}>
            {t('memorySize', {count: bytes.toLocaleString()})}
          </span>
        </ProjectSettingRow>
        {error && <p role="alert" className="project-error">{t(error)}</p>}
      </fieldset>
    </form>
  </ProjectScrollableModal>;
}

/** Render configured memory as Markdown, and offer the create, edit and delete paths. */
export function MemoryPanel({memory, save, create, remove, t}: {
  memory: MemoryView[];
  save(id: string, content: string): Promise<void>;
  create(name: string, content: string): Promise<void>;
  remove(id: string): Promise<void>;
} & PropsLocale<'project'>) {
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<MemoryView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<DeleteError>();
  const busy = deleting;
  const labels = useMemo<MarkdownLabels>(() => ({
    code: {copyLabel: t('copy'), copiedLabel: t('copied')},
    footnotes: t('footnotes'),
  }), [t]);
  const closeRemove = () => {
    if (deleting) return;
    setRemoving(null);
    setError(undefined);
  };
  return <section className="project-memory">
    {memory.length === 0 ? <p>{t('emptyMemory')}</p> : memory.map(item =>
      <MemoryDocument key={item.id} item={item} labels={labels} save={save} onRemove={setRemoving} disabled={busy} t={t} />)}
    <ProjectAddButton disabled={busy} onClick={() => setCreating(true)}>{t('addMemory')}</ProjectAddButton>
    <CreateMemoryDialog open={creating} create={create} onClose={() => setCreating(false)} t={t} />
    <Modal open={removing !== null} title={t('deleteMemoryTitle')} closeLabel={t('close')} onClose={closeRemove}
      footer={<><Button variant="outline" disabled={deleting} onClick={closeRemove}>{t('cancel')}</Button>
        <Button variant="primary" disabled={deleting} onClick={() => {
          if (!removing) return;
          setDeleting(true);
          setError(undefined);
          void remove(removing.id).then(() => setRemoving(null))
            .catch(() => setError('memoryDeleteError'))
            .finally(() => setDeleting(false));
        }}>{t(deleting ? 'deleting' : 'delete')}</Button></>}>
      <p>{t('deleteMemoryBody', {name: removing?.name ?? ''})}</p>
      {error && <p role="alert" className="project-error">{t(error)}</p>}
    </Modal>
  </section>;
}
