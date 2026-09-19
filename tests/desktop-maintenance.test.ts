import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import {runProjectMaintenance, type ProjectMaintenanceOptions} from '../src/desktop-maintenance.ts';

function fixture() {
  const controller = new AbortController();
  const children: Array<{child: EventEmitter; kills: unknown[]; args: string[]; spawnOptions: SpawnOptions}> = [];
  const options: ProjectMaintenanceOptions = {
    mode: 'recovery', entryPath: '/test/recovery.mjs', mainPath: '/test/main.js', signal: controller.signal,
    launch: {homeDir: '/test/project/dsh', stateDir: '/test/project/electron', cwd: '/test/project',
      environment: {DSH_PROJECT_ID: 'project', ELECTRON_RUN_AS_NODE: '1'}},
    protocol: {environmentKey: 'DSH_DESKTOP_WORKBENCH_MAINTENANCE', exitCodes: {restart: 80, recovery: 81, 'safe-mode': 82}},
    spawnProcess: (_executable, args, spawnOptions) => {
      const child = new EventEmitter();
      const kills: unknown[] = [];
      Object.assign(child, {kill: (signal: unknown) => {kills.push(signal); return true;}});
      children.push({child, kills, args, spawnOptions});
      return child as ChildProcess;
    },
  };
  return {options, controller, children};
}

test('maintenance waits for close, follows Safe Mode transitions and preserves the project Home', async () => {
  const {options, children} = fixture();
  let completed = false;
  const run = runProjectMaintenance(options).then(value => {completed = true; return value;});
  const first = children[0]!;
  assert.equal(first.spawnOptions.env?.DSH_HOME, options.launch.homeDir);
  assert.equal(first.spawnOptions.env?.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(first.spawnOptions.env?.DSH_DESKTOP_WORKBENCH_MAINTENANCE, '1');
  first.child.emit('spawn');
  first.child.emit('exit', 82, null);
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(children.length, 1);
  first.child.emit('close', 82, null);
  await Promise.resolve();
  assert.equal(children[1]!.args[1], '--dsh-desktop-safe-mode');
  children[1]!.child.emit('close', 81, null);
  await Promise.resolve();
  assert.equal(children[2]!.args[1], '--dsh-desktop-recovery');
  children[2]!.child.emit('close', 80, null);
  assert.equal(await run, 'restart');
});

test('closing recovery cancels without opening the project', async () => {
  const {options, children} = fixture();
  const run = runProjectMaintenance(options);
  children[0]!.child.emit('close', 0, null);
  assert.equal(await run, 'cancelled');
  assert.equal(children.length, 1);
});

test('cancellation waits for the maintenance process to stop', async () => {
  const {options, controller, children} = fixture();
  let completed = false;
  const run = runProjectMaintenance(options).finally(() => {completed = true;});
  const rejected = assert.rejects(run, {name: 'AbortError'});
  controller.abort();
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(children[0]!.kills, ['SIGTERM']);
  children[0]!.child.emit('close', null, 'SIGTERM');
  await rejected;
});

test('spawn failure and an unexpected termination never request a restart', async () => {
  for (const failure of ['spawn', 'signal', 'exit'] as const) {
    const {options, children} = fixture();
    const run = runProjectMaintenance(options);
    const rejected = assert.rejects(run);
    if (failure === 'spawn') children[0]!.child.emit('error', new Error('cannot start Electron'));
    children[0]!.child.emit('close', failure === 'exit' ? 7 : null, failure === 'signal' ? 'SIGKILL' : null);
    await rejected;
    assert.equal(children.length, 1);
  }
});

test('a real maintenance child returns only after its process has exited', async () => {
  const {options} = fixture();
  options.launch.cwd = process.cwd();
  let child: ChildProcess | undefined;
  options.spawnProcess = (executable, _args, spawnOptions) => {
    child = spawn(executable, ['-e', 'process.exit(process.env.DSH_DESKTOP_WORKBENCH_MAINTENANCE === "1" ? 80 : 7)'],
      {...spawnOptions, stdio: 'ignore'});
    return child;
  };
  assert.equal(await runProjectMaintenance(options), 'restart');
  assert.equal(child?.exitCode, 80);
});
