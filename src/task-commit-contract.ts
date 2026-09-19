import {validResourceUrl} from './resource-contract.ts';

export interface TaskCommitRequest {id: string; index: number; revision: string}
export interface TaskCommitFile {
  index: number; path: string; previousPath?: string; status: 'A'|'D'|'M'|'R'|'C'|'T';
  oldMode: string; newMode: string;
}
export interface TaskCommitChange {oldLine: number; newLine: number; oldText: string | null; newText: string}
export interface TaskCommitDiff {
  kind: 'text'|'binary'|'large'|'submodule'; changes: TaskCommitChange[];
  added: number; removed: number; oldObject: string; newObject: string;
  oldNoNewline?: boolean; newNoNewline?: boolean;
}
export interface TaskCommitPreview {
  state: 'ready'|'missing'|'parent-missing'; repository: string; resourceName: string; commit: string;
  message?: string; author?: string; authoredAt?: string; parents: string[];
  files: TaskCommitFile[]; diff?: TaskCommitDiff;
}
export const taskCommitErrors = ['task-commit-unavailable', 'task-commit-resource-unavailable', 'task-commit-resource-ambiguous',
  'task-commit-origin-mismatch', 'task-commit-state-changed', 'task-commit-too-large', 'task-commit-failed',
  'task-commit-host-unverified', 'task-commit-auth-remote-changed',
  'task-commit-fetch-failed', 'task-commit-timeout', 'task-commit-auth', 'task-commit-no-git'] as const;

/** Match declared HTTPS/SSH remotes without conflating custom servers or ports. */
export function repositoryIdentity(value: string): string | undefined {
  if (!validResourceUrl(value)) return;
  try {
    const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(.+)$/.exec(value);
    const url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '').replace(/\.git$/, '');
    if (!path || path.split('/').some(part => part === '.' || part === '..')) return;
    const port = url.port && !(url.protocol === 'ssh:' && url.port === '22') ? `:${url.protocol}${url.port}` : '';
    return `${url.hostname.toLowerCase()}${port}${path}`;
  } catch {return;}
}

export function commitWebUrl(repository: string, commit: string): string | undefined {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !repositoryIdentity(repository)) return;
  try {
    const url = new URL(repository);
    if (url.protocol !== 'https:') return;
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
      + (url.hostname === 'gitlab.com' ? '/-/commit/' : url.hostname === 'bitbucket.org' ? '/commits/' : '/commit/') + commit;
    return url.href;
  } catch {return;}
}
