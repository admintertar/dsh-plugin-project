/** Link development packages from the exact official Harness checkout. */
import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';

export interface OfficialSourcePin {
  schemaVersion: number;
  repository: string;
  tag: string;
  commit: string;
  version: string;
  desktopTree: string;
  dependencyLockBlob: string;
}

export function readOfficialPin(repository: string): OfficialSourcePin {
  const pin = JSON.parse(readFileSync(join(repository, 'upstream.json'), 'utf8')) as OfficialSourcePin;
  if (pin.schemaVersion !== 1 || pin.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git'
    || !/^dsh-v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(pin.tag)
    || !/^[a-f0-9]{40}$/.test(pin.commit)
    || !/^[a-f0-9]{40}$/.test(pin.desktopTree)
    || !/^[a-f0-9]{40}$/.test(pin.dependencyLockBlob)) {
    throw new Error('Invalid pinned official Desktop source in upstream.json');
  }
  return pin;
}

/** Validate the checkout before using its ignored build output and pnpm links. */
export function verifyOfficialSource(repository: string, supplied: string) {
  const pin = readOfficialPin(repository);
  const source = realpathSync(resolve(supplied));
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {encoding: 'utf8'}).trim();
  if (git('rev-parse', 'HEAD') !== pin.commit) throw new Error('Official checked out commit differs from upstream.json');
  for (const [actual, expected, label] of [
    [git('rev-parse', `refs/tags/${pin.tag}^{commit}`), pin.commit, 'release tag'],
    [git('rev-parse', 'HEAD:apps/desktop'), pin.desktopTree, 'Desktop source tree'],
    [git('rev-parse', 'HEAD:pnpm-lock.yaml'), pin.dependencyLockBlob, 'dependency lock'],
  ]) if (actual !== expected) throw new Error(`Official ${label} differs from upstream.json`);
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Official source has tracked changes; restore the pinned checkout before setup');
  }
  for (const name of ['apps/desktop', 'apps/desktop-host', 'packages/mcp/mcp-client']) {
    const manifest = JSON.parse(readFileSync(join(source, name, 'package.json'), 'utf8'));
    if (manifest.version !== pin.version) throw new Error(`Official ${name} version differs from upstream.json`);
  }
  for (const path of ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js', 'packages/mcp/mcp-client/lib/index.js']) {
    if (!existsSync(join(source, path))) throw new Error(`Build the official source first: ${path}`);
  }
  if (!existsSync(join(source, 'node_modules/.pnpm/node_modules/@deepseek-ai'))) {
    throw new Error('Run pnpm install --frozen-lockfile in the official source first');
  }
  return {source, pin};
}

/** Keep all official packages in one pnpm workspace; preserve prior links. */
export function setupOfficialSource(repository: string, supplied: string) {
  const {source, pin} = verifyOfficialSource(repository, supplied);
  const staging = join(repository, '.dev/official-source');
  mkdirSync(staging, {recursive: true});
  const merged = mkdtempSync(join(staging, 'scope-'));
  for (const directory of [join(source, 'node_modules/.pnpm/node_modules/@deepseek-ai'), join(source, 'node_modules/@deepseek-ai')]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const target = join(merged, name);
      if (!existsSync(target)) symlinkSync(realpathSync(join(directory, name)), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  const scope = join(repository, 'node_modules/@deepseek-ai');
  mkdirSync(join(repository, 'node_modules'), {recursive: true});
  const current = lstatSync(scope, {throwIfNoEntry: false});
  if (current?.isSymbolicLink()) {
    const target = realpathSync(scope);
    if (!target.startsWith(join(repository, '.dev') + sep)) throw new Error(`Refusing to replace an unmanaged package link: ${target}`);
    unlinkSync(scope);
  } else if (current) {
    const previous = join(mkdtempSync(join(staging, 'previous-scope-')), '@deepseek-ai');
    renameSync(scope, previous);
    console.log(`Preserved previous installed packages at ${previous}`);
  }
  symlinkSync(merged, scope, process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(repository, '.dev'), {recursive: true});
  writeFileSync(join(repository, '.dev/runtime-source.json'), JSON.stringify({
    desktopSource: source, repository: pin.repository, tag: pin.tag,
    commit: pin.commit, version: pin.version, edition: 'stable',
  }, null, 2) + '\n');
  console.log(`Project development packages now resolve from official ${pin.version} source at ${source}`);
}
