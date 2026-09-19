/** Supervise the official Desktop recovery process until it returns to this project. */
import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';

interface MaintenanceEnvironment {
  homeDir: string;
  stateDir: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export interface ProjectMaintenanceOptions {
  mode: 'recovery' | 'safe-mode';
  launch: MaintenanceEnvironment;
  entryPath: string;
  mainPath: string;
  signal: AbortSignal;
  failureDetail?: string;
  protocol: {environmentKey: string; exitCodes: {restart: number; recovery: number; 'safe-mode': number}};
  /** Tests supply a controlled child; production uses Electron's executable. */
  spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** Wait for actual process exit before allowing the project Host to open again. */
export async function runProjectMaintenance(options: ProjectMaintenanceOptions): Promise<'restart' | 'cancelled'> {
  let mode = options.mode;
  for (;;) {
    options.signal.throwIfAborted();
    const code = await runOnce(options, mode);
    if (code === options.protocol.exitCodes.restart) return 'restart';
    if (code === options.protocol.exitCodes.recovery) mode = 'recovery';
    else if (code === options.protocol.exitCodes['safe-mode']) mode = 'safe-mode';
    else if (code === 0) return 'cancelled';
    else throw new Error(`Desktop maintenance exited unexpectedly (${String(code)})`);
  }
}

function runOnce(options: ProjectMaintenanceOptions, mode: 'recovery' | 'safe-mode'): Promise<number | null> {
  const {launch, signal} = options;
  const environment = {...launch.environment, DSH_HOME: launch.homeDir,
    [options.protocol.environmentKey]: '1', DSH_DESKTOP_WORKBENCH_FAILURE_DETAIL: options.failureDetail ?? '',
    DSH_PROJECT_RECOVERY: JSON.stringify({homeDir: launch.homeDir, stateDir: launch.stateDir,
      projectId: launch.environment.DSH_PROJECT_ID, mainPath: options.mainPath}),
  };
  delete (environment as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(process.execPath, [options.entryPath,
      mode === 'safe-mode' ? '--dsh-desktop-safe-mode' : '--dsh-desktop-recovery'],
    {cwd: launch.cwd, env: environment, stdio: 'inherit'});
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      // Allow Desktop's five-second graceful shutdown to finish before escalation.
      escalation = setTimeout(() => { child.kill('SIGKILL'); }, 6_000);
    };
    child.once('error', error => { failure = error; });
    child.once('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', stop);
      clearTimeout(escalation);
      if (signal.aborted) { reject(signal.reason); return; }
      if (failure) { reject(failure); return; }
      if (terminationSignal) { reject(new Error(`Desktop maintenance was terminated (${terminationSignal})`)); return; }
      resolve(code);
    });
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
  });
}
