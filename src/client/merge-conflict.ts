/**
 * A merge the panel could not complete becomes a conversation. The preparation mirrors the task
 * page: preallocate the session, fill the official composer draft and open it, so the Agent starts
 * from a message the user can read and edit instead of one this panel sent on their behalf.
 */
export interface MergeConflictRequest {
  /** The files both sides changed; the Host rolled the merge back, so the worktree is untouched. */
  files: readonly string[];
  branch?: string; upstream?: string; ahead?: number; behind?: number;
}
export interface MergeConflictResult {sessionId?: string; draftPreserved?: boolean; cancelled?: boolean}
export interface MergeConflictDependencies {
  project(): {id: string; root: string} | undefined;
  beginNavigation(): AbortSignal;
  createSession(root: string, sessionId: string): Promise<void>;
  input(sessionId: string): {draft(): string; canFill?(): boolean; setDraft(text: string): void; notifyPreserved?(text: string): void};
  draft(request: MergeConflictRequest, project: {root: string}): string;
  openSession(sessionId: string): void;
  id?(): string;
}
interface Preparation {sessionId: string; created: boolean; pending?: Promise<MergeConflictResult>}

export class MergeConflictController {
  private readonly preparations = new Map<string, Preparation>();
  private disposed = false;
  constructor(private readonly dependencies: MergeConflictDependencies) {}

  /**
   * Identity is the project plus the conflicting paths: retrying the same conflict reuses the
   * conversation it already opened, while a different conflict gets its own.
   */
  handoff(request: MergeConflictRequest, signal?: AbortSignal): Promise<MergeConflictResult> {
    const project = this.dependencies.project();
    if (this.disposed || signal?.aborted || !project) return Promise.resolve({cancelled: true});
    const key = JSON.stringify([project.id, project.root, [...request.files].sort()]);
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
    const operation = async (): Promise<MergeConflictResult> => {
      // Preallocate the official identity: a lost create response must not create a second Session.
      if (!preparation.created) {
        await this.dependencies.createSession(project.root, preparation.sessionId);
        preparation.created = true;
      }
      if (!valid()) return {sessionId: preparation.sessionId, cancelled: true};
      const input = this.dependencies.input(preparation.sessionId);
      const draftPreserved = input.draft().length > 0 || input.canFill?.() === false;
      const suggestedDraft = this.dependencies.draft(request, project);
      if (!draftPreserved) input.setDraft(suggestedDraft);
      else input.notifyPreserved?.(suggestedDraft);
      this.dependencies.openSession(preparation.sessionId);
      this.preparations.delete(key);
      return {sessionId: preparation.sessionId, draftPreserved};
    };
    preparation.pending = operation().finally(() => {preparation.pending = undefined;});
    return preparation.pending;
  }

  dispose(): void {this.disposed = true; this.preparations.clear();}
}
