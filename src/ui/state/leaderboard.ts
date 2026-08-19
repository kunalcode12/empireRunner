/**
 * The leaderboard's data source.
 *
 * ## Why this is an interface with a local stub
 *
 * P12 has not been built. It owns the API routes, the submit/read endpoints and —
 * the part that matters — **server-side replay re-simulation**, which is the only
 * leaderboard anti-cheat that works and the reason law (a) exists at all.
 *
 * The screen still has to be designed and built now, so it is built against a
 * contract instead of against fake data scattered through a component. This is
 * the same move P13 made with `EconomyBackend`, for the same reason: when the
 * real implementation lands it is one assignment, not a rewrite of a screen.
 *
 * Every method returns a promise even though the local one is synchronous. An
 * interface only a synchronous implementation can satisfy is a comment, not an
 * abstraction — if a caller writes `source.top().length` today, the swap this
 * exists for is impossible tomorrow.
 *
 * ## The stub is labelled everywhere it surfaces
 *
 * `LeaderboardScreen` renders a visible "local scores only" notice when
 * `source.isRemote` is false. A screen that shows six invented names and calls
 * them a leaderboard is a lie to the player, and the person most likely to be
 * fooled by it is the next developer.
 */

export interface LeaderboardEntry {
  readonly rank: number;
  readonly name: string;
  readonly score: number;
  readonly distance: number;
  /** ms since epoch. */
  readonly at: number;
  /** True for the viewing player's own row. */
  readonly isSelf: boolean;
  /**
   * Whether the server re-simulated this replay and agreed with the score.
   * Always false locally — nothing has verified anything.
   */
  readonly verified: boolean;
}

export type LeaderboardScope = "global" | "weekly";

export interface LeaderboardSource {
  /** False for the local stub. The screen says so on the player's behalf. */
  readonly isRemote: boolean;
  top(scope: LeaderboardScope, limit: number): Promise<readonly LeaderboardEntry[]>;
  /** Submits a finished run. Returns the entry as accepted, or null if refused. */
  submit(score: number, distance: number, replay?: Uint8Array): Promise<LeaderboardEntry | null>;
}

interface LocalRow {
  score: number;
  distance: number;
  at: number;
}

const STORAGE_KEY = "axis.leaderboard.local.v1";
const MAX_ROWS = 50;

function readRows(): LocalRow[] {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Coerced rather than trusted. Same principle as `meta/save.ts`: a corrupt
    // local file must degrade to an empty board, never to a thrown exception on
    // a screen the player opened out of curiosity.
    const rows: LocalRow[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const score = typeof record["score"] === "number" ? record["score"] : 0;
      const distance = typeof record["distance"] === "number" ? record["distance"] : 0;
      const at = typeof record["at"] === "number" ? record["at"] : 0;
      if (Number.isFinite(score) && score > 0) {
        rows.push({ score, distance, at });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function writeRows(rows: readonly LocalRow[]): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX_ROWS)));
  } catch {
    // A full or blocked storage must not break the death screen. Losing a local
    // leaderboard row is the smallest possible failure here.
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The stub. Real scores, this device only, honest about being that. */
export function createLocalLeaderboard(now: () => number = Date.now): LeaderboardSource {
  return {
    isRemote: false,

    async top(scope: LeaderboardScope, limit: number): Promise<readonly LeaderboardEntry[]> {
      const cutoff = scope === "weekly" ? now() - WEEK_MS : 0;
      const rows = readRows()
        .filter((row) => row.at >= cutoff)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return rows.map((row, index) => ({
        rank: index + 1,
        name: "YOU",
        score: row.score,
        distance: row.distance,
        at: row.at,
        isSelf: true,
        verified: false,
      }));
    },

    async submit(score: number, distance: number): Promise<LeaderboardEntry | null> {
      if (!Number.isFinite(score) || score <= 0) {
        return null;
      }
      const rows = readRows();
      rows.push({ score, distance, at: now() });
      rows.sort((a, b) => b.score - a.score);
      writeRows(rows);
      const rank = rows.findIndex((row) => row.score === score) + 1;
      return {
        rank: rank > 0 ? rank : rows.length,
        name: "YOU",
        score,
        distance,
        at: now(),
        isSelf: true,
        verified: false,
      };
    },
  };
}
