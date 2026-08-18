import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  EMPTY_LEDGER,
  LedgerRejection,
  appendTransaction,
  bitsEarned,
  canAfford,
  foldLedger,
  fractureShardCost,
  transactionDelta,
  type Ledger,
  type Transaction,
} from "@/game/meta/economy";
import {
  createLocalEconomyBackend,
  createMemoryLedgerStore,
  createNullEconomyBackend,
} from "@/game/meta/backend";

/** Appends a run of transactions, asserting each one is accepted. */
function ledgerOf(...transactions: Transaction[]): Ledger {
  let ledger = EMPTY_LEDGER;
  transactions.forEach((transaction, index) => {
    const result = appendTransaction(ledger, transaction, index);
    expect(result.ok, `transaction ${index} (${transaction.kind}) was refused`).toBe(true);
    ledger = result.ledger;
  });
  return ledger;
}

const award = (bits: number, shards = 0): Transaction => ({
  kind: "run-reward",
  fromPickups: bits,
  fromDistance: 0,
  shards,
  seed: 1,
});

describe("the transaction ledger", () => {
  it("an empty ledger folds to zero", () => {
    expect(foldLedger(EMPTY_LEDGER)).toEqual({ bits: 0, shards: 0 });
  });

  it("balances are the fold, never a stored field", () => {
    const ledger = ledgerOf(award(500, 1), award(250), {
      kind: "upgrade",
      track: "bitValue",
      tier: 1,
      bits: 350,
    });
    expect(foldLedger(ledger)).toEqual({ bits: 400, shards: 1 });
  });

  it("every source adds and every sink subtracts", () => {
    const sources: Transaction[] = [
      award(100, 1),
      { kind: "daily-complete", day: "2026-08-19", shards: 1 },
      { kind: "weekly-tier", week: "2026-08-17", tier: 1, shards: 2 },
      { kind: "avatar-challenge", avatarId: "vane", shards: 1 },
      { kind: "purchase", bits: 1_000, shards: 5, receipt: "r1" },
      { kind: "opening-balance", bits: 50, shards: 0, fromVersion: 1 },
    ];
    for (const source of sources) {
      const delta = transactionDelta(source);
      expect(delta.bits + delta.shards, `${source.kind} did not add`).toBeGreaterThan(0);
    }

    const sinks: Transaction[] = [
      { kind: "fracture", index: 1, shards: 1, seed: 1 },
      { kind: "upgrade", track: "bitValue", tier: 1, bits: 350 },
      { kind: "boost", boostId: "headStart", quantity: 1, bits: 500 },
      { kind: "avatar-unlock", avatarId: "null", bits: 0, shards: 16 },
      { kind: "cosmetic", cosmeticId: "trail-ember", shards: 8 },
    ];
    for (const sink of sinks) {
      const delta = transactionDelta(sink);
      expect(delta.bits + delta.shards, `${sink.kind} did not subtract`).toBeLessThan(0);
    }
  });

  it("assigns monotonic sequences and never reuses one", () => {
    const ledger = ledgerOf(award(10), award(20), award(30));
    expect(ledger.entries.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(ledger.nextSequence).toBe(3);
  });

  it("never mutates the ledger it was given", () => {
    const before = ledgerOf(award(100));
    const after = appendTransaction(before, award(50), 0);
    expect(before.entries.length).toBe(1);
    expect(after.ledger.entries.length).toBe(2);
  });
});

describe("overdrafts", () => {
  /**
   * A clamp would turn "you cannot afford this" into "you can afford this and
   * it cost you everything", which is the worst possible failure for a currency
   * fifty runs went into.
   */
  it("refuses a Bit overdraft and leaves the balance untouched", () => {
    const ledger = ledgerOf(award(100));
    const result = appendTransaction(
      ledger,
      { kind: "upgrade", track: "bitValue", tier: 1, bits: 350 },
      0,
    );

    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(LedgerRejection.InsufficientBits);
    expect(result.balances).toEqual({ bits: 100, shards: 0 });
    expect(result.ledger).toBe(ledger);
  });

  it("refuses a Shard overdraft", () => {
    const result = appendTransaction(
      EMPTY_LEDGER,
      { kind: "fracture", index: 1, shards: 1, seed: 1 },
      0,
    );
    expect(result.rejection).toBe(LedgerRejection.InsufficientShards);
  });

  it("allows spending down to exactly zero", () => {
    const ledger = ledgerOf(award(350), {
      kind: "upgrade",
      track: "bitValue",
      tier: 1,
      bits: 350,
    });
    expect(foldLedger(ledger).bits).toBe(0);
  });

  it("refuses a non-finite amount rather than poisoning the balance", () => {
    const result = appendTransaction(EMPTY_LEDGER, award(Number.NaN), 0);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(LedgerRejection.NotFinite);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendTransaction(EMPTY_LEDGER, award(-999_999), 0)).not.toThrow();
  });
});

describe("bitsEarned — GAME_BIBLE §8.1", () => {
  /**
   * The worked example from §8.1, reproduced exactly. If this drifts, the
   * document and the game disagree about what a run pays.
   */
  it("reproduces the documented worked example", () => {
    // 310 Bits at tier 3 (+55.3%) with the 2x boost, over 2,400m.
    const earned = bitsEarned(310, 2_400, 1.553, 2);
    expect(earned.fromPickups).toBe(962);
    expect(earned.fromDistance).toBe(48);
    expect(earned.total).toBe(1_010);
  });

  /**
   * The two floors are separate. Flooring the sum instead would pay a different
   * number, and the example above is what pins it.
   */
  it("floors the two halves independently", () => {
    const earned = bitsEarned(1, 99, 1.5, 1);
    // 1 * 1.5 = 1.5 -> 1, and 99/50 = 1.98 -> 1. Flooring the sum would give 3.
    expect(earned.fromPickups).toBe(1);
    expect(earned.fromDistance).toBe(1);
    expect(earned.total).toBe(2);
  });

  it("pays distance Bits on the documented divisor", () => {
    expect(bitsEarned(0, TUNING.scoring.bitsPerMetreDivisor * 7, 1, 1).fromDistance).toBe(7);
  });

  it("pays nothing for an empty run", () => {
    expect(bitsEarned(0, 0, 1, 1).total).toBe(0);
  });
});

describe("Fracture pricing", () => {
  it("costs 1 then 2 Shards, per GAME_BIBLE §8.1", () => {
    expect(fractureShardCost(1)).toBe(1);
    expect(fractureShardCost(2)).toBe(2);
  });

  /** Never free: a future maxFracturesPerRun rise must not create free retries. */
  it("holds at the last price past the end of the table", () => {
    expect(fractureShardCost(3)).toBe(2);
    expect(fractureShardCost(99)).toBe(2);
  });

  it("treats a zeroth Fracture as the first", () => {
    expect(fractureShardCost(0)).toBe(1);
  });
});

describe("canAfford", () => {
  it("requires both currencies", () => {
    const balances = { bits: 100, shards: 1 };
    expect(canAfford(balances, 100, 1)).toBe(true);
    expect(canAfford(balances, 101, 1)).toBe(false);
    expect(canAfford(balances, 100, 2)).toBe(false);
  });
});

describe("the local EconomyBackend", () => {
  it("folds committed transactions into balances", async () => {
    const backend = createLocalEconomyBackend({ now: () => 0 });
    await backend.commit(award(500, 2));
    expect(await backend.getBalances()).toEqual({ bits: 500, shards: 2 });
  });

  it("reports a refusal instead of throwing", async () => {
    const backend = createLocalEconomyBackend({ now: () => 0 });
    const result = await backend.commit({
      kind: "upgrade",
      track: "bitValue",
      tier: 1,
      bits: 350,
    });
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(LedgerRejection.InsufficientBits);
    expect(await backend.getBalances()).toEqual({ bits: 0, shards: 0 });
  });

  it("does not write a refused transaction to the ledger", async () => {
    const store = createMemoryLedgerStore();
    const backend = createLocalEconomyBackend({ store, now: () => 0 });
    await backend.commit({ kind: "cosmetic", cosmeticId: "x", shards: 5 });
    expect((await backend.getLedger()).entries.length).toBe(0);
  });

  it("persists through its store", async () => {
    const store = createMemoryLedgerStore();
    const first = createLocalEconomyBackend({ store, now: () => 0 });
    await first.commit(award(1_000));

    const second = createLocalEconomyBackend({ store, now: () => 0 });
    expect(await second.getBalances()).toEqual({ bits: 1_000, shards: 0 });
  });

  it("flush resolves without doing damage", async () => {
    const backend = createLocalEconomyBackend({ now: () => 0 });
    await backend.commit(award(10));
    await expect(backend.flush()).resolves.toBeUndefined();
    expect(await backend.getBalances()).toEqual({ bits: 10, shards: 0 });
  });
});

describe("the null EconomyBackend", () => {
  it("refuses everything without throwing", async () => {
    const backend = createNullEconomyBackend();
    expect(await backend.getBalances()).toEqual({ bits: 0, shards: 0 });
    expect((await backend.commit(award(500))).ok).toBe(false);
    expect((await backend.getLedger()).entries.length).toBe(0);
    await expect(backend.flush()).resolves.toBeUndefined();
  });
});
