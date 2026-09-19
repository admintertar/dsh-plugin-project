import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const guard = new URL('../scripts/check-node.mjs', import.meta.url).href;
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Node version guard accepts supported stable releases and rejects incompatible versions', () => {
  for (const [version, accepted] of [
    ['20.19.0', false], ['22.18.999', false], ['22.19.0', true], ['22.20.0', true],
    ['23.0.0', false], ['24.0.0', true], ['25.0.0', true], ['24.0.0-rc.1', false],
  ] as const) {
    // Exercise the real guard in a fresh process, including its failure exit code.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}}); await import(${JSON.stringify(guard)});`],
    {encoding: 'utf8', timeout: 5000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, accepted ? 0 : 1, `${version}: ${result.stderr}`);
    if (!accepted) {
      assert.ok(result.stderr.includes(manifest.engines.node));
      assert.ok(result.stderr.includes(version));
    }
  }
});
