import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(readFileSync(join(repository, 'official-candidate.lock.json'), 'utf8'));
const supplied = process.argv[2];
if (!supplied || process.argv.length !== 3) throw new Error('Usage: node scripts/setup-official-candidate.mjs /path/to/deepseek-harness');
const source = realpathSync(resolve(supplied));
const git = (...args) => execFileSync('git', ['-C', source, ...args], {encoding: 'utf8'}).trim();
for (const [actual, expected, label] of [
  [git('rev-parse', '--verify', `${pin.commit}^{commit}`), pin.commit, 'commit'],
  [git('rev-parse', `${pin.commit}:apps/desktop`), pin.desktopTree, 'Desktop source tree'],
  [git('rev-parse', `${pin.commit}:pnpm-lock.yaml`), pin.dependencyLockBlob, 'dependency lock'],
  [git('rev-parse', `refs/tags/${pin.tag}^{commit}`), pin.commit, 'release tag'],
]) if (actual !== expected) throw new Error(`Official candidate ${label} differs from the pin`);
for (const name of ['apps/desktop', 'apps/desktop-host', 'packages/mcp/mcp-client']) {
  const manifest = JSON.parse(readFileSync(join(source, name, 'package.json'), 'utf8'));
  if (manifest.version !== pin.version) throw new Error(`Official ${name} version differs from the pin`);
}
for (const path of ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js', 'packages/mcp/mcp-client/lib/index.js']) {
  if (!existsSync(join(source, path))) throw new Error(`Build the official source first: ${path}`);
}

const hoisted = join(source, 'node_modules/.pnpm/node_modules/@deepseek-ai');
const rootScope = join(source, 'node_modules/@deepseek-ai');
const scope = join(repository, 'node_modules/@deepseek-ai');
const staging = join(repository, '.dev/official-candidate');
const merged = join(staging, 'scope');
if (!existsSync(hoisted)) throw new Error('Run pnpm install in the official source first');
const current = lstatSync(scope, {throwIfNoEntry: false});
if (current?.isSymbolicLink() && existsSync(merged) && realpathSync(scope) === merged
  && existsSync(join(merged, 'dsh-session'))
  && realpathSync(join(merged, 'dsh-session')).startsWith(source + sep)) {
  console.log(`Project development packages already resolve from official ${pin.version} source at ${source}`);
  process.exit(0);
}
mkdirSync(staging, {recursive: true});
if (existsSync(merged)) rmSync(merged, {recursive: true});
mkdirSync(merged);
for (const directory of [hoisted, rootScope]) {
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)) {
    const target = join(merged, name);
    if (!existsSync(target)) symlinkSync(realpathSync(join(directory, name)), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
if (current?.isSymbolicLink()) {
  const target = realpathSync(scope);
  if (target !== merged && !target.startsWith(join(repository, '.dev') + sep)) {
    throw new Error(`Refusing to replace an unmanaged package link: ${target}`);
  }
  unlinkSync(scope);
} else if (current) {
  const previous = join(mkdtempSync(join(staging, 'previous-scope-')), '@deepseek-ai');
  renameSync(scope, previous);
  console.log(`Preserved previous installed packages at ${previous}`);
}
symlinkSync(merged, scope, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`Project development packages now resolve from official ${pin.version} source at ${source}`);
