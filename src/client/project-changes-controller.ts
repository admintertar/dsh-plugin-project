import {resourceErrorCodes, type ResourceBranches, type ResourceSyncAction} from '../resource-contract.ts';
import type {ProjectChangeActionResult, ProjectChangeKind, ProjectChangesSnapshot} from '../project-changes.ts';

interface ChangesState {data?: ProjectChangesSnapshot; error?: string; commitError?: string; loading: boolean; pending: boolean;
  /** Which operation is in flight, so each control can say what it is doing. */
  action?: 'commit' | RepositorySyncAction}
const errors = new Set<string>(resourceErrorCodes);
/** Committing the whole repository is gone; a selection of project assets replaces it. */
export type RepositorySyncAction = Exclude<ResourceSyncAction, 'commit'>;

/**
 * Owns the project-asset review for the lifetime of a project window. It is separate from
 * ResourceController because the project root is not a managed resource: it has its own route,
 * its own revision, and no entry in the resource list or its counts.
 */
export class ProjectChangesController {
  private state: ChangesState = {loading: false, pending: false};
  private listeners = new Set<() => void>();
  private requests = new Set<AbortController>();
  private current?: AbortController;
  private disposed = false;
  constructor(private readonly request: typeof fetch = (input, init) => fetch(input, init)) {}
  getSnapshot = (): ChangesState => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private update(patch: Partial<ChangesState>): void {
    if (this.disposed) return;
    this.state = {...this.state, ...patch}; this.listeners.forEach(listener => listener());
  }
  clearError(): void {this.update({error: undefined, commitError: undefined});}
  async refresh(): Promise<void> {
    if (this.disposed || this.state.pending) return;
    this.current?.abort();
    const current = this.current = new AbortController(); this.requests.add(current);
    this.update({loading: true});
    try {
      const data = await this.read<ProjectChangesSnapshot>('/changes', {signal: current.signal});
      if (this.current === current && !current.signal.aborted) this.update({data, error: undefined});
    } catch (error) {if (!current.signal.aborted) this.update({error: this.code(error)});}
    finally {this.requests.delete(current); if (this.current === current) this.update({loading: false});}
  }
  /** Commit one item per selected asset, so history records each asset on its own. The Host needs the
   * asset identity, not just its paths, to stage assets that share a declaration file. */
  async commit(items: readonly {id: string; kind: ProjectChangeKind; paths: readonly string[]; message: string}[]): Promise<boolean> {
    const revision = this.state.data?.revision;
    if (this.disposed || this.state.pending || revision === undefined || items.length === 0) return false;
    this.current?.abort(); this.current = undefined;
    const controller = new AbortController(); this.requests.add(controller);
    this.update({pending: true, action: 'commit', loading: false, commitError: undefined, error: undefined});
    try {
      const data = await this.read<ProjectChangesSnapshot>('/changes', {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({action: 'commit', expectedRevision: revision, items: [...items]}),
        signal: controller.signal});
      if (!this.disposed) this.update({data});
      return !this.disposed;
    } catch (error) {
      if (!controller.signal.aborted) this.update({commitError: this.code(error)});
      return false;
    } finally {
      this.requests.delete(controller); this.update({pending: false, action: undefined});
      if (!this.disposed) await this.refresh();
    }
  }
  /**
   * Branch switching, remote checks and pushes. `silent` marks the automatic check that runs when
   * the overview opens: it must never lock the toolbar or raise a page-level error. The reply is
   * returned, because an update that had to merge reports its outcome there.
   */
  async sync(action: RepositorySyncAction, expectedRevision: string, branch?: string, silent = false): Promise<ProjectChangeActionResult | undefined> {
    if (this.disposed || this.state.pending) return undefined;
    this.current?.abort(); this.current = undefined;
    const controller = new AbortController(); this.requests.add(controller);
    if (!silent) this.update({pending: true, action, loading: false, error: undefined});
    try {
      return await this.send<ProjectChangeActionResult>('', {action, expectedRevision, ...(branch === undefined ? {} : {branch})}, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && !silent) this.update({error: this.code(error)});
      return undefined;
    } finally {
      this.requests.delete(controller);
      if (!silent) this.update({pending: false, action: undefined});
      if (!this.disposed) await this.refresh();
    }
  }
  /** Branch names for the picker. A failed read only hides the picker; the sync state already reports errors. */
  async branches(): Promise<ResourceBranches | undefined> {
    if (this.disposed) return undefined;
    const controller = new AbortController(); this.requests.add(controller);
    try {return await this.read<ResourceBranches>('/branches', {signal: controller.signal});}
    catch {return undefined;}
    finally {this.requests.delete(controller);}
  }
  private code(error: unknown): string {return error instanceof Error && errors.has(error.message) ? error.message : 'operation-failed';}
  private failure(data: unknown): Error {
    const code = (data as {error?: unknown} | undefined)?.error;
    return new Error(typeof code === 'string' && errors.has(code) ? code : 'operation-failed');
  }
  private async read<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(`/api/project/repository${path}`, init);
    const data = await response.json();
    if (!response.ok) throw this.failure(data);
    return data as T;
  }
  private async send<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await this.request(`/api/project/repository${path}`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal});
    const data = await response.json();
    if (!response.ok) throw this.failure(data);
    return data as T;
  }
  dispose(): void {this.disposed = true; this.requests.forEach(request => request.abort()); this.listeners.clear();}
}
