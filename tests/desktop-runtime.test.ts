import {strict as assert} from 'node:assert';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {readCompatibilityPin, verifyDesktopRuntime, type DesktopEdition} from '../src/desktop-runtime.ts';

for (const edition of ['stable', 'beta'] satisfies DesktopEdition[]) {
  test(`${edition}: launch validation rejects a different channel or stale installed runtime`, () => {
    const root = mkdtempSync(join(tmpdir(), 'project-runtime-pin-'));
    const pin = readCompatibilityPin(process.cwd());
    const write = (path: string, data: unknown) => {
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, JSON.stringify(data));
    };
    try {
      const desktop = join(root, 'desktop');
      const runtime = pin.harness[edition];
      const other = pin.harness[edition === 'stable' ? 'beta' : 'stable'];
      const name = edition === 'beta' ? 'dsh-plugin-desktop-beta' : 'dsh-plugin-desktop';
      const packageDir = join(desktop, name);
      const inventory = join(desktop, 'vendor/dsh-runtime', runtime.version, 'manifest.json');
      const installed = join(packageDir, 'node_modules/@deepseek-ai/dsh/package.json');
      write(join(root, 'upstream.json'), pin);
      write(join(desktop, 'upstream.json'), {channels: {[edition]: {
        package: name, commit: runtime.commit, runtimePackageVersion: runtime.version,
      }}});
      const manifest = {name, version: pin.desktop.version + (edition === 'beta' ? '-beta.1' : ''), dependencies: {'@deepseek-ai/dsh': runtime.version}};
      write(join(packageDir, 'package.json'), manifest);
      write(inventory, {...runtime, packages: []});
      write(installed, {name: '@deepseek-ai/dsh', version: runtime.version});
      assert.deepEqual(verifyDesktopRuntime(root, desktop, edition, true).harness, runtime);
      write(installed, {name: '@deepseek-ai/dsh', version: other.version});
      assert.throws(() => verifyDesktopRuntime(root, desktop, edition, true), /dependencies are stale/);
      write(installed, {name: '@deepseek-ai/dsh', version: runtime.version});
      write(inventory, {...runtime, commit: other.commit, packages: []});
      assert.throws(() => verifyDesktopRuntime(root, desktop, edition), /inventory differs/);
      write(inventory, {...runtime, packages: []});
      write(join(packageDir, 'package.json'), {...manifest, dependencies: {'@deepseek-ai/dsh': other.version}});
      assert.throws(() => verifyDesktopRuntime(root, desktop, edition), /runtime differs/);
    } finally {rmSync(root, {recursive: true, force: true});}
  });
}
