import {randomUUID} from 'node:crypto';
import {accessSync, constants, realpathSync, statSync} from 'node:fs';
import {basename, relative, sep} from 'node:path';
import {isMap, isSeq, parse, parseDocument} from 'yaml';
import {z} from 'zod';
import {manifestSchema, readProject, type ProjectView} from './project.ts';
import {commitResourceFiles, optionalText, recoverResourceTransaction, resourceFailure, resourcePaths, resourceRevision, within} from './resource-files.ts';
import {inspectResourceGit, runResourceGit, validateResourceBranch, type GitRun} from './resource-git.ts';
import {validResourceUrl, type ResourceAction, type ResourceCloneOperation, type ResourceInspection} from './resource-contract.ts';
import {isProjectRootResource} from './resource-scope.ts';
import {associateResourceRemote} from './resource-remote.ts';

export type ResourceDefinition = z.infer<typeof manifestSchema>['resources'][number];
const localSchema = z.object({resources: z.record(z.string(), z.string().min(1))}).strict();
export function resourceId(name: string): string {
  const prefix = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+|-+$/g, '').slice(0, 40) || 'resource';
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
function nameFor(name: string): string {return z.string().trim().min(1).max(160).parse(name);}

/** Portable YAML and machine bindings share one recoverable, revision-checked commit boundary. */
export class ProjectResourceStore {
  readonly manifest: string;
  readonly root: string;
  private readonly identity: string;
  constructor(manifest: string, readonly run: GitRun = runResourceGit,
    private readonly afterWrite?: (stage: 'journal' | 'manifest' | 'local') => void) {
    const paths = resourcePaths(manifest);
    this.manifest = paths.manifest; this.root = paths.root;
    recoverResourceTransaction(this.manifest);
    this.identity = readProject(this.manifest).id;
  }
  read(): ProjectView {
    const project = readProject(this.manifest);
    if (project.id !== this.identity) throw new Error('Restart this Project host before changing the Project identity');
    return project;
  }
  private configuration() {
    recoverResourceTransaction(this.manifest);
    const paths = resourcePaths(this.manifest);
    const text = optionalText(paths.manifest, 256_000);
    if (text === null) return resourceFailure('resource-config-invalid', 422);
    const localText = optionalText(paths.local, 64_000);
    const definition = manifestSchema.parse(parse(text));
    if (definition.id !== this.identity) throw new Error('Restart this Project host before changing the Project identity');
    const local = localSchema.parse(localText === null ? {resources: {}} : parse(localText));
    if (Object.keys(local.resources).some(id => !definition.resources.some(item => item.id === id))) resourceFailure('resource-config-invalid', 422);
    return {text, localText, definition, local, revision: resourceRevision(text, localText)};
  }
  revision(): string {return this.configuration().revision;}
  assertRevision(expected: string): void {if (this.revision() !== expected) resourceFailure('revision-conflict');}
  definition(id: string): ResourceDefinition {
    return this.configuration().definition.resources.find(item => item.id === id) ?? resourceFailure('resource-not-found', 404);
  }
  /** Preview is local-only; saving validates the directory again after any asynchronous Git inspection. */
  async inspect(path: string): Promise<ResourceInspection> {
    let canonical: string;
    try {canonical = realpathSync(path); if (!statSync(canonical).isDirectory()) return resourceFailure('resource-unavailable', 422); accessSync(canonical, constants.R_OK);}
    catch {return resourceFailure('resource-unavailable', 422);}
    const git = await inspectResourceGit(canonical, this.run);
    return {path: canonical, name: basename(canonical) || canonical, external: !within(this.root, canonical),
      duplicateId: this.read().resources.find(item => item.path === canonical)?.id, git};
  }
  private location(path: string, exclude?: string): {path: string; shared?: string} {
    let canonical: string;
    try {canonical = realpathSync(path); if (!statSync(canonical).isDirectory()) return resourceFailure('resource-unavailable', 422); accessSync(canonical, constants.R_OK);}
    catch {return resourceFailure('resource-unavailable', 422);}
    if (this.read().resources.some(item => item.id !== exclude && item.path === canonical)) resourceFailure('resource-duplicate');
    return {path: canonical, shared: within(this.root, canonical) ? relative(this.root, canonical).split(sep).join('/') || '.' : undefined};
  }
  /** Patch the YAML nodes in place so comments, ordering, and unrelated settings survive resource edits. */
  private save(expectedRevision: string, change: (resources: ResourceDefinition[], bindings: Record<string, string>) => void): void {
    const current = this.configuration();
    if (current.revision !== expectedRevision) resourceFailure('revision-conflict');
    const resources = current.definition.resources.map(item => ({...item}));
    const bindings = {...current.local.resources};
    change(resources, bindings);
    manifestSchema.parse({...current.definition, resources}); localSchema.parse({resources: bindings});
    const document = parseDocument(current.text);
    const sequence = document.get('resources');
    if (!isSeq(sequence)) return resourceFailure('resource-config-invalid', 422);
    const nodes = new Map(sequence.items.filter(isMap).map(node => [String(node.get('id')), node]));
    sequence.items = resources.map(item => {
      const node = nodes.get(item.id) ?? document.createNode(item);
      if (!isMap(node)) return resourceFailure('resource-config-invalid', 422);
      for (const key of ['name', 'type', 'path', 'url', 'branch'] as const) {
        if (item[key] === undefined) node.delete(key); else node.set(key, item[key]);
      }
      return node;
    });
    const localDocument = parseDocument(current.localText ?? 'resources: {}\n');
    const mapping = localDocument.get('resources');
    if (!isMap(mapping)) return resourceFailure('resource-config-invalid', 422);
    for (const entry of [...mapping.items]) {const key = String(entry.key); if (!Object.hasOwn(bindings, key)) mapping.delete(key);}
    for (const [id, path] of Object.entries(bindings)) mapping.set(id, path);
    commitResourceFiles(this.manifest, expectedRevision, document.toString({lineWidth: 0}), localDocument.toString({lineWidth: 0}), this.afterWrite);
  }
  async mutate(action: ResourceAction): Promise<void> {
    this.assertRevision(action.expectedRevision);
    if ('id' in action) {
      const item = this.read().resources.find(item => item.id === action.id);
      if (item && isProjectRootResource(item, this.root)) resourceFailure('resource-project-root');
    }
    if (action.action === 'addLocal') {
      const name = nameFor(action.name);
      const inspected = await this.inspect(action.path);
      if (action.type === 'git' && (!inspected.git?.url || !action.url || !validResourceUrl(action.url) || inspected.git.url !== action.url)) resourceFailure('resource-git-invalid', 422);
      const location = this.location(action.path);
      const id = resourceId(name);
      this.save(action.expectedRevision, (resources, bindings) => {
        resources.push({id, name, type: action.type, ...(location.shared === undefined ? {} : {path: location.shared}),
          ...(action.type === 'git' ? {url: action.url} : {})});
        if (location.shared === undefined) bindings[id] = location.path;
      });
    } else if (action.action === 'bind') {
      const existing = this.definition(action.id);
      const inspected = await this.inspect(action.path);
      if (existing.type === 'git' && !inspected.git) resourceFailure('resource-git-invalid', 422);
      if (existing.type === 'git' && inspected.git?.url !== existing.url && !action.originChoice) resourceFailure('resource-origin-mismatch');
      if (action.originChoice === 'replace' && !inspected.git?.url) resourceFailure('resource-url-invalid', 422);
      const location = this.location(action.path, action.id);
      this.save(action.expectedRevision, (resources, bindings) => {
        const item = resources.find(item => item.id === action.id)!;
        if (item.type === 'local') {
          item.path = location.shared;
          if (location.shared === undefined) bindings[item.id] = location.path; else delete bindings[item.id];
        } else {
          bindings[item.id] = location.path;
          if (action.originChoice === 'replace') item.url = inspected.git!.url;
        }
      });
    } else if (action.action === 'associate') {
      const item = this.read().resources.find(item => item.id === action.id) ?? resourceFailure('resource-not-found', 404);
      if (item.type !== 'git' || item.status !== 'ready' || !item.path) resourceFailure('resource-unavailable');
      const current = () => {
        this.assertRevision(action.expectedRevision);
        if (this.read().resources.find(resource => resource.id === action.id)?.path !== item.path) resourceFailure('git-state-changed');
      };
      await associateResourceRemote(item.path, action.url, action.branch, this.run, current, () => {
        try {this.save(action.expectedRevision, resources => {resources.find(resource => resource.id === action.id)!.url = action.url;});}
        catch (error) {
          // A prepared resource journal completes forward. Recover it before deciding whether
          // Git configuration must roll back, so the portable URL cannot outlive its origin.
          try {
            const saved = this.read().resources.find(resource => resource.id === action.id);
            if (saved && saved.path === item.path && saved.url === action.url) return;
          } catch { /* Preserve the persistence failure and the journal for existing recovery. */ }
          throw error;
        }
      });
    } else if (action.action === 'edit') {
      this.definition(action.id);
      if (action.url !== undefined && !validResourceUrl(action.url)) resourceFailure('resource-url-invalid', 422);
      await validateResourceBranch(action.branch, this.root, this.run);
      this.save(action.expectedRevision, resources => {
        const item = resources.find(item => item.id === action.id)!;
        item.name = nameFor(action.name);
        if (item.type === 'git') {if (action.url !== undefined) item.url = action.url; item.branch = action.branch || undefined;}
      });
    } else {
      this.definition(action.id);
      this.save(action.expectedRevision, (resources, bindings) => {
        resources.splice(resources.findIndex(item => item.id === action.id), 1); delete bindings[action.id];
      });
    }
  }
  /** Called only after the clone manager revalidates the completed working tree and directory identity. */
  registerClone(operation: ResourceCloneOperation, expectedRevision: string): void {
    const location = this.location(operation.target, operation.existing ? operation.resourceId : undefined);
    if (location.shared === undefined || location.shared === '.') resourceFailure('resource-target-invalid', 422);
    this.save(expectedRevision, (resources, bindings) => {
      const next: ResourceDefinition = {id: operation.resourceId, name: nameFor(operation.name), type: 'git', path: location.shared,
        url: operation.url, ...(operation.branch ? {branch: operation.branch} : {})};
      if (operation.existing) {
        const index = resources.findIndex(item => item.id === operation.resourceId);
        if (index < 0 || resources[index]?.type !== 'git') resourceFailure('resource-not-found', 404);
        resources[index] = next;
      } else {
        if (resources.some(item => item.id === next.id)) resourceFailure('resource-duplicate');
        resources.push(next);
      }
      delete bindings[next.id];
    });
  }
}
