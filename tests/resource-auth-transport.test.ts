import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, join} from 'node:path';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {gitAuthTransport} from '../src/resource-auth-transport.ts';
import {runResourceGit} from '../src/resource-git.ts';
import {resourceFixture, gitFixture} from './fixtures/resources.ts';

const execute = promisify(execFile);
function fill(args: string[], env: Record<string, string>, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args, 'credential', 'fill'], {env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', chunk => {output += chunk;}); child.stderr.resume();
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error('credential-refused')));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

test('real Git credential helper binds secrets to one HTTPS repository and uses no credential files', async () => {
  const credential = {kind: 'https' as const, username: 'fixture-user', password: 'fixture-secret-value'};
  const transport = await gitAuthTransport('https://example.com/private.git', credential);
  const script = /'([^']+helper\.cjs)' credential$/.exec(transport.args.find(arg => arg.startsWith('credential.helper=!'))!)![1]!;
  try {
    const output = await fill(transport.args, transport.env, 'protocol=https\nhost=example.com\npath=private.git\n\n');
    assert.match(output, /username=fixture-user\npassword=fixture-secret-value/);
    for (const input of ['protocol=https\nhost=other.example.com\npath=private.git\n\n',
      'protocol=https\nhost=example.com\npath=other.git\n\n', 'protocol=http\nhost=example.com\npath=private.git\n\n']) {
      await assert.rejects(fill(transport.args, transport.env, input), /credential-refused/);
    }
    assert.doesNotMatch(JSON.stringify(transport.env) + transport.args.join(' ') + readFileSync(script, 'utf8'), /fixture-secret-value|fixture-user/);
    for (const file of readdirSync(dirname(script))) assert.doesNotMatch(readFileSync(join(dirname(script), file), 'utf8'), /fixture-secret-value|fixture-user/);
    const response = await fetch(`http://127.0.0.1:${transport.env.DSH_GIT_AUTH_PORT}/`, {method: 'POST', body: '{}'});
    assert.equal(response.status, 403);
  } finally {await transport.close();}
  assert.equal(existsSync(script), false);
});

test('SSH askpass supplies only the selected key passphrase and cleans its helper on close', {skip: process.platform === 'win32'}, async () => {
  const keyPath = "/tmp/private key ' fixture";
  const transport = await gitAuthTransport('git@example.com:private.git', {kind: 'ssh', keyPath, passphrase: 'private-passphrase-fixture'});
  const launcher = transport.env.SSH_ASKPASS!;
  try {
    const result = await execute(launcher, [`Enter passphrase for key '${keyPath}':`], {env: {...process.env, ...transport.env}});
    assert.equal(result.stdout, 'private-passphrase-fixture\n');
    await assert.rejects(execute(launcher, ['Password for user:'], {env: {...process.env, ...transport.env}}));
    await assert.rejects(execute(launcher, ["Enter passphrase for key '/other/key':"], {env: {...process.env, ...transport.env}}));
    await assert.rejects(execute(launcher, [`Enter passphrase for key '${keyPath}.other':`], {env: {...process.env, ...transport.env}}));
    assert.match(transport.env.GIT_SSH_COMMAND!, /StrictHostKeyChecking=yes/);
    assert.match(transport.env.GIT_SSH_COMMAND!, /PasswordAuthentication=no/);
    for (const file of readdirSync(dirname(launcher))) assert.doesNotMatch(readFileSync(join(dirname(launcher), file), 'utf8'), /private-passphrase-fixture/);
    assert.doesNotMatch(JSON.stringify(transport.env), /private-passphrase-fixture/);
  } finally {await transport.close();}
  assert.equal(existsSync(launcher), false);
});

test('explicit credentials refuse Git URL rewrites before any authenticated transport', async () => {
  const f = resourceFixture(); const git = gitFixture(f.root);
  git('config', 'url.https://other.example.com/.insteadOf', 'https://example.com/');
  try {
    await assert.rejects(runResourceGit(['ls-remote', '--', 'https://example.com/private.git'], f.root,
      {auth: {url: 'https://example.com/private.git', credential: {kind: 'https', username: 'fixture-user', password: 'fixture-secret'}}}), /git-auth-remote-changed/);
  } finally {f.cleanup();}
});
