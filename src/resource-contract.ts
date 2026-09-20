import type {ResourceView} from './project.ts';

export const resourceErrorCodes = [
  'operation-failed', 'unauthorized', 'same-origin-json-required', 'body-too-large', 'native-picker-unavailable',
  'resource-config-invalid', 'resource-recovery-conflict', 'revision-conflict', 'resource-unavailable',
  'resource-duplicate', 'resource-not-found', 'resource-origin-mismatch', 'resource-git-invalid', 'resource-url-invalid',
  'resource-branch-invalid', 'resource-target-invalid', 'target-exists', 'target-tracked', 'git-unavailable',
  'git-auth-required', 'clone-failed', 'clone-timeout', 'clone-busy', 'operation-not-found', 'operation-not-ready',
  'git-auth-invalid', 'git-auth-expired', 'git-auth-cancelled', 'git-auth-unavailable', 'git-auth-remote-changed',
  'git-key-invalid', 'git-key-permissions', 'git-host-unverified',
  'project-closing', 'operation-interrupted', 'operation-storage-failed',
  'git-sync-busy', 'git-sync-failed', 'git-sync-timeout', 'git-local-changes', 'git-history-diverged',
  'git-no-remote', 'git-no-upstream', 'git-detached', 'git-in-progress', 'git-state-changed', 'git-remote-branch-missing', 'resource-project-root',
  'git-nothing-to-commit', 'git-commit-message-required', 'git-identity-missing', 'git-push-rejected', 'git-nothing-to-push', 'git-branch-missing',
] as const;
export type ResourceErrorCode = typeof resourceErrorCodes[number];
export interface ResourceInspection {
  path: string; name: string; external: boolean; duplicateId?: string;
  git?: {url?: string; branch?: string};
}
export interface ResourceGitSync {
  status: 'unlinked' | 'unborn' | 'unchecked' | 'current' | 'behind' | 'ahead' | 'diverged' | 'detached' | 'no-upstream' | 'error';
  phase?: 'checking' | 'updating' | 'committing' | 'pushing' | 'switching';
  dirty?: boolean; inProgress?: boolean; ahead?: number; behind?: number; upstream?: string;
  checkedAt?: string; updatedAt?: string; error?: string;
}
/** Actions that mutate or re-read one resource repository. `branches` is a separate read. */
export type ResourceSyncAction = 'check' | 'update' | 'commit' | 'push' | 'switch';
export interface ResourceBranches {
  current?: string; local: string[]; remote: string[]; remoteName?: string;
}
/** The working-tree changes a commit would include; untracked directories stay collapsed. */
export type ResourceChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
export interface ResourceChanges {files: {path: string; status: ResourceChangeStatus}[]}
export interface ManagedResource extends ResourceView {git?: {branch?: string; diagnostic?: string; sync?: ResourceGitSync}}
export type CloneStatus = 'cloning' | 'cancelling' | 'cancelled' | 'failed' | 'pending' | 'completed' | 'interrupted';
export interface ResourceCloneOperation {
  id: string; requestId: string; resourceId: string; existing: boolean; name: string; url: string;
  path: string; target: string; branch?: string; revision: string; status: CloneStatus;
  phase?: 'receiving' | 'resolving' | 'checkout'; percent?: number; error?: string;
  createdAt: string; updatedAt: string; identity?: {dev: number; ino: number};
}
export interface ResourcesSnapshot {
  revision: string; version: string; resources: ManagedResource[]; operations: ResourceCloneOperation[];
  canPick: boolean; canClone: boolean;
}
export type ResourceAction = ({expectedRevision: string} & (
  | {action: 'addLocal'; path: string; name: string; type: 'local' | 'git'; url?: string}
  | {action: 'edit'; id: string; name: string; url?: string; branch?: string}
  | {action: 'associate'; id: string; url: string; branch?: string}
  | {action: 'bind'; id: string; path: string; originChoice?: 'keep' | 'replace'}
  | {action: 'remove'; id: string}
));
export interface ResourceCloneRequest {
  requestId: string; expectedRevision: string; id?: string; name: string; url: string; path: string; branch?: string;
}

/** Accept only credential-free network remotes; the Git process also restricts protocols after URL rewrites. */
export function validResourceUrl(value: string): boolean {
  if (!value || value.length > 4096 || /[\s\u0000-\u001f\u007f\\?#]/.test(value)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    const decoded = decodeURIComponent(url.pathname);
    return (url.protocol === 'https:' || url.protocol === 'ssh:') && Boolean(url.hostname)
      && !url.password && !url.search && !url.hash && (url.protocol !== 'https:' || !url.username)
      && url.pathname !== '/' && !/[\u0000-\u0020\u007f]/.test(decoded);
  } catch {return false;}
}
