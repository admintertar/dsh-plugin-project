import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-skill';
import schema from '@deepseek-ai/schemastery';
import { createProjectMemory, deleteProjectMemory, projectContext, updateProjectMemory } from './project.ts';
import {projectTaskContext, registerProjectTaskTools} from './task-tools.ts';
import {registerProjectMemoryTools} from './memory-tools.ts';
import {ProjectTaskStore} from './tasks.ts';
import {ProjectSkillService} from './project-skills.ts';
import {ProjectMcpConfigStore} from './project-mcp-config.ts';
import {ProjectMcpRuntime} from './project-mcp-runtime.ts';
import { registerWindowActions } from './window-actions.ts';
import {registerProjectApi} from './project-api.ts';
import {createHash} from 'node:crypto';
import {dshHomePath} from '@deepseek-ai/dsh-home-paths';
import {ProjectResourceStore} from './project-resources.ts';
import {ResourceCloneManager} from './resource-clones.ts';
import {registerResourceApi} from './resource-api.ts';
import {ResourceGitAuthentication} from './resource-auth.ts';

export const name = 'project';
export const inject = ['webServer', 'connection', 'systemPrompt', 'sessions', 'tools', 'skills'];
export interface Config {manifestPath: string; enabled?: boolean}
export const Config = schema.object({manifestPath: schema.string().required(), enabled: schema.boolean().default(true)});

export async function apply(ctx: Context, config: Config): Promise<void> {
  registerWindowActions(ctx);
  const resources = new ProjectResourceStore(config.manifestPath);
  const identity = resources.read().id;
  let clones: ResourceCloneManager | undefined;
  const read = () => {
    const project = clones?.project() ?? resources.read();
    if (project.id !== identity) throw new Error('Restart this Project host before changing the Project identity');
    return project;
  };
  let mcp: ProjectMcpRuntime | undefined;
  let capabilities: Parameters<typeof registerProjectApi>[2];
  let closeApi: () => Promise<void> = async () => {};
  // Variable values are not parsed again, so Memory can contain literal {{templates}}.
  if (config.enabled !== false) {
    clones = new ResourceCloneManager(resources, dshHomePath('project-resources', createHash('sha256').update(resources.manifest).digest('hex').slice(0, 16)),
      resources.run, undefined, new ResourceGitAuthentication());
    const closeResources = registerResourceApi(ctx, resources, clones);
    ctx.effect(function* () {yield closeResources;}, 'project: resource lifecycle');
    const tasks = () => new ProjectTaskStore(read());
    registerProjectTaskTools(ctx, tasks);
    registerProjectMemoryTools(ctx, () => read().root, config.manifestPath);
    const skills = new ProjectSkillService(ctx, read());
    const mcpStore = new ProjectMcpConfigStore(read());
    mcp = new ProjectMcpRuntime(ctx, mcpStore);
    capabilities = {tasks, skills, mcpStore, mcp, gitAuth: clones.auth};
    const runtime = mcp;
    ctx.effect(function* () {
      yield async () => {
        await closeApi();
        try {await runtime.dispose();}
        finally {await skills.dispose();}
      };
    }, 'project: capability lifecycle');
    ctx.effect(() => ctx.systemPrompt.variable('project_reference', () => {
      const project = read();
      return `${projectContext(project)}\n\n${projectTaskContext(new ProjectTaskStore(project))}`;
    }), 'project: reference value');
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'project-reference', order: 50, text: '{{project_reference}}',
    }), 'project: reference context');
  }
  closeApi = registerProjectApi(ctx, read, capabilities, {
    create: input => createProjectMemory(config.manifestPath, input),
    update: (id, content) => updateProjectMemory(config.manifestPath, id, content),
    delete: id => deleteProjectMemory(config.manifestPath, id),
  });
  await mcp?.reconcile();
}
