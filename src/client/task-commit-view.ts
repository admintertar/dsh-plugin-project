import type {TaskCommitRequest, TaskCommitPreview, TaskCommitDiff} from '../task-commit-contract.ts';

export interface TaskCommitPreviewRequest extends TaskCommitRequest {kind: 'commit'; repository: string; commit: string; title: string}
interface State {
  data?: TaskCommitPreview; error?: string; loading: boolean; fetching: boolean;
  selected?: number; diff?: TaskCommitDiff; fileError?: string; loadingFile: boolean;
}
type Read = (request: TaskCommitRequest, options: {file?: number; fetch?: boolean; signal: AbortSignal}) => Promise<TaskCommitPreview>;

/** Per-tab state survives panel changes; generations isolate selection, retry and closure. */
export class TaskCommitView {
  private state: State = {loading: false, fetching: false, loadingFile: false};
  private listeners = new Set<() => void>();
  private files = new Map<number, TaskCommitDiff>();
  private pending?: AbortController;
  private disposed = false;
  constructor(readonly request: TaskCommitPreviewRequest, private read: Read) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private update(patch: Partial<State>) {if (!this.disposed) {this.state = {...this.state, ...patch}; this.listeners.forEach(listener => listener());}}
  async load(fetch = false): Promise<void> {
    if (this.disposed || this.state.loading) return;
    this.pending?.abort(); const pending = this.pending = new AbortController();
    this.update({loading: true, fetching: fetch, error: undefined, fileError: undefined, loadingFile: false});
    try {
      const data = await this.read(this.request, {fetch, signal: pending.signal});
      if (pending.signal.aborted) return;
      this.files.clear(); this.update({data, selected: undefined, diff: undefined});
    } catch (error) {if (!pending.signal.aborted) this.update({error: error instanceof Error ? error.message : 'task-commit-failed'});}
    finally {if (!pending.signal.aborted) this.update({loading: false, fetching: false});}
  }
  async select(index: number): Promise<void> {
    if (this.disposed || this.state.loading || !this.state.data?.files.some(file => file.index === index)) return;
    this.pending?.abort();
    if (this.state.selected === index) {this.update({selected: undefined, diff: undefined, fileError: undefined, loadingFile: false}); return;}
    const cached = this.files.get(index);
    this.update({selected: index, diff: cached, fileError: undefined, loadingFile: !cached});
    if (cached) return;
    const pending = this.pending = new AbortController();
    try {
      const data = await this.read(this.request, {file: index, signal: pending.signal});
      if (pending.signal.aborted) return;
      if (!data.diff || data.state !== 'ready') throw new Error('task-commit-unavailable');
      this.files.set(index, data.diff); this.update({diff: data.diff});
    } catch (error) {if (!pending.signal.aborted) this.update({fileError: error instanceof Error ? error.message : 'task-commit-failed'});}
    finally {if (!pending.signal.aborted) this.update({loadingFile: false});}
  }
  retryFile(): Promise<void> {
    const index = this.state.selected;
    if (index === undefined) return Promise.resolve();
    this.update({selected: undefined}); return this.select(index);
  }
  dispose() {this.disposed = true; this.pending?.abort(); this.files.clear(); this.listeners.clear();}
}
