import {resourceErrorCodes} from '../resource-contract.ts';
import type {GitAuthSnapshot, GitCredential, GitKeyChoice} from '../resource-auth-contract.ts';

interface State extends GitAuthSnapshot {keys: GitKeyChoice[]; busy: boolean; error?: string}
const errors = new Set<string>(resourceErrorCodes);
export class ResourceAuthController {
  private state: State = {requests: [], keys: [], busy: false};
  private listeners = new Set<() => void>();
  private requests = new Set<AbortController>();
  private loading = false;
  private disposed = false;
  private generation = 0;
  constructor(private readonly request: typeof fetch) {}
  getSnapshot = (): State => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private update(patch: Partial<State>): void {
    if (this.disposed) return;
    this.state = {...this.state, ...patch}; this.listeners.forEach(listener => listener());
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.loading || this.state.busy) return;
    this.loading = true;
    const generation = this.generation;
    try {
      const data = await this.read<GitAuthSnapshot>('');
      // A credential submission may finish while this older poll is in flight.
      if (generation === this.generation && !this.state.busy) this.update({...data, ...(data.requests[0]?.id !== this.state.requests[0]?.id ? {error: undefined} : {})});
    } catch { /* Connection errors are already presented by the project connection UI. */ }
    finally {this.loading = false;}
  }
  async loadKeys(): Promise<void> {
    const id = this.state.requests[0]?.id;
    try {this.update(await this.read<{keys: GitKeyChoice[]}>('/keys'));}
    catch (error) {if (this.state.requests[0]?.id === id) this.update({error: this.code(error)});}
  }
  async answer(id: string, credential: GitCredential | null): Promise<boolean> {
    if (this.disposed || this.state.busy) return false;
    this.generation++;
    this.update({busy: true, error: undefined});
    try {
      this.update(await this.read<GitAuthSnapshot>('', {method: 'POST', body: JSON.stringify({id, credential}), headers: {'content-type': 'application/json'}}));
      return !this.disposed;
    } catch (error) {
      const code = this.code(error);
      this.update({error: code, ...(code === 'git-auth-expired' ? {requests: this.state.requests.filter(item => item.id !== id)} : {})});
      return false;
    } finally {this.update({busy: false});}
  }
  private code(error: unknown): string {return error instanceof Error && errors.has(error.message) ? error.message : 'operation-failed';}
  private async read<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.disposed) throw new Error('project-closing');
    const controller = new AbortController(); this.requests.add(controller);
    try {
      const response = await this.request(`/api/project/resources/auth${path}`, {...init, signal: controller.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'operation-failed');
      return data as T;
    } finally {this.requests.delete(controller);}
  }
  dispose(): void {this.disposed = true; this.requests.forEach(request => request.abort()); this.listeners.clear(); this.state = {requests: [], keys: [], busy: false};}
}
