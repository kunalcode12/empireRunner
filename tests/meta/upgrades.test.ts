import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  UPGRADES,
  UPGRADE_TRACKS,
  UpgradeTrack,
  ZERO_UPGRADES,
  bitValueMultiplier,
  canPurchase,
  effectFraction,
  effectMultiplier,
  effectValue,
  formatUpgradeTable,
  fullClearCost,
  shieldCount,
  upgradeCost,
  upgradeTrackTotal,
  withTier,
} from "@/game/meta/upgrades";

const MAX_TIER = TUNING.economy.upgradeMaxTier;

describe("the upgrade cost and effect table", () => {
  /**
   * The snapshot exists so a balance change shows up as a **table diff** in
   * review. A change to `upgradeEffectK` is one character in a config file and
   * silently rebalances the entire game; the same change here rewrites six
   * columns and cannot be skimmed past.
   */
  it("matches the committed balance table", () => {
    expect(`\n${formatUpgradeTable()}\n`).toMatchInlineSnapshot(`
      "
      COST — cost(tier) = round5(base * 2.15^(tier-1))
      ┌──────────────────┬───────┬───────┬───────┬───────┬───────┬───────┬─────────┐
      │ Upgrade          │  base │    T1 │    T2 │    T3 │    T4 │    T5 │   Total │
      ├──────────────────┼───────┼───────┼───────┼───────┼───────┼───────┼─────────┤
      │ Magnet Duration  │   250 │   250 │   540 │ 1,155 │ 2,485 │ 5,340 │   9,770 │
      │ Flow Gain Rate   │   300 │   300 │   645 │ 1,385 │ 2,980 │ 6,410 │  11,720 │
      │ Bit Value        │   350 │   350 │   755 │ 1,620 │ 3,480 │ 7,480 │  13,685 │
      │ Shield Count     │   400 │   400 │   860 │ 1,850 │ 3,975 │ 8,545 │  15,630 │
      └──────────────────┴───────┴───────┴───────┴───────┴───────┴───────┴─────────┘
      Full clear: 50,805 Bits

      EFFECT — effect(tier) = Emax * (1 - 0.6^t) / (1 - 0.6^5),  Emax = +65%
      ┌──────────────────┬────────┬────────┬────────┬────────┬────────┬────────┐
      │ Upgrade          │     T0 │     T1 │     T2 │     T3 │     T4 │     T5 │
      ├──────────────────┼────────┼────────┼────────┼────────┼────────┼────────┤
      │ Magnet Duration  │   6.00 │   7.69 │   8.71 │   9.32 │   9.68 │   9.90 │
      │ Flow Gain Rate   │   6.00 │   7.69 │   8.71 │   9.32 │   9.68 │   9.90 │
      │ Bit Value        │   1.00 │   1.28 │   1.45 │   1.55 │   1.61 │   1.65 │
      │ Shield Count     │      1 │      1 │      2 │      2 │      2 │      3 │
      └──────────────────┴────────┴────────┴────────┴────────┴────────┴────────┘
      │ % of Emax        │   0.0% │  43.4% │  69.4% │  85.0% │  94.4% │ 100.0% │
      "
    `);
  });

  it("prices every tier from the documented formula", () => {
    for (const track of UPGRADE_TRACKS) {
      const base = UPGRADES[track].baseCost;
      for (let tier = 1; tier <= MAX_TIER; tier += 1) {
        const expected =
          Math.round(
            (base * Math.pow(TUNING.economy.upgradeCostExponent, tier - 1)) /
              TUNING.economy.upgradeCostRounding,
          ) * TUNING.economy.upgradeCostRounding;
        expect(upgradeCost(track, tier)).toBe(expected);
      }
    }
  });

  it("matches the two GAME_BIBLE rows that were computed correctly", () => {
    // Magnet and Flow reproduce §8.2 exactly. Bit Value T5 and Shield Count T5
    // do NOT — the document had 7,485 and 8,550 where the stated formula gives
    // 7,480 and 8,545. §8.2 has been corrected; this pins the formula's answer.
    expect(upgradeTrackTotal(UpgradeTrack.MagnetDuration)).toBe(9_770);
    expect(upgradeTrackTotal(UpgradeTrack.FlowGain)).toBe(11_720);
  });

  it("charges nothing for a tier outside 1..5", () => {
    expect(upgradeCost(UpgradeTrack.BitValue, 0)).toBe(0);
    expect(upgradeCost(UpgradeTrack.BitValue, MAX_TIER + 1)).toBe(0);
    expect(upgradeCost(UpgradeTrack.BitValue, 1.5)).toBe(0);
  });

  it("puts a full clear near fifty runs' worth of Bits", () => {
    // §8.2: "~50 competent runs at ~1,000 Bits each".
    const perRun = 1_000;
    const runs = fullClearCost() / perRun;
    expect(runs).toBeGreaterThan(45);
    expect(runs).toBeLessThan(55);
  });
});

describe("the diminishing curve", () => {
  it("front-loads: tier 1 delivers 43.4% of the total benefit", () => {
    expect(effectFraction(1)).toBeCloseTo(0.434, 3);
  });

  it("reaches exactly 100% at tier 5", () => {
    expect(effectFraction(MAX_TIER)).toBeCloseTo(1, 12);
  });

  it("is zero at tier 0 and monotonically increasing", () => {
    expect(effectFraction(0)).toBe(0);
    let previous = 0;
    for (let tier = 1; tier <= MAX_TIER; tier += 1) {
      const fraction = effectFraction(tier);
      expect(fraction).toBeGreaterThan(previous);
      previous = fraction;
    }
  });

  /**
   * §8.3, stated as a rule rather than a hope: "Any upgrade whose tier-5 value
   * more than doubles its tier-0 value is a balance bug."
   */
  it("tier 5 is +65%, never +400%", () => {
    expect(effectMultiplier(MAX_TIER)).toBeCloseTo(1 + TUNING.economy.upgradeEmax, 12);

    for (const track of UPGRADE_TRACKS) {
      if (UPGRADES[track].stepped) {
        continue;
      }
      const tierZero = effectValue(track, 0);
      const tierFive = effectValue(track, MAX_TIER);
      expect(tierFive / tierZero, `${track} more than doubles at tier 5`).toBeLessThanOrEqual(2);
    }
  });

  it("the last tier is a flex: tier 5 adds under 6% of the total", () => {
    const lastStep = effectFraction(MAX_TIER) - effectFraction(MAX_TIER - 1);
    expect(lastStep).toBeLessThan(0.06);
    expect(lastStep).toBeGreaterThan(0);
  });

  it("clamps out-of-range tiers rather than extrapolating", () => {
    expect(effectFraction(-3)).toBe(0);
    expect(effectFraction(99)).toBe(effectFraction(MAX_TIER));
  });
});

describe("Shield Count is stepped, not continuous", () => {
  /** You cannot hold 1.43 Shields — §8.2's DECISION. */
  it("returns whole Shields at every tier", () => {
    for (let tier = 0; tier <= MAX_TIER; tier += 1) {
      const value = effectValue(UpgradeTrack.ShieldCount, tier);
      expect(Number.isInteger(value), `tier ${tier} gave ${value}`).toBe(true);
    }
  });

  it("follows the documented step table and caps at 3", () => {
    const steps = [0, 1, 2, 3, 4, 5].map((tier) => effectValue(UpgradeTrack.ShieldCount, tier));
    expect(steps).toEqual([1, 1, 2, 2, 2, 3]);
  });

  it("keeps the curve's shape: front-loaded and flattening", () => {
    // The first increase arrives before the halfway tier, and the table never
    // decreases.
    let previous = 0;
    for (let tier = 0; tier <= MAX_TIER; tier += 1) {
      const value = effectValue(UpgradeTrack.ShieldCount, tier);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(shieldCount(withTier(ZERO_UPGRADES, UpgradeTrack.ShieldCount, 2))).toBe(2);
  });
});

describe("applying upgrades", () => {
  it("bit value multiplies from 1.00x to 1.65x", () => {
    expect(bitValueMultiplier(ZERO_UPGRADES)).toBe(1);
    expect(
      bitValueMultiplier(withTier(ZERO_UPGRADES, UpgradeTrack.BitValue, MAX_TIER)),
    ).toBeCloseTo(1.65, 10);
  });

  it("withTier never mutates and always clamps", () => {
    const next = withTier(ZERO_UPGRADES, UpgradeTrack.BitValue, 99);
    expect(ZERO_UPGRADES[UpgradeTrack.BitValue]).toBe(0);
    expect(next[UpgradeTrack.BitValue]).toBe(MAX_TIER);
    expect(withTier(ZERO_UPGRADES, UpgradeTrack.BitValue, -5)[UpgradeTrack.BitValue]).toBe(0);
  });

  it("canPurchase respects both the price and the tier ceiling", () => {
    expect(canPurchase(ZERO_UPGRADES, UpgradeTrack.MagnetDuration, 249)).toBe(false);
    expect(canPurchase(ZERO_UPGRADES, UpgradeTrack.MagnetDuration, 250)).toBe(true);

    const maxed = withTier(ZERO_UPGRADES, UpgradeTrack.MagnetDuration, MAX_TIER);
    expect(canPurchase(maxed, UpgradeTrack.MagnetDuration, 1_000_000)).toBe(false);
  });
});
