/** Development entry points use the independent Shell's immutable stable sources. */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {readCompatibilityPin, verifyDesktopRuntime} from './desktop-runtime.ts';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function resolveProjectShell(repository: string, supplied?: string): string {
  const source = join(repository, '.dev/runtime-source.json');
  const shell = supplied ?? (existsSync(source) ? readJson(source).shell : undefined);
  if (!shell) throw new Error('Run npm run setup -- /path/to/dsh-project-desktop first, or provide --shell');
  const directory = realpathSync(resolve(shell));
  if (readJson(join(directory, 'package.json')).name !== 'dsh-project-desktop') {
    throw new Error('Expected the independent dsh-project-desktop Shell, not a Desktop fork');
  }
  return directory;
}

export function readProjectShellRuntime(repository: string, shell: string) {
  const lock = readJson(join(shell, 'upstream.lock.json'));
  const pin = readCompatibilityPin(repository);
  if (lock.channel !== 'stable' || lock.desktop?.package !== 'dsh-plugin-desktop') {
    throw new Error('Only the independent Shell stable channel is supported');
  }
  if (lock.desktop.commit !== pin.desktop.commit || lock.desktop.version !== pin.desktop.version
    || lock.harness?.version !== pin.harness.stable.version || lock.harness?.commit !== pin.harness.stable.commit) {
    throw new Error('Shell Desktop / Harness pins differ from plugin upstream.json; validate the upgrade first');
  }
  return {shell, lock, ...verifyDesktopRuntime(repository, join(shell, '.upstream/desktop'), 'stable')};
}

export function verifyProjectShell(repository: string, supplied?: string) {
  const shell = resolveProjectShell(repository, supplied);
  const runtime = readProjectShellRuntime(repository, shell);
  // Recompute pinned source trees before trusting the snapshot or its tarballs.
  execFileSync(process.execPath, [join(shell, 'scripts/verify-upstream.mjs')], {cwd: shell, stdio: 'inherit'});
  return runtime;
}
