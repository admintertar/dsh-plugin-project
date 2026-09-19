import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {parseArgs} from 'node:util';
import {verifyProjectShell} from '../src/project-shell-development.ts';
import {exportOfficialRuntime} from '../src/official-runtime-development.ts';

const {values, positionals} = parseArgs({allowPositionals: true, options: {
  edition: {type: 'string', default: 'stable'}, desktop: {type: 'string'}, shell: {type: 'string'},
}});
if (positionals.length > 1 || [values.desktop, values.shell, positionals[0]].filter(Boolean).length > 1) {
  throw new Error('Usage: npm run setup -- --desktop /path/to/official-desktop-source (or --shell /path/to/dsh-project-desktop)');
}
if (values.edition !== 'stable') throw new Error('Only stable is supported; beta development has been retired');
const edition = 'stable';
const saved = existsSync('.dev/runtime-source.json') ? JSON.parse(readFileSync('.dev/runtime-source.json', 'utf8')) : {};
const explicitShell = values.shell ?? positionals[0];
const desktopSource = values.desktop ?? (explicitShell ? undefined : saved.desktopSource);
if (!desktopSource && !explicitShell && !saved.shell) {
  throw new Error('Run npm run setup -- --desktop /path/to/official-desktop-source (or --shell /path/to/dsh-project-desktop)');
}
const prepared = desktopSource
  ? exportOfficialRuntime(resolve('.'), desktopSource)
  : verifyProjectShell(resolve('.'), explicitShell);
const {directory, inventory, harness} = prepared;
const source = desktopSource ? {desktopSource: prepared.desktopSource} : {shell: prepared.shell};
const tarballs = resolve('.dev/runtime-tarballs', harness.version);
mkdirSync(tarballs, {recursive: true});
const overrides = {};
for (const entry of inventory.packages) {
  const path = join(directory, entry.filename);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== entry.sha256) throw new Error(`Runtime checksum mismatch: ${entry.name}`);
  const local = join(tarballs, entry.filename);
  copyFileSync(path, local);
  overrides[entry.name] = `file:${local}`;
}
const runtime = resolve('.dev/runtime');
mkdirSync(runtime, {recursive: true});
writeFileSync(join(runtime, 'package.json'), JSON.stringify({
  name: 'project-local-runtime', private: true, type: 'module',
  dependencies: Object.fromEntries([...new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives',
    ...Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-')),
  ])].map(name => [name, overrides[name]])), overrides,
}, null, 2) + '\n');
const installed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: runtime, stdio: 'inherit'});
if (installed.status !== 0) process.exit(installed.status ?? 1);
const scope = resolve('node_modules/@deepseek-ai');
const target = join(runtime, 'node_modules/@deepseek-ai');
mkdirSync(resolve('node_modules'), {recursive: true});
// Keep all official packages on the same stable runtime; preserve previous packages.
if (existsSync(scope) || lstatSync(scope, {throwIfNoEntry: false})) {
  if (lstatSync(scope).isSymbolicLink()) {
    const allowed = ['.dev/runtime', '.dev/runtime-beta'].map(path => resolve(path, 'node_modules/@deepseek-ai'));
    if (!allowed.includes(resolve('node_modules', readlinkSync(scope)))) throw new Error('Refusing to replace an unmanaged @deepseek-ai link');
    unlinkSync(scope);
  } else {
    const backup = join(mkdtempSync(resolve('.dev/npm-runtime-backup-')), '@deepseek-ai');
    renameSync(scope, backup);
    console.log(`Preserved previous npm runtime packages at ${backup}`);
  }
}
symlinkSync(target, scope, 'junction');
writeFileSync('.dev/runtime-source.json', JSON.stringify({...source, edition, ...harness}, null, 2) + '\n');
console.log(`Prepared ${edition}: DSH ${harness.version}, including matching development types.`);
