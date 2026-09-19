import {resourceErrorCodes, type ResourceAction, type ResourceCloneRequest, type ResourceInspection, type ResourcesSnapshot} from '../resource-contract.ts';
import {ResourceAuthController} from './resource-auth-controller.ts';

interface ResourceState {data?: ResourcesSnapshot; error?: string; syncErrors: Readonly<Record<string, string | undefined>>; loading: boolean; pending: readonly string[]}
const errors = new Set<string>(resourceErrorCodes);

/** Owns resource requests for the lifetime of a project window, rather than a mounted panel or Session. */
export class ResourceController {
  private state: ResourceState = {loading: false, pending: [], syncErrors: {}};
  private listeners = new Set<() => void>();
  private requests = new Set<AbortController>();
  private current?: AbortController;
  private disposed = false;
  readonly auth: ResourceAuthController;
  constructor(private readonly changed: () => void, private readonly request: typeof fetch = (input, init) => fetch(input, init)) {
    this.auth = new ResourceAuthController(request);
  }
  getSnapshot = (): ResourceState => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private update(patch: Partial<ResourceState>): void {
    if (this.disposed) return;
    this.state = {...this.state, ...patch}; this.listeners.forEach(listener => listener());
  }
  clearError(): void {this.update({error: undefined});}
  private accept(data: ResourcesSnapshot): void {
    if (this.disposed) return;
    const changed = data.revision !== this.state.data?.revision || JSON.stringify(data.resources) !== JSON.stringify(this.state.data?.resources);
    const ids = new Set(data.resources.map(item => item.id));
    // The current card phase replaces a transient duplicate-operation rejection.
    const syncErrors = Object.fromEntries(Object.entries(this.state.syncErrors).filter(([id, error]) => ids.has(id) && error && error !== 'git-sync-busy'));
    this.update({data, syncErrors}); if (changed) this.changed();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.state.pending.length > 0) return;
    this.current?.abort();
    const current = this.current = new AbortController(); this.requests.add(current);
    this.update({loading: true});
    try {
      const data = await this.read<ResourcesSnapshot>('', {signal: current.signal});
      if (this.current === current && !current.signal.aborted) this.accept(data);
    } catch (error) {if (!current.signal.aborted) this.update({error: this.code(error)});}
    finally {this.requests.delete(current); if (this.current === current) this.update({loading: false});}
  }
  async inspect(path: string): Promise<ResourceInspection> {
    if (this.disposed) throw new Error('project-closing');
    const controller = new AbortController(); this.requests.add(controller);
    try {return await this.read('/inspect', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({path}), signal: controller.signal});}
    finally {this.requests.delete(controller);}
  }
  async mutate(action: ResourceAction): Promise<boolean> {return this.post('', action, 'id' in action ? action.id : 'add');}
  async clone(request: ResourceCloneRequest): Promise<boolean> {return this.post('/clone', request, request.id ?? 'add', false);}
  async sync(id: string, action: 'check' | 'update', expectedRevision: string): Promise<boolean> {
    return this.post('/sync', {id, action, expectedRevision}, id, false, 'resource');
  }
  async operation(id: string, action: 'cancel' | 'register', expectedRevision?: string): Promise<boolean> {
    return this.post(`/operations/${encodeURIComponent(id)}/${action}`, action === 'cancel' ? {} : {expectedRevision}, id);
  }
  private async post(path: string, body: unknown, key: string, snapshot = true, errorScope: 'page' | 'resource' = 'page'): Promise<boolean> {
    if (this.disposed || this.state.pending.includes(key)) return false;
    this.current?.abort(); this.current = undefined;
    const controller = new AbortController(); this.requests.add(controller);
    this.update({pending: [...this.state.pending, key], loading: false,
      ...(errorScope === 'resource' ? {syncErrors: {...this.state.syncErrors, [key]: undefined}} : {error: undefined})});
    try {
      const data = await this.read<ResourcesSnapshot>(path, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(body), signal: controller.signal});
      // A second item's later write can finish before this reply. GET the latest coherent snapshot after all writes.
      if (snapshot && !this.disposed) this.changed();
      void data;
      return !this.disposed;
    } catch (error) {
      if (!controller.signal.aborted) this.update(errorScope === 'resource'
        ? {syncErrors: {...this.state.syncErrors, [key]: this.code(error)}} : {error: this.code(error)});
      return false;
    }
    finally {
      this.requests.delete(controller); this.update({pending: this.state.pending.filter(item => item !== key)});
      if (!this.disposed && this.state.pending.length === 0) await this.refresh();
    }
  }
  private code(error: unknown): string {return error instanceof Error && errors.has(error.message) ? error.message : 'operation-failed';}
  private async read<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(`/api/project/resources${path}`, init);
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === 'string' && errors.has(data.error) ? data.error : 'operation-failed');
    return data as T;
  }
  dispose(): void {this.disposed = true; this.auth.dispose(); this.requests.forEach(request => request.abort()); this.listeners.clear();}
}
