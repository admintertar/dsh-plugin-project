import {z} from 'zod';

export const taskIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const operationIdSchema = z.string().min(1).max(200);
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(8_000);
const texts = z.array(text).max(100);
export const taskStatusSchema = z.enum(['active', 'blocked', 'completed', 'cancelled']);
export const taskPhaseSchema = z.enum(['investigation', 'design', 'implementation', 'review', 'validation']);
export const artifactSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('file'), path: z.string().min(1).max(4_000), description: text.optional()}).strict(),
  z.object({type: z.literal('url'), url: z.string().url().max(8_000), description: text.optional()}).strict(),
  z.object({type: z.literal('commit'), repository: z.string().url().max(4_000), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), description: text.optional()}).strict(),
  z.object({type: z.literal('note'), description: text}).strict(),
]);
export const artifactInputSchema = z.union([
  artifactSchema,
  z.object({type: z.literal('file'), path: z.string().min(1).max(4_000), description: text.optional(),
    source: z.object({resourceId: taskIdSchema.optional(), path: z.string().min(1).max(4_000)}).strict()}).strict(),
]);
export const referenceSchema = z.discriminatedUnion('type', [
  z.object({id: taskIdSchema, label: text, type: z.literal('file'), resourceId: taskIdSchema.optional(), path: z.string().min(1).max(4_000)}).strict(),
  z.object({id: taskIdSchema, label: text, type: z.literal('url'), url: z.string().url().max(8_000)}).strict(),
  z.object({id: taskIdSchema, label: text, type: z.literal('task'), taskId: taskIdSchema}).strict(),
  z.object({id: taskIdSchema, label: text, type: z.literal('note'), text}).strict(),
]);
export const criterionInputSchema = z.object({id: taskIdSchema, text, required: z.boolean().default(true)}).strict();
export const criterionSchema = criterionInputSchema.extend({version: z.number().int().positive()});
export const briefInputSchema = z.object({
  currentBehavior: text.nullable().optional(), scope: text.nullable().optional(),
  constraints: texts.nullable().optional(), outOfScope: texts.nullable().optional(),
  acceptanceCriteria: z.array(criterionInputSchema).max(100).optional(),
}).strict();
export const briefSchema = z.object({
  currentBehavior: text.optional(), scope: text.optional(), constraints: texts.optional(), outOfScope: texts.optional(),
  acceptanceCriteria: z.array(criterionSchema).max(100).optional(),
}).strict();
export const handoffSchema = z.object({nextSteps: texts.optional(), readBefore: z.array(taskIdSchema).max(100).optional(), verifyBefore: texts.optional()}).strict();
export const verificationSchema = z.object({
  criterionId: taskIdSchema, criterionVersion: z.number().int().positive(),
  method: text, result: z.enum(['passed', 'failed', 'not-run', 'not-applicable']),
  coverage: text, reason: text.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.result === 'not-run' || value.result === 'not-applicable') && !value.reason) ctx.addIssue({code: 'custom', message: 'Verification requires a reason', path: ['reason']});
});
export const entryInputSchema = z.object({
  id: taskIdSchema, kind: z.enum(['progress', 'decision', 'scope', 'verification', 'completion']), content: text,
  basis: z.enum(['user-request', 'agent-proposal', 'observation']).optional(),
  referenceIds: z.array(taskIdSchema).max(100).optional(), supersedes: taskIdSchema.optional(),
  reason: text.optional(), verification: verificationSchema.optional(),
  verificationEntryIds: z.array(taskIdSchema).max(100).optional(),
}).strict();
export const entrySchema = entryInputSchema.extend({createdAt: z.string().datetime({offset: true})});
export const createProjectTaskSchema = z.object({
  title: z.string().min(1).max(240), objective: text, operationId: operationIdSchema,
  brief: briefInputSchema.optional(), summary: z.string().max(128 * 1024).optional(), phase: taskPhaseSchema.optional(),
  questions: texts.optional(), handoff: handoffSchema.optional(),
  references: z.array(referenceSchema).max(200).optional(), entries: z.array(entryInputSchema).max(100).optional(),
}).strict();
export const updateProjectTaskSchema = z.object({
  operationId: operationIdSchema, expectedRevision: revisionSchema,
  title: z.string().min(1).max(240).optional(), objective: text.optional(), status: taskStatusSchema.optional(),
  summary: z.string().max(128 * 1024).nullable().optional(), blockedReason: text.nullable().optional(),
  phase: taskPhaseSchema.nullable().optional(), brief: briefInputSchema.optional(),
  questions: texts.optional(), handoff: handoffSchema.nullable().optional(),
  references: z.array(referenceSchema).max(200).optional(), artifacts: z.array(artifactInputSchema).max(200).optional(),
  removeArtifacts: z.array(z.string().min(1).max(4_000)).max(200).optional(),
  removeReferences: z.array(taskIdSchema).max(200).optional(),
  entries: z.array(entryInputSchema).max(100).optional(), changeReason: text.optional(),
}).strict();
export type ProjectTaskStatus = z.infer<typeof taskStatusSchema>;
export type ProjectTaskPhase = z.infer<typeof taskPhaseSchema>;
export type ProjectArtifact = z.infer<typeof artifactSchema>;
export type TaskReference = z.infer<typeof referenceSchema>;
export type TaskCriterion = z.infer<typeof criterionSchema>;
export type TaskBrief = z.infer<typeof briefSchema>;
export type TaskHandoff = z.infer<typeof handoffSchema>;
export type TaskEntry = z.infer<typeof entrySchema>;
export type TaskEntryInput = z.infer<typeof entryInputSchema>;
export type CreateProjectTask = z.input<typeof createProjectTaskSchema>;
export type UpdateProjectTask = z.input<typeof updateProjectTaskSchema>;
export interface ProjectTask {
  schemaVersion: 3; directory: string; id: string; title: string; objective: string; status: ProjectTaskStatus;
  createdAt: string; updatedAt: string; summary?: string; blockedReason?: string;
  archived: boolean; artifacts: ProjectArtifact[]; phase?: ProjectTaskPhase; brief?: TaskBrief;
  questions?: string[]; handoff?: TaskHandoff; references: TaskReference[]; entries: TaskEntry[];
}
export interface TaskRecord extends ProjectTask {revision: string}
export interface ProjectTaskDiagnostic {path: string; code: 'invalid-task'|'size-limit'; error: string}
export interface ProjectTaskList {tasks: TaskRecord[]; diagnostics: ProjectTaskDiagnostic[]}
export interface TaskSource {sessionId: string; eventId?: string}
export interface TaskMutationResult {task: TaskRecord; taskCommitted: true; replayed: boolean; diagnostics: ProjectTaskDiagnostic[]}
export interface TaskSummary extends Omit<TaskRecord, 'brief'|'handoff'|'entries'|'references'|'artifacts'|'questions'> {truncated: boolean; nextStep?: string}
export interface TaskListOptions {query?: string; status?: ProjectTaskStatus; includeArchived?: boolean; limit?: number; cursor?: string}
export interface TaskListPage {tasks: TaskSummary[]; total: number; unarchivedTotal: number; nextCursor?: string; diagnostics: ProjectTaskDiagnostic[]}
export interface TaskDetail {task: TaskRecord; entriesNextCursor?: string; totalEntries: number; verification: Record<string, TaskEntry>}
export interface TaskWriteSource {sessionId: string; eventId?: string}
export interface TaskArchiveControl {expectedRevision: string; operationId: string}
