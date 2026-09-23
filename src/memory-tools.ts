import type {Context} from '@deepseek-ai/cordis';
import type {Session} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-present/types';
import {defineTool, type ToolRunContext} from '@deepseek-ai/dsh-tools';
import {z} from 'zod';
import {createProjectMemory, deleteProjectMemory, readProject, updateProjectMemory, type ProjectView} from './project.ts';
import {OUTPUT_SCHEMA, jsonObject, parameters, renderValue} from './tool-schema.ts';

const memoryId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const listInputSchema = z.object({}).strict();
const createInputSchema = z.object({
  name: z.string().min(1).max(160), content: z.string(),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional(),
  path: z.string().min(1).max(1_000).optional(),
}).strict();
const updateInputSchema = z.object({id: memoryId, content: z.string()}).strict();
const deleteInputSchema = z.object({id: memoryId}).strict();

const LIST_DESCRIPTION = 'List this Project\'s declared knowledge documents with their id, name, path and byte size. The full text of every declared document is already part of the project reference context; use this tool only to confirm ids before updating or deleting.';
const CREATE_DESCRIPTION = 'Add a durable Project knowledge document under memory/. Its content becomes part of every project session\'s reference material, so keep each document to one topic and prefer updating an existing document over creating a near-duplicate. One document is limited to 64 KB and all documents together to 128 KB. The file and its manifest declaration are written together; pass an explicit stable id when later turns must update this exact document.';
const UPDATE_DESCRIPTION = 'Replace one Project knowledge document by id. The whole document is replaced, so read its current text in the project reference material first and keep the parts that are still true.';
const DELETE_DESCRIPTION = 'Remove one Project knowledge document declaration and its file by id. This is durable and every later session stops receiving the document, so delete only knowledge that is genuinely obsolete.';

interface MemorySummary {id: string; name: string; path: string; bytes: number}

/** Bounded summaries: the text itself already reaches every session through the project reference. */
function summaries(project: ProjectView): {memory: MemorySummary[]} {
  return {memory: project.memory.map(({id, name, path, content}) => ({id, name, path, bytes: Buffer.byteLength(content)}))};
}

/** Mutating tools trust runtime Session identity and the exact Project root, never model arguments. */
function owningSession(exec: ToolRunContext, root: string, tool: string): Session {
  const session = exec.agent?.session;
  if (session === undefined || typeof session.id !== 'string' || !session.id) {
    throw new Error(`${tool} requires a calling agent with an owning Session`);
  }
  if (session.header.cwd !== root) throw new Error(`${tool} requires an owning Session in this Project root`);
  return session;
}

/** Explicit knowledge writes; conversations never infer which document to change. */
export function registerProjectMemoryTools(ctx: Context, root: () => string, manifestPath: string): void {
  ctx.tools.register(defineTool({
    name: 'project_memory_list', description: LIST_DESCRIPTION, parameters: parameters(listInputSchema),
    output: {schema: OUTPUT_SCHEMA, render: renderValue}, isConcurrencySafe: () => true,
    async execute() {return jsonObject(summaries(readProject(manifestPath)));},
  }));
  ctx.tools.register(defineTool({
    name: 'project_memory_create', description: CREATE_DESCRIPTION, parameters: parameters(createInputSchema),
    output: {schema: OUTPUT_SCHEMA, render: renderValue},
    async execute(args, exec) {
      owningSession(exec, root(), 'project_memory_create');
      const input = createInputSchema.parse(args);
      return jsonObject(summaries(createProjectMemory(manifestPath, input)));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'project_memory_update', description: UPDATE_DESCRIPTION, parameters: parameters(updateInputSchema),
    output: {schema: OUTPUT_SCHEMA, render: renderValue},
    async execute(args, exec) {
      owningSession(exec, root(), 'project_memory_update');
      const input = updateInputSchema.parse(args);
      return jsonObject(summaries(updateProjectMemory(manifestPath, input.id, input.content)));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'project_memory_delete', description: DELETE_DESCRIPTION, parameters: parameters(deleteInputSchema),
    output: {schema: OUTPUT_SCHEMA, render: renderValue},
    async execute(args, exec) {
      owningSession(exec, root(), 'project_memory_delete');
      const input = deleteInputSchema.parse(args);
      return jsonObject(summaries(deleteProjectMemory(manifestPath, input.id)));
    },
  }));
}
