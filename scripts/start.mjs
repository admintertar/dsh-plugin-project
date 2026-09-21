import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveProjectFile } from '../src/project-files.ts';
import { readProject } from '../src/project.ts';
import {readCompatibilityPin} from '../src/desktop-runtime.ts';
import {migrateProfilePluginLink, prepareProfilePlugin} from '../src/development-plugin.ts';

// Yarn 4 forwards the literal "--" separator to the script (npm swallowed it).
const args = process.argv.slice(2).filter(arg => arg !== '--');
const manifest = resolveProjectFile(resolve(args[0] ?? 'examples/demo-web/demo-web.agent-project'));
const port = Number(args[1] ?? 43191);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
const repository = realpathSync('.');
if (!existsSync('.dev/runtime-source.json')) throw new Error('Run yarn run setup first');
const source = JSON.parse(readFileSync('.dev/runtime-source.json', 'utf8'));
const edition = source.edition ?? 'stable';
if (edition !== 'stable') throw new Error('Only stable is supported; run yarn run setup with a stable runtime source');
const expected = readCompatibilityPin(repository).harness[edition];
if (source.version !== expected.version || source.commit !== expected.commit) throw new Error('Development runtime differs from upstream.json; run yarn run setup again');
const runtime = resolve('.dev/runtime/node_modules');
if (!existsSync(join(runtime, '@deepseek-ai/dsh/lib/bin.js'))) throw new Error('Run yarn run setup first');
const projectKey = createHash('sha256').update(manifest).digest('hex').slice(0, 16);
const projectHome = resolve('.dev/projects', projectKey);
const profile = join(projectHome, 'profiles/web');
const modules = join(profile, 'node_modules');
mkdirSync(modules, {recursive: true});
const profilePlugin = prepareProfilePlugin(repository, profile);
migrateProfilePluginLink(repository, profile, profilePlugin);
for (const [name, target] of [['@deepseek-ai', join(runtime, '@deepseek-ai')], ['dsh-plugin-project', profilePlugin]]) {
  const link = join(modules, name);
  if (!existsSync(link)) symlinkSync(target, link, 'junction');
}
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'project-web-profile', private: true, type: 'module',
  dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-project'], patchReload: 'startup'}},
}, null, 2) + '\n');
const overlay = join(projectHome, 'project.patch.yml');
writeFileSync(overlay, [
  '- id: webserver',
  '  config:',
  '    host: 127.0.0.1',
  `    port: ${port}`,
  '- id: web-runtime',
  '  config:',
  '    openBrowser: false',
  '    printUrl: true',
  '    surfaceContext: true',
  '    trustedHosts: []',
  '- id: project',
  '  config:',
  `    manifestPath: ${JSON.stringify(manifest)}`,
  '- id: session-telemetry-otel',
  '  disabled: true',
  '',
].join('\n'));
console.log(`Project: ${manifest}\nURL: http://127.0.0.1:${port}\nRuntime data: ${projectHome}`);
const child = spawn(process.execPath, [join(runtime, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', overlay], {
  cwd: readProject(manifest).root, stdio: 'inherit',
  env: {...process.env, DSH_HOME: projectHome, DSH_AGENTS_HOME: join(projectHome, 'agents'), DSH_PROJECT_MANIFEST: manifest},
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('exit', (code, signal) => {process.exitCode = code ?? (signal ? 1 : 0);});
