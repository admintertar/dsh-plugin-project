import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {setupOfficialSource} from '../src/setup-official-source.ts';

// The default development source is the pinned DeepSeek repository. Reject a
// Shell path while the companion Shell still uses a different Desktop source.
const {values, positionals} = parseArgs({args: process.argv.slice(2).filter(arg => arg !== '--'), allowPositionals: true, options: {
  desktop: {type: 'string'}, shell: {type: 'string'}, edition: {type: 'string', default: 'stable'},
}});
if (values.edition !== 'stable') throw new Error('Only stable is supported');
if (positionals.length > 1 || [values.desktop, values.shell, positionals[0]].filter(Boolean).length > 1) {
  throw new Error('Usage: yarn run setup -- --desktop /path/to/deepseek-harness');
}
const saved = existsSync('.dev/runtime-source.json') ? JSON.parse(readFileSync('.dev/runtime-source.json', 'utf8')) : {};
if (values.shell) {
  throw new Error('Shell setup is unavailable until dsh-project-desktop uses the pinned official Desktop source');
}
const supplied = values.desktop ?? positionals[0] ?? saved.desktopSource;
if (!supplied) throw new Error('Run yarn run setup -- --desktop /path/to/deepseek-harness');
setupOfficialSource(resolve('.'), supplied);
