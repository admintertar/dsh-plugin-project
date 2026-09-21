import type {TaskSummary,
  ProjectTaskDiagnostic, TaskDetail as StoredTaskDetail} from './task-contract.ts';
import type {ProjectSkillsSnapshot} from './project-skills.ts';
import type {ProjectMcpServer, ProjectMcpLocalOverride, ProjectMcpServerView} from './project-mcp-config.ts';
import type {ProjectMcpRuntimeView, ProjectMcpConnectionTestResult} from './project-mcp-runtime.ts';

export interface TaskParticipantView {
  sessionId?: string; title?: string; availability: 'available' | 'archived' | 'unavailable';
}
export interface TaskDetail extends StoredTaskDetail {
  participants: TaskParticipantView[];
  artifactPaths: Array<string | null>;
  referencePaths: Array<string | null>;
  sourceSessionIds: Record<string, string | null>;
  diagnostics: ProjectTaskDiagnostic[];
}
export interface TasksSnapshot {
  version: string; tasks: TaskSummary[]; invalidTaskCount: number; diagnostics: ProjectTaskDiagnostic[];
  total: number; unarchivedTotal: number; nextCursor?: string;
}
export interface TaskFilePreview {name: string; mime: string; extension: string; size: number; version: string; text?: string; base64?: string}
export interface CapabilityContext {kind: 'project' | 'session'; sessionId?: string; agentPreset?: string}
/**
 * The local attended chooser the Host can drive: the official directory-picker
 * seam (`native`) or the Desktop shell runtime (`desktop`, which serves Windows
 * where the launcher pins the browse backend). `null` means neither is reachable.
 */
export type PickSource = 'native' | 'desktop';
export type SkillsSnapshot = ProjectSkillsSnapshot & {version: string; canImport: boolean; pickSource: PickSource | null; context: CapabilityContext};
export interface ProjectToolView {name: string; description: string; group: 'dsh' | 'project' | 'mcp'}
export interface ToolsSnapshot {version: string; context: CapabilityContext; tools: ProjectToolView[]}
export interface McpSnapshot {version: string; servers: ProjectMcpServerView[]; runtime: ProjectMcpRuntimeView[]}
export type TaskAction = {action: 'archive'; id: string; archived: boolean; expectedRevision: string; operationId: string};
export type SkillAction = {action: 'enable'; name: string; enabled: boolean} | {action: 'import'; path: string};
export type McpAction = {action: 'upsert'; server: ProjectMcpServer; local?: ProjectMcpLocalOverride}
  | {action: 'test'; server: ProjectMcpServer; local?: ProjectMcpLocalOverride}
  | {action: 'delete'; id: string} | {action: 'reload'};
export type {ProjectMcpServer, ProjectMcpLocalOverride, ProjectMcpServerView, ProjectMcpConnectionTestResult};
