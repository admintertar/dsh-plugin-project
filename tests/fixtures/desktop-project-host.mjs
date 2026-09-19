/** Real Desktop Host in an isolated Node process; no Electron windows or model calls. */
import {strict as assert} from 'node:assert';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareDesktopWindow} from '../../src/desktop-development.ts';
import {readCompatibilityPin} from '../../src/desktop-runtime.ts';

const [repository, desktopRepository, edition, manifestPath, stateRoot] = process.argv.slice(2);
const {launch, prepared, preferences} = await prepareDesktopWindow({repository, desktopRepository, edition, manifestPath, stateRoot});
const packageDir = dirname(dirname(launch.mainPath));
const requireDesktop = createRequire(join(packageDir, 'package.json'));
const load = file => import(pathToFileURL(join(packageDir, 'lib', file)).href);
// Source imports are test-only control adapters. The child below boots the
// actual compiled host-process-entry, with no TS transform in that process.
const control = file => import(pathToFileURL(join(packageDir, 'src', file)).href);
const {HostRpc} = await control('host-rpc.ts');
const {bindNativeRuntime, runtimeSnapshot} = await control('host-runtime-bridge.ts');
const {installDesktopPnpmRuntime} = await load('desktop-runtime-environment.js');
const {desktopReleaseUserDataLocations} = await control('profile-channel-admission.ts');
const {desktopProfilePreferencesFromSettings} = await load('profile-preferences.js');
const pnpmBinPath = join(dirname(requireDesktop.resolve('pnpm')), 'bin/pnpm.mjs');
const electronVersion = JSON.parse(readFileSync(requireDesktop.resolve('electron/package.json'), 'utf8')).version;
const environment = {...process.env, DSH_HOME: launch.home, DSH_AGENTS_HOME: join(launch.home, 'agents')};
const pnpm = installDesktopPnpmRuntime({platform: process.platform, appExecutable: process.execPath,
  pnpmBinPath, electronVersion, stateDir: join(stateRoot, 'commands'), environment});
let worker;
let rpc;
let releaseNative;
let stderr = '';
let shell;
let response;
const runtime = {
  platform: process.platform, locale: 'en',
  updates: {isPackaged: false, canDownload: false, currentVersion: readCompatibilityPin(repository).desktop.version, statePath: join(stateRoot, 'updates')},
  schedule(spec) {shell = spec; return async () => {};},
  registerTrayItem() {return {refresh() {}, dispose() {}};},
  setLocalePreference() {}, setThemeSource() {},
};
try {
  prepared.port = 0;
  const probe = join(prepared.profile.dir, 'node_modules/project-compatibility-probe');
  mkdirSync(probe, {recursive: true});
  writeFileSync(join(probe, 'package.json'), JSON.stringify({name: 'project-compatibility-probe', type: 'module', exports: './index.js'}));
  copyFileSync(new URL('./project-compatibility-probe.mjs', import.meta.url), join(probe, 'index.js'));
  prepared.patches.push({insert: [{id: 'project-compatibility-probe', name: 'project-compatibility-probe', config: {repository}}]});
  worker = fork(join(packageDir, 'tests/fixtures/isolated-host/child.mjs'), [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', env: environment,
  });
  worker.stderr.on('data', data => {stderr += String(data);});
  const [ready] = await once(worker, 'message');
  assert.deepEqual(ready, {ready: true});
  rpc = new HostRpc({send: data => worker.send(data), listen: receive => {
    worker.on('message', receive); return () => worker.off('message', receive);
  }}, 30_000);
  worker.on('exit', () => rpc.close(stderr || 'Host exited'));
  releaseNative = bindNativeRuntime(rpc, runtime);
  rpc.handle('certificate', () => ({failureCode: 'test-disabled'}));
  rpc.handle('quit', () => {});
  const result = await rpc.call('boot', [{
    prepared, profilePreferences: desktopProfilePreferencesFromSettings(preferences, preferences.notifications, 'disabled', false),
    homeDir: launch.home, activeProfileName: prepared.profile.name,
    pluginManagementStatePath: join(launch.userData, 'plugin-management/state.json'),
    selectionStatePath: join(launch.userData, 'profile-selection/state.json'), marketUserDataDir: launch.userData,
    releaseUserDataLocations: desktopReleaseUserDataLocations(launch.home, launch.userData),
    launchEnvironmentLayers: [{source: 'process', values: environment}],
    desktopPnpmBootstrap: {activeProfileName: prepared.profile.name, activeProfileDir: prepared.profile.dir,
      homeDir: launch.home, appExecutable: process.execPath, pnpmBinPath, electronVersion,
      nodeBinDir: pnpm.nodeBinDir, nodeShimPath: pnpm.nodeShimPath, clearEnvironmentPath: pnpm.clearEnvironmentPath,
      dshBootstrapPath: join(packageDir, 'lib/desktop-cli.js')},
    logDirectory: join(stateRoot, 'logs'),
  }, runtimeSnapshot(runtime), Buffer.alloc(32, 6).toString('base64url')]);
  assert.equal(result.pid, worker.pid);
  assert.ok(shell, 'real Host registers the native shell');
  const headers = {[shell.rendererAccessHeader.name]: shell.rendererAccessHeader.value};
  response = await fetch(shell.authenticationUrl, {headers, redirect: 'manual'});
  await response.body?.cancel();
  assert.equal(response.status, 303);
  headers.Cookie = response.headers.get('set-cookie').split(';')[0];
  response = await fetch(new URL('/api/project/snapshot', shell.url), {headers});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).root, dirname(manifestPath));
  response = await fetch(new URL('/api/project/tools', shell.url), {headers});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tools, [], 'no Session means no active tool catalog');
  response = await fetch(new URL('/__project_compatibility', shell.url), {headers});
  assert.equal(response.status, 200);
  const observed = await response.json();
  assert.ok(observed.tools.includes('project_task_create'), 'Project task tools load in the real Host');
  assert.equal(observed.sessionVersion, readCompatibilityPin(repository).harness[edition].version,
    'the linked Project plugin resolves the selected Desktop runtime');
  response = await fetch(shell.url, {headers});
  assert.equal(response.status, 200);
  const html = await response.text();
  const boot = JSON.parse(html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\]) = (\{.*?\})<\/script>/u)[1]);
  const client = boot.entries.find(entry => entry.id === 'dsh-plugin-project');
  assert.ok(client, 'Project client is included in the official Loader graph');
  response = await fetch(new URL(client.url, shell.url), {headers});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /project_task_create|ProjectTask|project-task/);
  console.log(`project-host-ok:${edition}`);
} finally {
  await response?.body?.cancel().catch(() => {});
  if (rpc) await rpc.call('stop').catch(() => {});
  await releaseNative?.();
  rpc?.close('Test finished');
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, 'exit');
    worker.kill();
    await exited;
  }
  pnpm.dispose();
}
