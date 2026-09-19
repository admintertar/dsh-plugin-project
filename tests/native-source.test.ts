import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

test('Desktop launcher source dependencies load in native Node without a TypeScript transform', () => {
  const environment = {...process.env};
  delete environment.NODE_OPTIONS;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {strict as assert} from 'node:assert';
    import {readProject} from './src/project.ts';
    import {ProjectHttpError} from './src/http.ts';
    import {prepareDesktopWindow} from './src/desktop-development.ts';
    import {runProjectMaintenance} from './src/desktop-maintenance.ts';
    const project = readProject('./examples/demo-web/demo-web.agent-project');
    const error = new ProjectHttpError(409, 'revision-conflict');
    assert.equal(project.id, 'demo-web');
    assert.equal(error.status, 409);
    assert.equal(error.code, 'revision-conflict');
    assert.equal(error.message, 'revision-conflict');
    assert.equal(typeof prepareDesktopWindow, 'function');
    assert.equal(typeof runProjectMaintenance, 'function');
    console.log('native-source-ok');
  `], {cwd: fileURLToPath(new URL('../', import.meta.url)), env: environment, encoding: 'utf8', timeout: 15_000});
  assert.equal(result.trim(), 'native-source-ok');
});
