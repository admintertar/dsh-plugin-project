import {realpathSync} from 'node:fs';
import {resourceFailure} from './resource-files.ts';
import {validResourceUrl} from './resource-contract.ts';
import {validateResourceBranch, type GitRun} from './resource-git.ts';

/** Configure an existing repository only. No clone, checkout, commit, fetch or push. */
export async function associateResourceRemote(path: string, url: string, branch: string | undefined, run: GitRun,
  current: () => void, save: () => void): Promise<void> {
  if (!validResourceUrl(url)) resourceFailure('resource-url-invalid', 422);
  if (realpathSync(await run(['rev-parse', '--show-toplevel'], path)) !== realpathSync(path)) resourceFailure('resource-git-invalid');
  const localBranch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], path).catch(() => resourceFailure('git-detached'));
  const remoteBranch = branch || localBranch;
  await validateResourceBranch(remoteBranch, path, run);
  const names = (await run(['remote'], path)).split('\n');
  if (names.includes('origin') && await run(['remote', 'get-url', 'origin'], path) !== url) resourceFailure('resource-origin-mismatch');
  // Read local values using a successful --list call, so an unreadable config cannot look absent.
  const read = async () => {
    const values = new Map<string, string[]>();
    for (const entry of (await run(['config', '--local', '--null', '--list'], path, {raw: true})).split('\0')) {
      const split = entry.indexOf('\n'); if (split < 0) continue;
      const key = entry.slice(0, split), value = entry.slice(split + 1);
      values.set(key, [...values.get(key) ?? [], value]);
    }
    return values;
  };
  const original = await read();
  const changes = [
    ...(!names.includes('origin') ? [
      {key: 'remote.origin.url', values: [url]},
      {key: 'remote.origin.fetch', values: ['+refs/heads/*:refs/remotes/origin/*']},
    ] : []),
    {key: `branch.${localBranch}.remote`, values: ['origin']},
    {key: `branch.${localBranch}.merge`, values: [`refs/heads/${remoteBranch}`]},
  ];
  const applied: typeof changes = [];
  try {
    current();
    for (const change of changes) {
      const values = (await read()).get(change.key) ?? [];
      if (JSON.stringify(values) !== JSON.stringify(original.get(change.key) ?? [])) resourceFailure('git-state-changed');
      await run(['config', '--local', '--replace-all', change.key, change.values[0]!], path);
      applied.push(change);
    }
    current();
    if (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], path) !== localBranch) resourceFailure('git-state-changed');
    save();
  } catch (error) {
    // Restore only values still owned by this operation; retain concurrent external edits.
    for (const change of applied.reverse()) {
      const values = (await read()).get(change.key) ?? [];
      if (JSON.stringify(values) !== JSON.stringify(change.values)) continue;
      await run(['config', '--local', '--unset-all', change.key], path);
      for (const value of original.get(change.key) ?? []) await run(['config', '--local', '--add', change.key, value], path);
    }
    throw error;
  }
}
