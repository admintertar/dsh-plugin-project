import type {
  SessionListState, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client';
import type {SessionId} from '@deepseek-ai/dsh-session/types';

/** Session ordering choices retained after removing the Workspace grouping layer. */
export type ProjectSessionOrder = 'manual' | 'updated';

/** Inputs needed to derive the flat, Project-scoped Session list. */
export interface ProjectSessionRowsInput {
  list: SessionListState;
  projectRoot: string;
  archivedIds: readonly SessionId[];
  /** Official flat-browser view order; omitted on the initial recency pass. */
  viewOrder?: readonly string[];
}

/** Inputs for the official recent-activity promotion policy. */
export interface ProjectSessionOrderInput {
  sessions: readonly SessionSummary[];
  previousOrder: readonly string[] | undefined;
  previousUpdatedAt: Readonly<Record<string, number>>;
  orderBy: ProjectSessionOrder;
  /** Re-sort the whole account on first load or when switching to updated. */
  sortByRecency: boolean;
}

/** Reconciled view order plus the timestamps observed during this pass. */
export interface ProjectSessionOrderResult {
  order: SessionId[];
  updatedAt: Record<string, number>;
  changed: boolean;
}

/** One merged Project search row; the snippet exists only for a Host content hit. */
export interface ProjectSessionSearchRow {
  session: SessionSummary;
  snippet?: string;
}

/** Bounded search projection matching the Session Controller's result contract. */
export interface ProjectSessionSearchResult {
  items: ProjectSessionSearchRow[];
  hasMore: boolean;
}

const SEARCH_QUERY_MAX_CODE_UNITS = 500;

/** Newest update first, with Session identity as a deterministic tie breaker. */
function byRecency(left: SessionSummary, right: SessionSummary): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return left.id < right.id ? -1 : 1;
}

/**
 * Derive the one-window/one-Workspace Session list.
 *
 * The visibility rules intentionally mirror the official flat browser: direct
 * top-level Sessions only, archived rows removed, and at most the selected
 * blank placeholder retained. The Project root adds the window boundary.
 */
export function projectSessionRows({
  list, projectRoot, archivedIds, viewOrder,
}: ProjectSessionRowsInput): SessionSummary[] {
  const archived = new Set(archivedIds);
  const visible = list.ids.map(id => list.byId[id]).filter((session): session is SessionSummary =>
    session !== undefined
      && session.cwd === projectRoot
      && session.origin !== 'subagent'
      && !archived.has(session.id)
      && (!session.blank || session.id === list.current));
  visible.sort(byRecency);
  if (viewOrder === undefined) return visible;

  const byId = new Map(visible.map(session => [session.id, session]));
  const ordered: SessionSummary[] = [];
  for (const key of viewOrder) {
    const id = key as SessionId;
    const session = byId.get(id);
    if (session === undefined) continue;
    ordered.push(session);
    byId.delete(id);
  }
  // `visible` is already newest-first, so newly discovered Sessions append in
  // the same deterministic order as the official reconciler.
  ordered.push(...visible.filter(session => byId.has(session.id)));
  return ordered;
}

/**
 * Reconcile one Project's persisted order and apply the official promotion
 * rule: while sorted by update, only Sessions whose timestamp advanced move
 * to the front; unrelated rows keep their relative order.
 */
export function nextProjectSessionOrder({
  sessions, previousOrder, previousUpdatedAt, orderBy, sortByRecency,
}: ProjectSessionOrderInput): ProjectSessionOrderResult {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const included = new Set<SessionId>();
  let order: SessionId[] = [];
  if (previousOrder !== undefined) {
    for (const key of previousOrder) {
      const id = key as SessionId;
      if (!byId.has(id) || included.has(id)) continue;
      order.push(id);
      included.add(id);
    }
  }
  for (const session of sessions) {
    if (included.has(session.id)) continue;
    order.push(session.id);
    included.add(session.id);
  }

  if (sortByRecency) {
    order.sort((left, right) => byRecency(byId.get(left)!, byId.get(right)!));
  } else if (orderBy === 'updated') {
    const promoted = sessions.filter(session => {
      const previous = previousUpdatedAt[session.id];
      return previous === undefined || session.updatedAt > previous;
    }).sort(byRecency);
    if (promoted.length > 0) {
      const promotedIds = new Set(promoted.map(session => session.id));
      order = [...promoted.map(session => session.id), ...order.filter(id => !promotedIds.has(id))];
    }
  }

  const updatedAt = Object.fromEntries(sessions.map(session => [session.id, session.updatedAt]));
  const priorOrder = previousOrder;
  const orderChanged = priorOrder === undefined || order.length !== priorOrder.length
    || order.some((id, index) => id !== priorOrder[index]);
  const previousTimestamps = Object.keys(previousUpdatedAt);
  const timestampsChanged = Object.keys(updatedAt).length !== previousTimestamps.length
    || Object.entries(updatedAt).some(([id, timestamp]) => previousUpdatedAt[id] !== timestamp);
  return {order, updatedAt, changed: orderChanged || timestampsChanged};
}

/** Keep the controlled input and Host RPC payload inside the search wire contract. */
export function sanitizeProjectSessionQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '');
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul;
  let end = SEARCH_QUERY_MAX_CODE_UNITS;
  const last = withoutNul.charCodeAt(end - 1);
  const next = withoutNul.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
  return withoutNul.slice(0, end);
}

/**
 * Merge immediate title matches with ranked Host content results, then apply
 * the already-derived Project scope so content from another window cannot leak.
 */
export function projectSessionSearch(
  rows: readonly SessionSummary[],
  query: string,
  content: {items: readonly SessionSearchResultItem[]; hasMore: boolean},
  limit: number,
): ProjectSessionSearchResult {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return {items: [], hasMore: false};

  const rowById = new Map(rows.filter(row => !row.blank).map(row => [row.id, row]));
  const contentById = new Map<SessionId, SessionSearchResultItem>();
  for (const item of content.items) {
    if (rowById.has(item.sessionId) && !contentById.has(item.sessionId)) {
      contentById.set(item.sessionId, item);
    }
  }

  const ordered: SessionSummary[] = [];
  const included = new Set<SessionId>();
  const include = (session: SessionSummary) => {
    if (included.has(session.id)) return;
    included.add(session.id);
    ordered.push(session);
  };
  [...rowById.values()].filter(row => row.displayTitle.toLowerCase().includes(normalized))
    .sort(byRecency).forEach(include);
  for (const item of content.items) {
    const session = rowById.get(item.sessionId);
    if (session !== undefined) include(session);
  }

  return {
    items: ordered.slice(0, limit).map(session => {
      const match = contentById.get(session.id);
      return match === undefined ? {session} : {session, snippet: match.snippet};
    }),
    hasMore: content.hasMore || ordered.length > limit,
  };
}

/**
 * Resolve DOM-style insert-before semantics for one manual row drop.
 * `null` means no move, `undefined` means append, and an id is the next row.
 */
export function projectSessionDropAnchor(
  orderedIds: readonly SessionId[],
  sourceId: SessionId,
  targetId: SessionId,
  half: 'before' | 'after',
): SessionId | null | undefined {
  if (sourceId === targetId) return null;
  const remaining = orderedIds.filter(id => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  if (targetIndex < 0) return null;
  return remaining[targetIndex + (half === 'after' ? 1 : 0)];
}
