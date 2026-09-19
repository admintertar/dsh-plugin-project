import {existsSync, lstatSync, readFileSync, unlinkSync} from 'node:fs';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {exclusiveAtomicWriteFile} from './atomic-file.ts';

/** Cross-Host exclusion for the synchronous file commit, never for model work. */
export function withTaskWriteLock<T>(path: string, work: () => T): T {
  const owner = JSON.stringify({pid: process.pid, host: hostname(), token: randomUUID()});
  let held = false;
  const recover = `${path}.recovery`;
  try {
    if (existsSync(recover)) throw new Error('Task write lock recovery is busy; inspect an interrupted recovery before retrying');
    try {exclusiveAtomicWriteFile(path, owner); held = true;}
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (lstatSync(path).isSymbolicLink()) throw new Error('Task write lock cannot be a symbolic link');
      const stale = readFileSync(path, 'utf8');
      if (!deadOwner(stale)) throw new Error('Task write lock is busy; retry after the current writer finishes');
      // The marker serializes recovery so two readers of one stale lock cannot
      // remove the new live lock. Ambiguous ownership is never taken over.
      exclusiveAtomicWriteFile(recover, owner);
      try {
        if (readFileSync(path, 'utf8') !== stale || !deadOwner(stale)) throw new Error('Task write lock changed; retry');
        unlinkSync(path);
        exclusiveAtomicWriteFile(path, owner);
        held = true;
      } finally {if (existsSync(recover) && readFileSync(recover, 'utf8') === owner) unlinkSync(recover);}
    }
    return work();
  } finally {if (held && existsSync(path) && readFileSync(path, 'utf8') === owner) unlinkSync(path);}
}
function deadOwner(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as {pid?: unknown; host?: unknown};
    if (value.host !== hostname() || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return false;
    try {process.kill(value.pid, 0); return false;}
    catch (error) {return error instanceof Error && 'code' in error && error.code === 'ESRCH';}
  } catch {return false;}
}
