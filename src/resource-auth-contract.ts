/** Credentials are one-operation inputs, never part of resource or clone records. */
export type GitCredential = {kind: 'https'; username: string; password: string}
  | {kind: 'ssh'; keyPath: string; passphrase: string};
export interface GitAuthScope {url: string; name: string; action: 'clone' | 'check' | 'update' | 'commit'}
export interface GitAuthRequest extends GitAuthScope {id: string; kind: GitCredential['kind']; retry: boolean}
export interface GitKeyChoice {name: string; path: string}
export interface GitAuthSnapshot {requests: GitAuthRequest[]}
