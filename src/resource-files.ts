import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync} from 'node:fs';
import {isAbsolute, join, relative, sep} from 'node:path';
import {z} from 'zod';
import {appendGitignoreRules, atomicWriteFile, exclusiveAtomicWriteFile} from './atomic-file.ts';
import {projectFilePaths} from './project-files.ts';
import {ProjectHttpError} from './http.ts';

export function resourceFailure(code: string, status = 409): never {throw new ProjectHttpError(status, code);}
export const nodeError = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;
export function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
export function optionalText(path: string, limit: number): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > limit) return resourceFailure('resource-config-invalid', 422);
    const bytes = readFileSync(path);
    if (bytes.length > limit) return resourceFailure('resource-config-invalid', 422);
    return bytes.toString('utf8');
  } catch (error) {if (nodeError(error, 'ENOENT')) return null; throw error;}
}
/** Resource metadata writes never follow links into another project or directory. */
export function resourcePaths(manifestPath: string, create = false) {
  const paths = projectFilePaths(manifestPath);
  if (create) {
    try {mkdirSync(paths.metadata, {mode: 0o700});} catch (error) {if (!nodeError(error, 'EEXIST')) throw error;}
  }
  try {
    if (lstatSync(paths.metadata).isSymbolicLink() || !statSync(paths.metadata).isDirectory()
      || !within(paths.root, realpathSync(paths.metadata))) resourceFailure('resource-config-invalid', 422);
  } catch (error) {if (!nodeError(error, 'ENOENT')) throw error;}
  const result = {...paths, local: join(paths.metadata, 'local.yaml'), journal: join(paths.metadata, 'resource-transaction.json')};
  for (const path of [result.manifest, result.local, result.journal, join(paths.metadata, '.gitignore')]) {
    try {if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) resourceFailure('resource-config-invalid', 422);}
    catch (error) {if (!nodeError(error, 'ENOENT')) throw error;}
  }
  return result;
}
export function resourceRevision(manifest: string | null, local: string | null): string {
  return createHash('sha256').update(JSON.stringify([manifest, local])).digest('hex');
}
const entrySchema = z.object({before: z.string().nullable(), after: z.string(), mode: z.number().int().min(0).max(0o777)}).strict();
const journalSchema = z.object({schemaVersion: z.literal(1), manifest: z.string(), definition: entrySchema, local: entrySchema}).strict();

/** Fixed file names and expected contents make interrupted two-file commits recoverable without overwriting external edits. */
export function recoverResourceTransaction(manifestPath: string): void {
  const paths = resourcePaths(manifestPath);
  const text = optionalText(paths.journal, 1024 * 1024);
  if (text === null) return;
  const journal = journalSchema.parse(JSON.parse(text));
  if (journal.manifest !== paths.manifest) resourceFailure('resource-recovery-conflict');
  const entries = [[paths.manifest, journal.definition, 256_000], [paths.local, journal.local, 64_000]] as const;
  for (const [path, entry, limit] of entries) {
    if (Buffer.byteLength(entry.after) > limit || (entry.before !== null && Buffer.byteLength(entry.before) > limit)) resourceFailure('resource-config-invalid', 422);
    const current = optionalText(path, limit);
    if (current !== entry.before && current !== entry.after) resourceFailure('resource-recovery-conflict');
  }
  for (const [path, entry, limit] of entries) {
    const current = optionalText(path, limit);
    if (current === entry.after) continue;
    if (current !== entry.before) resourceFailure('resource-recovery-conflict');
    if (current === null) exclusiveAtomicWriteFile(path, entry.after, entry.mode);
    else atomicWriteFile(path, entry.after, entry.mode, true);
  }
  unlinkSync(paths.journal);
}

/** All writes are synchronous: no Host reader can observe a half-written pair in this event loop. */
export function commitResourceFiles(manifestPath: string, expectedRevision: string, definition: string, local: string,
  afterWrite?: (stage: 'journal' | 'manifest' | 'local') => void): void {
  recoverResourceTransaction(manifestPath);
  if (Buffer.byteLength(definition) > 256_000 || Buffer.byteLength(local) > 64_000) resourceFailure('body-too-large', 413);
  const paths = resourcePaths(manifestPath, true);
  const previous = optionalText(paths.manifest, 256_000);
  const previousLocal = optionalText(paths.local, 64_000);
  if (resourceRevision(previous, previousLocal) !== expectedRevision) resourceFailure('revision-conflict');
  appendGitignoreRules(paths.metadata, ['/local.yaml', '/resource-transaction.json']);
  const journal = {schemaVersion: 1, manifest: paths.manifest,
    definition: {before: previous, after: definition, mode: statSync(paths.manifest).mode & 0o777},
    local: {before: previousLocal, after: local, mode: 0o600}};
  const text = JSON.stringify(journal);
  if (Buffer.byteLength(text) > 1024 * 1024) resourceFailure('body-too-large', 413);
  exclusiveAtomicWriteFile(paths.journal, text, 0o600);
  afterWrite?.('journal');
  // Check again after preparing the journal; keep it for diagnosis if an external editor won.
  if (optionalText(paths.manifest, 256_000) !== previous || optionalText(paths.local, 64_000) !== previousLocal) resourceFailure('resource-recovery-conflict');
  atomicWriteFile(paths.manifest, definition, journal.definition.mode, true);
  afterWrite?.('manifest');
  if (optionalText(paths.local, 64_000) !== previousLocal) resourceFailure('resource-recovery-conflict');
  if (previousLocal === null) exclusiveAtomicWriteFile(paths.local, local, 0o600);
  else atomicWriteFile(paths.local, local, 0o600);
  afterWrite?.('local');
  unlinkSync(paths.journal);
}
