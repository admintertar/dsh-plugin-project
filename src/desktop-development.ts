/** Pinned development adapter; this module is never loaded by the Project plugin. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { readProject } from './project.ts';
import {verifyDesktopRuntime, type DesktopEdition} from './desktop-runtime.ts';
import {migrateProfilePluginLink, prepareProfilePlugin} from './development-plugin.ts';

export type {DesktopEdition} from './desktop-runtime.ts';
export interface DesktopProjectOptions {
  repository: string;
  desktopRepository: string;
  manifestPath: string;
  edition: DesktopEdition;
  stateRoot?: string;
}
export interface DesktopProjectLaunch {
  edition: DesktopEdition;
  projectId: string;
  projectRoot: string;
  manifestPath: string;
  desktopPackage: string;
  mainPath: string;
  electronPackage: string;
  home: string;
  userData: string;
  profile: string;
  statusPath: string;
  settingsPath: string;
}

function initialize(path: string, content: string): boolean {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  try {writeFileSync(path, content, {flag: 'wx', mode: 0o600}); return true;}
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

export function desktopProjectPaths(stateRoot: string, manifestPath: string, edition: DesktopEdition) {
  const canonicalManifest = realpathSync(manifestPath);
  const key = createHash('sha256').update(canonicalManifest).digest('hex').slice(0, 16);
  const directory = resolve(stateRoot, edition, key);
  return {manifestPath: canonicalManifest, directory, home: join(directory, 'dsh'), userData: join(directory, 'electron')};
}

function isRunning(launch: DesktopProjectLaunch): boolean {
  if (!existsSync(launch.statusPath)) return false;
  const status = JSON.parse(readFileSync(launch.statusPath, 'utf8'));
  if (!Number.isSafeInteger(status.pid) || status.pid <= 0 || status.event === 'quit') return false;
  try {process.kill(status.pid, 0);}
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
  if (status.projectId !== launch.projectId || status.userData !== launch.userData
    || status.home !== launch.home || status.mainPath !== launch.mainPath) {
    throw new Error('A different Desktop launch is using this Project data directory; close it first');
  }
  return true;
}

function workbenchContains(repository: string, edition: DesktopEdition, manifestPath: string): boolean {
  const statusPath = join(repository, '.dev/desktop-workbench', edition, 'status.json');
  if (!existsSync(statusPath)) return false;
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  if (status.event === 'quit' || !Number.isSafeInteger(status.pid) || status.pid <= 0
    || !status.projects?.some((project: {id: string}) => project.id === manifestPath)) return false;
  try {process.kill(status.pid, 0); return true;}
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Author a dedicated dev Profile, preserving any settings from previous launches. */
export async function prepareDesktopProject(options: DesktopProjectOptions): Promise<DesktopProjectLaunch> {
  const repository = realpathSync(options.repository);
  const desktopRepository = realpathSync(options.desktopRepository);
  const project = readProject(options.manifestPath);
  const paths = desktopProjectPaths(options.stateRoot ?? join(repository, '.dev/desktop-projects'), options.manifestPath, options.edition);
  const {desktopPackage, packageDir} = verifyDesktopRuntime(repository, desktopRepository, options.edition, true);
  const mainPath = join(packageDir, 'lib/main.js');
  if (!existsSync(mainPath) || !existsSync(join(repository, 'lib/client.js'))) throw new Error('Build the Project plugin and Desktop package before preparing a native launch');
  const requireDesktop = createRequire(join(packageDir, 'package.json'));
  const electronPackage = dirname(requireDesktop.resolve('electron/package.json'));
  const selectionPath = join(paths.userData, 'profile-selection/state.json');
  const selected = existsSync(selectionPath) ? JSON.parse(readFileSync(selectionPath, 'utf8')).active : 'desktop';
  if (typeof selected !== 'string' || !selected || selected === '.' || selected === '..' || /[\\/\0]/.test(selected)) throw new Error('Invalid selected Desktop Profile');
  const profile = join(paths.home, 'profiles', selected);
  const projectMode = readProjectPresentation(profile);
  const settingsPath = join(paths.home, 'settings.yaml');
  const launch: DesktopProjectLaunch = {
    edition: options.edition, projectId: project.id, projectRoot: project.root,
    manifestPath: paths.manifestPath, desktopPackage, mainPath, electronPackage,
    home: paths.home, userData: paths.userData, profile, settingsPath,
    statusPath: join(paths.directory, 'launch-status.json'),
  };
  // Reopening a running Project must not rewrite files watched by its Host.
  // Electron's own instance lock will forward this launch to its existing window.
  if (isRunning(launch) || (!options.stateRoot && workbenchContains(repository, options.edition, paths.manifestPath))) return launch;
  const dependency = 'link:./.project-plugin';
  const profileManifest = {
    name: 'project-desktop-development', private: true, type: 'module',
    dependencies: {'dsh-plugin-project': dependency},
    dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-project'], patchReload: 'startup'}},
  };
  initialize(join(profile, 'package.json'), JSON.stringify(profileManifest, null, 2) + '\n');
  const existing = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  const migratingDependency = existing.dependencies?.['dsh-plugin-project'] === `link:${repository}`;
  if (migratingDependency) {
    existing.dependencies['dsh-plugin-project'] = dependency;
    writeFileSync(join(profile, 'package.json'), JSON.stringify(existing, null, 2) + '\n');
  }
  if (selected !== 'desktop' && !existing.dependencies?.['dsh-plugin-project']) {
    existing.dependencies = {...existing.dependencies, 'dsh-plugin-project': dependency};
    existing.dsh ??= {}; existing.dsh.profile ??= {};
    existing.dsh.profile.bundles = [...new Set([...(existing.dsh.profile.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']), 'dsh-plugin-project'])];
    existing.dsh.profile.patchReload = 'startup';
    writeFileSync(join(profile, 'package.json'), JSON.stringify(existing, null, 2) + '\n');
  }
  if (existing.dependencies?.['dsh-plugin-project'] !== dependency) throw new Error('This development Profile belongs to another plugin checkout');
  const profilePlugin = prepareProfilePlugin(repository, profile);
  initialize(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  initialize(join(profile, 'cordis.patch.yml'), stringify([
    {id: 'project', config: {manifestPath: paths.manifestPath, enabled: projectMode}},
    {id: 'ui-sidebar', disabled: false},
    {id: 'session-telemetry-otel', disabled: true},
  ]));
  if (selected !== 'desktop') {
    const patchPath = join(profile, 'cordis.patch.yml');
    const rows = parse(readFileSync(patchPath, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('Invalid Profile patch');
    if (!rows.some(row => row.id === 'project')) {
      rows.push({id: 'project', config: {manifestPath: paths.manifestPath, enabled: projectMode}},
        {id: 'ui-sidebar', disabled: false}, {id: 'session-telemetry-otel', disabled: true});
      writeFileSync(patchPath, stringify(rows));
    }
  }
  initialize(settingsPath, stringify({'dsh-desktop': {mode: 'advanced', port: 0, openBrowser: false, networkExposure: 'loopback'}}));
  initialize(join(paths.userData, 'desktop-market/state.json'), JSON.stringify({version: 1, requested: 'disabled', legacyDefaulted: false}) + '\n');
  mkdirSync(join(paths.userData, 'chromium'), {recursive: true, mode: 0o700});
  mkdirSync(join(paths.userData, 'crashes'), {recursive: true, mode: 0o700});
  const pluginLink = join(profile, 'node_modules/dsh-plugin-project');
  if (!migrateProfilePluginLink(repository, profile, profilePlugin) || migratingDependency) {
    const pnpm = join(dirname(requireDesktop.resolve('pnpm')), 'bin/pnpm.mjs');
    const installed = spawnSync(process.execPath, [pnpm, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], {cwd: profile, encoding: 'utf8'});
    if (installed.status !== 0) throw new Error(`Cannot link the Project plugin into the development Profile: ${installed.stderr}`);
  }
  if (!existsSync(pluginLink) || realpathSync(pluginLink) !== realpathSync(profilePlugin)) {
    throw new Error('Development Profile must resolve the staged Project plugin; close it and repair its dependency link');
  }
  const profileApi = await import(pathToFileURL(join(packageDir, 'lib/profile.js')).href);
  await profileApi.healDesktopProfileModuleFallback(paths.home);
  const prepared = await composeDesktopWindow(launch, selected);
  const compose = await import(pathToFileURL(requireDesktop.resolve('@deepseek-ai/dsh-app-boot')).href);
  const rows = compose.composeEntries([prepared.patches]);
  const row = (id: string) => rows.find((item: {id?: string}) => item.id === id);
  if ((projectMode && prepared.mode !== 'advanced') || !row('ui-sidebar') || row('ui-sidebar')?.disabled === true
    || !row('ui-conversation') || row('ui-conversation')?.disabled === true || row('project')?.name !== 'dsh-plugin-project'
    || row('project')?.disabled === true || row('project')?.config?.manifestPath !== paths.manifestPath) {
    throw new Error('Desktop composition must retain the official sidebar and the current Project binding');
  }
  if (prepared.requiresDependencyMigration) throw new Error('Development Profile dependencies need repair; run pnpm install in its Profile directory');
  await profileApi.healDesktopProfileModuleFallback(paths.home, prepared.profile);
  return launch;
}

/** Prepare serializable inputs in a separate Node process, before its Host starts. */
export async function prepareDesktopWindow(options: DesktopProjectOptions) {
  if (!options.stateRoot && workbenchContains(realpathSync(options.repository), options.edition, realpathSync(options.manifestPath))) {
    throw new Error('Close the running Project window before preparing a new Host');
  }
  const launch = await prepareDesktopProject(options);
  if (isRunning(launch)) throw new Error('Close the Desktop maintenance window before opening this Project');
  const prepared = await composeDesktopWindow(launch, launch.profile.split(/[\\/]/).at(-1)!);
  const settings = parse(readFileSync(prepared.settingsDocument, 'utf8'));
  const notifications = {enabled: true, notifyOnTurnCompletion: true, notifyOnTurnFailure: true,
    notifyOnJobCompletion: true, notifyOnJobFailure: true, ...settings['dsh-desktop-notifications']};
  return {launch, prepared, presentation: readProjectPresentation(launch.profile) ? 'project' : prepared.mode, preferences: {mode: prepared.mode, openBrowser: prepared.openBrowser,
    networkExposure: prepared.networkExposure, market: prepared.market.requested, notifications,
    aaEnabled: prepared.aaEnabled}};
}

/** Product mode is separate from Desktop's underlying shell enum. */
export function readProjectPresentation(profile: string): boolean {
  const file = join(profile, 'cordis.patch.yml');
  if (!existsSync(file)) return true;
  const rows = parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Invalid Profile patch');
  return rows.find(row => row.id === 'project')?.config?.enabled !== false;
}

export async function saveProjectPresentation(launch: Pick<DesktopProjectLaunch, 'userData' | 'profile' | 'settingsPath' | 'manifestPath' | 'mainPath'>, mode: string): Promise<void> {
  if (!['project', 'advanced', 'extended', 'compatibility'].includes(mode)) throw new Error('Unknown presentation mode');
  const enabled = mode === 'project';
  mkdirSync(launch.userData, {recursive: true, mode: 0o700});
  const patchPath = join(launch.profile, 'cordis.patch.yml');
  const rows = existsSync(patchPath) ? parse(readFileSync(patchPath, 'utf8')) : [];
  if (!Array.isArray(rows)) throw new Error('Invalid Profile patch');
  const project = rows.find(row => row.id === 'project');
  if (project) project.config = {...project.config, enabled};
  else rows.push({id: 'project', config: {manifestPath: launch.manifestPath, enabled}});
  // All modes share the official sidebar, including Profiles from the old shell.
  for (const row of rows) if (row.id === 'ui-sidebar') row.disabled = false;
  mkdirSync(launch.profile, {recursive: true, mode: 0o700});
  writeFileSync(patchPath, stringify(rows));
  const settings = existsSync(launch.settingsPath) ? parse(readFileSync(launch.settingsPath, 'utf8')) : {};
  settings['dsh-desktop'] = {...settings['dsh-desktop'], mode: enabled ? 'advanced' : mode, openBrowser: false, networkExposure: 'loopback'};
  writeFileSync(launch.settingsPath, stringify(settings), {mode: 0o600});
  const base = dirname(launch.mainPath);
  const api = await import(pathToFileURL(join(base, 'profile-preferences.js')).href);
  const settingsApi = await import(pathToFileURL(join(base, 'setup-wizard-settings.js')).href);
  const previous = api.readDesktopProfilePreferences(launch.userData, launch.profile);
  const current = settingsApi.readDesktopSetupWizardSettings(launch.settingsPath);
  await api.writeDesktopProfilePreferences(launch.userData, launch.profile,
    api.desktopProfilePreferencesFromSettings(current, current.notifications, previous?.market ?? 'disabled', previous?.aaEnabled === true));
}

async function composeDesktopWindow(launch: DesktopProjectLaunch, profileName: string) {
  restoreOfficialSidebar(launch.profile);
  const base = dirname(launch.mainPath);
  const profileApi = await import(pathToFileURL(join(base, 'profile.js')).href);
  const preferencesApi = await import(pathToFileURL(join(base, 'profile-preferences.js')).href);
  const preferences = preferencesApi.readDesktopProfilePreferences(launch.userData, launch.profile);
  const settingsApi = await import(pathToFileURL(join(base, 'setup-wizard-settings.js')).href);
  const current = settingsApi.readDesktopSetupWizardSettings(launch.settingsPath);
  await settingsApi.updateDesktopSetupWizardSettings(launch.settingsPath, {...current,
    mode: readProjectPresentation(launch.profile) ? 'advanced' : preferences?.mode ?? current.mode,
    openBrowser: false, networkExposure: 'loopback', notifications: preferences?.notifications ?? current.notifications});
  const market = preferences?.market ?? 'disabled';
  return profileApi.prepareDesktopProfile('1', launch.home, process.platform, profileName,
    join(launch.userData, 'plugin-management/state.json'),
    {requested: market, effective: market, legacyDefaulted: false}, {lanAddresses: [], aaEnabled: preferences?.aaEnabled === true});
}

/** Migrate the previous Project shell's disable flags when preparing a stopped Host. */
export function restoreOfficialSidebar(profile: string): void {
  const patchPath = join(profile, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return;
  const rows = parse(readFileSync(patchPath, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Invalid Profile patch');
  let changed = false;
  for (const row of rows) {
    if (row?.id !== 'ui-sidebar' || row.disabled !== true) continue;
    row.disabled = false;
    changed = true;
  }
  if (changed) writeFileSync(patchPath, stringify(rows));
}
