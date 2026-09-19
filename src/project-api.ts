import {createHash} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import {z} from 'zod';
import {readJsonBody, requireAuthenticatedRequest, sendJson, sendProjectError, ProjectHttpError} from './http.ts';
import {projectMcpServerSchema, projectMcpLocalSchema, type ProjectMcpConfigStore} from './project-mcp-config.ts';
import type {ProjectMcpRuntime} from './project-mcp-runtime.ts';
import type {ProjectSkillService} from './project-skills.ts';
import {TaskStoreError, type ProjectTaskStore} from './tasks.ts';
import type {ProjectView} from './project.ts';
import type {SkillsSnapshot, McpSnapshot, ToolsSnapshot, ProjectToolView} from './api-types.ts';
import {sessionCapabilities} from './session-capabilities.ts';
import {registerTaskApi} from './task-api.ts';
import type {ResourceGitAuthentication} from './resource-auth.ts';

interface ProjectCapabilities {
  tasks(): ProjectTaskStore;
  skills: ProjectSkillService;
  mcpStore: ProjectMcpConfigStore;
  mcp: ProjectMcpRuntime;
  gitAuth?: ResourceGitAuthentication;
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const memoryAction = z.object({action: z.literal('update'), id, content: z.string()}).strict();
const skillAction = z.discriminatedUnion('action', [
  z.object({action: z.literal('enable'), name: z.string().min(1).max(64), enabled: z.boolean()}).strict(),
  z.object({action: z.literal('import'), path: z.string().min(1).max(8_000)}).strict(),
]);
const mcpAction = z.discriminatedUnion('action', [
  z.object({action: z.literal('upsert'), server: projectMcpServerSchema, local: projectMcpLocalSchema.optional()}).strict(),
  z.object({action: z.literal('test'), server: projectMcpServerSchema, local: projectMcpLocalSchema.optional()}).strict(),
  z.object({action: z.literal('delete'), id}).strict(),
  z.object({action: z.literal('reload')}).strict(),
]);
function version(value: unknown): string {return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);}

/** API queues cover persistence AND runtime reconciliation, not just connection work. */
function queue() {
  let tail = Promise.resolve();
  return {
    wait: () => tail,
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}

export function registerProjectApi(ctx: Context, read: () => ProjectView, capabilities?: ProjectCapabilities,
  updateMemory?: (id: string, content: string) => ProjectView): () => Promise<void> {
  let closing = false;
  const assertOpen = () => {if (closing) throw new ProjectHttpError(503, 'project-closing');};
  const register = (path: string, methods: string[], operation: (req: import('node:http').IncomingMessage, signal: AbortSignal) => Promise<unknown>) => {
    ctx.effect(() => ctx.webServer.register({kind: 'exact', path: `/api/project/${path}`,
      async handler(req, res) {
        const request = new AbortController();
        const disconnected = () => {if (!res.writableEnded) request.abort();};
        res.once('close', disconnected);
        try {requireAuthenticatedRequest(ctx, req, methods); assertOpen(); sendJson(res, await operation(req, request.signal));}
        catch (error) {sendProjectError(res, error instanceof TaskStoreError
          ? new ProjectHttpError(error.status, error.code.startsWith('task-') ? error.code : `task-${error.code}`)
          : error, methods);}
        finally {res.removeListener('close', disconnected);}
      },
    }), `project: ${path} API`);
  };
  register('snapshot', ['GET'], async () => read());
  const memoryQueue = queue();
  if (updateMemory !== undefined) register('memory', ['POST'], async req => {
    // JSON escaping can make the request larger than the decoded 64 KB document.
    const action = memoryAction.parse(await readJsonBody(req, 400_000));
    return memoryQueue.run(async () => {
      assertOpen();
      if (Buffer.byteLength(action.content) > 64_000) throw new ProjectHttpError(413, 'body-too-large');
      return updateMemory(action.id, action.content);
    });
  });
  if (capabilities === undefined) return async () => {closing = true; await memoryQueue.wait();};
  const {tasks, skills, mcpStore, mcp} = capabilities;
  const skillQueue = queue();
  const mcpQueue = queue();
  const canImport = () => (ctx.get('directoryPicker') as {capability(): {kind: string}} | undefined)?.capability().kind === 'native';

  const closeTasks = registerTaskApi(ctx, register, read, tasks, assertOpen, capabilities.gitAuth);
  const skillSnapshot = async (catalog: Awaited<ReturnType<typeof sessionCapabilities>>): Promise<SkillsSnapshot> => {
    const value = await skills.snapshot({cwd: read().root, scope: catalog.scope}, catalog.skills);
    const data = {...value, context: catalog.context, ...(value.diagnostic === undefined ? {} : {diagnostic: 'invalid-skill-index'}), canImport: canImport()};
    return {...data, version: version(data)};
  };
  const mcpSnapshot = (): McpSnapshot => {
    // Private-file parse failures use the generic route error; runtime text is
    // deliberately not returned because arbitrary servers can echo partial secrets.
    const data = {servers: mcpStore.list(), runtime: mcp.snapshot().map(state => ({...state,
      ...(state.lastError === undefined ? {} : {lastError: {name: state.lastError.name, message: 'mcp-connection-failed'}}),
    }))};
    return {...data, version: version(data)};
  };
  register('skills', ['GET', 'POST'], async req => {
    const catalog = await sessionCapabilities(ctx, read().root, req.url);
    if (req.method === 'GET') {await skillQueue.wait(); return skillSnapshot(catalog);}
    const action = skillAction.parse(await readJsonBody(req));
    return skillQueue.run(async () => {
      assertOpen();
      if (action.action === 'enable') await skills.setEnabled(action.name, action.enabled);
      else {
        if (!canImport()) throw new ProjectHttpError(409, 'native-picker-unavailable');
        await skills.importBundle(action.path);
      }
      return skillSnapshot(catalog);
    });
  });
  register('tools', ['GET'], async req => {
    const catalog = await sessionCapabilities(ctx, read().root, req.url);
    const projectNames = new Set(['project_task_create', 'project_task_list', 'project_task_get', 'project_task_update', 'project_task_bind']);
    const tools: ProjectToolView[] = catalog.context.kind === 'project' ? [] : catalog.tools.schemas(catalog.scope)
      .map(({name, description}) => ({name, description,
        group: (name.startsWith('mcp__') ? 'mcp' : projectNames.has(name) ? 'project' : 'dsh') as ProjectToolView['group']}))
      .sort((a, b) => a.name.localeCompare(b.name));
    const data = {context: catalog.context, tools};
    return {...data, version: version(data)} satisfies ToolsSnapshot;
  });
  register('mcp', ['GET', 'POST'], async req => {
    read();
    if (req.method === 'GET') {await mcpQueue.wait(); return mcpSnapshot();}
    const action = mcpAction.parse(await readJsonBody(req));
    return mcpQueue.run(async () => {
      assertOpen();
      if (action.action === 'test') {
        const result = await mcp.testConnection(mcpStore.preview(action.server, action.local));
        return {...result, ...(result.error === undefined ? {} : {error: {name: result.error.name, message: 'mcp-connection-failed'}})};
      }
      if (action.action === 'upsert') mcpStore.upsert(action.server, action.local);
      else if (action.action === 'delete') mcpStore.delete(action.id);
      await mcp.reconcile();
      return mcpSnapshot();
    });
  });
  return async () => {
    closing = true;
    await Promise.all([memoryQueue.wait(), skillQueue.wait(), mcpQueue.wait(), closeTasks()]);
  };
}
