import {strict as assert} from 'node:assert';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {stringify} from 'yaml';
import {atomicWriteFile} from '../src/atomic-file.ts';
import {Context} from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import type {ProjectView} from '../src/project.ts';
import {ProjectSkillService} from '../src/project-skills.ts';

function writeSkill(directory: string, name: string, body = 'Use the project skill.'): void {
  mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, 'SKILL.md'), [
    '---', `name: ${name}`, `description: ${name} description`, '---', '', body, '',
  ].join('\n'));
}

async function fixture(options: ConstructorParameters<typeof ProjectSkillService>[2] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-skills-')));
  const project: ProjectView = {
    id: 'skills-project', name: 'Skills Project', description: '', root,
    resources: [{id: 'root', name: 'Root', type: 'local', path: root, status: 'ready'}],
    memory: [],
  };
  const ctx = new Context();
  await ctx.plugin(SkillRegistry);
  ctx.skills.register({
    name: 'inherited-skill', description: 'Inherited description', content: 'Inherited body.', source: 'runtime',
  });
  const service = new ProjectSkillService(ctx, project, {watch: false, ...options});
  return {root, ctx, service, cleanup: async () => {
    await service.dispose();
    await ctx.fiber.dispose();
    rmSync(root, {recursive: true, force: true});
  }};
}

test('project skills discover standard bundles, reject flat files and group inherited skills', async () => {
  const f = await fixture();
  try {
    writeSkill(join(f.root, 'skills/project-skill'), 'project-skill');
    writeFileSync(join(f.root, 'skills/flat-skill.md'), [
      '---', 'name: flat-skill', 'description: Flat skills are unsupported', '---', '', 'Flat body.',
    ].join('\n'));
    const snapshot = await f.service.snapshot();
    assert.deepEqual(snapshot.project.map(skill => skill.name), ['project-skill']);
    assert.deepEqual(snapshot.inherited.map(skill => skill.name), ['inherited-skill']);
    assert.equal(snapshot.project[0]?.enabled, true);
    assert.equal(snapshot.inherited[0]?.readonly, true);
    assert.deepEqual((await f.ctx.skills.list()).map(skill => skill.name), ['inherited-skill', 'project-skill']);
    assert.equal((await f.ctx.skills.get('project-skill'))?.content, 'Use the project skill.');
    assert.equal(await f.ctx.skills.get('flat-skill'), undefined);
  } finally {await f.cleanup();}
});

test('project skills invalidate the DSH catalog on enable changes and retain the last valid index', async () => {
  const f = await fixture();
  try {
    writeSkill(join(f.root, 'skills/toggle-skill'), 'toggle-skill');
    let invalidations = 0;
    f.ctx.on('skills/change', () => {invalidations += 1;});
    await f.service.setEnabled('toggle-skill', false);
    assert.equal(invalidations, 1);
    assert.deepEqual((await f.ctx.skills.list()).map(skill => skill.name), ['inherited-skill']);

    writeFileSync(join(f.root, 'skills/index.yaml'), 'not: [valid');
    const damaged = await f.service.snapshot();
    assert.equal(damaged.project[0]?.enabled, false);
    assert.match(damaged.diagnostic ?? '', /index\.yaml|yaml|parse/i);

    await f.service.setEnabled('toggle-skill', true);
    assert.equal(invalidations, 2);
    assert.deepEqual((await f.ctx.skills.list()).map(skill => skill.name), ['inherited-skill', 'toggle-skill']);
    // Enabling removes the explicit entry, so a switch turned off and on again leaves no leftover diff.
    assert.equal(readFileSync(f.service.layout.skillIndex, 'utf8'), 'schemaVersion: 1\nskills: {}\n');
  } finally {await f.cleanup();}
});

test('project skills import a complete bundle without modifying the source and reject conflicts', async () => {
  const f = await fixture();
  const sourceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'project-skill-source-')));
  try {
    const source = join(sourceRoot, 'imported-skill');
    writeSkill(source, 'imported-skill', 'Imported body.');
    mkdirSync(join(source, 'references'));
    writeFileSync(join(source, 'references/guide.md'), 'Keep this reference.\n');
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    let invalidations = 0;
    f.ctx.on('skills/change', () => {invalidations += 1;});

    const imported = await f.service.importBundle(source);
    assert.equal(imported.name, 'imported-skill');
    assert.equal(imported.enabled, true);
    assert.equal(invalidations, 1);
    assert.equal(readFileSync(join(f.root, 'skills/imported-skill/references/guide.md'), 'utf8'), 'Keep this reference.\n');
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
    await assert.rejects(f.service.importBundle(source), /already exists|conflict/i);
  } finally {
    await f.cleanup();
    rmSync(sourceRoot, {recursive: true, force: true});
  }
});

test('project skills reject sources inside the target and symbolic links escaping the bundle', async () => {
  const f = await fixture();
  const sourceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'project-skill-links-')));
  try {
    const nested = join(f.root, 'skills/nested-skill');
    writeSkill(nested, 'nested-skill');
    await assert.rejects(f.service.importBundle(nested), /inside|project skills/i);

    const source = join(sourceRoot, 'linked-skill');
    writeSkill(source, 'linked-skill');
    writeFileSync(join(sourceRoot, 'outside.txt'), 'outside');
    symlinkSync(join(sourceRoot, 'outside.txt'), join(source, 'outside-link'));
    await assert.rejects(f.service.importBundle(source), /symbolic link|outside/i);
    assert.equal(existsSync(join(f.root, 'skills/linked-skill')), false);
  } finally {
    await f.cleanup();
    rmSync(sourceRoot, {recursive: true, force: true});
  }
});

test('project skills enforce file count, per-file and total import limits', async () => {
  const f = await fixture({limits: {maxFiles: 3, maxFileBytes: 256, maxTotalBytes: 320}});
  const sourceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'project-skill-limits-')));
  try {
    const tooMany = join(sourceRoot, 'too-many');
    writeSkill(tooMany, 'too-many');
    writeFileSync(join(tooMany, 'one.txt'), '1');
    writeFileSync(join(tooMany, 'two.txt'), '2');
    writeFileSync(join(tooMany, 'three.txt'), '3');
    await assert.rejects(f.service.importBundle(tooMany), /file count|3 files/i);

    const tooLarge = join(sourceRoot, 'too-large');
    writeSkill(tooLarge, 'too-large');
    writeFileSync(join(tooLarge, 'large.bin'), Buffer.alloc(257));
    await assert.rejects(f.service.importBundle(tooLarge), /single file|256 bytes/i);

    const tooBig = join(sourceRoot, 'too-big');
    writeSkill(tooBig, 'too-big');
    writeFileSync(join(tooBig, 'first.bin'), Buffer.alloc(150));
    writeFileSync(join(tooBig, 'second.bin'), Buffer.alloc(150));
    await assert.rejects(f.service.importBundle(tooBig), /total size|320 bytes/i);
  } finally {
    await f.cleanup();
    rmSync(sourceRoot, {recursive: true, force: true});
  }
});


async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Skill catalog did not reflect the edited index');
    await delay(30);
  }
}

test('hand-edited and atomically replaced Skill indexes refresh the cached DSH catalog', async () => {
  const f = await fixture({watch: true});
  try {
    writeSkill(join(f.root, 'skills/watched-skill'), 'watched-skill');
    const enabled = async () => (await f.ctx.skills.list({cwd: f.root})).some(skill => skill.name === 'watched-skill');
    assert.equal(await enabled(), true);
    atomicWriteFile(f.service.layout.skillIndex, 'schemaVersion: 1\nskills:\n  watched-skill: {enabled: false}\n');
    await eventually(async () => !(await enabled()));
    writeFileSync(f.service.layout.skillIndex, 'not: [valid');
    await delay(400);
    assert.equal(await enabled(), false);
    assert.ok((await f.service.snapshot()).diagnostic);
    writeFileSync(f.service.layout.skillIndex, 'schemaVersion: 1\nskills: {}\n');
    await eventually(enabled);
    await f.service.dispose();
    let changes = 0;
    f.ctx.on('skills/change', () => {changes += 1;});
    atomicWriteFile(f.service.layout.skillIndex, 'schemaVersion: 1\nskills:\n  watched-skill: {enabled: false}\n');
    await delay(400);
    assert.equal(changes, 0, 'Disposed provider must stop index notifications');
  } finally {await f.cleanup();}
});

test('Skill enable writes enforce the index byte limit without changing disk or effective state', async () => {
  const f = await fixture();
  try {
    const name = 's'.repeat(64);
    writeSkill(join(f.root, 'skills', name), name);
    const index = {schemaVersion: 1, skills: {} as Record<string, {enabled: boolean}>};
    for (let i = 0; i < 761; i++) index.skills[`s${i.toString().padStart(4, '0')}-` + 'x'.repeat(58)] = {enabled: true};
    const content = stringify(index, {lineWidth: 0});
    assert.ok(Buffer.byteLength(content) <= 65_536);
    writeFileSync(f.service.layout.skillIndex, content);
    await f.service.snapshot();
    await assert.rejects(f.service.setEnabled(name, false), /Skill index exceeds 65536/);
    assert.equal(readFileSync(f.service.layout.skillIndex, 'utf8'), content);
    assert.equal((await f.service.snapshot()).project[0]?.enabled, true);
  } finally {await f.cleanup();}
});

test('project Skill management includes the selected preset and marks same-name shadowing as ineffective', async () => {
  const {createScope} = await import('@deepseek-ai/dsh-scope');
  const f = await fixture();
  const key = {};
  const preset = createScope(f.ctx, key);
  try {
    writeSkill(join(f.root, 'skills/shared-skill'), 'shared-skill');
    preset.ctx.get('skills')!.register({name: 'shared-skill', description: 'Scoped replacement', source: 'bundled', content: 'Preset body'});
    preset.ctx.get('skills')!.register({name: 'preset-only', description: 'Preset skill', source: 'bundled', content: 'Preset body'});
    const global = await f.service.snapshot();
    assert.equal(global.project[0]?.effective, true);
    assert.equal(global.inherited.some(skill => skill.name === 'preset-only'), false);
    const scoped = await f.service.snapshot({cwd: f.root, scope: key});
    assert.equal(scoped.project[0]?.enabled, true);
    assert.equal(scoped.project[0]?.effective, false);
    assert.equal(scoped.inherited.find(skill => skill.name === 'shared-skill')?.description, 'Scoped replacement');
    assert.equal(scoped.inherited.find(skill => skill.name === 'preset-only')?.source, 'bundled');
  } finally {await preset.dispose(); await f.cleanup();}
});
