/** Profile-local build staging shared by the Web and Desktop development launchers. */
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

/** Keep DSH peers outside the source checkout's selected development graph. */
export function prepareProfilePlugin(repository: string, profile: string): string {
  const directory = join(profile, '.project-plugin');
  const marker = join(directory, 'source.json');
  if (lstatSync(directory, {throwIfNoEntry: false})) {
    if (lstatSync(directory).isSymbolicLink() || !existsSync(marker)
      || JSON.parse(readFileSync(marker, 'utf8')).repository !== repository) {
      throw new Error('This development Profile plugin belongs to another checkout');
    }
  }
  mkdirSync(directory, {recursive: true});
  // Mark ownership before copying so a stopped, interrupted preparation can retry.
  writeFileSync(marker, JSON.stringify({repository}) + '\n');
  const source = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const {name, version, type, exports, dsh, dependencies, peerDependencies, license, private: isPrivate} = source;
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name, version, type, exports, dsh, dependencies, peerDependencies, license, private: isPrivate}, null, 2) + '\n');
  cpSync(join(repository, 'lib'), join(directory, 'lib'), {recursive: true});
  cpSync(join(repository, 'cordis.patch.yml'), join(directory, 'cordis.patch.yml'));
  cpSync(join(repository, 'THIRD_PARTY_NOTICES.md'), join(directory, 'THIRD_PARTY_NOTICES.md'));
  if (existsSync(join(repository, 'LICENSE'))) cpSync(join(repository, 'LICENSE'), join(directory, 'LICENSE'));
  // Plugin-owned libraries contain no DSH runtime. DSH peers resolve through
  // the Profile's Web runtime scope or official Desktop installation fallback.
  for (const dependency of Object.keys(dependencies)) {
    const target = join(directory, 'node_modules', dependency);
    mkdirSync(dirname(target), {recursive: true});
    if (!existsSync(target)) symlinkSync(join(repository, 'node_modules', dependency), target, 'junction');
  }
  return directory;
}

/** Repair only an old physical link to this checkout; return whether it exists. */
export function migrateProfilePluginLink(repository: string, profile: string, profilePlugin: string): boolean {
  const pluginLink = join(profile, 'node_modules/dsh-plugin-project');
  const link = lstatSync(pluginLink, {throwIfNoEntry: false});
  if (!link) return false;
  if (existsSync(pluginLink) && realpathSync(pluginLink) === realpathSync(profilePlugin)) return true;
  if (!link.isSymbolicLink() || !existsSync(pluginLink) || realpathSync(pluginLink) !== repository) {
    throw new Error('This development Profile plugin link belongs to another checkout');
  }
  // pnpm can trust its lock even when the old physical link remains. Never
  // replace a directory or a link belonging to another plugin installation.
  unlinkSync(pluginLink);
  symlinkSync(profilePlugin, pluginLink, 'junction');
  return true;
}
