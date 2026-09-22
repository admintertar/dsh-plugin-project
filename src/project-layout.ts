import {existsSync, lstatSync, mkdirSync, realpathSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {appendGitignoreRules, exclusiveAtomicWriteFile} from './atomic-file.ts';

const SKILL_INDEX = 'schemaVersion: 1\nskills: {}\n';

/** Canonical locations owned by the Project Tasks, Skills and MCP features. */
export interface ProjectLayout {
  root: string;
  metadata: string;
  memory: string;
  tasks: string;
  taskSources: string;
  skills: string;
  skillIndex: string;
  mcp: string;
  /** Legacy single-file declarations: still read for compatibility, and the only place an id that
   * lives there can be removed from. New and edited declarations go to `mcpServerDirectory`. */
  mcpServers: string;
  /** One declaration per file: `mcp/servers/<id>.yaml`. Paths are per-asset, so a review selection
   * can commit one server without dragging its siblings along. */
  mcpServerDirectory: string;
  mcpLocal: string;
}

/** Return the canonical capability layout without mutating the project. */
export function projectLayout(root: string): ProjectLayout {
  const canonical = realpathSync(root);
  if (!statSync(canonical).isDirectory()) throw new Error(`Project root is not a directory: ${canonical}`);
  const tasks = join(canonical, 'tasks');
  const skills = join(canonical, 'skills');
  const mcp = join(canonical, 'mcp');
  return {
    root: canonical,
    metadata: join(canonical, '.agent-project'),
    memory: join(canonical, 'memory'),
    tasks,
    taskSources: join(canonical, '.agent-project', 'task-sources.yaml'),
    skills,
    skillIndex: join(skills, 'index.yaml'),
    mcp,
    mcpServers: join(mcp, 'servers.yaml'),
    mcpServerDirectory: join(mcp, 'servers'),
    mcpLocal: join(mcp, 'local.yaml'),
  };
}

/** Reject directory conflicts before project creation mutates the workspace. */
export function validateProjectLayout(root: string): ProjectLayout {
  const layout = projectLayout(root);
  const directories = [layout.metadata, layout.memory, layout.tasks, layout.skills, layout.mcp, layout.mcpServerDirectory];
  for (const directory of directories) {
    if ((directory === layout.metadata || directory === layout.memory) && lstatSync(directory, {throwIfNoEntry: false})?.isSymbolicLink()) {
      throw new Error(`${directory} must be a real project directory`);
    }
    if (existsSync(directory) && !statSync(directory).isDirectory()) {
      throw new Error(`${directory} must be a directory`);
    }
  }
  const metadataIgnore = join(layout.metadata, '.gitignore');
  const info = lstatSync(metadataIgnore, {throwIfNoEntry: false});
  if (info && !info.isFile()) throw new Error(`${metadataIgnore} must be a regular file`);
  return layout;
}

/** Initialize capability directories and indexes without replacing existing content. */
export function ensureProjectLayout(root: string): ProjectLayout {
  const layout = validateProjectLayout(root);
  const directories = [layout.metadata, layout.tasks, layout.skills, layout.mcp, layout.mcpServerDirectory];
  for (const directory of directories) mkdirSync(directory, {recursive: true, mode: 0o755});
  if (!existsSync(layout.skillIndex)) exclusiveAtomicWriteFile(layout.skillIndex, SKILL_INDEX);
  // Commit this file and shared metadata; only machine-specific and transient records are ignored.
  appendGitignoreRules(layout.metadata, ['/local.yaml', '/task-sources.yaml', '/resource-transaction.json']);
  appendGitignoreRules(layout.root, ['mcp/local.yaml']);
  return layout;
}
