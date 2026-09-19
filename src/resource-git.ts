import {spawn, type SpawnOptions} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {resourceFailure, nodeError} from './resource-files.ts';
import {validResourceUrl} from './resource-contract.ts';
import type {GitCredential} from './resource-auth-contract.ts';
import {gitAuthTransport} from './resource-auth-transport.ts';

export interface GitRunOptions {signal?: AbortSignal; timeoutMs?: number; progress?: (text: string) => void; sync?: boolean; raw?: boolean; literalObjects?: boolean;
  auth?: {url: string; credential: GitCredential}}
export type GitRun = (args: readonly string[], cwd: string, options?: GitRunOptions) => Promise<string>;
export class ResourceGitError extends Error {
  constructor(readonly code: string) {super(code);}
}

/** Non-interactive system Git; stdout/stderr stay bounded and cancellation owns the entire process group. */
export const runResourceGit: GitRun = async (args, cwd, options = {}) => {
  if (!options.auth) return executeGit(args, cwd, options);
  const {url, credential} = options.auth;
  if (!validResourceUrl(url) || (credential.kind === 'https') !== /^https:/i.test(url)) throw new ResourceGitError('git-auth-invalid');
  // An insteadOf rewrite must never silently redirect explicitly supplied credentials or keys.
  const actual = await executeGit(['ls-remote', '--get-url', '--', url], cwd, {...options, auth: undefined, raw: false});
  if (actual !== url) throw new ResourceGitError('git-auth-remote-changed');
  const transport = await gitAuthTransport(url, credential);
  try {return await executeGit([...transport.args, ...args], cwd, options, transport.env);}
  finally {await transport.close();}
};

const executeGit = (args: readonly string[], cwd: string, options: GitRunOptions, authEnv: Record<string, string> = {}): Promise<string> => new Promise((resolve, reject) => {
  const failed = options.sync ? 'git-sync-failed' : 'clone-failed';
  if (options.signal?.aborted) {reject(new ResourceGitError('clone-cancelled')); return;}
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('DSH_GIT_AUTH_') && !key.startsWith('SSH_ASKPASS')));
  Object.assign(env, {GIT_TERMINAL_PROMPT: '0',
    // Also block transport for object reads on older Git versions that ignore GIT_NO_LAZY_FETCH.
    GIT_ALLOW_PROTOCOL: options.literalObjects && !args.includes('fetch') ? '' : 'https:ssh', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', ...(options.literalObjects ? {GIT_NO_REPLACE_OBJECTS: '1'} : {}),
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', LC_ALL: 'C', ...authEnv});
  const spawnOptions: SpawnOptions = {cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']};
  const child = spawn('git', [...args], spawnOptions);
  let stdout = ''; let stderr = ''; let reason: string | undefined; let killTimer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder('utf8');
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
      // Windows is not claimed as desktop-validated; taskkill still owns descendants.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
      killer.on('error', () => {child.kill(signal);});
    } else {
      try {process.kill(-child.pid, signal);} catch (error) {if (!nodeError(error, 'ESRCH')) child.kill(signal);}
    }
  };
  const stop = (code: string) => {
    if (reason) return;
    reason = code; kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 300);
  };
  const abort = () => stop('clone-cancelled');
  options.signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => stop(options.sync ? 'git-sync-timeout' : 'clone-timeout'), options.timeoutMs ?? 10_000);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += decoder.write(chunk);
    if (Buffer.byteLength(stdout) > 1024 * 1024) {stdout = ''; stop(options.raw ? 'git-output-too-large' : failed);}
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr = Buffer.from(stderr + text).subarray(-64 * 1024).toString('utf8');
    options.progress?.(text);
  });
  let spawnError: Error | undefined;
  child.on('error', error => {spawnError = error;});
  child.on('close', code => {
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', abort);
    // A helper may outlive the Git parent after SIGTERM. Finish the group before resolving cancellation.
    if (reason) kill('SIGKILL');
    if (spawnError) reject(new ResourceGitError(nodeError(spawnError, 'ENOENT') ? 'git-unavailable' : failed));
    else if (reason) reject(new ResourceGitError(reason));
    else if (code !== 0) reject(new ResourceGitError(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr) ? 'git-host-unverified'
      : /Authentication failed|could not read (?:Username|Password)|Permission denied \(publickey[^)]*\)|incorrect passphrase|invalid credentials|HTTP Basic: Access denied/i.test(stderr) ? 'git-auth-required'
      : options.sync && /couldn't find remote ref/i.test(stderr) ? 'git-remote-branch-missing' : failed));
    else {stdout += decoder.end(); resolve(options.raw ? stdout : stdout.trim());}
  });
});

/** Only a working-tree root is a Git resource; subdirectories never silently widen to its root. */
export async function inspectResourceGit(path: string, run: GitRun = runResourceGit): Promise<{url?: string; branch?: string} | undefined> {
  try {
    const root = await run(['rev-parse', '--show-toplevel'], path);
    if (realpathSync(root) !== realpathSync(path)) return undefined;
    const [url, branch] = await Promise.all([
      run(['remote', 'get-url', 'origin'], path).catch(() => ''),
      run(['symbolic-ref', '--quiet', '--short', 'HEAD'], path)
        .catch(() => run(['rev-parse', '--short', 'HEAD'], path).catch(() => '')),
    ]);
    return {url: validResourceUrl(url) ? url : undefined, branch: branch || undefined};
  } catch {return undefined;}
}

export async function validateResourceBranch(branch: string | undefined, cwd: string, run: GitRun = runResourceGit): Promise<void> {
  if (!branch) return;
  if (branch.length > 255 || branch.startsWith('-') || branch.startsWith('@') || /[\u0000-\u0020\u007f]/.test(branch)) resourceFailure('resource-branch-invalid', 422);
  try {await run(['check-ref-format', '--branch', branch], cwd);} catch {resourceFailure('resource-branch-invalid', 422);}
}
