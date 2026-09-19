/** The task page prepares a conversation; only the official composer submits it. */
export interface ContinueTask {id: string; title: string; status: string}
export interface TaskContinuationResult {sessionId?: string; draftPreserved?: boolean; cancelled?: boolean; suggestedDraft?: string}
export interface TaskContinuationDependencies {
  project(): {id: string; root: string} | undefined;
  beginNavigation(): AbortSignal;
  createSession(root: string, sessionId: string): Promise<void>;
  readTask(id: string): Promise<ContinueTask>;
  input(sessionId: string): {draft(): string; canFill?(): boolean; setDraft(text: string): void; notifyPreserved?(text: string): void};
  draft(task: ContinueTask): string;
  openSession(sessionId: string): void;
  id?(): string;
}
interface Preparation {
  sessionId: string;
  created: boolean;
  pending?: Promise<TaskContinuationResult>;
}

/** Retain identity across failed requests and panel unmounts without retaining stale navigation. */
export class TaskContinuationController {
  private readonly preparations = new Map<string, Preparation>();
  private disposed = false;
  constructor(private readonly dependencies: TaskContinuationDependencies) {}

  continue(task: ContinueTask, signal?: AbortSignal): Promise<TaskContinuationResult> {
    const project = this.dependencies.project();
    if (this.disposed || signal?.aborted || !project) return Promise.resolve({cancelled: true});
    const key = JSON.stringify([project.id, project.root, task.id]);
    const previous = this.preparations.get(key);
    if (previous?.pending) return previous.pending;
    const id = this.dependencies.id ?? (() => crypto.randomUUID());
    const preparation = previous ?? {sessionId: id(), created: false};
    this.preparations.set(key, preparation);
    const navigation = this.dependencies.beginNavigation();
    const valid = () => {
      const current = this.dependencies.project();
      return !this.disposed && !signal?.aborted && !navigation.aborted && current?.id === project.id && current.root === project.root;
    };
    const operation = async (): Promise<TaskContinuationResult> => {
      // Preallocate the official identity: a lost create response must not create a second Session.
      if (!preparation.created) {
        await this.dependencies.createSession(project.root, preparation.sessionId);
        preparation.created = true;
      }
      if (!valid()) return {sessionId: preparation.sessionId, cancelled: true};
      const latest = await this.dependencies.readTask(task.id);
      if (!valid()) return {sessionId: preparation.sessionId, cancelled: true};
      const input = this.dependencies.input(preparation.sessionId);
      const draftPreserved = input.draft().length > 0 || input.canFill?.() === false;
      const suggestedDraft = this.dependencies.draft(latest);
      if (!draftPreserved) input.setDraft(suggestedDraft);
      else input.notifyPreserved?.(suggestedDraft);
      this.dependencies.openSession(preparation.sessionId);
      this.preparations.delete(key);
      return {sessionId: preparation.sessionId, draftPreserved, ...(draftPreserved ? {suggestedDraft} : {})};
    };
    preparation.pending = operation().finally(() => {preparation.pending = undefined;});
    return preparation.pending;
  }

  dispose(): void {this.disposed = true; this.preparations.clear();}
}
