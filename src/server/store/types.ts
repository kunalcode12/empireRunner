/**
 * The storage port.
 *
 * Every persistent thing the server does goes through this interface, and no
 * module above it names a database. That is not architectural decoration — it is
 * the difference between "swap in Postgres" being an afternoon and being a
 * rewrite, and this project has to be able to run with no database at all
 * (`memory.ts`) so the test suite and the load test are honest and hermetic.
 *
 * ## Async everywhere, even where the adapter is synchronous
 *
 * `memory.ts` could return values directly. It returns promises, because the
 * moment one adapter is genuinely async every caller has to be too, and
 * retrofitting `await` through a call graph is exactly the kind of change that
 * silently reorders operations. Paying it up front costs nothing.
 *
 * ## What is deliberately NOT here
 *
 * Transactions. A real implementation of `recordRun` wants one — it writes a run
 * and four board entries — and this interface cannot express that. Rather than
 * invent a half-transaction abstraction that the memory adapter would fake, the
 * operations are shaped so each one is individually idempotent and ordered so a
 * crash between them leaves the run recorded but unranked, which is recoverable,
 * rather than ranked but unrecorded, which is not. A Postgres adapter should
 * wrap `recordRun` in a real transaction and is free to.
 */

/** Which board an entry belongs to. */
export const BoardScope = {
  AllTime: "all-time",
  Weekly: "weekly",
  Daily: "daily",
  /** Not a stored board. Assembled per-request from a player's friend list. */
  Friends: "friends",
} as const;
export type BoardScopeValue = (typeof BoardScope)[keyof typeof BoardScope];

/** A player, anonymous or upgraded. */
export interface PlayerRecord {
  readonly playerId: string;
  /** Chosen name, or a generated one. Never an email, never a real name. */
  displayName: string;
  /** Short shareable code others use to add this player as a friend. */
  readonly friendCode: string;
  /** ms epoch. */
  readonly createdAt: number;
  /**
   * Set once a player upgrades from anonymous to a real account.
   *
   * The `playerId` never changes when this happens. That is the whole point of
   * the upgrade path: a player who has already earned a leaderboard place keeps
   * it, so signing up is never a reset.
   */
  accountId: string | null;
  /** Shards the player holds. The server owns this; a run token quotes it. */
  shards: number;
  /** Whether the player agreed to anonymous telemetry. Defaults to false. */
  telemetryConsent: boolean;
}

/** One validated run. The score here is always the server's own. */
export interface RunRecord {
  readonly runId: string;
  readonly playerId: string;
  /** Server-computed. The client's claim is never stored anywhere. */
  readonly score: number;
  readonly distance: number;
  readonly seed: number;
  readonly tickCount: number;
  /** ms epoch, server clock. Never the client's. */
  readonly submittedAt: number;
  /** The board period keys this run counted toward, at submission time. */
  readonly dayKey: string;
  readonly weekKey: string;
}

/** A row on a board. */
export interface BoardEntry {
  readonly playerId: string;
  readonly displayName: string;
  readonly score: number;
  readonly distance: number;
  readonly runId: string;
  readonly submittedAt: number;
}

/** A page of board entries plus the cursor to continue from. */
export interface BoardPage {
  readonly entries: readonly BoardEntry[];
  /** Opaque and signed. `null` when there is nothing after this page. */
  readonly nextCursor: string | null;
  /** Total rows on this board, so a client can render "of 4,812". */
  readonly total: number;
}

/** The persisted half of a player's save. Mirrors `game/meta`'s shape loosely. */
export interface CloudSave {
  /** Save schema version, from `meta/save.ts`. */
  readonly version: number;
  /** ms epoch of the client's last local write. Used for last-write-wins. */
  readonly updatedAt: number;
  /**
   * Currencies. These are the fields the monotonic rule protects.
   *
   * Kept as a flat record rather than named fields so a new currency is a data
   * change; `save.ts` applies `max` across every key present in either side, so
   * a currency this server has never heard of is still never reduced.
   */
  readonly currencies: Readonly<Record<string, number>>;
  /** Everything else — upgrades, inventory, missions, lifetime stats. Opaque. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** One anonymous telemetry row. */
export interface TelemetryEvent {
  readonly kind: string;
  /** ms epoch, server clock. */
  readonly at: number;
  /** Bounded numeric fields. No strings, so no free-text PII can arrive. */
  readonly values: Readonly<Record<string, number>>;
}

/**
 * The port.
 *
 * Implementations must be safe to call concurrently. The memory adapter is
 * trivially so (single-threaded Node); a networked one must not assume
 * read-modify-write is atomic and should say how it achieves that.
 */
export interface Store {
  // ── Identity ──────────────────────────────────────────────────────────────
  createPlayer(displayName: string): Promise<PlayerRecord>;
  getPlayer(playerId: string): Promise<PlayerRecord | null>;
  getPlayerByFriendCode(code: string): Promise<PlayerRecord | null>;
  updatePlayer(playerId: string, patch: Partial<Omit<PlayerRecord, "playerId">>): Promise<void>;
  /** Links an anonymous player to an account. Fails if the account is taken. */
  linkAccount(playerId: string, accountId: string): Promise<boolean>;
  getPlayerByAccount(accountId: string): Promise<PlayerRecord | null>;

  // ── Friends ───────────────────────────────────────────────────────────────
  addFriend(playerId: string, friendId: string): Promise<void>;
  listFriends(playerId: string): Promise<readonly string[]>;

  // ── Runs and boards ───────────────────────────────────────────────────────
  /**
   * Records a validated run and updates every board it qualifies for.
   *
   * Idempotent on `runId`: a client that retries a submission whose response was
   * lost gets the same answer rather than a second board entry.
   */
  recordRun(run: RunRecord): Promise<void>;
  /** A player's best entry on a board, or null. Used for the rank lookup. */
  getPlayerBest(
    scope: BoardScopeValue,
    period: string,
    playerId: string,
  ): Promise<BoardEntry | null>;
  /** One page of a board, descending by score. */
  getBoardPage(
    scope: BoardScopeValue,
    period: string,
    offset: number,
    limit: number,
  ): Promise<{ entries: readonly BoardEntry[]; total: number }>;
  /**
   * A player's 1-based rank on a board, without scanning it.
   *
   * The memory adapter keeps a sorted index and binary-searches; a SQL adapter
   * should use a window function or a rank column. What must NOT happen is
   * pulling the board into memory to find one row — that is the operation that
   * works perfectly until the board has a million entries.
   */
  getPlayerRank(scope: BoardScopeValue, period: string, playerId: string): Promise<number | null>;
  /** Board entries for a specific set of players, for the friends board. */
  getEntriesForPlayers(
    scope: BoardScopeValue,
    period: string,
    playerIds: readonly string[],
  ): Promise<readonly BoardEntry[]>;

  // ── Single-use tokens ─────────────────────────────────────────────────────
  /**
   * Marks a nonce spent. Returns false if it already was.
   *
   * This is a test-and-set and must be atomic in any real adapter — a
   * check-then-write pair is a race an attacker can win by submitting the same
   * token twice simultaneously, which is trivially easy to do on purpose.
   */
  consumeNonce(nonce: string, expiresAt: number): Promise<boolean>;

  // ── Cloud save ────────────────────────────────────────────────────────────
  getSave(playerId: string): Promise<CloudSave | null>;
  putSave(playerId: string, save: CloudSave): Promise<void>;

  // ── Telemetry ─────────────────────────────────────────────────────────────
  appendTelemetry(playerId: string, events: readonly TelemetryEvent[]): Promise<void>;
  /** Diagnostics and balance export. Never exposed through a public route. */
  readTelemetry(playerId: string): Promise<readonly TelemetryEvent[]>;

  /** Drops everything. Tests only; a production adapter may throw. */
  reset(): Promise<void>;
}
