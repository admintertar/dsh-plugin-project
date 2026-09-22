import {strict as assert} from 'node:assert';
import {chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parse, stringify} from 'yaml';
import {atomicWriteFile} from '../src/atomic-file.ts';
import {ProjectMcpConfigStore, type ProjectMcpServer} from '../src/project-mcp-config.ts';
import type {ProjectView} from '../src/project.ts';

function fixture(options: ConstructorParameters<typeof ProjectMcpConfigStore>[1] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-config-')));
  const project: ProjectView = {
    id: 'mcp-project', name: 'MCP Project', description: '', root,
    resources: [{id: 'root', name: 'Root', type: 'local', path: root, status: 'ready'}], memory: [],
  };
  const store = new ProjectMcpConfigStore(project, options);
  return {root, project, store, cleanup: () => rmSync(root, {recursive: true, force: true})};
}

const stdio: ProjectMcpServer = {
  id: 'local-files', serverName: 'files', enabled: true, transport: 'stdio',
  command: 'node', args: ['server.mjs'], toolCallTimeoutMs: 30_000,
};

const http: ProjectMcpServer = {
  id: 'remote-search', serverName: 'search', enabled: false, transport: 'streamable-http',
  url: 'https://example.com/mcp', toolCallTimeoutMs: 60_000,
  reconnect: {enabled: true, initialDelayMs: 500, maxDelayMs: 5_000, maxAttempts: 4},
};

test('project mcp config merges private overrides but exposes only presence flags', () => {
  const f = fixture();
  try {
    f.store.upsert(stdio, {env: {API_TOKEN: 'stdio-secret'}, cwd: '/tmp/project-mcp'});
    f.store.upsert(http, {headers: {Authorization: 'Bearer http-secret'}});
    const listed = f.store.list();
    assert.deepEqual(listed.map(server => [server.id, server.hasEnvironment, server.hasHeaders, server.hasCwd]), [
      ['local-files', true, false, true],
      ['remote-search', false, true, false],
    ]);
    assert.doesNotMatch(JSON.stringify(listed), /stdio-secret|http-secret|API_TOKEN|Authorization|\/tmp\/project-mcp/);
    assert.deepEqual(f.store.resolved('local-files'), {
      ...stdio, env: {API_TOKEN: 'stdio-secret'}, cwd: '/tmp/project-mcp',
    });
    assert.deepEqual(f.store.resolved('remote-search'), {
      ...http, headers: {Authorization: 'Bearer http-secret'},
    });
    if (process.platform !== 'win32') assert.equal(statSync(join(f.root, 'mcp/local.yaml')).mode & 0o777, 0o600);
  } finally {f.cleanup();}
});

test('project mcp config rejects duplicate server names and invalid transport fields', () => {
  const f = fixture();
  try {
    // A file is named after its id, so ids cannot collide any more; server names still can.
    writeFileSync(f.store.serverFilePath('one'), [
      'id: one', 'serverName: shared', 'enabled: true', 'transport: stdio',
      'command: node', 'args: []', 'toolCallTimeoutMs: 1000',
    ].join('\n'));
    writeFileSync(f.store.serverFilePath('two'), [
      'id: two', 'serverName: shared', 'enabled: true', 'transport: streamable-http',
      'url: https://example.com/mcp', 'toolCallTimeoutMs: 1000',
    ].join('\n'));
    assert.throws(() => f.store.list(), /duplicate.*serverName/i);

    writeFileSync(f.store.serverFilePath('mixed'), [
      'id: mixed', 'serverName: mixed', 'enabled: true', 'transport: stdio',
      'command: node', 'args: []', 'url: https://example.com', 'toolCallTimeoutMs: 1000',
    ].join('\n'));
    assert.throws(() => f.store.list(), /url|transport|unrecognized/i);
  } finally {f.cleanup();}
});

test('project mcp config validates URL, timeout, reconnect and secret placement', () => {
  const f = fixture();
  try {
    const path = f.store.serverFilePath(http.id);
    f.store.upsert(http);
    assert.throws(() => f.store.upsert({...http, url: 'file:///tmp/mcp'}), /http|url/i);
    assert.throws(() => f.store.upsert({...stdio, toolCallTimeoutMs: 99}), /timeout|100/i);
    assert.throws(() => f.store.upsert({...http, reconnect: {initialDelayMs: 2_000, maxDelayMs: 1_000}}), /initialDelay|maxDelay/i);
    for (const reconnect of [{initialDelayMs: 60_000}, {maxDelayMs: 100}]) {
      const before = readFileSync(path, 'utf8');
      assert.throws(() => f.store.preview({...http, reconnect}), /initialDelay|maxDelay/i);
      assert.throws(() => f.store.upsert({...http, reconnect}), /initialDelay|maxDelay/i);
      assert.equal(readFileSync(path, 'utf8'), before);
    }

    writeFileSync(f.store.serverFilePath('leaked'), [
      'id: leaked', 'serverName: leaked', 'enabled: true', 'transport: stdio',
      'command: node', 'args: []', 'toolCallTimeoutMs: 1000', 'env: {TOKEN: secret}',
    ].join('\n'));
    assert.throws(() => f.store.list(), /env|secret|unrecognized/i);
  } finally {f.cleanup();}
});

test('project mcp config upserts, rejects namespace conflicts and deletes local overrides', () => {
  const f = fixture();
  try {
    f.store.upsert(stdio, {env: {TOKEN: 'secret'}});
    assert.throws(() => f.store.upsert({...http, serverName: stdio.serverName}), /serverName|already/i);
    f.store.upsert({...stdio, enabled: false}, {env: {TOKEN: 'next-secret'}});
    assert.equal(f.store.get(stdio.id)?.enabled, false);
    f.store.delete(stdio.id);
    assert.equal(f.store.get(stdio.id), undefined);
    assert.doesNotMatch(readFileSync(join(f.root, 'mcp/local.yaml'), 'utf8'), /local-files|next-secret/);
  } finally {f.cleanup();}
});

test('project mcp config rolls back the public file when the private commit fails', () => {
  const f = fixture();
  try {
    f.store.upsert(stdio, {env: {TOKEN: 'original'}});
    const publicPath = f.store.serverFilePath(stdio.id);
    const localPath = join(f.root, 'mcp/local.yaml');
    chmodSync(localPath, 0o600);
    const beforePublic = readFileSync(publicPath, 'utf8');
    const beforeLocal = readFileSync(localPath, 'utf8');
    let writes = 0;
    const failing = new ProjectMcpConfigStore(f.project, {
      writeFile(path, content, mode) {
        writes += 1;
        if (writes === 2) throw new Error('private commit failed');
        atomicWriteFile(path, content, mode);
      },
    });
    assert.throws(() => failing.upsert({...stdio, enabled: false}, {env: {TOKEN: 'replacement'}}), /private commit failed/);
    assert.equal(readFileSync(publicPath, 'utf8'), beforePublic);
    assert.equal(readFileSync(localPath, 'utf8'), beforeLocal);
  } finally {f.cleanup();}
});


test('project mcp config rejects oversized serialized public and local documents before any write', () => {
  const f = fixture();
  try {
    f.store.upsert(stdio, {env: {TOKEN: 'original'}});
    // upsert now writes a per-server file; the legacy file is deliberately left alone.
    const paths = [f.store.serverFilePath(stdio.id), f.store.layout.mcpLocal];
    chmodSync(paths[0]!, 0o640);
    const before = paths.map(path => ({bytes: readFileSync(path), mode: statSync(path).mode}));
    const assertUnchanged = () => paths.forEach((path, index) => {
      assert.deepEqual(readFileSync(path), before[index]!.bytes);
      assert.equal(statSync(path).mode, before[index]!.mode);
    });
    const huge = Array.from({length: 9}, () => '界'.repeat(16_384));
    assert.throws(() => f.store.upsert({...stdio, enabled: false}, {
      env: Object.fromEntries(huge.map((value, i) => [`VALUE_${i}`, value])),
    }), /local config exceeds 262144/);
    assertUnchanged();
    assert.throws(() => f.store.upsert({...stdio, args: huge}, {env: {TOKEN: 'changed'}}), /public config exceeds 262144/);
    assertUnchanged();
    assert.equal(f.store.list().length, 1);
    f.store.delete(stdio.id);
    assert.deepEqual(f.store.list(), []);
  } finally {f.cleanup();}
});

test('an existing single-file declaration is migrated to one file per server on open', () => {
  const f = fixture();
  try {
    // A project that predates the split keeps every declaration in mcp/servers.yaml.
    writeFileSync(join(f.root, 'mcp', 'servers.yaml'), stringify({schemaVersion: 1, servers: [stdio, http]}, {lineWidth: 0}));
    // Opening the project constructs the store, which retires the single file.
    const store = new ProjectMcpConfigStore(f.project);
    assert.equal(existsSync(join(f.root, 'mcp', 'servers.yaml')), false);
    assert.deepEqual(store.list().map(server => server.id), ['local-files', 'remote-search']);
    assert.deepEqual(store.get('local-files')?.serverName, 'files');
    assert.equal(existsSync(store.serverFilePath('local-files')), true);
    assert.equal(existsSync(store.serverFilePath('remote-search')), true);

    // Idempotent: opening again finds the same declarations and nothing left to migrate.
    const reopened = new ProjectMcpConfigStore(f.project);
    assert.deepEqual(reopened.list().map(server => server.id), ['local-files', 'remote-search']);
    assert.equal(existsSync(join(f.root, 'mcp', 'servers.yaml')), false);
  } finally {f.cleanup();}
});

test('an empty single-file declaration is cleaned up without inventing a server', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'mcp', 'servers.yaml'), 'schemaVersion: 1\nservers: []\n');
    const store = new ProjectMcpConfigStore(f.project);
    assert.deepEqual(store.list(), []);
    assert.equal(existsSync(join(f.root, 'mcp', 'servers.yaml')), false);
  } finally {f.cleanup();}
});

test('an unreadable single-file declaration is left alone instead of blocking the project', () => {
  const f = fixture();
  try {
    const legacy = join(f.root, 'mcp', 'servers.yaml');
    writeFileSync(legacy, 'schemaVersion: 1\nservers:\n  - {id: broken}\n');
    const store = new ProjectMcpConfigStore(f.project);
    assert.equal(existsSync(legacy), true);
    assert.deepEqual(store.list(), []);
  } finally {f.cleanup();}
});
