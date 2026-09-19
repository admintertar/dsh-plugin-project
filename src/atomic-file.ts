import {chmodSync, existsSync, linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Build a same-directory temporary path so the final rename stays atomic. */
function temporaryPath(path: string): string {
  return join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
}

/** Remove a private temporary file after either a successful commit or a failed attempt. */
function cleanup(path: string): void {
  try {unlinkSync(path);}
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

/** Atomically replace text; preserveMode retains existing permissions even under a stricter umask. */
export function atomicWriteFile(path: string, content: string, mode = 0o600, preserveMode = false): void {
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, content, {encoding: 'utf8', flag: 'wx', mode});
    if (preserveMode) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    cleanup(temporary);
    throw error;
  }
}

/**
 * Atomically create a new text file while preserving an existing target.
 * A same-directory hard link is the no-replace commit boundary; unlike rename,
 * it fails with EEXIST if another writer won the target name first.
 */
export function exclusiveAtomicWriteFile(path: string, content: string, mode = 0o600): void {
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, content, {encoding: 'utf8', flag: 'wx', mode});
    linkSync(temporary, path);
    cleanup(temporary);
  } catch (error) {
    cleanup(temporary);
    throw error;
  }
}

/** Add exact project-local ignore rules once while preserving all existing rules and comments. */
export function appendGitignoreRules(root: string, rules: readonly string[]): void {
  const path = join(root, '.gitignore');
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const existing = new Set(original.split(/\r?\n/));
  const missing = rules.filter(rule => !existing.has(rule));
  if (missing.length === 0) return;
  const prefix = original.length === 0 || original.endsWith('\n') ? original : `${original}\n`;
  // Ignore rules are public project metadata; replacing an existing file must
  // retain its permissions instead of using the private YAML default.
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  atomicWriteFile(path, `${prefix}${missing.join('\n')}\n`, mode ?? 0o666, mode !== undefined);
}
