import {useEffect, useMemo, useState} from 'react';
import {
  Button, IconCheckOutline16, IconCloseOutline16, IconEditOutline16, MarkdownText, Tooltip,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {PropsLocale} from '@deepseek-ai/dsh-client-ui-slots';
import type {MemoryView} from '../project.ts';

const MEMORY_BYTES_LIMIT = 64_000;

function MemoryDocument({item, labels, save, t}: {
  item: MemoryView;
  labels: MarkdownLabels;
  save(id: string, content: string): Promise<void>;
} & PropsLocale<'project'>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'memoryTooLarge' | 'memorySaveError'>();
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
      {!editing && <Tooltip label={t('edit')} side="top" delayMs={400}>
        <span className="project-memory-action-anchor"><Button size="sm" icon={<IconEditOutline16 />}
          aria-label={t('editMemory', {name: item.name})} onClick={() => {setDraft(item.content); setError(undefined); setEditing(true);}} /></span>
      </Tooltip>}
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

/** Render configured memory as Markdown and preserve its raw source while editing. */
export function MemoryPanel({memory, save, t}: {
  memory: MemoryView[];
  save(id: string, content: string): Promise<void>;
} & PropsLocale<'project'>) {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: {copyLabel: t('copy'), copiedLabel: t('copied')},
    footnotes: t('footnotes'),
  }), [t]);
  return <section className="project-memory">
    {memory.length === 0 ? <p>{t('emptyMemory')}</p> : memory.map(item =>
      <MemoryDocument key={item.id} item={item} labels={labels} save={save} t={t} />)}
  </section>;
}
