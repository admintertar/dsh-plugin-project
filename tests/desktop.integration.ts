import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse, stringify} from 'yaml';
import {prepareDesktopProject, prepareDesktopWindow, saveProjectPresentation, type DesktopEdition} from '../src/desktop-development.ts';
import {readCompatibilityPin} from '../src/desktop-runtime.ts';

const repository = resolve('.');
// Historical fork integration only; current native acceptance lives in the Shell.
const desktopRepository = process.env.DSH_PROJECT_DESKTOP_REPOSITORY;
if (!desktopRepository) throw new Error('Historical test requires an explicit DSH_PROJECT_DESKTOP_REPOSITORY; use yarn run test:desktop for the independent Shell');
for (const edition of ['beta', 'stable'] satisfies DesktopEdition[]) {
  test(`${edition}: real Desktop Host loads Project tools, API and browser module`, () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'project-desktop-host-'));
    try {
      const output = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/desktop-project-host.mjs', import.meta.url)),
        repository, desktopRepository, edition, join(repository, 'examples/demo-web/demo-web.agent-project'), stateRoot],
      {encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024});
      assert.match(output, new RegExp(`project-host-ok:${edition}`));
    } finally {rmSync(stateRoot, {recursive: true, force: true});}
  });
  test(`${edition}: real Desktop composition retains the official sidebar and Project binding across modes`, async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'project-desktop-integration-'));
    const originalHome = process.env.DSH_HOME;
    const options = {repository, desktopRepository, stateRoot, edition,
      manifestPath: join(repository, 'examples/demo-web/demo-web.agent-project')};
    try {
      const first = await prepareDesktopProject(options);
      assert.equal(first.projectId, 'demo-web');
      const requireProfile = createRequire(join(first.profile, 'package.json'));
      const pluginEntry = requireProfile.resolve('dsh-plugin-project');
      const requirePlugin = createRequire(pluginEntry);
      const pluginManifest = JSON.parse(readFileSync(requirePlugin.resolve('dsh-plugin-project/package.json'), 'utf8'));
      for (const peer of Object.keys(pluginManifest.peerDependencies)) {
        assert.ok(existsSync(requirePlugin.resolve(peer)), `installed plugin resolves ${peer}`);
      }
      assert.equal(JSON.parse(readFileSync(requirePlugin.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version,
        readCompatibilityPin(repository).harness[edition].version);
      for (const client of pluginManifest.dsh.client.inject) {
        assert.ok(existsSync(requireProfile.resolve(client)), `Profile resolves client dependency ${client}`);
      }
      assert.equal(existsSync(join(first.userData, 'profile-setup')), false, 'preparing a Profile must not skip its first-run wizard');
      assert.equal(process.env.DSH_HOME, originalHome);
      const settings = parse(readFileSync(first.settingsPath, 'utf8'));
      settings['dsh-desktop'].port = 43187;
      writeFileSync(first.settingsPath, stringify(settings));
      const again = await prepareDesktopProject(options);
      assert.equal(again.home, first.home);
      assert.equal(parse(readFileSync(first.settingsPath, 'utf8'))['dsh-desktop'].port, 43187);
      const patchPath = join(first.profile, 'cordis.patch.yml');
      const patches = parse(readFileSync(patchPath, 'utf8'));
      writeFileSync(first.statusPath, JSON.stringify({event: 'starting', projectId: first.projectId,
        pid: process.pid, home: first.home, userData: first.userData, mainPath: first.mainPath}));
      const preparedPath = join(first.profile, 'cordis.yml');
      const previousWrite = statSync(preparedPath).mtimeMs;
      const previousPluginWrite = statSync(pluginEntry).mtimeMs;
      assert.deepEqual(await prepareDesktopProject(options), first);
      assert.equal(statSync(preparedPath).mtimeMs, previousWrite, 'reopening must not rewrite the running Profile');
      assert.equal(statSync(pluginEntry).mtimeMs, previousPluginWrite, 'reopening must not copy over a running plugin');
      rmSync(first.statusPath);
      const profileManifestPath = join(first.profile, 'package.json');
      const legacy = JSON.parse(readFileSync(profileManifestPath, 'utf8'));
      legacy.dependencies['dsh-plugin-project'] = `link:${repository}`;
      writeFileSync(profileManifestPath, JSON.stringify(legacy));
      const pluginLink = join(first.profile, 'node_modules/dsh-plugin-project');
      rmSync(pluginLink);
      symlinkSync(repository, pluginLink, 'junction');
      await prepareDesktopProject(options);
      assert.equal(realpathSync(pluginLink), realpathSync(join(first.profile, '.project-plugin')),
        'a stopped legacy Profile migrates away from the source dependency graph');
      rmSync(pluginLink);
      symlinkSync(stateRoot, pluginLink, 'junction');
      await assert.rejects(prepareDesktopProject(options), /plugin link belongs to another checkout/);
      assert.equal(realpathSync(pluginLink), realpathSync(stateRoot), 'foreign plugin links must be preserved');
      rmSync(pluginLink);
      symlinkSync(join(first.profile, '.project-plugin'), pluginLink, 'junction');
      for (const mode of ['advanced', 'extended', 'compatibility', 'project']) {
        await saveProjectPresentation(first, mode);
        const window = await prepareDesktopWindow(options);
        assert.equal(window.presentation, mode);
        assert.equal(window.prepared.mode, mode === 'project' ? 'advanced' : mode);
        assert.equal(window.launch.home, first.home, 'mode selection keeps the same DSH Home');
        const compose = await import(pathToFileURL(requireProfile.resolve('@deepseek-ai/dsh-app-boot')).href);
        const rows = compose.composeEntries([window.prepared.patches]);
        assert.equal(rows.find((row: {id: string}) => row.id === 'ui-sidebar')?.disabled, false);
      }
      writeFileSync(patchPath, stringify([...patches, {id: 'ui-sidebar', disabled: true}]));
      await prepareDesktopProject(options);
      assert.ok(parse(readFileSync(patchPath, 'utf8')).filter((row: {id: string}) => row.id === 'ui-sidebar')
        .every((row: {disabled: boolean}) => row.disabled === false), 'old Project sidebar overrides are migrated');
      writeFileSync(patchPath, stringify([...patches, {id: 'project', config: {manifestPath: '/another/project.agent-project'}}]));
      await assert.rejects(prepareDesktopProject(options), /official sidebar and the current Project binding/);
      writeFileSync(patchPath, stringify(patches));
      const profileApi = await import(pathToFileURL(join(desktopRepository, first.desktopPackage, 'lib/profile-manager.js')).href);
      profileApi.createDesktopWebProfile(first.home, 'alternate');
      profileApi.selectDesktopProfile(join(first.userData, 'profile-selection/state.json'), first.home, 'alternate');
      const selected = await prepareDesktopWindow(options);
      assert.equal(selected.prepared.profile.name, 'alternate');
      assert.equal(selected.presentation, 'project');
      assert.equal(existsSync(join(selected.launch.userData, 'profile-setup')), false);
      await saveProjectPresentation(selected.launch, 'compatibility');
      profileApi.selectDesktopProfile(join(first.userData, 'profile-selection/state.json'), first.home, 'desktop');
      assert.equal((await prepareDesktopWindow(options)).presentation, 'project');
      profileApi.selectDesktopProfile(join(first.userData, 'profile-selection/state.json'), first.home, 'alternate');
      const alternateAgain = await prepareDesktopWindow(options);
      assert.equal(alternateAgain.presentation, 'compatibility');
      assert.equal(alternateAgain.prepared.mode, 'compatibility');
    } finally {rmSync(stateRoot, {recursive: true, force: true});}
  });
}
