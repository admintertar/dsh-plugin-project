/** Test-only observer copied into an isolated Desktop Profile. */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
export const inject = ['tools', 'webServer'];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/__project_compatibility', handler(_request, response) {
    const requirePlugin = createRequire(createRequire(import.meta.url).resolve('dsh-plugin-project'));
    const session = JSON.parse(readFileSync(requirePlugin.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({tools: ctx.tools.schemas().map(tool => tool.name), sessionVersion: session.version}));
  }}));
}
