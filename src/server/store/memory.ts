/**
 * The in-memory store. What the tests and the load test run against.
 *
 * ## It is not a stub
 *
 * The rank lookup is the reason. `getPlayerRank` could trivially be
 * `entries.findIndex(...)` here and every test would pass — and then the
 * Postgres adapter would be written to the same shape and the production board
 * would scan a million rows to answer one request. So this adapter maintains a
 * **descending sorted array with binary-searched insertion**, and rank is the
 * insertion index. It is O(log n) to find and O(n) to splice, which for the
 * bounded board sizes here is genuinely fast, and — more importantly — it means
 * the interface was designed against a real implementation of the hard operation
 * rather than around it.
 *
 * ## Ordering is total, and that matters
 *
 * Two runs with the same score must rank in a stable, defensible order or
 * pagination breaks: an unstable comparator lets the same entry appear on page 1
 * and page 2, or vanish from both. Ties break on `submittedAt` ascending — the
 * player who got there first is ahead — and then on `runId`, which is unique, so
 * the order is total.
 *
 * ## One entry per player per board
 *
 * A board is "best run", not "every run". Submitting a worse score leaves the
 * board untouched; submitting a better one replaces the existing row rather than
 * adding a second. Without this the top ten is one person's ten best runs, which
 * is technically a leaderboard and useless as one.
 */

import { SERVER_CONFIG } from "../config";
import { randomId } from "../crypto";
import {
  type BoardEntry,
  type BoardScopeValue,
  type CloudSave,
  type PlayerRecord,
  type RunRecord,
  type Store,
  type TelemetryEvent,
} from "./types";

/** Descending by score; ties to the earlier submission, then to a stable id. */
function compareEntries(a: BoardEntry, b: BoardEntry): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.submittedAt !== b.submittedAt) {
    return a.submittedAt - b.submittedAt;
  }
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/** Index of the first entry that does NOT sort before `entry`. */
function lowerBound(list: readonly BoardEntry[], entry: BoardEntry): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const at = list[mid];
    if (at !== undefined && compareEntries(at, entry) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

interface Board {
  /** Sorted descending. The index IS the rank. */
  readonly sorted: BoardEntry[];
  /** playerId -> their single entry, so a replace can find the old one. */
  readonly byPlayer: Map<string, BoardEntry>;
}

function createBoard(): Board {
  return { sorted: [], byPlayer: new Map() };
}

export function createMemoryStore(): Store {
  const players = new Map<string, PlayerRecord>();
  const byFriendCode = new Map<string, string>();
  const byAccount = new Map<string, string>();
  const friends = new Map<string, Set<string>>();
  const runs = new Map<string, RunRecord>();
  const boards = new Map<string, Board>();
  const nonces = new Map<string, number>();
  const saves = new Map<string, CloudSave>();
  const telemetry = new Map<string, TelemetryEvent[]>();

  function boardKey(scope: BoardScopeValue, period: string): string {
    return `${scope}:${period}`;
  }

  function board(scope: BoardScopeValue, period: string): Board {
    const key = boardKey(scope, period);
    let existing = boards.get(key);
    if (existing === undefined) {
      existing = createBoard();
      boards.set(key, existing);
    }
    return existing;
  }

  /** Inserts or upgrades a player's entry. Keeps the board sorted. */
  function place(scope: BoardScopeValue, period: string, entry: BoardEntry): void {
    const target = board(scope, period);
    const previous = target.byPlayer.get(entry.playerId);

    if (previous !== undefined) {
      // A board holds a player's BEST run, so a worse score is simply ignored.
      if (compareEntries(previous, entry) <= 0) {
        return;
      }
      const at = lowerBound(target.sorted, previous);
      // `lowerBound` finds where an equal entry would go; scan forward for the
      // identical one. Equal-comparing entries are impossible here (runId breaks
      // every tie) but the scan costs nothing and is obviously correct.
      for (let i = at; i < target.sorted.length; i += 1) {
        if (target.sorted[i]?.runId === previous.runId) {
          target.sorted.splice(i, 1);
          break;
        }
      }
    }

    target.sorted.splice(lowerBound(target.sorted, entry), 0, entry);
    target.byPlayer.set(entry.playerId, entry);

    // Prune the tail. A board that grows forever is a memory leak with a
    // leaderboard attached, and nobody is reading row 10,001.
    const max = SERVER_CONFIG.leaderboard.maxEntriesPerBoard;
    while (target.sorted.length > max) {
      const dropped = target.sorted.pop();
      if (dropped !== undefined) {
        target.byPlayer.delete(dropped.playerId);
      }
    }
  }

  return {
    async createPlayer(displayName: string): Promise<PlayerRecord> {
      const FRIEND_CODE_BYTES = 4;
      let friendCode = randomId(FRIEND_CODE_BYTES).toUpperCase();
      while (byFriendCode.has(friendCode)) {
        friendCode = randomId(FRIEND_CODE_BYTES).toUpperCase();
      }

      const record: PlayerRecord = {
        playerId: randomId(),
        displayName,
        friendCode,
        createdAt: Date.now(),
        accountId: null,
        shards: 0,
        telemetryConsent: false,
      };
      players.set(record.playerId, record);
      byFriendCode.set(friendCode, record.playerId);
      return record;
    },

    async getPlayer(playerId: string): Promise<PlayerRecord | null> {
      return players.get(playerId) ?? null;
    },

    async getPlayerByFriendCode(code: string): Promise<PlayerRecord | null> {
      const id = byFriendCode.get(code.toUpperCase());
      return id === undefined ? null : (players.get(id) ?? null);
    },

    async updatePlayer(
      playerId: string,
      patch: Partial<Omit<PlayerRecord, "playerId">>,
    ): Promise<void> {
      const existing = players.get(playerId);
      if (existing === undefined) {
        return;
      }
      players.set(playerId, { ...existing, ...patch });
    },

    async linkAccount(playerId: string, accountId: string): Promise<boolean> {
      const taken = byAccount.get(accountId);
      // Already linked to this same player: idempotent, not a failure. A client
      // retrying an upgrade whose response was lost must not be told no.
      if (taken !== undefined) {
        return taken === playerId;
      }
      const existing = players.get(playerId);
      if (existing === undefined) {
        return false;
      }
      players.set(playerId, { ...existing, accountId });
      byAccount.set(accountId, playerId);
      return true;
    },

    async getPlayerByAccount(accountId: string): Promise<PlayerRecord | null> {
      const id = byAccount.get(accountId);
      return id === undefined ? null : (players.get(id) ?? null);
    },

    async addFriend(playerId: string, friendId: string): Promise<void> {
      // Mutual by design. A one-way friend list means two players comparing
      // scores see different boards, which reads as a bug every time.
      for (const [a, b] of [
        [playerId, friendId],
        [friendId, playerId],
      ] as const) {
        let set = friends.get(a);
        if (set === undefined) {
          set = new Set();
          friends.set(a, set);
        }
        set.add(b);
      }
    },

    async listFriends(playerId: string): Promise<readonly string[]> {
      return Array.from(friends.get(playerId) ?? []);
    },

    async recordRun(run: RunRecord): Promise<void> {
      if (runs.has(run.runId)) {
        return;
      }
      runs.set(run.runId, run);

      const player = players.get(run.playerId);
      const entry: BoardEntry = {
        playerId: run.playerId,
        displayName: player?.displayName ?? "Runner",
        score: run.score,
        distance: run.distance,
        runId: run.runId,
        submittedAt: run.submittedAt,
      };

      place("all-time", "all", entry);
      place("weekly", run.weekKey, entry);
      place("daily", run.dayKey, entry);
    },

    async getPlayerBest(
      scope: BoardScopeValue,
      period: string,
      playerId: string,
    ): Promise<BoardEntry | null> {
      return board(scope, period).byPlayer.get(playerId) ?? null;
    },

    async getBoardPage(
      scope: BoardScopeValue,
      period: string,
      offset: number,
      limit: number,
    ): Promise<{ entries: readonly BoardEntry[]; total: number }> {
      const target = board(scope, period);
      return {
        entries: target.sorted.slice(offset, offset + limit),
        total: target.sorted.length,
      };
    },

    async getPlayerRank(
      scope: BoardScopeValue,
      period: string,
      playerId: string,
    ): Promise<number | null> {
      const target = board(scope, period);
      const entry = target.byPlayer.get(playerId);
      if (entry === undefined) {
        return null;
      }
      // Binary search, not a scan. See the header — this is the operation the
      // whole interface exists to keep honest.
      return lowerBound(target.sorted, entry) + 1;
    },

    async getEntriesForPlayers(
      scope: BoardScopeValue,
      period: string,
      playerIds: readonly string[],
    ): Promise<readonly BoardEntry[]> {
      const target = board(scope, period);
      const found: BoardEntry[] = [];
      for (const id of playerIds) {
        const entry = target.byPlayer.get(id);
        if (entry !== undefined) {
          found.push(entry);
        }
      }
      return found.sort(compareEntries);
    },

    async consumeNonce(nonce: string, expiresAt: number): Promise<boolean> {
      const now = Date.now();
      // Opportunistic sweep. Cheap, bounded by how many nonces exist, and it
      // keeps the map from growing without a background timer to leak.
      for (const [key, expiry] of nonces) {
        if (expiry <= now) {
          nonces.delete(key);
        }
      }
      if (nonces.has(nonce)) {
        return false;
      }
      nonces.set(nonce, expiresAt);
      return true;
    },

    async getSave(playerId: string): Promise<CloudSave | null> {
      return saves.get(playerId) ?? null;
    },

    async putSave(playerId: string, save: CloudSave): Promise<void> {
      saves.set(playerId, save);
    },

    async appendTelemetry(playerId: string, events: readonly TelemetryEvent[]): Promise<void> {
      let list = telemetry.get(playerId);
      if (list === undefined) {
        list = [];
        telemetry.set(playerId, list);
      }
      list.push(...events);
      const max = SERVER_CONFIG.telemetry.maxEventsPerSession;
      if (list.length > max) {
        list.splice(0, list.length - max);
      }
    },

    async readTelemetry(playerId: string): Promise<readonly TelemetryEvent[]> {
      return telemetry.get(playerId) ?? [];
    },

    async reset(): Promise<void> {
      players.clear();
      byFriendCode.clear();
      byAccount.clear();
      friends.clear();
      runs.clear();
      boards.clear();
      nonces.clear();
      saves.clear();
      telemetry.clear();
    },
  };
}
