import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { ensureProjectLayout, validateProjectLayout } from './project-layout.ts';

export const PROJECT_EXTENSION = '.agent-project';

/** The entry file sits at the project root; optional data lives beside it. */
export function projectFilePaths(file: string) {
  const manifest = realpathSync(file);
  if (!statSync(manifest).isFile() || !manifest.endsWith(PROJECT_EXTENSION)) {
    throw new Error('请选择 .agent-project 项目文件');
  }
  const root = dirname(manifest);
  return {manifest, root, metadata: join(root, PROJECT_EXTENSION)};
}

/** A folder may have one unambiguous entry; never silently choose between projects. */
export function findProjectFile(target: string): string | undefined {
  const canonical = realpathSync(target);
  if (statSync(canonical).isFile()) return projectFilePaths(canonical).manifest;
  const files = readdirSync(canonical, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
    .map(entry => join(canonical, entry.name));
  if (files.length > 1) throw new Error('此目录有多个项目，请直接选择要打开的 .agent-project 文件');
  if (files[0]) return files[0];
  return undefined;
}

export function resolveProjectFile(target: string): string {
  const file = findProjectFile(target);
  if (!file) throw new Error('目录中没有项目文件，请使用“文件 → 新建项目…”');
  return file;
}

/** Create a portable manifest and initialize its layout without replacing existing entries. */
export function createProjectFile(target: string): string {
  const file = resolve(target.endsWith(PROJECT_EXTENSION) ? target : target + PROJECT_EXTENSION);
  const root = realpathSync(dirname(file));
  const name = basename(file, PROJECT_EXTENSION);
  if (!name || name.length > 160) throw new Error('项目名称应为 1–160 个字符');
  const slug = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[^a-zA-Z0-9]+|-+$/g, '').slice(0, 48);
  validateProjectLayout(root);
  const manifest = join(root, basename(file));
  const fd = openSync(manifest, 'wx', 0o600);
  const created = fstatSync(fd);
  try {
    writeFileSync(fd, stringify({schemaVersion: 1,
    id: `${slug || 'project'}-${randomUUID().slice(0, 8)}`, name,
    resources: [{id: 'root', name: basename(root) || root, type: 'local', path: '.'}], memory: [],
    }));
    ensureProjectLayout(root);
    return manifest;
  } catch (error) {
    // Remove only the entry created here, never a replacement or user data.
    try {
      const current = lstatSync(manifest);
      if (current.dev === created.dev && current.ino === created.ino) unlinkSync(manifest);
    } catch (rollbackError) {
      if (!(rollbackError instanceof Error && 'code' in rollbackError && rollbackError.code === 'ENOENT')) {
        throw new AggregateError([error, rollbackError], 'Project creation failed and its manifest could not be removed');
      }
    }
    throw error;
  } finally {closeSync(fd);}
}

/** Initialize the selected workspace folder, or reopen its existing project. */
export function createProjectInDirectory(directory: string): string {
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error('请选择项目文件夹');
  return findProjectFile(root) ?? createProjectFile(join(root, (basename(root) || 'Project') + PROJECT_EXTENSION));
}

export interface RecentProject {path: string; title: string; available: boolean}

/** A recent target stays visible when it disappears, but must no longer be openable. */
export function projectTargetAvailable(target: string): boolean {
  try {resolveProjectFile(target); return true;} catch {return false;}
}

export class RecentProjects {
  private readonly file: string;
  constructor(file: string) {this.file = file;}
  list(): RecentProject[] {
    if (!existsSync(this.file)) return [];
    const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('最近项目记录格式错误');
    return data.filter((item): item is Omit<RecentProject, 'available'> =>
      Boolean(item) && typeof item === 'object' && typeof item.path === 'string' && typeof item.title === 'string')
      .slice(0, 12)
      .map(item => ({...item, available: projectTargetAvailable(item.path)}));
  }
  remember(project: Omit<RecentProject, 'available'>): void {
    const next = [project, ...this.list().filter(item => item.path !== project.path)].slice(0, 12);
    mkdirSync(dirname(this.file), {recursive: true, mode: 0o700});
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(next.map(({path, title}) => ({path, title})), null, 2) + '\n', {mode: 0o600});
    renameSync(temporary, this.file);
  }
}
