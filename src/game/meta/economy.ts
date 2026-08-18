/**
 * Bits and Shards, as an append-only transaction ledger.
 *
 * ## Balances are never assigned. They are folded.
 *
 * There is no `setBits`. Every currency change is a `Transaction` appended to a
 * ledger, and the balance is the fold of that ledger. The reason is that a
 * balance which can be assigned is a balance nobody can explain: when a player
 * writes in saying their Bits vanished, "the number is 400" is not an answer,
 * and neither is a stack trace. A ledger answers it — every Bit is attributable
 * to the run that earned it or the purchase that spent it.
 *
 * It is also the only structure that makes the remote backend in `backend.ts`
 * viable. Two devices syncing balances have a conflict with no correct
 * resolution; two devices syncing *transactions* have a merge.
 *
 * ## The union is exhaustive on purpose
 *
 * Every source and sink in GAME_BIBLE §8.1 is its own variant carrying its own
 * evidence — a Bit award names the run that produced it, an upgrade purchase
 * names the track and tier. `applyTransaction` switches on the tag with no
 * default branch, so adding a source to the design and forgetting to handle it
 * is a **compile error**, not a silent zero.
 *
 * ## Overdrafts are refused, never clamped
 *
 * `spend` returns a typed result. It does not throw, and it never clamps a
 * balance to zero — a clamp turns "you cannot afford this" into "you can afford
 * this and it cost you everything", which is the worst possible failure mode for
 * a currency the player has spent fifty runs accumulating.
 */

import { TUNING } from "@/game/config/tuning";

/** The two currencies. Shards are never spendable on upgrades — GAME_BIBLE §8.1. */
export const Currency = {
  Bits: "bits",
  Shards: "shards",
} as const;
export type CurrencyName = (typeof Currency)[keyof typeof Currency];

export interface Balances {
  readonly bits: number;
  readonly shards: number;
}

export const ZERO_BALANCES: Balances = Object.freeze({ bits: 0, shards: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// Transactions — every source and sink in GAME_BIBLE §8.1
// ─────────────────────────────────────────────────────────────────────────────

/** Bits earned by finishing a run. GAME_BIBLE §8.1's `bitsEarned` formula. */
export interface RunRewardTransaction {
  kind: "run-reward";
  /** Bits from pickups, after `bitValueMult` and the boost multiplier. */
  fromPickups: number;
  /** Bits from `floor(distance / bitsPerMetreDivisor)`. */
  fromDistance: number;
  /** Shards picked up in the run. */
  shards: number;
  /** The run's seed, tying this award to a specific run. */
  seed: number;
}

/** Shards for completing all three dailies. */
export interface DailyCompleteTransaction {
  kind: "daily-complete";
  /** The UTC day key the dailies belonged to. */
  day: string;
  shards: number;
}

/** Shards for a weekly contract tier. */
export interface WeeklyTierTransaction {
  kind: "weekly-tier";
  week: string;
  /** 1..3. */
  tier: number;
  shards: number;
}

/** A Shard for a first-time avatar challenge. */
export interface AvatarChallengeTransaction {
  kind: "avatar-challenge";
  avatarId: string;
  shards: number;
}

/** Real-money purchase. Available, never required — GAME_BIBLE §8.1. */
export interface PurchaseTransaction {
  kind: "purchase";
  bits: number;
  shards: number;
  /** Opaque receipt id from whatever store sold it. */
  receipt: string;
}

/** Shards spent on a Fracture. 1 for the first in a run, 2 for the second. */
export interface FractureTransaction {
  kind: "fracture";
  /** 1-based index of the Fracture within its run. */
  index: number;
  shards: number;
  seed: number;
}

/** Bits spent on an upgrade tier. */
export interface UpgradeTransaction {
  kind: "upgrade";
  track: string;
  /** The tier bought, 1..5. */
  tier: number;
  bits: number;
}

/** Bits spent on a consumable boost. */
export interface BoostPurchaseTransaction {
  kind: "boost";
  boostId: string;
  quantity: number;
  bits: number;
}

/** Shards spent unlocking a premium avatar. */
export interface AvatarUnlockTransaction {
  kind: "avatar-unlock";
  avatarId: string;
  bits: number;
  shards: number;
}

/** Shards spent on a premium cosmetic. */
export interface CosmeticTransaction {
  kind: "cosmetic";
  cosmeticId: string;
  shards: number;
}

/**
 * The opening balance a migrated save starts from.
 *
 * Exists so a save written before the ledger — schema v1, which stored plain
 * numbers — can be brought forward without inventing a history it never had.
 * See `save.ts`.
 */
export interface OpeningBalanceTransaction {
  kind: "opening-balance";
  bits: number;
  shards: number;
  /** The schema version the balance was carried forward from. */
  fromVersion: number;
}

export type Transaction =
  | RunRewardTransaction
  | DailyCompleteTransaction
  | WeeklyTierTransaction
  | AvatarChallengeTransaction
  | PurchaseTransaction
  | FractureTransaction
  | UpgradeTransaction
  | BoostPurchaseTransaction
  | AvatarUnlockTransaction
  | CosmeticTransaction
  | OpeningBalanceTransaction;

/** A ledger entry: the transaction plus when it happened and its sequence. */
export interface LedgerEntry {
  /** Monotonic within a save. Ordering is by this, never by timestamp. */
  readonly sequence: number;
  /** ms since epoch. Diagnostic only — clocks lie, sequence does not. */
  readonly at: number;
  readonly transaction: Transaction;
}

export interface Ledger {
  readonly entries: readonly LedgerEntry[];
  readonly nextSequence: number;
}

export const EMPTY_LEDGER: Ledger = Object.freeze({
  entries: Object.freeze([]),
  nextSequence: 0,
});

/**
 * The signed effect of one transaction on each currency.
 *
 * Exhaustive with no `default`. The `never` assignment at the end is what makes
 * a forgotten variant fail at compile time instead of silently contributing
 * zero — which would be a currency source that quietly does nothing, the kind of
 * bug that is only ever found by a player counting.
 */
export function transactionDelta(transaction: Transaction): Balances {
  switch (transaction.kind) {
    case "run-reward":
      return {
        bits: transaction.fromPickups + transaction.fromDistance,
        shards: transaction.shards,
      };
    case "daily-complete":
      return { bits: 0, shards: transaction.shards };
    case "weekly-tier":
      return { bits: 0, shards: transaction.shards };
    case "avatar-challenge":
      return { bits: 0, shards: transaction.shards };
    case "purchase":
      return { bits: transaction.bits, shards: transaction.shards };
    case "opening-balance":
      return { bits: transaction.bits, shards: transaction.shards };
    case "fracture":
      return { bits: 0, shards: -transaction.shards };
    case "upgrade":
      return { bits: -transaction.bits, shards: 0 };
    case "boost":
      return { bits: -transaction.bits, shards: 0 };
    case "avatar-unlock":
      return { bits: -transaction.bits, shards: -transaction.shards };
    case "cosmetic":
      return { bits: 0, shards: -transaction.shards };
    default: {
      const exhaustive: never = transaction;
      return exhaustive;
    }
  }
}

/** Folds a ledger into balances. The only way a balance is ever produced. */
export function foldLedger(ledger: Ledger): Balances {
  let bits = 0;
  let shards = 0;
  for (const entry of ledger.entries) {
    const delta = transactionDelta(entry.transaction);
    bits += delta.bits;
    shards += delta.shards;
  }
  return Object.freeze({ bits, shards });
}

/** Why a transaction was refused. */
export const LedgerRejection = {
  None: "none",
  InsufficientBits: "insufficient-bits",
  InsufficientShards: "insufficient-shards",
  NotFinite: "not-finite",
} as const;
export type LedgerRejectionValue = (typeof LedgerRejection)[keyof typeof LedgerRejection];

export interface AppendResult {
  readonly ok: boolean;
  readonly ledger: Ledger;
  readonly balances: Balances;
  readonly rejection: LedgerRejectionValue;
}

/**
 * Appends a transaction if the balances can bear it.
 *
 * Returns a new ledger; never mutates. On refusal the ledger comes back
 * unchanged and `rejection` says why — the caller decides whether that is an
 * error, a disabled button, or a "not enough Bits" toast.
 */
export function appendTransaction(
  ledger: Ledger,
  transaction: Transaction,
  at: number = Date.now(),
): AppendResult {
  const before = foldLedger(ledger);
  const delta = transactionDelta(transaction);

  if (!Number.isFinite(delta.bits) || !Number.isFinite(delta.shards)) {
    return {
      ok: false,
      ledger,
      balances: before,
      rejection: LedgerRejection.NotFinite,
    };
  }

  const bits = before.bits + delta.bits;
  const shards = before.shards + delta.shards;

  if (bits < 0) {
    return { ok: false, ledger, balances: before, rejection: LedgerRejection.InsufficientBits };
  }
  if (shards < 0) {
    return { ok: false, ledger, balances: before, rejection: LedgerRejection.InsufficientShards };
  }

  const entry: LedgerEntry = Object.freeze({
    sequence: ledger.nextSequence,
    at,
    transaction,
  });

  return {
    ok: true,
    ledger: Object.freeze({
      entries: Object.freeze([...ledger.entries, entry]),
      nextSequence: ledger.nextSequence + 1,
    }),
    balances: Object.freeze({ bits, shards }),
    rejection: LedgerRejection.None,
  };
}

/**
 * Bits earned by a run. GAME_BIBLE §8.1.
 *
 * ```
 *   bitsEarned = floor(bitsCollected * bitValueMult * boostMultiplier)
 *              + floor(distanceMetres / 50)
 * ```
 *
 * The two floors are separate and that is not incidental: flooring the sum
 * instead would quietly pay a different number, and the worked example in §8.1
 * (310 Bits at tier 3 with 2x → 962, plus 2400/50 → 48, total 1,010) only comes
 * out right this way.
 */
export function bitsEarned(
  bitsCollected: number,
  distanceMetres: number,
  bitValueMultiplier: number,
  boostMultiplier: number,
): { fromPickups: number; fromDistance: number; total: number } {
  const fromPickups = Math.floor(bitsCollected * bitValueMultiplier * boostMultiplier);
  const fromDistance = Math.floor(distanceMetres / TUNING.scoring.bitsPerMetreDivisor);
  return { fromPickups, fromDistance, total: fromPickups + fromDistance };
}

/**
 * What a Fracture costs, by its index within the run. GAME_BIBLE §8.1.
 *
 * Past the table the cost is the last entry rather than free, so a future
 * `maxFracturesPerRun` increase cannot accidentally make extra Fractures cost
 * nothing.
 */
export function fractureShardCost(index: number): number {
  const costs = TUNING.fracture.fractureShardCost;
  const clamped = Math.max(1, Math.min(index, costs.length));
  return costs[clamped - 1] ?? 0;
}

/** Whether a ledger's fold can afford a price. */
export function canAfford(balances: Balances, bits: number, shards: number): boolean {
  return balances.bits >= bits && balances.shards >= shards;
}
