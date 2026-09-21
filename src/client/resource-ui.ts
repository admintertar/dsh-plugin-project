import type {ManagedResource, ResourceGitSync, ResourceInspection} from '../resource-contract.ts';
import type {CapabilityTranslate} from './capability-ui.tsx';

/** The Host owns detection: any working-tree root is a Git resource, even before it has an origin remote. */
export function detectedResourceType(inspection: ResourceInspection | undefined): 'git' | 'local' {
  return inspection?.git ? 'git' : 'local';
}

const errorKeys = {
  'resource-config-invalid': 'resourceErrorConfig', 'resource-recovery-conflict': 'resourceErrorRecovery', 'revision-conflict': 'resourceErrorRevision',
  'resource-unavailable': 'resourceErrorDirectory', 'resource-duplicate': 'resourceErrorDuplicate', 'resource-not-found': 'resourceErrorMissing',
  'resource-origin-mismatch': 'resourceErrorOrigin', 'resource-git-invalid': 'resourceErrorGit', 'resource-url-invalid': 'resourceErrorUrl',
  'resource-branch-invalid': 'resourceErrorBranch', 'resource-target-invalid': 'resourceErrorTarget', 'target-exists': 'resourceErrorExists',
  'target-tracked': 'resourceErrorTracked', 'git-unavailable': 'resourceNoGit', 'git-auth-required': 'resourceErrorAuth',
  'git-auth-invalid': 'gitAuthInvalid', 'git-auth-expired': 'gitAuthExpired', 'git-auth-cancelled': 'gitAuthCancelled',
  'git-auth-unavailable': 'gitAuthUnavailable', 'git-auth-remote-changed': 'gitAuthRemoteChanged',
  'git-key-invalid': 'gitAuthKeyInvalid', 'git-key-permissions': 'gitAuthKeyPermissions', 'git-host-unverified': 'gitAuthHost',
  'clone-failed': 'resourceErrorClone', 'clone-timeout': 'resourceErrorTimeout', 'clone-busy': 'resourceErrorBusy',
  'operation-not-found': 'resourceErrorOperation', 'operation-not-ready': 'resourceErrorOperation', 'project-closing': 'resourceErrorClosing',
  'operation-storage-failed': 'resourceErrorStorage', 'operation-interrupted': 'resourceInterrupted',
  'native-picker-unavailable': 'nativePickerUnavailable', 'unauthorized': 'authenticationError', 'body-too-large': 'bodyTooLarge',
  'git-sync-busy': 'resourceSyncBusy', 'git-sync-failed': 'resourceSyncFailed', 'git-sync-timeout': 'resourceSyncTimeout',
  'git-local-changes': 'resourceSyncDirtyBody', 'git-history-diverged': 'resourceSyncDivergedBody',
  'git-no-upstream': 'resourceSyncNoUpstreamBody', 'git-detached': 'resourceSyncDetachedBody',
  'git-in-progress': 'resourceSyncInProgressBody', 'git-state-changed': 'resourceSyncChanged',
  'git-remote-branch-missing': 'resourceSyncMissingBranch',
  'git-nothing-to-commit': 'resourceCommitClean', 'git-commit-message-required': 'resourceCommitMessageRequired',
  'git-identity-missing': 'resourceCommitIdentity', 'git-push-rejected': 'resourcePushRejected',
  'git-nothing-to-push': 'resourcePushClean', 'git-branch-missing': 'resourceBranchMissing',
  'git-no-remote': 'resourceSyncUnlinkedBody', 'resource-project-root': 'resourceProjectRootBody',
} as const;
export function resourceErrorText(code: string, t: CapabilityTranslate): string {return t(errorKeys[code as keyof typeof errorKeys] ?? 'capabilityError');}
const syncLabels = {unborn: 'resourceSyncUnborn', unchecked: 'resourceSyncUnchecked', current: 'resourceSyncCurrent', behind: 'resourceSyncBehind', ahead: 'resourceSyncAhead',
  diverged: 'resourceSyncDiverged', detached: 'resourceSyncDetached', 'no-upstream': 'resourceSyncNoUpstream', error: 'resourceSyncError'} as const;
const phaseLabels = {checking: 'resourceSyncChecking', updating: 'resourceSyncUpdating', committing: 'resourceSyncCommitting',
  pushing: 'resourceSyncPushing', switching: 'resourceSyncSwitching'} as const;
export function resourceSyncLabel(sync: ResourceGitSync | undefined, t: CapabilityTranslate): string {
  if (sync?.phase) return t(phaseLabels[sync.phase]);
  if (sync?.status === 'unlinked' || sync?.error === 'git-no-remote') return t('resourceSyncUnlinked');
  const blocker = {'git-auth-required': 'gitAuthRequired', 'git-local-changes': 'resourceSyncDirty', 'git-history-diverged': 'resourceSyncDiverged', 'git-detached': 'resourceSyncDetached',
    'git-no-upstream': 'resourceSyncNoUpstream', 'git-in-progress': 'resourceSyncInProgress',
    // Nothing to commit or push is a no-op, not a failure the user has to act on.
    'git-nothing-to-commit': 'resourceSyncClean', 'git-nothing-to-push': 'resourceSyncCurrent'} as const;
  if (sync?.error && sync.error in blocker) return t(blocker[sync.error as keyof typeof blocker]);
  if (sync?.error) return t('resourceSyncError');
  if (sync?.inProgress) return t('resourceSyncInProgress');
  if (sync?.status === 'diverged') return t('resourceSyncDiverged');
  if (sync?.status === 'no-upstream') return t('resourceSyncNoUpstream');
  if (sync?.status === 'unborn') return t('resourceSyncUnborn');
  if (sync?.behind) return t('resourceSyncBehind', {count: sync.behind});
  if (sync?.dirty) return t('resourceSyncDirty');
  return t(syncLabels[sync?.status ?? 'unchecked'], {count: sync?.ahead ?? 0});
}
export function canCheckResource(item: ManagedResource): boolean {
  const sync = item.git?.sync;
  return item.type === 'git' && item.status === 'ready' && Boolean(item.url)
    && !['unlinked', 'unborn', 'no-upstream', 'detached'].includes(sync?.status ?? '')
    && !['git-no-remote', 'git-no-upstream', 'git-detached'].includes(sync?.error ?? '');
}
export function canUpdateResource(sync: ResourceGitSync | undefined): boolean {
  return Boolean(sync?.status === 'behind' && !sync.phase && !sync.dirty && !sync.inProgress && !sync.error);
}
/** Only local commits can be pushed, and never while the branch history is unresolved. */
export function canPushResource(sync: ResourceGitSync | undefined): boolean {
  return Boolean(sync?.status === 'ahead' && !sync.phase && !sync.inProgress && !sync.error);
}
export function canCommitResource(sync: ResourceGitSync | undefined): boolean {
  return Boolean(sync?.dirty && !sync.phase && !sync.inProgress && !sync.error);
}
/** Switching is refused with local changes; the Host never stashes them automatically. */
export function canSwitchResource(sync: ResourceGitSync | undefined): boolean {
  return Boolean(!sync?.dirty && !sync?.phase && !sync?.inProgress);
}
