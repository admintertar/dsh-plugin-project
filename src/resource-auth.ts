import {randomUUID} from 'node:crypto';
import {constants, closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join, basename} from 'node:path';
import {z} from 'zod';
import {ProjectHttpError} from './http.ts';
import {ResourceGitError, type GitRun, type GitRunOptions} from './resource-git.ts';
import {validResourceUrl} from './resource-contract.ts';
import type {GitAuthRequest, GitAuthScope, GitAuthSnapshot, GitCredential, GitKeyChoice} from './resource-auth-contract.ts';

const line = z.string().max(8192).refine(value => !/[\r\n\0]/.test(value));
export const gitCredentialSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('https'), username: line.min(1), password: line.min(1)}).strict(),
  z.object({kind: z.literal('ssh'), keyPath: line.min(1), passphrase: line}).strict(),
]);
const fail = (code: string): never => {throw new ProjectHttpError(422, code);};

/** Read only the header and metadata. The private key never enters a response or project storage. */
export function validateGitKey(value: string): string {
  if (!isAbsolute(value) || /[\r\n\0]/.test(value)) return fail('git-key-invalid');
  let descriptor: number | undefined;
  try {
    const path = realpathSync(value); descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024) return fail('git-key-invalid');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return fail('git-key-permissions');
    const header = Buffer.alloc(80); const size = readSync(descriptor, header, 0, header.length, 0);
    if (!/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n/.test(header.subarray(0, size).toString('utf8'))) return fail('git-key-invalid');
    return path;
  } catch (error) {if (error instanceof ProjectHttpError) throw error; return fail('git-key-invalid');}
  finally {if (descriptor !== undefined) closeSync(descriptor);}
}

export function gitKeyChoices(directory = join(homedir(), '.ssh')): GitKeyChoice[] {
  try {
    return readdirSync(directory, {withFileTypes: true}).slice(0, 100).flatMap(item => {
      if (!item.isFile() || item.name.endsWith('.pub')) return [];
      try {const path = validateGitKey(join(directory, item.name)); return [{name: basename(path), path}];} catch {return [];}
    });
  } catch {return [];}
}

interface Pending {view: GitAuthRequest; resolve(value: GitCredential): void; reject(error: Error): void}

/** Host-local prompts are scoped to one live Git operation; no credential cache or persistent storage. */
export class ResourceGitAuthentication {
  private pending = new Map<string, Pending>();
  private closing = false;
  constructor(private readonly waitMs = 5 * 60_000) {}
  snapshot(): GitAuthSnapshot {return {requests: [...this.pending.values()].map(item => ({...item.view}))};}
  answer(id: string, input: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) throw new ProjectHttpError(409, 'git-auth-expired');
    if (input === null) {pending.reject(new ResourceGitError('git-auth-cancelled')); return;}
    const parsed = gitCredentialSchema.safeParse(input);
    if (!parsed.success || parsed.data.kind !== pending.view.kind) fail('git-auth-invalid');
    const credential = parsed.data!;
    if (credential.kind === 'ssh') credential.keyPath = validateGitKey(credential.keyPath);
    pending.resolve(credential);
  }
  private ask(scope: GitAuthScope, signal: AbortSignal, retry: boolean): Promise<GitCredential> {
    if (this.closing || signal.aborted) return Promise.reject(new ResourceGitError('clone-cancelled'));
    if (this.pending.size >= 100) return Promise.reject(new ResourceGitError('git-auth-required'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (credential?: GitCredential, error?: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (credential) resolve(credential); else reject(error);
      };
      const abort = () => finish(undefined, new ResourceGitError('clone-cancelled'));
      const timer = setTimeout(() => finish(undefined, new ResourceGitError('git-auth-expired')), this.waitMs); timer.unref();
      this.pending.set(id, {view: {...scope, id, kind: /^https:/i.test(scope.url) ? 'https' : 'ssh', retry},
        resolve: value => finish(value), reject: error => finish(undefined, error)});
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    });
  }
  async run(run: GitRun, args: readonly string[], cwd: string, options: GitRunOptions,
    scope: GitAuthScope, interactive: boolean | (() => boolean), current: () => void): Promise<string> {
    if (!validResourceUrl(scope.url)) fail('resource-url-invalid');
    let credential: GitCredential | undefined;
    for (let attempt = 0; ; attempt++) {
      if (this.closing || options.signal?.aborted) throw new ResourceGitError('clone-cancelled');
      current();
      try {return await run(args, cwd, {...options, ...(credential ? {auth: {url: scope.url, credential}} : {})});}
      catch (error) {
        if (!(error instanceof ResourceGitError) || error.code !== 'git-auth-required'
          || !(typeof interactive === 'function' ? interactive() : interactive) || attempt >= 3) throw error;
        credential = undefined;
        credential = await this.ask(scope, options.signal ?? new AbortController().signal, attempt > 0);
      }
    }
  }
  dispose(): void {
    this.closing = true;
    for (const item of [...this.pending.values()]) item.reject(new ResourceGitError('clone-cancelled'));
  }
}
