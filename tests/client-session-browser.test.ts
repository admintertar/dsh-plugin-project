import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import type {SessionListState, SessionSummary} from '@deepseek-ai/dsh-api-session-controller/client';
import type {SessionId} from '@deepseek-ai/dsh-session/types';
import {
  projectSessionDropAnchor,
  nextProjectSessionOrder,
  projectSessionRows,
  projectSessionSearch,
  sanitizeProjectSessionQuery,
} from '../src/client/session-browser.ts';

const sid = (value: string) => value as SessionId;
const summary = (id: string, partial: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, cwd: '/project', running: false, blank: false, updatedAt: 0, ...partial,
});
const sessionList = (items: readonly SessionSummary[], current?: SessionId): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])),
  current, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
});

test('project session browser keeps only visible sessions from the Project root', () => {
  const currentBlank = summary('blank-current', {blank: true, updatedAt: 5});
  const list = sessionList([
    summary('older', {updatedAt: 10}),
    summary('newer', {updatedAt: 30}),
    currentBlank,
    summary('blank-unused', {blank: true, updatedAt: 40}),
    summary('other-root', {cwd: '/other', updatedAt: 50}),
    summary('subagent', {origin: 'subagent', updatedAt: 60}),
    summary('archived', {updatedAt: 70}),
  ], currentBlank.id);

  assert.deepEqual(projectSessionRows({
    list, projectRoot: '/project', archivedIds: [sid('archived')],
    viewOrder: undefined,
  }).map(item => item.id), [sid('newer'), sid('older'), currentBlank.id]);
});

test('project session browser reconciles the persisted flat-list order', () => {
  const list = sessionList([
    summary('a', {updatedAt: 10}), summary('b', {updatedAt: 30}), summary('c', {updatedAt: 20}),
  ]);
  assert.deepEqual(projectSessionRows({
    list, projectRoot: '/project', archivedIds: [],
    viewOrder: [sid('c'), sid('a'), sid('b')],
  }).map(item => item.id), [sid('c'), sid('a'), sid('b')]);
});

test('project session browser promotes only newly active sessions in updated mode', () => {
  const sessions = [
    summary('b', {updatedAt: 30}), summary('c', {updatedAt: 20}), summary('a', {updatedAt: 10}),
  ];
  const result = nextProjectSessionOrder({
    sessions,
    previousOrder: [sid('a'), sid('b'), sid('c')],
    previousUpdatedAt: {a: 10, b: 25, c: 20},
    orderBy: 'updated',
    sortByRecency: false,
  });
  assert.deepEqual(result.order, [sid('b'), sid('a'), sid('c')]);
  assert.deepEqual(result.updatedAt, {b: 30, c: 20, a: 10});
  assert.equal(result.changed, true);
});

test('project session browser preserves the reconciled order in manual mode', () => {
  const sessions = [summary('new', {updatedAt: 40}), summary('old', {updatedAt: 10})];
  const result = nextProjectSessionOrder({
    sessions,
    previousOrder: [sid('old')],
    previousUpdatedAt: {old: 10},
    orderBy: 'manual',
    sortByRecency: false,
  });
  assert.deepEqual(result.order, [sid('old'), sid('new')]);
});

test('project session browser search merges title and scoped content matches', () => {
  const rows = [
    summary('title-match', {displayTitle: 'Release checklist', updatedAt: 30}),
    summary('content-match', {displayTitle: 'Notes', updatedAt: 20}),
    summary('unmatched', {displayTitle: 'Unrelated', updatedAt: 10}),
  ];
  const result = projectSessionSearch(rows, 'release', {
    items: [
      {sessionId: sid('content-match'), snippet: 'The release is ready'},
      {sessionId: sid('outside-project'), snippet: 'release'},
    ],
    hasMore: false,
  }, 20);
  assert.deepEqual(result.items.map(item => ({id: item.session.id, snippet: item.snippet})), [
    {id: sid('title-match'), snippet: undefined},
    {id: sid('content-match'), snippet: 'The release is ready'},
  ]);
  assert.equal(result.hasMore, false);
});

test('project session browser sanitizes wire queries without splitting surrogate pairs', () => {
  assert.equal(sanitizeProjectSessionQuery('a\0b'), 'ab');
  const value = `${'a'.repeat(499)}😀tail`;
  assert.equal(sanitizeProjectSessionQuery(value), 'a'.repeat(499));
});

test('project session browser resolves manual drag anchors', () => {
  const ids = [sid('a'), sid('b'), sid('c')];
  assert.equal(projectSessionDropAnchor(ids, sid('c'), sid('a'), 'before'), sid('a'));
  assert.equal(projectSessionDropAnchor(ids, sid('a'), sid('c'), 'after'), undefined);
  assert.equal(projectSessionDropAnchor(ids, sid('b'), sid('b'), 'before'), null);
});
