/** Development-only checks shared by setup and the native launch adapter. */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

export type DesktopEdition = 'beta' | 'stable';
export interface HarnessPin {version: string; commit: string}
export interface CompatibilityPin {
  desktop: {version: string; commit: string};
  harness: Record<DesktopEdition, HarnessPin>;
}
interface RuntimeInventory extends HarnessPin {
  packages: {name: string; version: string; filename: string; sha256: string}[];
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function readCompatibilityPin(repository: string): CompatibilityPin {
  return readJson(join(repository, 'upstream.json'));
}

/** Check the selected channel, its source inventory, and optionally the installed runtime. */
export function verifyDesktopRuntime(repository: string, desktopRepository: string, edition: DesktopEdition, installed = false) {
  const pin = readCompatibilityPin(repository);
  const harness = pin.harness[edition];
  if (!harness) throw new Error(`Missing ${edition} runtime pin`);
  const desktopPackage = edition === 'beta' ? 'dsh-plugin-desktop-beta' : 'dsh-plugin-desktop';
  const packageDir = join(desktopRepository, desktopPackage);
  const manifest = readJson(join(packageDir, 'package.json'));
  if (manifest.name !== desktopPackage || manifest.version.replace(/-beta\.\d+$/, '') !== pin.desktop.version) {
    throw new Error('Desktop version differs from the pinned development adapter');
  }
  const channel = readJson(join(desktopRepository, 'upstream.json')).channels?.[edition];
  if (channel?.package !== desktopPackage || channel.commit !== harness.commit
    || channel.runtimePackageVersion !== harness.version || manifest.dependencies?.['@deepseek-ai/dsh'] !== harness.version) {
    throw new Error(`${edition} Desktop runtime differs from upstream.json; update and validate the adapter first`);
  }
  const directory = join(desktopRepository, 'vendor/dsh-runtime', harness.version);
  const inventory: RuntimeInventory = readJson(join(directory, 'manifest.json'));
  if (inventory.commit !== harness.commit || inventory.version !== harness.version) {
    throw new Error(`${edition} Desktop runtime inventory differs from upstream.json`);
  }
  if (installed) {
    const requireDesktop = createRequire(join(packageDir, 'package.json'));
    const actual = readJson(requireDesktop.resolve('@deepseek-ai/dsh/package.json'));
    if (actual.version !== harness.version) throw new Error(`${edition} Desktop dependencies are stale; run corepack yarn install --immutable`);
  }
  return {harness, directory, inventory, desktopPackage, packageDir};
}
