import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('lib', {recursive: true});
await build({entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true});
await build({entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'], sourcemap: true,
  banner: {js: 'window.__ModuleLoader__.load({id:"dsh-plugin-project",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},
  footer: {js: 'return module.exports;}});'},
});
const pin = JSON.parse(await readFile('upstream.json', 'utf8'));
await writeFile('lib/build.json', JSON.stringify({desktop: pin.desktop.version, harness: pin.harness}) + '\n');
