import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {parseArgs} from 'node:util';
import {verifyProjectShell} from '../src/project-shell-development.ts';
import {exportOfficialRuntime} from '../src/official-runtime-development.ts';

// Yarn 4 forwards the literal "--" separator to the script (npm swallowed it),
// so strip it to keep the documented `-- <args>` invocation working.
const {values, positionals} = parseArgs({args: process.argv.slice(2).filter(arg => arg !== '--'), allowPositionals: true, options: {
  edition: {type: 'string', default: 'stable'}, desktop: {type: 'string'}, shell: {type: 'string'},
}});
if (positionals.length > 1 || [values.desktop, values.shell, positionals[0]].filter(Boolean).length > 1) {
  throw new Error('Usage: yarn run setup -- --desktop /path/to/official-desktop-source (or --shell /path/to/dsh-project-desktop)');
}
if (values.edition !== 'stable') throw new Error('Only stable is supported; beta development has been retired');
const edition = 'stable';
const saved = existsSync('.dev/runtime-source.json') ? JSON.parse(readFileSync('.dev/runtime-source.json', 'utf8')) : {};
const explicitShell = values.shell ?? positionals[0];
const desktopSource = values.desktop ?? (explicitShell ? undefined : saved.desktopSource);
if (!desktopSource && !explicitShell && !saved.shell) {
  throw new Error('Run yarn run setup -- --desktop /path/to/official-desktop-source (or --shell /path/to/dsh-project-desktop)');
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
// Yarn 4 equivalent of the former npm install. The archive inventory already
// names every official package, so it supplies both the direct dependency set
// and the resolutions that pin the whole transitive tree to the same stable
// tarballs. Yarn does not recursively auto-install peers the way npm does, so
// the one peer npm previously added implicitly is declared explicitly at the
// version the official release preapproves (see dsh-desktop-source/.yarnrc.yml).
const runtimeDependencies = {...overrides, '@deepseek-ai/cordis-plugin-group': '1.0.2'};
writeFileSync(join(runtime, 'package.json'), JSON.stringify({
  name: 'project-local-runtime', private: true, type: 'module',
  packageManager: 'yarn@4.18.0', dependencies: runtimeDependencies, resolutions: overrides,
}, null, 2) + '\n');
writeFileSync(join(runtime, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableScripts: false\n');
// Yarn derives the project boundary from the nearest lockfile. Without one it
// would treat this directory as an undeclared workspace of the plugin checkout,
// so seed an empty lockfile once and let later runs reuse what install writes.
if (!existsSync(join(runtime, 'yarn.lock'))) writeFileSync(join(runtime, 'yarn.lock'), '');
// Node refuses to spawn a .cmd launcher without a shell since the CVE-2024-27980
// fix, which made this step fail silently on Windows (status null, no output).
const installed = spawnSync(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['yarn', 'install'], {cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32'});
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
    const backup = join(mkdtempSync(resolve('.dev/runtime-backup-')), '@deepseek-ai');
    renameSync(scope, backup);
    console.log(`Preserved previous runtime packages at ${backup}`);
  }
}
symlinkSync(target, scope, 'junction');
writeFileSync('.dev/runtime-source.json', JSON.stringify({...source, edition, ...harness}, null, 2) + '\n');
console.log(`Prepared ${edition}: DSH ${harness.version}, including matching development types.`);
