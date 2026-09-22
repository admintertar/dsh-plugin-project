import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage} from 'node:http';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {ProjectHttpError, readJsonBody, requireAuthenticatedRequest, sendJson, sendProjectError} from './http.ts';
import type {ProjectResourceStore} from './project-resources.ts';
import type {ResourceCloneManager} from './resource-clones.ts';
import {ResourceSyncManager} from './resource-sync.ts';
import {gitKeyChoices} from './resource-auth.ts';
import {pickSource} from './directory-pick.ts';
import {mapProjectChanges, parseMcpServers, type ProjectChangeContext, type ProjectChangesSnapshot} from './project-changes.ts';
import {ProjectTaskStore} from './tasks.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const name = z.string().trim().min(1).max(160);
const path = z.string().min(1).max(8000);
const expectedRevision = z.string().length(64);
const url = z.string().min(1).max(4096);
const branch = z.string().max(255).optional();
const actionSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('addLocal'), expectedRevision, path, name, type: z.enum(['git', 'local']), url: url.optional()}).strict(),
  z.object({action: z.literal('edit'), expectedRevision, id, name, url: url.optional(), branch}).strict(),
  z.object({action: z.literal('associate'), expectedRevision, id, url, branch}).strict(),
  z.object({action: z.literal('bind'), expectedRevision, id, path, originChoice: z.enum(['keep', 'replace']).optional()}).strict(),
  z.object({action: z.literal('remove'), expectedRevision, id}).strict(),
]);
const cloneSchema = z.object({requestId: z.string().min(1).max(128), expectedRevision, id: id.optional(), name, url, path, branch}).strict();

/** Picked paths are checked again by the Host, behind the same DSH authentication as the other project APIs. */
export function registerResourceApi(ctx: Context, store: ProjectResourceStore, clones: ResourceCloneManager,
  sync = new ResourceSyncManager(clones)): () => Promise<void> {
  let closing = false;
  let tail: Promise<unknown> = Promise.resolve();
  const open = () => {if (closing) throw new ProjectHttpError(503, 'project-closing');};
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const task = tail.then(() => {open(); return work();});
    tail = task.catch(() => {}); return task;
  };
  const canPick = () => pickSource(ctx) !== null;
  const snapshot = () => {const source = pickSource(ctx); return sync.snapshot(source !== null, source);};
  const requirePicker = () => {if (!canPick()) throw new ProjectHttpError(409, 'native-picker-unavailable');};
  const register = (path: string, methods: string[], handler: (req: IncomingMessage) => Promise<unknown>, prefix = false) => {
    ctx.effect(() => ctx.webServer.register({kind: prefix ? 'prefix' : 'exact', path: `/api/project/resources${path}`,
      async handler(req, res) {
        try {requireAuthenticatedRequest(ctx, req, methods); open(); sendJson(res, await handler(req));}
        catch (error) {sendProjectError(res, error, methods);}
      },
    }), `project: resources${path} API`);
  };
  register('', ['GET', 'POST'], async req => {
    if (req.method === 'POST') {
      const action = actionSchema.parse(await readJsonBody(req));
      await queue(async () => {
        if (action.action === 'addLocal' || action.action === 'bind') requirePicker();
        if ('id' in action) {clones.assertMutable(action.id); sync.assertMutable(action.id);}
        await store.mutate(action);
        if (action.action === 'bind' || action.action === 'remove') clones.releaseResource(action.id);
        clones.invalidate();
        if ('id' in action) sync.invalidate(action.id);
      });
    }
    return snapshot();
  });
  register('/inspect', ['POST'], async req => {
    requirePicker(); const action = z.object({path}).strict().parse(await readJsonBody(req));
    open(); return store.inspect(action.path);
  });
  register('/clone', ['POST'], async req => {
    const action = cloneSchema.parse(await readJsonBody(req));
    const operation = await queue(() => {if (action.id) sync.assertMutable(action.id); return clones.start(action);});
    return {operation};
  });
  register('/sync', ['POST'], async req => {
    const action = z.object({id, action: z.enum(['check', 'update', 'commit', 'push', 'switch']), expectedRevision,
      message: z.string().max(4096).optional(), branch: z.string().max(255).optional()}).strict().parse(await readJsonBody(req));
    // `commit` carries the message and `switch` the target branch; the other actions take neither.
    const input = action.action === 'commit' ? action.message : action.action === 'switch' ? action.branch : undefined;
    await queue(() => {sync.start(action.id, action.action, action.expectedRevision, true, input); return Promise.resolve();});
    return {accepted: true};
  });
  register('/branches', ['GET'], async req => {
    const resource = id.parse(new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? '');
    return sync.branches(resource);
  });
  register('/changes', ['GET'], async req => {
    const resource = id.parse(new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? '');
    return sync.changes(resource);
  });
  register('/auth', ['GET', 'POST'], async req => {
    store.revision();
    if (req.method === 'POST') {
      const body = z.object({id: z.string().uuid(), credential: z.unknown()}).strict().parse(await readJsonBody(req, 24 * 1024));
      if (!clones.auth) throw new ProjectHttpError(409, 'git-auth-expired');
      clones.auth.answer(body.id, body.credential);
    }
    return clones.auth?.snapshot() ?? {requests: []};
  });
  register('/auth/keys', ['GET'], async () => {store.revision(); return {keys: gitKeyChoices()};});
  register('/operations', ['POST'], async req => {
    const match = /^\/api\/project\/resources\/operations\/([a-f0-9-]{36})\/(cancel|register)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!match) throw new ProjectHttpError(404, 'operation-not-found');
    const body = await readJsonBody(req);
    if (match[2] === 'cancel') {z.object({}).strict().parse(body); open(); await clones.cancel(match[1]!);}
    else {
      const action = z.object({expectedRevision}).strict().parse(body);
      await queue(() => clones.register(match[1]!, action.expectedRevision));
    }
    return snapshot();
  }, true);
  const repositorySchema = z.object({action: z.enum(['check', 'update', 'push', 'switch']), expectedRevision,
    branch: z.string().max(255).optional()}).strict();
  /** The project repository is not a managed resource, so it has its own route and never takes a resource id. */
  const registerRepository = (path: string, methods: string[], handler: (req: IncomingMessage) => Promise<unknown>) => {
    ctx.effect(() => ctx.webServer.register({kind: 'exact', path: `/api/project/repository${path}`,
      async handler(req, res) {
        try {requireAuthenticatedRequest(ctx, req, methods); open(); sendJson(res, await handler(req));}
        catch (error) {sendProjectError(res, error, methods);}
      },
    }), `project: repository${path} API`);
  };
  registerRepository('', ['GET', 'POST'], async req => {
    if (req.method !== 'POST') return sync.projectRootStatus();
    const action = repositorySchema.parse(await readJsonBody(req));
    // `switch` carries the target branch; the other actions take neither.
    const input = action.action === 'switch' ? action.branch : undefined;
    await queue(() => {void sync.startProjectRoot(action.action, action.expectedRevision, true, input); return Promise.resolve();});
    return {accepted: true};
  });
  registerRepository('/branches', ['GET'], async () => sync.projectRootBranches());
  /** Asset-level review of the project root: Git reports files, the overview reviews project assets. */
  const changeSnapshot = async (): Promise<ProjectChangesSnapshot> => {
    const status = await sync.projectRootStatus();
    // A project root that is not a Git working tree still answers, so the panel can explain it.
    if (status.repository === undefined) return {revision: status.revision, available: false, entries: []};
    const changes = await sync.projectRootChanges();
    const project = store.read();
    const readDeclaration = (path: string): string | undefined => {
      try {
        const info = statSync(path);
        return info.isFile() && info.size <= 1_000_000 ? readFileSync(path, 'utf8') : undefined;
      } catch {return undefined;}
    };
    const headDeclaration = await clones.run(['show', 'HEAD:mcp/servers.yaml'], project.root).catch(() => undefined);
    let tasks: ProjectChangeContext['tasks'] = [];
    // A damaged task directory must not hide the rest of the review.
    try {
      tasks = new ProjectTaskStore(project).list().tasks
        .map(task => ({directory: task.directory, title: task.title, artifactCount: task.artifacts.length}));
    } catch {tasks = [];}
    const context: ProjectChangeContext = {memory: project.memory.map(item => ({id: item.id, name: item.name, path: item.path})),
      tasks, mcpWorking: parseMcpServers(readDeclaration(join(project.root, 'mcp', 'servers.yaml'))), mcpHead: parseMcpServers(headDeclaration)};
    const repository = status.repository;
    return {revision: status.revision, available: repository !== undefined,
      ...(repository?.branch === undefined ? {} : {branch: repository.branch}),
      ...(repository?.url === undefined ? {} : {url: repository.url}),
      ...(repository?.sync === undefined ? {} : {sync: {status: repository.sync.status,
        ...(repository.sync.dirty === undefined ? {} : {dirty: repository.sync.dirty}),
        ...(repository.sync.ahead === undefined ? {} : {ahead: repository.sync.ahead}),
        ...(repository.sync.behind === undefined ? {} : {behind: repository.sync.behind}),
        ...(repository.sync.error === undefined ? {} : {error: repository.sync.error})}}),
      entries: mapProjectChanges(changes.files, context)};
  };
  registerRepository('/changes', ['GET', 'POST'], async req => {
    if (req.method !== 'POST') return changeSnapshot();
    // One asset per commit: the client sends the ordered list, the Host creates one commit each.
    const action = z.object({action: z.literal('commit'), expectedRevision,
      items: z.array(z.object({message: z.string().min(1).max(4096),
        paths: z.array(z.string().min(1).max(4000)).min(1).max(500)}).strict()).min(1).max(200)}).strict()
      .parse(await readJsonBody(req));
    // Committing a selection is a write, so it serializes with the other project writes.
    let snapshot: ProjectChangesSnapshot | undefined;
    await queue(async () => {
      await sync.commitProjectSelection(action.items, action.expectedRevision);
      snapshot = await changeSnapshot();
    });
    return snapshot ?? changeSnapshot();
  });
  sync.startAutomaticChecks();
  return async () => {closing = true; clones.auth?.dispose(); await Promise.all([tail, clones.dispose(), sync.dispose()]);};
}
