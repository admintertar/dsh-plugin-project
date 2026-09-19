import {useCallback, type ComponentType} from 'react';
import {defineStore, type BoundActions, type StoreDecl} from '@deepseek-ai/dsh-client-store';
import type {} from '@deepseek-ai/dsh-client-resources/client';
import type {TabId} from '@deepseek-ai/dsh-client-ui-dockkit';
import type {Context} from '@deepseek-ai/cordis';
import type {PropsRuntime, PropsRenderSlots, SlotMap, StoredEntry} from '@deepseek-ai/dsh-client-ui-slots';
import type {TextPreviewProps, TextInjected, TextStore} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client';
import type {UseSidebarRightTabInfo} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {TaskFilePreview} from '../api-types.ts';
import type {ProjectCapabilityController} from './controller.ts';

/** File authority is a registered Task item, never a Session or a client-supplied path. */
export interface TaskPreviewRequest {id: string; kind: 'artifact'|'reference'; index: number; revision: string; path: string}
const PREVIEW = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview';

// The official viewer currently parses a Session-shaped address. This reserved,
// transient UI namespace is never sent to workspaceFiles or written to Task data.
export const TASK_PREVIEW_SCOPE = 'project-task-preview';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'project.task.preview': {
      kind: 'single'; scope: 'root'; owner: {request: TaskPreviewRequest};
      hookContext: UseSidebarRightTabInfo;
      inject: {hooks: {tabInfo: (_standard: unknown, hook: UseSidebarRightTabInfo) => UseSidebarRightTabInfo}};
    };
    'project.task.document': Omit<SlotMap['sidebar.right.tab.document'], 'scope'|'owner'|'inject'> & {
      scope: 'root'; owner: SlotMap['sidebar.right.tab.document']['owner'] & {request: TaskPreviewRequest};
      inject: {hooks: {tabInfo: (_standard: unknown, hook: UseSidebarRightTabInfo) => UseSidebarRightTabInfo}};
    };
  }
}
export const taskPreviewSlot = {kind: 'single', scope: 'root', inject: {hooks: {tabInfo: (_: unknown, hook: UseSidebarRightTabInfo) => hook}}} as const;

/** Decode bounded API bytes; text renderers reject binary or malformed UTF-8. */
export function taskFileBytes(file: TaskFilePreview): Uint8Array<ArrayBuffer> {
  return file.text !== undefined ? new TextEncoder().encode(file.text)
    : Uint8Array.from(atob(file.base64 ?? ''), character => character.charCodeAt(0));
}

/** Bind the official viewer's read actions to the Task API and its tab lifetime. */
export function taskPreviewReads(controller: Pick<ProjectCapabilityController, 'taskFile'>, request: TaskPreviewRequest,
  actions: BoundActions<TextStore>): TextInjected & {dispose(): void} {
  const generations = new Map<string, AbortController>();
  const lifetimes = new Map<AbortSignal, () => void>();
  const load = (tabId: TabId, offset: number, signal: AbortSignal, bytes: boolean, reset: boolean) => {
    if (signal.aborted) return;
    generations.get(tabId)?.abort();
    const generation = new AbortController(); generations.set(tabId, generation);
    if (!lifetimes.has(signal)) {
      const forget = () => {generations.get(tabId)?.abort(); generations.delete(tabId); actions.forget(tabId); lifetimes.delete(signal);};
      lifetimes.set(signal, forget); signal.addEventListener('abort', forget, {once: true});
    }
    if (reset) actions.reset(tabId);
    actions.loading(tabId, bytes ? 'bytes-complete' : 'text-pages');
    const live = () => !signal.aborted && !generation.signal.aborted;
    void controller.taskFile(request.id, request.kind, request.index, request.revision, AbortSignal.any([signal, generation.signal])).then(file => {
      if (!live()) return;
      const data = taskFileBytes(file);
      const metadata = {absolutePath: request.path, version: file.version, bytes: file.size};
      if (bytes) actions.complete(tabId, {...metadata, data, offset: 0, eof: true});
      else {
        if (data.byteLength > 1024 * 1024) throw new Error('task-file-too-large');
        const text = new TextDecoder('utf-8', {fatal: true}).decode(data);
        if (text.includes('\0')) throw new Error('task-file-not-text');
        const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
        // The Task API returns a bounded snapshot; publish it as one complete page
        // so a later file edit can never mix two versions in the same document.
        actions.page(tabId, {...metadata, offset, text: lines.slice(offset - 1).join('\n'), lines: Math.max(0, lines.length - offset + 1), eof: true});
      }
    }).catch(error => {
      if (!live()) return;
      const message = error instanceof Error ? error.message : 'task-file-unavailable';
      const code = message === 'task-file-too-large' ? 'workspace-file/too-large'
        : message === 'task-file-not-text' || error instanceof TypeError ? 'workspace-file/not-text' : 'workspace-file/not-found';
      actions.failed(tabId, {code, message, details: {path: request.path, ...(code === 'workspace-file/too-large' ? {limit: (bytes ? 32 : 1) * 1024 * 1024} : {})}} as Parameters<typeof actions.failed>[1]);
    });
  };
  return {
    loadPage: (id, _file, offset, signal) => load(id, offset, signal, false, false),
    reloadPages: (id, _file, signal) => load(id, 1, signal, false, true),
    loadAll: (id, _file, signal) => load(id, 1, signal, true, false),
    reloadAll: (id, _file, signal) => load(id, 1, signal, true, true),
    dispose() {for (const read of generations.values()) read.abort(); for (const [signal, forget] of lifetimes) {signal.removeEventListener('abort', forget); forget();}},
  };
}

/** New root Store declarations retain official actions without sharing chat state. */
function independentStore(declaration?: StoreDecl): StoreDecl | undefined {
  if (!declaration) return undefined;
  const handle = typeof declaration === 'function' ? declaration() : declaration;
  return defineStore({...handle.spec, persist: undefined});
}

/**
 * Rehost registered official components through root Slots. Only the Slot scope
 * and file reader differ; the viewer, renderer implementations and CSS are the
 * exact same objects installed by ui-sidebar-documentpreview. Remove this bridge
 * when upstream exports a host-independent preview entry point.
 */
export function registerTaskPreview(ctx: Context, controller: ProjectCapabilityController): void {
  ctx.slots.inject('project.task.preview', () => {
    let disposeBody: (() => void) | undefined;
    // Readers survive viewer/tab remounts, but only for the tab's lifetime.
    // Closing a tab releases its request and store state, even if Tasks stays open.
    const readers = new Map<AbortSignal, {reads: ReturnType<typeof taskPreviewReads>; dispose(): void}>();
    let current: StoredEntry | undefined;
    const sync = () => {
      const entry = ctx.slots.entriesOfSlot('sidebar.right.pane.tab').find(item => item.options.key === PREVIEW);
      if (entry === current) return;
      disposeBody?.(); for (const reader of readers.values()) reader.dispose(); readers.clear(); current = entry;
      if (!entry) return;
      const OfficialPreview = entry.component as ComponentType<TextPreviewProps>;
      const Wrapper = (props: PropsRuntime<'project.task.preview'> & PropsRenderSlots<'project.task.document'> & TextPreviewProps) => {
        const {tab} = props.useTabInfo();
        let reader = readers.get(tab.signal);
        if (!reader) {
          const reads = taskPreviewReads(controller, props.request, props.actions);
          const dispose = () => {tab.signal.removeEventListener('abort', dispose); reads.dispose(); readers.delete(tab.signal);};
          reader = {reads, dispose}; readers.set(tab.signal, reader);
          tab.signal.addEventListener('abort', dispose, {once: true});
        }
        const version = props.useStore(state => state.byTab[tab.id]?.version);
        return <OfficialPreview {...props} {...reader.reads}
          useResource={(() => ({status: 'live', value: {absolutePath: props.request.path, version: version ?? ''}, failure: undefined})) as TextPreviewProps['useResource']}
          renderSlot={((_name: unknown, owner: SlotMap['sidebar.right.tab.document']['owner'], options: never) =>
            props.renderSlot('project.task.document', {...owner, request: props.request}, options)) as TextPreviewProps['renderSlot']} />;
      };
      // StoredEntry is deliberately type-erased by the official registry. This
      // boundary adapts session inject positions to the root registration only.
      disposeBody = ctx.slots.register({name: 'project.task.preview', locale: entry.locale,
        store: independentStore(entry.store), children: {'project.task.document': {...taskPreviewSlot, kind: 'keyed'}},
        inject: (actions: unknown) => (entry.inject as Function)(TASK_PREVIEW_SCOPE, actions),
      } as never, Wrapper as never);
    };
    const unsubscribe = ctx.slots.subscribe('sidebar.right.pane.tab', sync); sync();
    return () => {unsubscribe(); disposeBody?.(); for (const reader of readers.values()) reader.dispose(); readers.clear();};
  });
  ctx.slots.inject('project.task.document', () => {
    const installed = new Map<StoredEntry, () => void>();
    const sync = () => {
      const entries = ctx.slots.entriesOfSlot('sidebar.right.tab.document');
      for (const [entry, dispose] of installed) if (!entries.includes(entry)) {dispose(); installed.delete(entry);}
      for (const entry of entries) if (!installed.has(entry)) {
        const OfficialDocument = entry.component as ComponentType<Record<string, unknown>>;
        const Wrapper = (props: PropsRuntime<'project.task.document'>) => {
          const readRelated = useCallback(async (_address: string, path: string, signal: AbortSignal) => {
            try {const file = await controller.taskFile(props.request.id, props.request.kind, props.request.index, props.request.revision, signal, path);
              return {ok: true, value: {absolutePath: path, version: file.version, bytes: file.size, offset: 0, eof: true,
                data: file.base64 ?? btoa(Array.from(taskFileBytes(file), byte => String.fromCharCode(byte)).join(''))}};
            } catch {return {ok: false, error: {code: 'workspace-file/not-found', message: 'Task asset unavailable', details: {path}}};}
          }, [props.request]);
          return <OfficialDocument {...props} readRelated={readRelated} />;
        };
        installed.set(entry, ctx.slots.register({name: 'project.task.document', key: entry.options.key, locale: entry.locale,
          store: independentStore(entry.store),
          ...(entry.inject ? {inject: (...args: unknown[]) => (entry.inject as Function)(TASK_PREVIEW_SCOPE, ...args)} : {}),
        } as never, Wrapper as never));
      }
    };
    const unsubscribe = ctx.slots.subscribe('sidebar.right.tab.document', sync); sync();
    return () => {unsubscribe(); for (const dispose of installed.values()) dispose();};
  });
}
