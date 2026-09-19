import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runResourceGit} from '../src/resource-git.ts';
import {resourceFixture} from './fixtures/resources.ts';

const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
function alive(pid: number): boolean {
  try {return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {encoding: 'utf8'}).trim().startsWith('Z');} catch {return false;}
}
for (const mode of ['cancel', 'timeout'] as const) test(`system Git ${mode} terminates the actual Git, shell and helper process group`, {skip: process.platform === 'win32'}, async () => {
  const f = resourceFixture(); const path = join(f.base, 'pids.json');
  const fixture = fileURLToPath(new URL('./fixtures/resource-git-process.mjs', import.meta.url));
  const controller = new AbortController(); let pids: {parent: number; child: number} | undefined;
  const task = runResourceGit(['-c', `alias.resource-fixture=!${quote(process.execPath)} ${quote(fixture)} ${quote(path)}`, 'resource-fixture'], f.root,
    {signal: controller.signal, timeoutMs: mode === 'timeout' ? 1500 : 10_000});
  const rejected = assert.rejects(task, mode === 'timeout' ? /clone-timeout/ : /clone-cancelled/);
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(path)); pids = JSON.parse(readFileSync(path, 'utf8'));
    if (mode === 'cancel') controller.abort();
    await rejected;
    for (let attempt = 0; attempt < 30 && (alive(pids!.parent) || alive(pids!.child)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(alive(pids!.parent), false); assert.equal(alive(pids!.child), false);
  } finally {
    controller.abort(); await rejected;
    if (pids) for (const pid of [pids.parent, pids.child]) {try {process.kill(pid, 'SIGKILL');} catch {}}
    f.cleanup();
  }
});
