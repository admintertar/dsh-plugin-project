// Delegate maintenance to Desktop's own recovery and disposable Safe Mode flows.
import { app } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const launch = JSON.parse(process.env.DSH_PROJECT_RECOVERY);
app.setPath('userData', launch.stateDir);
mkdirSync(join(launch.stateDir, 'chromium'), {recursive: true, mode: 0o700});
app.setPath('sessionData', join(launch.stateDir, 'chromium'));
const statusPath = join(dirname(launch.stateDir), 'launch-status.json');
const record = event => writeFileSync(statusPath, JSON.stringify({event, pid: process.pid,
  home: launch.homeDir, userData: launch.stateDir, mainPath: launch.mainPath,
  projectId: launch.projectId}) + '\n', {mode: 0o600});
record('maintenance');
app.on('quit', () => record('quit'));
void (async () => {
  if (process.argv.includes('--dsh-desktop-safe-mode')) {
    const {prepareWorkbenchSafeMode} = await import(pathToFileURL(join(dirname(launch.mainPath), 'workbench.js')).href);
    prepareWorkbenchSafeMode(launch.stateDir);
  }
  await import(pathToFileURL(launch.mainPath).href);
})().catch(error => {console.error(error); app.exit(1);});
