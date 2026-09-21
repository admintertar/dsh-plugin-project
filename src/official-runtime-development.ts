/** Prepare development dependencies from an immutable official Desktop commit. */
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {readCompatibilityPin, verifyDesktopRuntime} from './desktop-runtime.ts';

export function exportOfficialRuntime(repository: string, supplied: string) {
  const pin = readCompatibilityPin(repository);
  if (!/^[a-f0-9]{40}$/.test(pin.desktop.commit)) throw new Error('Expected a full pinned Desktop commit');
  const desktopSource = realpathSync(supplied);
  // No working-tree files, hooks, private fork patches or installed modules are used.
  const commit = execFileSync('git', ['-C', desktopSource, 'rev-parse', '--verify', `${pin.desktop.commit}^{commit}`], {encoding: 'utf8'}).trim();
  if (commit !== pin.desktop.commit) throw new Error('Desktop commit differs from upstream.json');
  const stagingRoot = join(repository, '.dev');
  mkdirSync(stagingRoot, {recursive: true});
  const snapshot = mkdtempSync(join(stagingRoot, 'official-runtime-'));
  const archive = join(snapshot, 'runtime.tar');
  try {
    execFileSync('git', ['-C', desktopSource, 'archive', '--format=tar', `--output=${archive}`, commit, '--',
      'dsh-plugin-desktop/package.json', 'upstream.json', `vendor/dsh-runtime/${pin.harness.stable.version}`,
    ]);
    // GNU tar, which Git Bash puts ahead of bsdtar on the Windows runner, reads a
    // colon inside a -f/-C value as a remote host, so extract from the snapshot
    // directory using a relative name instead of passing absolute Windows paths.
    execFileSync('tar', ['-xf', 'runtime.tar'], {cwd: snapshot});
    unlinkSync(archive);
    return {desktopSource, snapshot, ...verifyDesktopRuntime(repository, snapshot, 'stable')};
  } catch (error) {
    rmSync(snapshot, {recursive: true, force: true});
    throw error;
  }
}
