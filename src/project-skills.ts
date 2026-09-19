import {randomUUID} from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, watchFile, unwatchFile,
} from 'node:fs';
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderObservation,
  type SkillSummary,
  type SkillViewOptions,
} from '@deepseek-ai/dsh-skill';
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem';
import {parse, stringify} from 'yaml';
import {z} from 'zod';
import {atomicWriteFile} from './atomic-file.ts';
import {ensureProjectLayout, type ProjectLayout} from './project-layout.ts';
import type {ProjectView} from './project.ts';

const MAX_INDEX_BYTES = 64 * 1024;
const DEFAULT_IMPORT_LIMITS: ProjectSkillImportLimits = {
  maxFiles: 1_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  skills: z.record(
    z.string(),
    z.object({enabled: z.boolean()}).strict(),
  ),
}).strict().superRefine((value, ctx) => {
  for (const name of Object.keys(value.skills)) {
    if (!isSkillName(name)) ctx.addIssue({code: 'custom', message: `Invalid Skill name: ${name}`, path: ['skills', name]});
  }
});

type SkillIndex = z.infer<typeof indexSchema>;

/** Limits applied before any imported Skill content is copied into the Project. */
export interface ProjectSkillImportLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** Optional runtime controls used to disable watchers or lower import limits in tests. */
export interface ProjectSkillServiceOptions {
  watch?: boolean;
  limits?: Partial<ProjectSkillImportLimits>;
}

/** One Project-owned Skill shown in the management UI. */
export interface ProjectSkillView {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: SkillInvocationPolicy;
  provider: string;
  source: string;
  path: string;
  enabled: boolean;
  effective: boolean;
  readonly: false;
}

/** One effective Skill inherited from another DSH provider. */
export interface InheritedSkillView extends SkillSummary {
  readonly: true;
}

/** A bounded management snapshot with an optional non-fatal index diagnostic. */
export interface ProjectSkillsSnapshot {
  schemaVersion: 1;
  project: ProjectSkillView[];
  inherited: InheritedSkillView[];
  diagnostic?: string;
}

interface ImportFile {
  source: string;
  relativePath: string;
  mode: number;
}

interface ImportDirectory {
  relativePath: string;
  mode: number;
}

interface ImportManifest {
  name: string;
  files: ImportFile[];
  directories: ImportDirectory[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function boundedText(path: string, bytes: number): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > bytes) throw new Error(`Expected a file no larger than ${bytes} bytes: ${path}`);
  const content = readFileSync(path);
  if (content.length > bytes) throw new Error(`File changed beyond the size limit: ${path}`);
  return content.toString('utf8');
}

function providerCandidates(
  observation: readonly SkillCandidate[] | SkillProviderObservation,
): readonly SkillCandidate[] {
  return isProviderObservation(observation) ? observation.candidates : observation;
}

function withCandidates(
  observation: readonly SkillCandidate[] | SkillProviderObservation,
  candidates: readonly SkillCandidate[],
): readonly SkillCandidate[] | SkillProviderObservation {
  return isProviderObservation(observation) ? {candidates, complete: observation.complete} : candidates;
}

function isProviderObservation(
  observation: readonly SkillCandidate[] | SkillProviderObservation,
): observation is SkillProviderObservation {
  return !Array.isArray(observation);
}

/** Read just enough standard frontmatter to establish the bundle's durable name. */
function skillName(path: string, maxFileBytes: number): string {
  const raw = boundedText(path, maxFileBytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error(`Skill bundle is missing YAML frontmatter: ${path}`);
  const data = z.object({name: z.string(), description: z.string().min(1)}).passthrough().parse(parse(match[1]!));
  if (!isSkillName(data.name)) throw new Error(`Invalid Skill name: ${data.name}`);
  return data.name;
}

function validatedLimits(options: ProjectSkillServiceOptions): ProjectSkillImportLimits {
  const limits = {...DEFAULT_IMPORT_LIMITS, ...options.limits};
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  }
  return limits;
}

/**
 * Resolve every source entry before copying it. Internal symbolic links are
 * materialized as ordinary files/directories, while links escaping the bundle
 * and special files are rejected.
 */
function importManifest(sourceDirectory: string, limits: ProjectSkillImportLimits): ImportManifest {
  const requested = resolve(sourceDirectory);
  const root = realpathSync(requested);
  if (!statSync(root).isDirectory()) throw new Error(`Skill source is not a directory: ${sourceDirectory}`);
  const files: ImportFile[] = [];
  const directories: ImportDirectory[] = [];
  let totalBytes = 0;

  const visit = (path: string, relativePath: string, ancestors: ReadonlySet<string>): void => {
    const lexical = lstatSync(path);
    const canonical = lexical.isSymbolicLink() ? realpathSync(path) : path;
    if (!isWithin(root, canonical)) throw new Error(`Symbolic link points outside the Skill bundle: ${path}`);
    const info = lexical.isSymbolicLink() ? statSync(canonical) : lexical;
    if (info.isDirectory()) {
      if (ancestors.has(canonical)) throw new Error(`Symbolic link cycle in Skill bundle: ${path}`);
      directories.push({relativePath, mode: info.mode & 0o777});
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(canonical);
      for (const entry of readdirSync(canonical, {withFileTypes: true}).sort((left, right) => left.name.localeCompare(right.name))) {
        visit(join(canonical, entry.name), join(relativePath, entry.name), nextAncestors);
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Skill bundles may contain only regular files and directories: ${path}`);
    if (info.size > limits.maxFileBytes) {
      throw new Error(`Skill import single file limit is ${limits.maxFileBytes} bytes: ${path}`);
    }
    files.push({source: canonical, relativePath, mode: info.mode & 0o777});
    if (files.length > limits.maxFiles) throw new Error(`Skill import file count exceeds ${limits.maxFiles} files`);
    totalBytes += info.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`Skill import total size exceeds ${limits.maxTotalBytes} bytes`);
    }
  };

  visit(root, '', new Set());
  const name = skillName(join(root, 'SKILL.md'), limits.maxFileBytes);
  if (basename(root) !== name) throw new Error(`Skill directory name must match frontmatter name "${name}"`);
  return {name, files, directories};
}

/** Materialize a previously validated, self-contained bundle into a private temporary directory. */
function copyImport(manifest: ImportManifest, destination: string): void {
  mkdirSync(destination, {mode: 0o700});
  for (const directory of manifest.directories) {
    if (directory.relativePath === '') continue;
    mkdirSync(join(destination, directory.relativePath), {mode: directory.mode});
  }
  for (const file of manifest.files) {
    const target = join(destination, file.relativePath);
    copyFileSync(file.source, target);
    // Preserve executable helper scripts without carrying special permission bits.
    try {chmodSync(target, file.mode);}
    catch { /* A copied file remains usable even when chmod is unavailable. */ }
  }
}

/**
 * Owns a Project-specific filesystem provider, its enable index, and safe local
 * bundle imports. Provider mutations explicitly invalidate the DSH Skill catalog.
 */
export class ProjectSkillService {
  readonly layout: ProjectLayout;
  readonly providerName: string;
  private readonly ctx: Context;
  private readonly delegate: FileSystemSkillProvider;
  private readonly invalidate: () => void;
  private readonly unregister: () => void;
  private readonly limits: ProjectSkillImportLimits;
  private lastValidIndex: SkillIndex = {schemaVersion: 1, skills: {}};
  private indexDiagnostic: string | undefined;
  private disposal: Promise<void> | undefined;
  private observedIndex = '';
  private readonly onIndexChange = (): void => {
    const index = this.readIndex();
    const signature = this.indexSignature(index);
    if (signature === this.observedIndex) return;
    this.observedIndex = signature;
    this.invalidate();
  };

  constructor(ctx: Context, project: ProjectView, options: ProjectSkillServiceOptions = {}) {
    this.ctx = ctx;
    this.layout = ensureProjectLayout(project.root);
    this.providerName = `project-${project.id}`;
    this.limits = validatedLimits(options);
    let delegate!: FileSystemSkillProvider;
    let invalidate!: () => void;
    this.unregister = ctx.skills.registerProvider((control) => {
      invalidate = control.invalidate;
      delegate = new FileSystemSkillProvider(ctx, control, {
        providerName: this.providerName,
        includeDefaultRoots: false,
        customSkillDirs: [this.layout.skills],
        watch: options.watch ?? true,
      });
      const provider: SkillProvider = {
        name: this.providerName,
        list: async lookup => this.filteredList(delegate, lookup),
        get: (candidate, lookup) => delegate.get(candidate, lookup),
      };
      return provider;
    });
    this.delegate = delegate;
    this.invalidate = invalidate;
    this.observedIndex = this.indexSignature(this.readIndex());
    // The official provider watches Markdown. Watch the index path separately;
    // stat polling also follows editors that replace the YAML inode atomically.
    if (options.watch !== false) {
      watchFile(this.layout.skillIndex, {interval: 250, persistent: false}, this.onIndexChange);
    }
  }

  /** Return Project-owned entries, including disabled ones, plus effective inherited DSH entries. */
  async snapshot(options: SkillViewOptions = {}, registry = this.ctx.skills): Promise<ProjectSkillsSnapshot> {
    const observation = await this.delegate.list(options);
    const index = this.readIndex();
    const project = providerCandidates(observation)
      .filter(candidate => this.isStandardBundle(candidate))
      .map(candidate => this.projectView(candidate, this.isEnabled(candidate.name, index)))
      .sort((left, right) => left.name.localeCompare(right.name));
    const effective = await registry.list(options);
    for (const skill of project) skill.effective = effective.some(item => item.name === skill.name && item.provider === this.providerName);
    const inherited = effective
      .filter(skill => skill.provider !== this.providerName)
      .map(skill => ({...skill, readonly: true as const}));
    return {
      schemaVersion: 1,
      project,
      inherited,
      ...(this.indexDiagnostic === undefined ? {} : {diagnostic: this.indexDiagnostic}),
    };
  }

  /** Persist one Project Skill's enabled state and invalidate cached DSH catalogs. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!isSkillName(name)) throw new Error(`Invalid Skill name: ${name}`);
    const candidates = providerCandidates(await this.delegate.list({}));
    if (!candidates.some(candidate => candidate.name === name && this.isStandardBundle(candidate))) {
      throw new Error(`Project Skill does not exist: ${name}`);
    }
    const index = this.readIndex();
    const next = indexSchema.parse({
      schemaVersion: 1,
      skills: {...index.skills, [name]: {enabled}},
    });
    const content = stringify(next, {lineWidth: 0});
    if (Buffer.byteLength(content) > MAX_INDEX_BYTES) throw new Error(`Skill index exceeds ${MAX_INDEX_BYTES} bytes`);
    atomicWriteFile(this.layout.skillIndex, content, 0o600);
    this.lastValidIndex = next;
    this.observedIndex = this.indexSignature(next);
    this.indexDiagnostic = undefined;
    this.invalidate();
  }

  /** Validate and atomically import one complete local `<name>/SKILL.md` bundle. */
  async importBundle(sourceDirectory: string): Promise<ProjectSkillView> {
    const source = realpathSync(resolve(sourceDirectory));
    if (isWithin(this.layout.skills, source) || isWithin(source, this.layout.skills)) {
      throw new Error('Skill source must be outside the Project skills directory');
    }
    const manifest = importManifest(source, this.limits);
    const destination = join(this.layout.skills, manifest.name);
    if (existsSync(destination)) throw new Error(`Project Skill already exists: ${manifest.name}`);
    const temporary = join(this.layout.skills, `.import-${randomUUID()}`);
    try {
      copyImport(manifest, temporary);
      const copied = providerCandidates(await this.delegate.list({})).find(candidate =>
        candidate.name === manifest.name && candidate.path !== undefined
        && resolve(candidate.path) === join(temporary, 'SKILL.md'));
      if (copied === undefined || await this.delegate.get(copied, {}) === undefined) {
        throw new Error(`Imported Skill failed DSH validation: ${manifest.name}`);
      }
      if (existsSync(destination)) throw new Error(`Project Skill already exists: ${manifest.name}`);
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, {recursive: true, force: true});
      throw error;
    }
    this.invalidate();
    const snapshot = await this.snapshot();
    const imported = snapshot.project.find(skill => skill.name === manifest.name);
    if (imported === undefined) throw new Error(`Imported Skill is not discoverable: ${manifest.name}`);
    return imported;
  }

  /** Unregister the provider and await all filesystem watchers exactly once. */
  dispose(): Promise<void> {
    if (this.disposal === undefined) {
      unwatchFile(this.layout.skillIndex, this.onIndexChange);
      this.unregister();
      this.disposal = this.delegate.dispose();
    }
    return this.disposal;
  }

  private async filteredList(
    delegate: FileSystemSkillProvider,
    options: SkillLookupOptions,
  ): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const observation = await delegate.list(options);
    const index = this.readIndex();
    const candidates = providerCandidates(observation)
      .filter(candidate => this.isStandardBundle(candidate) && this.isEnabled(candidate.name, index));
    return withCandidates(observation, candidates);
  }

  /** Keep a last-known-good index so a hand-edited YAML error does not change the effective catalog. */
  private readIndex(): SkillIndex {
    try {
      const next = indexSchema.parse(parse(boundedText(this.layout.skillIndex, MAX_INDEX_BYTES)));
      this.lastValidIndex = next;
      this.indexDiagnostic = undefined;
    } catch (error) {
      this.indexDiagnostic = `${this.layout.skillIndex}: ${errorMessage(error).slice(0, 1_000)}`;
    }
    return this.lastValidIndex;
  }

  private isEnabled(name: string, index: SkillIndex): boolean {
    return index.skills[name]?.enabled ?? true;
  }

  private indexSignature(index: SkillIndex): string {
    return JSON.stringify(Object.entries(index.skills).sort(([left], [right]) => left.localeCompare(right)));
  }

  /** Reject flat Markdown and bundles whose direct directory/name/path contract does not match. */
  private isStandardBundle(candidate: SkillCandidate): candidate is SkillCandidate & {path: string} {
    if (candidate.path === undefined) return false;
    const child = relative(this.layout.skills, resolve(candidate.path));
    const segments = child.split(sep);
    if (segments.length !== 2 || segments[0] !== candidate.name || segments[1] !== 'SKILL.md') return false;
    try {return isWithin(this.layout.skills, realpathSync(candidate.path));}
    catch {return false;}
  }

  private projectView(candidate: SkillCandidate & {path: string}, enabled: boolean): ProjectSkillView {
    return {
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse === undefined ? {} : {whenToUse: candidate.whenToUse}),
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      path: candidate.path,
      enabled,
      effective: enabled,
      readonly: false,
    };
  }
}
