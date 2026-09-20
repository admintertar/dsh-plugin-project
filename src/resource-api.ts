import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage} from 'node:http';
import {z} from 'zod';
import {ProjectHttpError, readJsonBody, requireAuthenticatedRequest, sendJson, sendProjectError} from './http.ts';
import type {ProjectResourceStore} from './project-resources.ts';
import type {ResourceCloneManager} from './resource-clones.ts';
import {ResourceSyncManager} from './resource-sync.ts';
import {gitKeyChoices} from './resource-auth.ts';

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

/** Native-picked paths are checked again by the Host, behind the same DSH authentication as the other project APIs. */
export function registerResourceApi(ctx: Context, store: ProjectResourceStore, clones: ResourceCloneManager,
  sync = new ResourceSyncManager(clones)): () => Promise<void> {
  let closing = false;
  let tail: Promise<unknown> = Promise.resolve();
  const open = () => {if (closing) throw new ProjectHttpError(503, 'project-closing');};
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const task = tail.then(() => {open(); return work();});
    tail = task.catch(() => {}); return task;
  };
  const canPick = () => (ctx.get('directoryPicker') as {capability(): {kind: string}} | undefined)?.capability().kind === 'native';
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
    return sync.snapshot(canPick());
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
    return sync.snapshot(canPick());
  }, true);
  sync.startAutomaticChecks();
  return async () => {closing = true; clones.auth?.dispose(); await Promise.all([tail, clones.dispose(), sync.dispose()]);};
}
