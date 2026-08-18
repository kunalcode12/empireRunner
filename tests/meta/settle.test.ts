import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createLocalEconomyBackend } from "@/game/meta/backend";
import { foldLedger } from "@/game/meta/economy";
import { Boost } from "@/game/meta/inventory";
import { emptyMissionProgress, weeklyContractFor } from "@/game/meta/missions";
import { ZERO_LIFETIME } from "@/game/meta/progression";
import { buildRunSummary, createRunRecorder, type RunSummary } from "@/game/meta/runSummary";
import { settleRun, totalBitMultiplier } from "@/game/meta/settle";
import { UpgradeTrack, ZERO_UPGRADES, withTier } from "@/game/meta/upgrades";

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

function runWith(overrides: Partial<RunSummary>): RunSummary {
  const base = buildRunSummary(createRunRecorder(), {
    distance: 0,
    score: 0,
    bestCombo: 0,
    band: 0,
    elapsedSeconds: 0,
    seed: 42,
    shieldsHeld: 0,
  });
  return Object.freeze({ ...base, ...overrides });
}

function inputFor(run: RunSummary, overrides: Partial<Parameters<typeof settleRun>[1]> = {}) {
  return {
    run,
    upgrades: ZERO_UPGRADES,
    avatarId: "ferro",
    boosts: [] as const,
    missions: emptyMissionProgress(AT),
    lifetime: ZERO_LIFETIME,
    avatarChallengesClaimed: [] as const,
    ownedAvatars: ["ferro"] as const,
    ...overrides,
  };
}

describe("settling a run", () => {
  it("pays Bits from pickups and distance", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(
      backend,
      inputFor(runWith({ bitsCollected: 310, distance: 2_400 })),
      AT,
    );

    expect(settlement.bitsFromPickups).toBe(310);
    expect(settlement.bitsFromDistance).toBe(48);
    expect(settlement.bitsAwarded).toBe(358);
    expect(settlement.balances.bits).toBe(358);
  });

  /** GAME_BIBLE §8.1's worked example, end to end through the real backend. */
  it("reproduces the §8.1 worked example with tier-3 Bit Value and the 2x boost", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(
      backend,
      inputFor(runWith({ bitsCollected: 310, distance: 2_400 }), {
        upgrades: withTier(ZERO_UPGRADES, UpgradeTrack.BitValue, 3),
        boosts: [Boost.DoubleBits],
      }),
      AT,
    );

    // 310 * 1.553 * 2 = 962.86 -> 962, plus 2400/50 = 48.
    expect(settlement.bitsFromPickups).toBe(962);
    expect(settlement.bitsFromDistance).toBe(48);
    expect(settlement.bitsAwarded).toBe(1_010);
  });

  it("keeps the boost multiplier separate from the Bit-value multiplier", () => {
    const multipliers = totalBitMultiplier(
      withTier(ZERO_UPGRADES, UpgradeTrack.BitValue, 3),
      "ochre",
      [Boost.DoubleBits],
    );
    // Upgrade and avatar combine into one Bit-value factor; the boost is its
    // own factor, because §8.1's formula applies it that way and the worked
    // example only reproduces if it stays separate.
    expect(multipliers.bitValue).toBeCloseTo(1.553 * 1.1, 3);
    expect(multipliers.boost).toBe(TUNING.economy.doubleBitsMultiplier);
  });

  it("credits Shards picked up in the run", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(backend, inputFor(runWith({ shardsCollected: 2 })), AT);
    expect(settlement.balances.shards).toBe(2);
  });

  /**
   * Fractures were incurred DURING the run, so they are charged before anything
   * is paid out. Paying first would let a player Fracture on a balance they did
   * not have at the moment they Fractured.
   */
  it("charges Fractures before paying the run reward", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    // Two Fractures cost 1 + 2 = 3 Shards; the run collected 3.
    const settlement = await settleRun(
      backend,
      inputFor(runWith({ fracturesUsed: 2, shardsCollected: 3, distance: 500 })),
      AT,
    );

    expect(settlement.shardsSpent).toBe(3);
    // Charged first, so both charges were refused against a zero balance.
    expect(settlement.shortfalls.length).toBe(2);
    expect(settlement.balances.shards).toBe(3);
  });

  it("charges Fractures successfully when the player already holds Shards", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    await backend.commit({ kind: "purchase", bits: 0, shards: 10, receipt: "test" });

    const settlement = await settleRun(
      backend,
      inputFor(runWith({ fracturesUsed: 2, distance: 500 })),
      AT,
    );
    expect(settlement.shortfalls).toEqual([]);
    expect(settlement.balances.shards).toBe(7);
  });

  /**
   * Refusing to settle the whole run because one charge did not fit would cost
   * the player everything they just earned — a far worse outcome than an
   * uncharged Shard.
   */
  it("still pays the run reward when a Fracture charge is refused", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(
      backend,
      inputFor(runWith({ fracturesUsed: 1, distance: 5_000, bitsCollected: 100 })),
      AT,
    );
    expect(settlement.shortfalls.length).toBe(1);
    expect(settlement.balances.bits).toBeGreaterThan(0);
    expect(settlement.lifetime.runs).toBe(1);
  });

  it("advances lifetime stats and reports new unlocks", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(
      backend,
      inputFor(runWith({ distance: 6_000, score: 30_000 }), {
        lifetime: { ...ZERO_LIFETIME, runs: 1 },
      }),
      AT,
    );

    expect(settlement.lifetime.runs).toBe(2);
    expect(settlement.lifetime.bestDistance).toBe(6_000);
    // 6,000m in one run unlocks the Static theme; the second run opens the store.
    expect(settlement.unlocked).toContain("theme.static");
    expect(settlement.unlocked).toContain("screen.store");
  });

  it("unlocks avatar challenges and pays a Shard for each, once", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const run = runWith({ rolls: 40, nearMisses: 60 });

    const first = await settleRun(backend, inputFor(run), AT);
    expect(first.avatarsUnlocked).toEqual(["vane", "quill"]);
    expect(first.avatarChallengesClaimed).toEqual(["vane", "quill"]);
    expect(first.balances.shards).toBe(2);

    // Same feat again: already owned, so nothing is unlocked and nothing is paid.
    const second = await settleRun(
      backend,
      inputFor(run, {
        ownedAvatars: ["ferro", "vane", "quill"],
        avatarChallengesClaimed: first.avatarChallengesClaimed,
      }),
      AT,
    );
    expect(second.avatarsUnlocked).toEqual([]);
    expect(second.balances.shards).toBe(2);
  });

  it("folds the run into mission progress", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(
      backend,
      inputFor(runWith({ distance: 2_500, bitsCollected: 400, nearMisses: 30 })),
      AT,
    );
    expect(Object.keys(settlement.missions.values).length).toBeGreaterThan(0);
  });

  it("pays weekly tiers individually so the ledger is reconcilable", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const contract = weeklyContractFor(AT);

    const settlement = await settleRun(
      backend,
      inputFor(runWith({ distance: 50_000, bitsCollected: 20_000, nearMisses: 500 }), {
        missions: {
          ...emptyMissionProgress(AT),
          values: { [contract.id]: contract.targets[2] },
        },
      }),
      AT,
    );

    expect(settlement.missionRewards.weeklyTiers).toEqual([1, 2, 3]);
    const ledger = await backend.getLedger();
    const weekly = ledger.entries.filter((e) => e.transaction.kind === "weekly-tier");
    // Three separate entries, not one lump the player cannot reconcile.
    expect(weekly.length).toBe(3);
    expect(settlement.balances.shards).toBeGreaterThanOrEqual(
      TUNING.meta.weeklyTierShards.reduce((sum, s) => sum + s, 0),
    );
  });

  it("an empty run settles cleanly and pays nothing", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(backend, inputFor(runWith({})), AT);

    expect(settlement.bitsAwarded).toBe(0);
    expect(settlement.shardsAwarded).toBe(0);
    expect(settlement.shortfalls).toEqual([]);
    expect(settlement.lifetime.runs).toBe(1);
  });

  it("every currency movement lands in the ledger", async () => {
    const backend = createLocalEconomyBackend({ now: () => AT });
    await settleRun(backend, inputFor(runWith({ distance: 1_000, bitsCollected: 50 })), AT);

    const ledger = await backend.getLedger();
    expect(ledger.entries.length).toBeGreaterThan(0);
    // Balances are the fold, never a stored number.
    expect(foldLedger(ledger)).toEqual(await backend.getBalances());
  });
});
