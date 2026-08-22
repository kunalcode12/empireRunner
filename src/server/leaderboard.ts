/**
 * Leaderboards. Item 3: all-time, weekly, daily and friends, cursor-paginated,
 * with a rank lookup that does not scan.
 *
 * ## Cursors are signed, and that is not paranoia
 *
 * A cursor is an offset. An unsigned one is a query parameter, and a query
 * parameter is something a client edits — `?cursor=999999999` turns one page
 * request into a scan of a board that may have a million rows. Signing it means
 * the only offsets the server will honour are ones it issued, so paging is
 * bounded by the pages that actually exist.
 *
 * It also makes the cursor opaque, which keeps the door open: swapping offset
 * paging for keyset paging (`WHERE (score, submitted_at) < (?, ?)`) later is an
 * internal change, because no client ever knew what was inside.
 *
 * ## Why the rank lookup gets its own path
 *
 * "Rank lookup for the current player without scanning." The naive version —
 * fetch the board, `findIndex` — is O(n) per request and works beautifully until
 * the board is big, at which point every player's own rank is the most expensive
 * query on the site. It is delegated to `Store.getPlayerRank`, which the memory
 * adapter answers with a binary search over a maintained sorted index. See that
 * file's header for why it is implemented properly rather than stubbed.
 *
 * ## The friends board is assembled, not stored
 *
 * There is no `friends` board in the store, because a stored one would need a
 * row per player per friendship and would have to be rewritten whenever anybody
 * added anybody. Instead the friend list is read, their existing all-time or
 * weekly entries are fetched by id, and the result is sorted. The player is
 * always included in their own friends board — a board you are not on is a board
 * you cannot locate yourself in.
 */

import { SERVER_CONFIG } from "./config";
import { sign, verifySigned } from "./crypto";
import { ok, refuse, Reason, type Result } from "./errors";
import { ALL_TIME_PERIOD, periodKeysFor } from "./period";
import { BoardScope, type BoardEntry, type BoardScopeValue, type Store } from "./store/types";

/** A page, plus where the player sits on this board. */
export interface LeaderboardView {
  readonly scope: BoardScopeValue;
  readonly period: string;
  readonly entries: readonly BoardEntry[];
  readonly nextCursor: string | null;
  readonly total: number;
  /** The caller's own rank, 1-based, or null if they have no entry. */
  readonly playerRank: number | null;
  /** The caller's own best entry on this board, or null. */
  readonly playerEntry: BoardEntry | null;
}

interface CursorPayload {
  readonly s: BoardScopeValue;
  readonly p: string;
  readonly o: number;
}

function encodeCursor(scope: BoardScopeValue, period: string, offset: number): string {
  return sign({ s: scope, p: period, o: offset } satisfies CursorPayload);
}

/**
 * Decodes a cursor, checking it belongs to the board being asked for.
 *
 * The scope/period check matters: without it a cursor issued for the daily board
 * could be replayed against the all-time board, which is not a security problem
 * but is a correctness one — the offset means something different there.
 */
function decodeCursor(cursor: string, scope: BoardScopeValue, period: string): number | null {
  const payload = verifySigned<unknown>(cursor);
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate["s"] !== scope ||
    candidate["p"] !== period ||
    typeof candidate["o"] !== "number" ||
    !Number.isInteger(candidate["o"]) ||
    candidate["o"] < 0
  ) {
    return null;
  }
  return candidate["o"];
}

/** Resolves the period key a scope is read at, for a given instant. */
export function periodFor(scope: BoardScopeValue, at: number): string {
  const keys = periodKeysFor(at);
  if (scope === BoardScope.Weekly) {
    return keys.weekKey;
  }
  if (scope === BoardScope.Daily) {
    return keys.dayKey;
  }
  return ALL_TIME_PERIOD;
}

export interface BoardQuery {
  readonly scope: BoardScopeValue;
  readonly playerId: string;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** Injected so tests can read a board at a chosen instant. */
  readonly now?: number | undefined;
}

/** Clamps a requested page size into the configured band. */
function pageSize(requested: number | undefined): number {
  const { defaultPageSize, maxPageSize } = SERVER_CONFIG.leaderboard;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return defaultPageSize;
  }
  return Math.min(maxPageSize, Math.trunc(requested));
}

/**
 * Reads one page of a board.
 *
 * The friends scope is assembled per request; every other scope is a stored
 * board read by offset.
 */
export async function readBoard(query: BoardQuery, store: Store): Promise<Result<LeaderboardView>> {
  const at = query.now ?? Date.now();
  const limit = pageSize(query.limit);

  if (query.scope === BoardScope.Friends) {
    return readFriendsBoard(query, store, at, limit);
  }

  const period = periodFor(query.scope, at);

  let offset = 0;
  if (query.cursor !== undefined && query.cursor !== "") {
    const decoded = decodeCursor(query.cursor, query.scope, period);
    if (decoded === null) {
      return refuse(Reason.BadRequest, "That page cursor is not valid.");
    }
    offset = decoded;
  }

  const page = await store.getBoardPage(query.scope, period, offset, limit);
  const nextOffset = offset + page.entries.length;

  const [playerRank, playerEntry] = await Promise.all([
    store.getPlayerRank(query.scope, period, query.playerId),
    store.getPlayerBest(query.scope, period, query.playerId),
  ]);

  return ok({
    scope: query.scope,
    period,
    entries: page.entries,
    nextCursor: nextOffset < page.total ? encodeCursor(query.scope, period, nextOffset) : null,
    total: page.total,
    playerRank,
    playerEntry,
  });
}

/**
 * The friends board.
 *
 * Built from the all-time board, because a friends board scoped to today is
 * usually empty and an empty board is not a comparison. The player is always
 * included: a leaderboard you are absent from cannot answer the only question
 * anyone asks it.
 *
 * Paged in memory rather than in the store, which is correct at friend-list
 * scale — a few hundred at the very most — and would not be at board scale.
 */
async function readFriendsBoard(
  query: BoardQuery,
  store: Store,
  at: number,
  limit: number,
): Promise<Result<LeaderboardView>> {
  const period = ALL_TIME_PERIOD;

  let offset = 0;
  if (query.cursor !== undefined && query.cursor !== "") {
    const decoded = decodeCursor(query.cursor, BoardScope.Friends, period);
    if (decoded === null) {
      return refuse(Reason.BadRequest, "That page cursor is not valid.");
    }
    offset = decoded;
  }

  const friends = await store.listFriends(query.playerId);
  const ids = Array.from(new Set([query.playerId, ...friends]));
  const all = await store.getEntriesForPlayers(BoardScope.AllTime, period, ids);

  const entries = all.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  const rankIndex = all.findIndex((entry) => entry.playerId === query.playerId);

  return ok({
    scope: BoardScope.Friends,
    period,
    entries,
    nextCursor:
      nextOffset < all.length ? encodeCursor(BoardScope.Friends, period, nextOffset) : null,
    total: all.length,
    // A scan is correct here and nowhere else: this list is the caller's friends,
    // bounded by how many people one person knows, not by how many people play.
    playerRank: rankIndex === -1 ? null : rankIndex + 1,
    playerEntry: all[rankIndex] ?? null,
  });
}

/** Just the caller's standing, on every board at once. */
export interface RankSummary {
  readonly allTime: number | null;
  readonly weekly: number | null;
  readonly daily: number | null;
}

/**
 * The caller's rank on all three stored boards.
 *
 * Three indexed lookups, no pages fetched. This is what the death screen and the
 * profile read, and it is deliberately a separate endpoint from `readBoard` so
 * that showing a player their own rank never costs a page of somebody else's.
 */
export async function readRanks(
  playerId: string,
  store: Store,
  now: number = Date.now(),
): Promise<RankSummary> {
  const keys = periodKeysFor(now);
  const [allTime, weekly, daily] = await Promise.all([
    store.getPlayerRank(BoardScope.AllTime, ALL_TIME_PERIOD, playerId),
    store.getPlayerRank(BoardScope.Weekly, keys.weekKey, playerId),
    store.getPlayerRank(BoardScope.Daily, keys.dayKey, playerId),
  ]);
  return { allTime, weekly, daily };
}

/** Parses a scope from a query string, defaulting to all-time. */
export function parseScope(raw: string | null): BoardScopeValue | null {
  if (raw === null || raw === "") {
    return BoardScope.AllTime;
  }
  const known: readonly BoardScopeValue[] = [
    BoardScope.AllTime,
    BoardScope.Weekly,
    BoardScope.Daily,
    BoardScope.Friends,
  ];
  return known.find((scope) => scope === raw) ?? null;
}
