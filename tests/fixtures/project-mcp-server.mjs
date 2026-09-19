import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';

const pidFile = process.argv.find(arg => arg.startsWith('--pid-file='))?.slice('--pid-file='.length);
if (pidFile) writeFileSync(pidFile, String(process.pid));
const empty = process.argv.includes('--empty');
const image = process.argv.includes('--image');

const lines = createInterface({input: process.stdin, crlfDelay: Infinity});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id, result})}\n`);
}

for await (const line of lines) {
  if (line.trim() === '') continue;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: {tools: {}},
      serverInfo: {name: 'project-mcp-fixture', version: '1.0.0'},
    });
  } else if (message.method === 'tools/list') {
    respond(message.id, {
      tools: empty ? [] : [{name: 'ping', description: 'Returns pong.', inputSchema: {type: 'object', properties: {}}}],
    });
  } else if (message.method === 'tools/call') {
    respond(message.id, {content: image
      ? [{type: 'image', mimeType: 'image/png', data: 'AA=='}]
      : [{type: 'text', text: 'pong'}]});
  }
}
