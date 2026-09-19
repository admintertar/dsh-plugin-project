import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createServer} from 'node:https';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {ResourceGitAuthentication} from '../src/resource-auth.ts';
import {runResourceGit} from '../src/resource-git.ts';
import {resourceFixture, gitFixture} from './fixtures/resources.ts';

test('real HTTPS clone pauses for authentication then continues without persisting a password', {skip: process.platform === 'win32'}, async () => {
  const f = resourceFixture(); gitFixture(f.outside);
  const cert = join(f.base, 'cert.pem'); const key = join(f.base, 'key.pem'); const config = join(f.base, 'cert.cnf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config], {stdio: 'ignore'});
  const bare = join(f.base, 'private.git');
  execFileSync('git', ['clone', '--bare', f.outside, bare], {stdio: 'ignore'});
  execFileSync('git', ['--git-dir', bare, 'update-server-info']);
  let authorized = 0;
  const server = createServer({cert: readFileSync(cert), key: readFileSync(key)}, (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('fixture-user:private-https-fixture').toString('base64')}`) {
      res.writeHead(401, {'www-authenticate': 'Basic realm="fixture"'}); res.end(); return;
    }
    authorized++;
    const url = new URL(req.url!, 'https://127.0.0.1');
    const path = resolve(bare, '.' + url.pathname.slice('/private.git'.length));
    try {
      if (!url.pathname.startsWith('/private.git/') || !path.startsWith(bare + sep) || !statSync(path).isFile()) throw new Error('missing');
      res.writeHead(200, {'content-type': 'application/octet-stream'}); res.end(readFileSync(path));
    } catch {res.writeHead(404); res.end();}
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `https://127.0.0.1:${(server.address() as {port: number}).port}/private.git`;
  const auth = new ResourceGitAuthentication(); const controller = new AbortController();
  const target = join(f.root, 'private'); mkdirSync(target);
  const work = auth.run(runResourceGit, ['-c', `http.sslCAInfo=${cert}`, 'clone', '--no-recurse-submodules', '--', url, '.'], target,
    {signal: controller.signal, timeoutMs: 15_000}, {url, name: 'Private', action: 'clone'}, true, () => {});
  // Attach the failure observer before polling to keep a transport failure from becoming unhandled.
  let settled = false;
  const result = work.then(() => undefined, error => error as Error).finally(() => {settled = true;});
  try {
    for (let i = 0; i < 1000 && !auth.snapshot().requests.length; i++) {
      if (settled) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(auth.snapshot().requests.length, 1);
    auth.answer(auth.snapshot().requests[0]!.id, {kind: 'https', username: 'fixture-user', password: 'private-https-fixture'});
    assert.equal(await result, undefined); assert.ok(authorized > 0);
    assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# Fixture\n');
    assert.doesNotMatch(readFileSync(join(target, '.git/config'), 'utf8'), /private-https-fixture|fixture-user|credential\.helper|dsh-git-auth/);
  } finally {
    controller.abort(); auth.dispose(); await result; server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup();
  }
});
