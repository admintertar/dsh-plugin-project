// One app instance, with the official enhanced shell in each Project window.
import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {projectCopy} from '../src/locales.ts';
import {parse} from 'yaml';
import { readProject } from '../src/project.ts';
import { createProjectFile, createProjectInDirectory, findProjectFile, resolveProjectFile, RecentProjects } from '../src/project-files.ts';
import { desktopProjectPaths, saveProjectPresentation } from '../src/desktop-development.ts';
import { runProjectMaintenance } from '../src/desktop-maintenance.ts';
import { existsSync, readFileSync } from 'node:fs';

const config = JSON.parse(process.env.DSH_PROJECT_DESKTOP_LAUNCH);
app.setName('DSH Desktop');
app.setPath('userData', config.userData);
for (const name of ['chromium', 'crashes']) mkdirSync(join(config.userData, name), {recursive: true, mode: 0o700});
app.setPath('sessionData', join(config.userData, 'chromium'));
app.setPath('crashDumps', join(config.userData, 'crashes'));

if (!app.requestSingleInstanceLock({manifestPath: config.manifestPath, action: config.action})) {
  app.quit();
} else if (config.action === 'close') {
  app.quit();
} else {
  const recent = new RecentProjects(join(config.userData, 'recent-projects.json'));
  const pending = [{manifestPath: config.manifestPath, action: 'open'}];
  let workbench;
  const reportError = error => {if (error.name === 'AbortError') return; console.error(error); dialog.showErrorBox('DSH Project', error.message ?? String(error));};
  const dispatch = data => data.action === 'close'
    ? workbench.close(realpathSync(data.manifestPath)) : workbench.open(data.manifestPath);
  app.on('open-file', (event, path) => {
    event.preventDefault();
    const data = {manifestPath: path, action: 'open'};
    if (workbench) void Promise.resolve().then(() => dispatch(data)).catch(reportError);
    else pending.push(data);
  });
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    if (typeof data?.manifestPath !== 'string') return;
    if (workbench) void Promise.resolve().then(() => dispatch(data)).catch(reportError);
    else pending.push(data);
  });
  // Electron emits ready after its ESM entry finishes evaluating.
  void app.whenReady().then(async () => {
    const {DesktopWorkbench, configureWorkbenchProfile, WORKBENCH_MAINTENANCE_ENV, WORKBENCH_MAINTENANCE_EXIT_CODES} = await import(pathToFileURL(config.workbenchPath).href);
    const nativeWindows = new Map();
    let projects = [];
    const report = event => {
      const path = join(config.userData, 'status.json');
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({event, pid: process.pid, projects, windows: [...nativeWindows.values()]}, null, 2) + '\n', {mode: 0o600});
      renameSync(temporary, path);
    };
    app.on('browser-window-created', (_event, window) => {
      nativeWindows.set(window.id, {id: window.id, loaded: false});
      window.webContents.on('did-finish-load', () => {
        const url = new URL(window.webContents.getURL());
        nativeWindows.set(window.id, {id: window.id, loaded: true, origin: url.origin, path: url.pathname, title: window.accessibleTitle});
        report('window-loaded');
      });
      window.on('closed', () => {nativeWindows.delete(window.id); report('window-closed');});
    });
    workbench = new DesktopWorkbench({
      title: 'DSH Desktop', labels: locale => {const t = projectCopy(locale); return {create: t.createProject, open: t.openProject, recent: t.recentProjects, close: t.closeProject};},
      recent: () => recent.list(),
      onOpened: (path, title) => recent.remember({path, title}),
      async create() {
        const t = projectCopy(workbench.locale);
        const result = await dialog.showOpenDialog({title: t.createProjectDirectory, buttonLabel: t.selectProjectFolder,
          message: t.createProjectDirectoryBody, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']});
        return result.canceled || !result.filePaths[0] ? undefined : createProjectInDirectory(result.filePaths[0]);
      },
      async recover(mode, launch, signal, failureDetail) {
        return runProjectMaintenance({mode, launch, signal, failureDetail,
          entryPath: join(config.repository, 'scripts/electron-recovery.mjs'), mainPath: join(dirname(config.workbenchPath), 'main.js'),
          protocol: {environmentKey: WORKBENCH_MAINTENANCE_ENV, exitCodes: WORKBENCH_MAINTENANCE_EXIT_CODES}});
      },
      async resolve(target) {
        const manifestPath = resolveProjectFile(target);
        const project = readProject(manifestPath);
        const paths = desktopProjectPaths(join(config.repository, '.dev/desktop-projects'), manifestPath, config.edition);
        const environment = {...process.env, DSH_PROJECT_MANIFEST: manifestPath, DSH_PROJECT_ID: project.id, DSH_TELEMETRY_DISABLED: '1'};
        delete environment.DSH_PROJECT_DESKTOP_LAUNCH;
        return {id: manifestPath, title: project.name,
          recovery: {homeDir: paths.home, stateDir: paths.userData, cwd: project.root, environment},
          async selectPresentation(mode, directory) {
            if (!['project', 'advanced', 'extended', 'compatibility'].includes(mode)) throw new Error('未知窗口模式');
            let selected = manifestPath;
            if (mode === 'project' && directory) {
              selected = findProjectFile(directory);
              if (!selected) {
                const result = await dialog.showSaveDialog({title: projectCopy(workbench.locale).saveWorkspace,
                  defaultPath: join(realpathSync(directory), basename(directory) + '.agent-project'),
                  filters: [{name: projectCopy(workbench.locale).projectFile, extensions: ['agent-project']}]});
                if (result.canceled || !result.filePath) return;
                selected = createProjectFile(result.filePath);
              }
            }
            readProject(selected);
            const paths = desktopProjectPaths(join(config.repository, '.dev/desktop-projects'), selected, config.edition);
            const statePath = join(paths.userData, 'profile-selection/state.json');
            const profile = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).active : 'desktop';
            if (typeof profile !== 'string' || !profile || profile === '.' || profile === '..' || /[\\/\0]/.test(profile)) throw new Error('无效的 Profile');
            return {target: selected, async commit() {
              await saveProjectPresentation({mainPath: join(dirname(config.workbenchPath), 'main.js'), userData: paths.userData, profile: join(paths.home, 'profiles', profile),
                settingsPath: join(paths.home, 'settings.yaml'), manifestPath: selected}, mode);
            }};
          },
          async setup(launch, signal) {
            const preference = parse(readFileSync(launch.prepared.settingsDocument, 'utf8')).locale?.preference;
            const locale = preference === 'en' || preference === 'zh' ? preference : workbench.locale;
            const t = projectCopy(locale);
            const outcome = await configureWorkbenchProfile(launch, {locale, signal,
              presentationModes: [{id: 'project', mode: 'advanced', title: t.projectMode, description: t.projectModeBody}],
              commitPresentation: selection => saveProjectPresentation({mainPath: join(dirname(config.workbenchPath), 'main.js'),
                userData: launch.stateDir, profile: launch.prepared.profile.dir, settingsPath: launch.prepared.settingsDocument, manifestPath},
                selection.presentation ?? selection.mode),
            });
            if (outcome === 'cancelled') return undefined;
            return outcome === 'changed' ? await this.prepare() : launch;
          },
          async prepare() {
            const prepared = await new Promise((resolve, reject) => {
              const environment = {...process.env};
              delete environment.ELECTRON_RUN_AS_NODE;
              delete environment.DSH_PROJECT_DESKTOP_LAUNCH;
              const child = spawn(config.nodeExecutable, [join(config.repository, 'scripts/desktop.ts'),
                '--desktop', config.desktopRepository, '--project', manifestPath, '--edition', config.edition, '--prepare-window'],
              {cwd: project.root, env: environment, stdio: ['ignore', 'pipe', 'pipe']});
              let output = '', error = '';
              child.stdout.on('data', data => {output += data;});
              child.stderr.on('data', data => {error += data;});
              child.on('error', reject);
              child.on('close', code => {
                if (code !== 0) {reject(new Error(error || 'Project preparation failed')); return;}
                try {resolve(JSON.parse(output));} catch (cause) {reject(cause);}
              });
            });
            const {launch, preferences} = prepared;
            return {prepared: prepared.prepared, presentation: prepared.presentation, preferences, homeDir: launch.home,
              stateDir: launch.userData, cwd: project.root, environment};
        }};
      },
      async pick() {
        const result = await dialog.showOpenDialog({title: projectCopy(workbench.locale).openProject, properties: ['openFile', 'openDirectory'],
          filters: [{name: projectCopy(workbench.locale).projectFile, extensions: ['agent-project']}]});
        return result.canceled ? undefined : resolveProjectFile(result.filePaths[0]);
      },
      onChange(value) {projects = value; report('projects-changed');},
    });
    workbench.start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
    app.on('quit', () => report('quit'));
    for (const request of pending) await dispatch(request).catch(reportError);
  }).catch(reportError);
}
