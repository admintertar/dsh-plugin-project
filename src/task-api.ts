import {constants, openSync, closeSync, fstatSync, readFileSync, realpathSync} from 'node:fs';
import {extname, basename, dirname, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {isAbsolute, relative} from 'node:path';
import type {IncomingMessage} from 'node:http';
import type {Context} from '@deepseek-ai/cordis';
import type {SessionId} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-workspace';
import {z} from 'zod';
import {ProjectHttpError, readJsonBody} from './http.ts';
import type {ProjectView} from './project.ts';
import type {ProjectTaskStore} from './tasks.ts';
import {operationIdSchema, revisionSchema, taskIdSchema, taskStatusSchema,
  type ProjectTaskDiagnostic, type TaskSource} from './task-contract.ts';
import type {TaskDetail, TaskParticipantView, TasksSnapshot} from './api-types.ts';
import {TaskCommitReader} from './task-commits.ts';
import type {ResourceGitAuthentication} from './resource-auth.ts';

type Register = (path: string, methods: string[], operation: (req: IncomingMessage, signal: AbortSignal) => Promise<unknown>) => void;
const archiveSchema = z.object({action: z.literal('archive'), id: taskIdSchema, archived: z.boolean(),
  expectedRevision: revisionSchema, operationId: operationIdSchema}).strict();
const listSchema = z.object({query: z.string().max(240).optional(), status: taskStatusSchema.optional(),
  includeArchived: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(2000).optional()}).strict();

function query(req: IncomingMessage): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(req.url ?? '/', 'http://localhost').searchParams) {
    if (Object.hasOwn(values, key)) throw new ProjectHttpError(422, 'invalid-task-query');
    values[key] = value;
  }
  return values;
}

/** Only structured categories and project-relative locations cross the HTTP boundary. */
function publicDiagnostics(root: string, diagnostics: ProjectTaskDiagnostic[]): ProjectTaskDiagnostic[] {
  return diagnostics.map(item => {
    const path = (isAbsolute(item.path) ? relative(root, item.path) : item.path).replaceAll('\\', '/');
    return {code: item.code, error: item.code,
      path: path === 'tasks' || (path.startsWith('tasks/') && !path.split('/').includes('..')) ? path : 'tasks'};
  });
}

/** Use the official cold reader so a restart does not erase historical participation. */
async function participant(ctx: Context, root: string, item: TaskSource): Promise<TaskParticipantView> {
  const result: TaskParticipantView = {availability: 'unavailable'};
  try {
    const sessionId = item.sessionId as SessionId;
    const reader = ctx.get('sessionQuery');
    const observation = reader ? await reader.readTitleSnapshot(sessionId) : undefined;
    const header = observation?.session ?? ctx.sessions.get(sessionId)?.header;
    if (!header || header.cwd !== root || header.origin === 'subagent') return result;
    return {...result, sessionId: item.sessionId, title: observation?.title?.title,
      availability: ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId) ? 'archived' : 'available'};
  } catch {return result;}
}

/** Task reads and writes share the Store contract; these routes never start or submit a conversation. */
export function registerTaskApi(ctx: Context, register: Register, read: () => ProjectView,
  store: () => ProjectTaskStore, assertOpen: () => void, auth?: ResourceGitAuthentication): () => Promise<void> {
  const commits = new TaskCommitReader(read, store, undefined, auth);
  const commitRequest = z.object({id: taskIdSchema, index: z.coerce.number().int().min(0).max(199), revision: revisionSchema}).strict();
  register('tasks/commit', ['GET'], async (req, signal) => {
    const {file, ...request} = commitRequest.extend({file: z.coerce.number().int().min(0).max(1999).optional()}).parse(query(req));
    return commits.preview(request, {file, signal});
  });
  register('tasks/commit/fetch', ['POST'], async (req, signal) => {
    const request = commitRequest.parse(await readJsonBody(req));
    assertOpen(); return commits.preview(request, {fetch: true, signal});
  });
  const snapshot = (args: z.output<typeof listSchema>): TasksSnapshot => {
    const root = read().root;
    const tasks = store();
    const page = tasks.listPage({...args, includeArchived: args.includeArchived === 'true'});
    const diagnostics = publicDiagnostics(root, page.diagnostics);
    const data = {...page, diagnostics, invalidTaskCount: page.diagnostics.filter(item => item.code === 'invalid-task').length};
    return {...data, version: createHash('sha256').update(JSON.stringify(data)).digest('hex')};
  };
  register('tasks', ['GET', 'POST'], async req => {
    read();
    const args = listSchema.parse(query(req));
    if (req.method === 'POST') {
      const action = archiveSchema.parse(await readJsonBody(req));
      assertOpen();
      store().setArchived(action.id, action.archived, action);
      // Any successful mutation changes the pagination revision. Return a new
      // first page, never report the committed write as a stale-cursor failure.
      delete args.cursor;
    }
    return snapshot(args);
  });
  register('tasks/detail', ['GET'], async req => {
    const args = z.object({id: taskIdSchema, cursor: z.string().max(2000).optional()}).strict().parse(query(req));
    const root = read().root;
    const tasks = store();
    const detail = tasks.detail(args.id, {cursor: args.cursor});
    const sources = tasks.sources(args.id);
    const participation = [...new Map(Object.values(sources).map(source => [source.sessionId, source])).values()];
    const participants: TaskParticipantView[] = [];
    // Bound parallel disk observations; the local file size bounds the total retained history.
    for (let offset = 0; offset < participation.length; offset += 8) {
      participants.push(...await Promise.all(participation.slice(offset, offset + 8).map(item => participant(ctx, root, item))));
    }
    assertOpen();
    if (read().root !== root) throw new ProjectHttpError(409, 'project-session-unavailable');
    const available = new Set(participants.filter(item => item.availability === 'available').map(item => item.sessionId));
    const sourceSessionIds = Object.fromEntries(detail.task.entries.map(entry => {
      const source = sources[entry.id]?.sessionId;
      return [entry.id, source && available.has(source) ? source : null];
    }));
    return {...detail, participants, sourceSessionIds,
      artifactPaths: detail.task.artifacts.map(artifact => tasks.artifactPath(detail.task, artifact) ?? null),
      referencePaths: detail.task.references.map(reference => reference.type === 'file'
        ? tasks.referencePath(reference) ?? null : null),
      diagnostics: [],
    } satisfies TaskDetail;
  });
  register('tasks/file', ['GET'], async req => {
    const args = z.object({id: taskIdSchema, kind: z.enum(['artifact', 'reference']), index: z.coerce.number().int().min(0), revision: revisionSchema,
      related: z.string().min(1).max(4000).optional()}).strict().parse(query(req));
    const tasks = store(); const task = tasks.get(args.id);
    if (task.revision !== args.revision) throw new ProjectHttpError(409, 'task-revision-conflict');
    const item = args.kind === 'artifact' ? task.artifacts[args.index] : task.references[args.index];
    if (!item || item.type !== 'file') throw new ProjectHttpError(404, 'task-file-unavailable');
    let path = args.kind === 'artifact' ? tasks.artifactPath(task, item) : tasks.referencePath(item as import('./task-contract.ts').TaskReference);
    if (!path) throw new ProjectHttpError(404, 'task-file-unavailable');
    // HTML's official renderer may request only local JS/CSS under the registered
    // document's directory. It never gains a general-purpose filesystem reader.
    if (args.related !== undefined) {
      if (!['.html', '.htm'].includes(extname(path).toLowerCase()) || !/\.(?:js|css)$/i.test(args.related)
        || /[\\?#:\x00]/.test(args.related) || isAbsolute(args.related) || args.related.split('/').includes('..')) throw new ProjectHttpError(422, 'invalid-task-query');
      const root = dirname(path); const target = resolve(root, args.related);
      try {if (!realpathSync(target).startsWith(root + sep) || realpathSync(target) !== target) throw new Error('outside document');}
      catch {throw new ProjectHttpError(404, 'task-file-unavailable');}
      path = target;
    }
    const maxBytes = args.related === undefined ? 32 * 1024 * 1024 : 4 * 1024 * 1024;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new ProjectHttpError(404, 'task-file-unavailable');
      if (info.size > maxBytes) throw new ProjectHttpError(413, 'task-file-too-large');
      data = readFileSync(fd);
    } finally {closeSync(fd);}
    if (data.length > maxBytes) throw new ProjectHttpError(413, 'task-file-too-large');
    const extension = extname(path).toLowerCase();
    const mime = ({'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf'} as Record<string, string>)[extension];
    const textFile = args.related === undefined && !data.includes(0) && !mime && data.length <= 1024 * 1024;
    return {name: basename(path), version: createHash('sha256').update(data).digest('hex'), mime: mime ?? (textFile ? 'text/plain' : 'application/octet-stream'),
      ...(textFile ? {text: data.toString('utf8')} : {base64: data.toString('base64')}), extension, size: data.length};
  });
  return () => commits.dispose();
}
