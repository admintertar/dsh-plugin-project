import {execFile, execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createProjectFile} from '../../src/project-files.ts';
import {ProjectResourceStore} from '../../src/project-resources.ts';
import {ResourceCloneManager} from '../../src/resource-clones.ts';
import {runResourceGit, type GitRun} from '../../src/resource-git.ts';

const execute = promisify(execFile);
export function resourceFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'project-resources-')));
  const root = join(base, 'project'); mkdirSync(root);
  const manifest = createProjectFile(join(root, 'example.agent-project'));
  const runtime = join(base, 'runtime');
  const outside = join(base, 'outside'); mkdirSync(outside);
  const store = new ProjectResourceStore(manifest);
  return {base, root, outside, manifest, runtime, store, cleanup: () => rmSync(base, {recursive: true, force: true})};
}
export function gitFixture(root: string, empty = false) {
  mkdirSync(root, {recursive: true});
  const git = (...args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-b', 'main');
  if (!empty) {
    writeFileSync(join(root, 'README.md'), '# Fixture\n'); git('add', 'README.md');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
    git('branch', 'feature');
  }
  return git;
}
/** Local transport belongs to this injected test runner; production URL validation and Git protocols remain unchanged. */
export function localCloneRunner(source: string, override?: (args: readonly string[], cwd: string, options: Parameters<GitRun>[2]) => ReturnType<GitRun> | undefined): GitRun {
  return async (args, cwd, options) => {
    const overridden = override?.(args, cwd, options);
    if (overridden) return overridden;
    if (!args.includes('clone')) return runResourceGit(args, cwd, options);
    const copy = [...args]; const separator = copy.indexOf('--'); const url = copy[separator + 1]!;
    copy[separator + 1] = source;
    await execute('git', copy, {cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024});
    await execute('git', ['remote', 'set-url', 'origin', url], {cwd});
    return '';
  };
}
export async function finishClone(manager: ResourceCloneManager, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const operation = (await manager.snapshot(false)).operations.find(item => item.id === id)!;
    if (operation.status !== 'cloning' && operation.status !== 'cancelling') return operation;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Clone did not settle');
}
