/**
 * Cloud save reconciliation. Item 5: "last-write-wins-plus-monotonic-currency —
 * never let a sync reduce a player's balance. Conflict resolution must be
 * tested, not assumed."
 *
 * ## The two rules do different jobs and the order matters
 *
 * **Last-write-wins** settles everything that is a *statement of preference*:
 * equipped avatar, selected boosts, settings, which missions were claimed. For
 * those, the newest write is the one the player most recently meant, and older
 * state is genuinely stale.
 *
 * **Monotonic maximum** governs everything that is a *count of what was earned*:
 * every currency, and lifetime statistics. For those, "newest" is not
 * "correct" — two devices both accumulate, and whichever syncs last would
 * otherwise erase the other's progress.
 *
 * Applying last-write-wins alone produces the single worst bug a game backend
 * can have. A player earns 8,000 Bits on their phone, opens the game on a tablet
 * that has been asleep for a week, and the tablet's stale save syncs up and
 * takes the Bits away. They are not recoverable, the player cannot prove they
 * existed, and they will never trust the game again. It is worth spending a rule
 * on.
 *
 * ## Why max and not sum
 *
 * Summing looks fairer and duplicates currency. Two devices each holding 5,000
 * Bits from the same earned 5,000 would sync to 10,000 — a player with two
 * devices prints money. `max` cannot create currency; its failure mode is that a
 * genuine concurrent spend on two devices is only counted once, in the player's
 * favour. That is the correct direction to be wrong in.
 *
 * ## Union over keys, not a fixed field list
 *
 * `reconcile` walks the union of currency keys from both sides. A currency added
 * in a later phase is protected on the day it is added, with no change here — and
 * more importantly, a currency this server has never heard of, arriving from a
 * newer client, is not silently dropped.
 */

import type { CloudSave } from "./store/types";

/** What a reconciliation did, so it can be asserted rather than assumed. */
export interface ReconcileReport {
  readonly merged: CloudSave;
  /** True when the incoming payload was newer and its fields were taken. */
  readonly tookRemotePayload: boolean;
  /** Currency keys where the stored value beat the incoming one. */
  readonly protectedCurrencies: readonly string[];
}

/** The greater of two numbers, treating anything non-finite as absent. */
function maxDefined(a: number | undefined, b: number | undefined): number {
  const left = Number.isFinite(a) ? (a as number) : 0;
  const right = Number.isFinite(b) ? (b as number) : 0;
  return Math.max(left, right);
}

/**
 * Merges an incoming save against the stored one.
 *
 * Pure. Given the same two saves it returns the same result, which is what makes
 * the conflict cases testable rather than a thing that happens in production and
 * is argued about afterwards.
 *
 * @param stored   what the server currently holds, or null for a first sync
 * @param incoming what the client just sent
 */
export function reconcile(stored: CloudSave | null, incoming: CloudSave): ReconcileReport {
  if (stored === null) {
    return {
      merged: incoming,
      tookRemotePayload: true,
      protectedCurrencies: [],
    };
  }

  // Last-write-wins for the opaque payload. `>=` rather than `>` so a client
  // re-sending an identical timestamp — a retry — settles on its own copy rather
  // than flapping between two equally-old versions.
  const incomingIsNewer = incoming.updatedAt >= stored.updatedAt;

  const currencies: Record<string, number> = {};
  const protectedCurrencies: string[] = [];

  const keys = new Set([...Object.keys(stored.currencies), ...Object.keys(incoming.currencies)]);
  for (const key of keys) {
    const mine = stored.currencies[key];
    const theirs = incoming.currencies[key];
    const winner = maxDefined(mine, theirs);
    currencies[key] = winner;

    // Recorded, not just applied. A silent protection is indistinguishable from
    // a bug when somebody asks why the numbers differ.
    if (
      Number.isFinite(mine) &&
      (mine as number) > (Number.isFinite(theirs) ? (theirs as number) : 0)
    ) {
      protectedCurrencies.push(key);
    }
  }

  return {
    merged: {
      // The higher schema version wins outright. A newer client's save must not
      // be downgraded into an older shape by an older one syncing after it.
      version: Math.max(stored.version, incoming.version),
      updatedAt: Math.max(stored.updatedAt, incoming.updatedAt),
      currencies,
      payload: incomingIsNewer ? incoming.payload : stored.payload,
    },
    tookRemotePayload: incomingIsNewer,
    protectedCurrencies,
  };
}

/** Fields a save must have to be accepted at all. */
export function isCloudSave(value: unknown): value is CloudSave {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["version"] !== "number" || typeof candidate["updatedAt"] !== "number") {
    return false;
  }
  const currencies = candidate["currencies"];
  if (typeof currencies !== "object" || currencies === null || Array.isArray(currencies)) {
    return false;
  }
  // Every currency must be a finite non-negative number. A NaN here would
  // propagate through `Math.max` and permanently poison a balance, and a
  // negative one is a debt this game has no concept of.
  for (const value of Object.values(currencies as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return false;
    }
  }
  const payload = candidate["payload"];
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}
