import {randomBytes} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {GitCredential} from './resource-auth-contract.ts';
import {ProjectHttpError, readJsonBody} from './http.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// This helper contains no credentials. A short-lived loopback capability hands
// credentials to Git's helper / OpenSSH askpass, never via argv, disk or logs.
const helper = String.raw`const http = require('node:http');
let input = '';
async function main() {
  const mode = process.argv[2];
  if (mode === 'credential' && process.argv[3] !== 'get') return;
  if (mode === 'credential') for await (const chunk of process.stdin) {input += chunk; if (input.length > 16384) process.exit(1);}
  const body = JSON.stringify({mode, input, prompt: mode === 'askpass' ? process.argv[3] : undefined});
  const request = http.request({host: '127.0.0.1', port: process.env.DSH_GIT_AUTH_PORT, path: '/', method: 'POST',
    headers: {authorization: process.env.DSH_GIT_AUTH_TOKEN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, response => {
    if (response.statusCode !== 200) {response.resume(); process.exitCode = 1; return;}
    response.pipe(process.stdout);
  });
  request.on('error', () => {process.exitCode = 1;}); request.setTimeout(10000, () => request.destroy()); request.end(body);
}
main().catch(() => {process.exitCode = 1;});
`;

export async function gitAuthTransport(url: string, credential: GitCredential): Promise<{
  args: string[]; env: Record<string, string>; close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-auth-'));
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const refuse = () => {res.writeHead(403); res.end();};
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== token || req.headers.origin) {refuse(); return;}
    try {
      const body = await readJsonBody(req, 16 * 1024) as {mode?: string; input?: string; prompt?: string};
      let answer: string | undefined;
      if (credential.kind === 'https' && body.mode === 'credential' && typeof body.input === 'string') {
        const fields = Object.fromEntries(body.input.split('\n').filter(Boolean).map(line => {const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];}));
        const expected = new URL(url);
        const actual = new URL(`https://${fields.host}/${fields.path ?? ''}`);
        if (fields.protocol === 'https' && actual.origin === expected.origin && actual.pathname === expected.pathname
          && !actual.username && !actual.password && !actual.search && !actual.hash) {
          answer = `username=${credential.username}\npassword=${credential.password}\n\n`;
        }
      } else if (credential.kind === 'ssh' && body.mode === 'askpass' && typeof body.prompt === 'string'
        && /^Enter passphrase for key '(.*)':\s*$/.exec(body.prompt)?.[1] === credential.keyPath) {
        answer = credential.passphrase + '\n';
      }
      if (answer === undefined) {refuse(); return;}
      res.writeHead(200, {'content-type': 'text/plain', 'cache-control': 'no-store'}); res.end(answer);
    } catch {refuse();}
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => {server.close(() => resolve());});
    await rm(directory, {recursive: true, force: true});
  };
  try {
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const script = join(directory, 'helper.cjs'); await writeFile(script, helper, {mode: 0o600});
    const launcher = join(directory, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
    await writeFile(launcher, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" askpass %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} askpass "$@"\n`, {mode: 0o700});
    const env: Record<string, string> = {DSH_GIT_AUTH_PORT: String((server.address() as {port: number}).port), DSH_GIT_AUTH_TOKEN: token,
      ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: launcher};
    if (credential.kind === 'https') {
      const command = `!${quote(process.execPath)} ${quote(script)} credential`;
      return {args: ['-c', 'credential.helper=', '-c', `credential.helper=${command}`, '-c', 'credential.useHttpPath=true',
        '-c', 'http.followRedirects=false'], env, close};
    }
    return {args: [], env: {...env, GIT_SSH_VARIANT: 'ssh', SSH_ASKPASS: launcher, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0',
      GIT_SSH_COMMAND: `ssh -o BatchMode=no -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=1 -i ${quote(credential.keyPath.replaceAll('%', '%%'))}`}, close};
  } catch {await close(); throw new ProjectHttpError(422, 'git-auth-unavailable');}
}
