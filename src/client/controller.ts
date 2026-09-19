import type {CapabilityData, CapabilityState, CapabilityView, ViewState,
  TaskAction, SkillAction, McpAction, ProjectMcpConnectionTestResult, TaskDetail, TaskFilePreview} from './types.ts';
import type {TaskListOptions} from '../task-contract.ts';
import {createTaskView} from './task-view.ts';
import {taskCommitErrors, type TaskCommitRequest, type TaskCommitPreview} from '../task-commit-contract.ts';
import {TaskCommitView, type TaskCommitPreviewRequest} from './task-commit-view.ts';

const views: CapabilityView[] = ['tasks', 'skills', 'tools', 'mcp'];
const publicErrors = new Set(['unauthorized', 'same-origin-json-required', 'body-too-large', 'invalid-json',
  'operation-failed', 'native-picker-unavailable', 'method-not-allowed',
  'invalid-session', 'project-session-unavailable', 'catalog-unavailable', 'invalid-task-query',
  'task-revision-conflict', 'task-binding-conflict', 'task-operation-conflict', 'task-locked', 'task-not-found',
  'task-file-unavailable', 'task-file-too-large', 'task-invalid-task', 'task-invalid-storage', 'task-size-limit', 'task-cursor-conflict', ...taskCommitErrors]);

/** Item mutations are queued by the Host but do not lock unrelated controls in the panel. */
export interface MutationOptions {scope?: 'global' | 'item'}

/** Independent snapshots prevent an unavailable capability from clearing the project or another view. */
export class ProjectCapabilityController {
  readonly taskView = createTaskView();
  private state: CapabilityState = {
    tasks: {loading: false, pending: false}, skills: {loading: false, pending: false}, mcp: {loading: false, pending: false},
    tools: {loading: false, pending: false},
  };
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Map<CapabilityView, AbortController>();
  private readonly mutations = new Set<AbortController>();
  private disposed = false;
  private commitViews = new Map<AbortSignal, {view: TaskCommitView; dispose(): void}>();
  private sessionId?: string;
  private catalogGeneration = 0;
  private taskGeneration = 0;
  private taskQuery: TaskListOptions = {};
  constructor(private readonly request: typeof fetch = (input, init) => fetch(input, init)) {}
  getSnapshot = (): CapabilityState => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  setTaskQuery(query: TaskListOptions): void {
    if (this.disposed || JSON.stringify(query) === JSON.stringify(this.taskQuery)) return;
    this.taskQuery = {...query};
    this.taskGeneration++;
    this.requests.get('tasks')?.abort();
    this.requests.delete('tasks');
    this.update('tasks', {data: undefined, loading: false, error: undefined});
  }
  async getTask(id: string, options: {cursor?: string} = {}): Promise<TaskDetail> {
    return this.taskRequest(`tasks/detail?${new URLSearchParams({id, ...(options.cursor ? {cursor: options.cursor} : {})})}`);
  }
  async taskFile(id: string, kind: 'artifact'|'reference', index: number, revision: string, signal?: AbortSignal, related?: string): Promise<TaskFilePreview> {
    return this.taskRequest(`tasks/file?${new URLSearchParams({id, kind, index: String(index), revision, ...(related === undefined ? {} : {related})})}`, {signal});
  }
  async taskCommit(request: TaskCommitRequest, options: {file?: number; fetch?: boolean; signal?: AbortSignal} = {}): Promise<TaskCommitPreview> {
    const body = {id: request.id, index: request.index, revision: request.revision};
    return options.fetch ? this.taskRequest('tasks/commit/fetch', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: options.signal})
      : this.taskRequest(`tasks/commit?${new URLSearchParams({...body, index: String(body.index), ...(options.file === undefined ? {} : {file: String(options.file)})})}`, {signal: options.signal});
  }
  taskCommitView(request: TaskCommitPreviewRequest, signal: AbortSignal): TaskCommitView {
    const existing = this.commitViews.get(signal); if (existing) return existing.view;
    const view = new TaskCommitView(request, (request, options) => this.taskCommit(request, options));
    const dispose = () => {signal.removeEventListener('abort', dispose); view.dispose(); this.commitViews.delete(signal);};
    if (signal.aborted || this.disposed) view.dispose();
    else {this.commitViews.set(signal, {view, dispose}); signal.addEventListener('abort', dispose, {once: true});}
    return view;
  }
  private async taskRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.disposed) throw new Error('operation-failed');
    const request = new AbortController();
    this.mutations.add(request);
    try {return await this.readPath<T>(path, {...init, signal: init.signal ? AbortSignal.any([init.signal, request.signal]) : request.signal});}
    finally {this.mutations.delete(request);}
  }
  setSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId || this.disposed) return;
    this.sessionId = sessionId;
    this.invalidateCatalogs();
  }
  /** Drop the previous composition immediately, including counts and late replies. */
  invalidateCatalogs(): void {
    if (this.disposed) return;
    this.catalogGeneration++;
    for (const view of ['skills', 'tools'] as const) {
      this.requests.get(view)?.abort();
      this.requests.delete(view);
      this.update(view, {data: undefined, error: undefined, loading: false});
      void this.refresh(view);
    }
  }
  private update<K extends CapabilityView>(view: K, patch: Partial<ViewState<CapabilityData[K]>>): void {
    if (this.disposed) return;
    this.state = {...this.state, [view]: {...this.state[view], ...patch}};
    this.listeners.forEach(listener => listener());
  }
  async refresh<K extends CapabilityView>(view: K): Promise<void> {
    if (this.disposed || this.state[view].pending) return;
    this.requests.get(view)?.abort();
    const current = new AbortController();
    this.requests.set(view, current);
    this.update(view, {loading: true});
    try {
      const data = await this.read<CapabilityData[K]>(view, {signal: current.signal});
      if (this.requests.get(view) === current && !current.signal.aborted) this.update(view, {data, error: undefined});
    } catch (error) {
      if (!current.signal.aborted) this.update(view, {error: this.errorCode(error),
        ...((view === 'skills' || view === 'tools') ? {data: undefined} : {})});
    } finally {
      if (this.requests.get(view) === current) {this.requests.delete(view); this.update(view, {loading: false});}
    }
  }
  async refreshAll(): Promise<void> {await Promise.all(views.map(view => this.refresh(view)));}
  async mutate(view: 'tasks', action: TaskAction, options?: MutationOptions): Promise<boolean>;
  async mutate(view: 'skills', action: SkillAction, options?: MutationOptions): Promise<boolean>;
  async mutate(view: 'mcp', action: Exclude<McpAction, {action: 'test'}>, options?: MutationOptions): Promise<boolean>;
  async mutate(view: CapabilityView, action: TaskAction | SkillAction | McpAction, options: MutationOptions = {}): Promise<boolean> {
    if (this.disposed || (options.scope !== 'item' && this.state[view].pending)) return false;
    if (view === 'tasks' && this.taskQuery.cursor !== undefined) this.setTaskQuery({...this.taskQuery, cursor: undefined});
    this.requests.get(view)?.abort();
    const current = new AbortController();
    const generation = this.catalogGeneration;
    const taskGeneration = this.taskGeneration;
    this.mutations.add(current);
    if (options.scope !== 'item') this.update(view, {pending: true, loading: false, error: undefined});
    else this.update(view, {error: undefined});
    try {
      const data = await this.read<CapabilityData[typeof view]>(view, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(action), signal: current.signal,
      });
      if ((view !== 'skills' || generation === this.catalogGeneration)
        && (view !== 'tasks' || taskGeneration === this.taskGeneration)) this.update(view, {data});
      if (view === 'mcp') void this.refresh('tools');
      return !this.disposed;
    } catch (error) {
      if (!current.signal.aborted && (view !== 'skills' || generation === this.catalogGeneration)
        && (view !== 'tasks' || taskGeneration === this.taskGeneration)) this.update(view, {error: this.errorCode(error)});
      return false;
    } finally {
      this.mutations.delete(current);
      if (options.scope !== 'item') this.update(view, {pending: false});
      if (view === 'skills' && generation !== this.catalogGeneration) void this.refresh('skills');
      if (view === 'tasks' && taskGeneration !== this.taskGeneration) void this.refresh('tasks');
    }
  }
  async importSkill(pick: () => Promise<string | null>): Promise<boolean> {
    if (this.disposed || this.state.skills.pending) return false;
    try {
      const path = await pick();
      return path === null || this.disposed ? false : this.mutate('skills', {action: 'import', path});
    } catch {this.update('skills', {error: 'native-picker-unavailable'}); return false;}
  }
  async testMcp(action: Extract<McpAction, {server: unknown}>): Promise<ProjectMcpConnectionTestResult> {
    if (this.disposed || this.state.mcp.pending) return {ok: false, toolNames: [], error: {name: 'Error', message: 'operation-failed'}};
    const current = new AbortController();
    this.mutations.add(current);
    this.update('mcp', {pending: true, error: undefined});
    try {
      return await this.read('mcp', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({...action, action: 'test'}), signal: current.signal});
    } catch (error) {
      return {ok: false, toolNames: [], error: {name: 'Error', message: this.errorCode(error)}};
    } finally {this.mutations.delete(current); this.update('mcp', {pending: false});}
  }
  dispose(): void {
    this.disposed = true;
    for (const {dispose} of this.commitViews.values()) dispose();
    this.requests.forEach(request => request.abort());
    this.mutations.forEach(request => request.abort());
    this.listeners.clear();
  }
  private errorCode(error: unknown): string {return error instanceof Error && publicErrors.has(error.message) ? error.message : 'operation-failed';}
  private async read<T>(view: CapabilityView, init: RequestInit): Promise<T> {
    let query = (view === 'skills' || view === 'tools') && this.sessionId
      ? `?sessionId=${encodeURIComponent(this.sessionId)}` : '';
    if (view === 'tasks') {
      const values = Object.fromEntries(Object.entries(this.taskQuery).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      const parameters = new URLSearchParams(values).toString();
      query = parameters ? `?${parameters}` : '';
    }
    return this.readPath<T>(`${view}${query}`, init);
  }
  private async readPath<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(`/api/project/${path}`, init);
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === 'string' && publicErrors.has(data.error) ? data.error : 'operation-failed');
    return data as T;
  }
}
