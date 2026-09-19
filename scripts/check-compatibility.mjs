import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {verifyProjectShell} from '../src/project-shell-development.ts';

const args = process.argv.slice(2);
const desktopOnly = args[0] === '--desktop-only';
if (desktopOnly) args.shift();
if (args.length > 1) throw new Error('Usage: npm run test:compatibility -- /path/to/dsh-project-desktop');
const {shell} = verifyProjectShell(resolve('.'), args[0]);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args, cwd = process.cwd()) {
  const result = spawnSync(npm, args, {cwd, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!desktopOnly) {
  run(['run', 'setup', '--', shell]);
  run(['run', 'check']);
}
// Native composition and real Host/recovery checks exercise the Shell's pinned
// plugin. Current plugin work is validated above and through its Web entry.
run(['run', 'check'], shell);
