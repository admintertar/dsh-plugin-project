import type {TasksSnapshot, SkillsSnapshot, McpSnapshot, ToolsSnapshot} from '../api-types.ts';
export type * from '../api-types.ts';
export type CapabilityView = 'tasks' | 'skills' | 'mcp' | 'tools';
export interface CapabilityData {tasks: TasksSnapshot; skills: SkillsSnapshot; mcp: McpSnapshot; tools: ToolsSnapshot}
export interface ViewState<T> {loading: boolean; pending: boolean; data?: T; error?: string}
export type CapabilityState = {[K in CapabilityView]: ViewState<CapabilityData[K]>};
