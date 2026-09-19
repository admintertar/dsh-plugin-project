import {spawn} from 'node:child_process';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {resolveProjectFile} from '../src/project-files.ts';
import {verifyProjectShell} from '../src/project-shell-development.ts';

const {values} = parseArgs({options: {
  shell: {type: 'string'}, project: {type: 'string'},
  edition: {type: 'string', default: 'stable'},
  'prepare-only': {type: 'boolean', default: false},
}});
if (values.edition !== 'stable') throw new Error('Only stable is supported');
const {shell, lock} = verifyProjectShell(resolve('.'), values.shell);
const project = values.project ? resolveProjectFile(values.project) : undefined;
console.log(`Independent Shell: ${shell}\nPinned plugin: ${lock.project.commit}`);
// The Shell builds its pinned plugin, never a mutable development Profile.
if (values['prepare-only']) {
  console.log('Source validation complete. No Profile or running window was changed.');
} else {
  const child = spawn(process.execPath, [join(shell, 'scripts/start.mjs'), ...(project ? [project] : [])],
    {cwd: shell, env: process.env, stdio: 'inherit'});
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', error => {console.error(error.message); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
}
