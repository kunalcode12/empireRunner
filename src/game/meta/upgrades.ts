/**
 * The four upgrade tracks. GAME_BIBLE §8.2 and §8.3.
 *
 * ```
 *   cost(tier)   = round5( base * 2.15^(tier - 1) )        tier 1..5
 *   effect(tier) = Emax * (1 - k^tier) / (1 - k^5)   k=0.6, tier 0..5
 * ```
 *
 * ## The shape is the design, and it is worth defending
 *
 * Tier 1 costs 250 Bits and delivers **43.4%** of the total benefit. Tier 5
 * costs 5,340 and delivers the last **5.6%**. That asymmetry is intentional in
 * both directions: the first purchase has to feel transformative or the
 * treadmill never starts, and the last one has to be a completionist flex rather
 * than a requirement, or the game has quietly gated its own content behind
 * 50,000 Bits.
 *
 * **Tier 5 is +65%, not +400%.** Any upgrade whose tier-5 value more than
 * doubles its tier-0 value is a balance bug, and `tests/meta/upgrades.test.ts`
 * fails on it. That test also snapshots the entire cost and effect table, so a
 * change to any of these numbers shows up as a table diff in review rather than
 * as a one-character change to a constant nobody notices.
 *
 * ## Shield Count is not on the curve
 *
 * You cannot hold 1.43 Shields. §8.2's DECISION replaces the continuous curve
 * with the integer step table `[1,1,2,2,2,3]`, which keeps the curve's *shape* —
 * front-loaded, flattening — in integer space. It is the one track where
 * `effectValue` reads a table instead of evaluating the formula.
 */

import { TUNING } from "@/game/config/tuning";

const ECONOMY = TUNING.economy;
const MAX_TIER = ECONOMY.upgradeMaxTier;

/** The four tracks. */
export const UpgradeTrack = {
  MagnetDuration: "magnetDuration",
  FlowGain: "flowGain",
  BitValue: "bitValue",
  ShieldCount: "shieldCount",
} as const;
export type UpgradeTrackName = (typeof UpgradeTrack)[keyof typeof UpgradeTrack];

export const UPGRADE_TRACKS: readonly UpgradeTrackName[] = Object.freeze([
  UpgradeTrack.MagnetDuration,
  UpgradeTrack.FlowGain,
  UpgradeTrack.BitValue,
  UpgradeTrack.ShieldCount,
]);

/** Owned tier per track, 0..5. */
export type UpgradeLevels = Readonly<Record<UpgradeTrackName, number>>;

export const ZERO_UPGRADES: UpgradeLevels = Object.freeze({
  [UpgradeTrack.MagnetDuration]: 0,
  [UpgradeTrack.FlowGain]: 0,
  [UpgradeTrack.BitValue]: 0,
  [UpgradeTrack.ShieldCount]: 0,
});

/** What a track means in the game, for the store screen and for tests. */
export interface UpgradeDefinition {
  readonly track: UpgradeTrackName;
  readonly label: string;
  /** Bits — the tier-1 price. */
  readonly baseCost: number;
  /** The tier-0 value the effect scales from. */
  readonly baseValue: number;
  /** Unit, for display. */
  readonly unit: string;
  /**
   * True when the track uses the integer step table rather than the curve.
   * Exactly one track does.
   */
  readonly stepped: boolean;
}

/**
 * Shield Count's integer steps, indexed by tier 0..5.
 *
 * Tier 0 is 1 Shield — the baseline `TUNING.pickups.maxShields` — and tier 5
 * caps at 3.
 */
const MAX_SHIELDS = 3;
const SHIELD_STEPS: readonly number[] = Object.freeze([1, 1, 2, 2, 2, MAX_SHIELDS]);

export const UPGRADES: Readonly<Record<UpgradeTrackName, UpgradeDefinition>> = Object.freeze({
  [UpgradeTrack.MagnetDuration]: Object.freeze({
    track: UpgradeTrack.MagnetDuration,
    label: "Magnet Duration",
    baseCost: ECONOMY.upgradeBaseCost.magnetDuration,
    baseValue: TUNING.pickups.magnetDuration,
    unit: "s",
    stepped: false,
  }),
  [UpgradeTrack.FlowGain]: Object.freeze({
    track: UpgradeTrack.FlowGain,
    label: "Flow Gain Rate",
    baseCost: ECONOMY.upgradeBaseCost.flowGain,
    baseValue: TUNING.flow.flowPerNearMiss,
    unit: "Flow",
    stepped: false,
  }),
  [UpgradeTrack.BitValue]: Object.freeze({
    track: UpgradeTrack.BitValue,
    label: "Bit Value",
    baseCost: ECONOMY.upgradeBaseCost.bitValue,
    baseValue: 1,
    unit: "x",
    stepped: false,
  }),
  [UpgradeTrack.ShieldCount]: Object.freeze({
    track: UpgradeTrack.ShieldCount,
    label: "Shield Count",
    baseCost: ECONOMY.upgradeBaseCost.shieldCount,
    baseValue: SHIELD_STEPS[0] ?? 1,
    unit: "shields",
    stepped: true,
  }),
});

/** Rounds to the nearest `upgradeCostRounding`. */
function roundCost(value: number): number {
  const granularity = ECONOMY.upgradeCostRounding;
  return Math.round(value / granularity) * granularity;
}

/** Bits to buy `tier`, 1..5. Zero outside that range — nothing to buy. */
export function upgradeCost(track: UpgradeTrackName, tier: number): number {
  if (tier < 1 || tier > MAX_TIER || !Number.isInteger(tier)) {
    return 0;
  }
  const base = UPGRADES[track].baseCost;
  return roundCost(base * Math.pow(ECONOMY.upgradeCostExponent, tier - 1));
}

/** Bits to go from `fromTier` to `toTier`. */
export function upgradeCostRange(
  track: UpgradeTrackName,
  fromTier: number,
  toTier: number,
): number {
  let total = 0;
  for (let tier = fromTier + 1; tier <= toTier; tier += 1) {
    total += upgradeCost(track, tier);
  }
  return total;
}

/** Bits to take a track from 0 to 5. */
export function upgradeTrackTotal(track: UpgradeTrackName): number {
  return upgradeCostRange(track, 0, MAX_TIER);
}

/** Bits to fully clear every track. GAME_BIBLE §8.2 puts this near 50,815. */
export function fullClearCost(): number {
  let total = 0;
  for (const track of UPGRADE_TRACKS) {
    total += upgradeTrackTotal(track);
  }
  return total;
}

/**
 * The diminishing curve, as a fraction of Emax in 0..1.
 *
 * `Math.pow` is fine here: this is meta, evaluated between runs, and never
 * touches the sim. The transcendental ban in eslint.config.mjs is scoped to
 * `src/game/sim/**` for cross-engine replay reproducibility.
 */
export function effectFraction(tier: number): number {
  if (tier <= 0) {
    return 0;
  }
  const clamped = Math.min(tier, MAX_TIER);
  const k = ECONOMY.upgradeEffectK;
  return (1 - Math.pow(k, clamped)) / (1 - Math.pow(k, MAX_TIER));
}

/** The multiplier a tier applies to its track's base value. */
export function effectMultiplier(tier: number): number {
  return 1 + ECONOMY.upgradeEmax * effectFraction(tier);
}

/**
 * The actual value of a track at a tier, in the track's own unit.
 *
 * Shield Count reads the step table; everything else scales its base value by
 * the curve.
 */
export function effectValue(track: UpgradeTrackName, tier: number): number {
  const clamped = Math.max(0, Math.min(Math.trunc(tier), MAX_TIER));
  if (UPGRADES[track].stepped) {
    return SHIELD_STEPS[clamped] ?? SHIELD_STEPS[0] ?? 1;
  }
  return UPGRADES[track].baseValue * effectMultiplier(clamped);
}

/** The Bit-value multiplier the economy applies to a run's pickups. */
export function bitValueMultiplier(levels: UpgradeLevels): number {
  return effectMultiplier(levels[UpgradeTrack.BitValue]);
}

/** Shields the player starts a run with. */
export function shieldCount(levels: UpgradeLevels): number {
  return effectValue(UpgradeTrack.ShieldCount, levels[UpgradeTrack.ShieldCount]);
}

/** Whether a track can be bought up one tier. */
export function canPurchase(levels: UpgradeLevels, track: UpgradeTrackName, bits: number): boolean {
  const next = levels[track] + 1;
  return next <= MAX_TIER && bits >= upgradeCost(track, next);
}

/** Returns new levels with one track raised a tier. Pure; never mutates. */
export function withTier(
  levels: UpgradeLevels,
  track: UpgradeTrackName,
  tier: number,
): UpgradeLevels {
  return Object.freeze({
    ...levels,
    [track]: Math.max(0, Math.min(Math.trunc(tier), MAX_TIER)),
  });
}

/** One row of the balance table. */
export interface UpgradeTableRow {
  readonly track: UpgradeTrackName;
  readonly label: string;
  readonly baseCost: number;
  /** Bits per tier, index 0 = tier 1. */
  readonly costs: readonly number[];
  /** Bits to clear the track. */
  readonly total: number;
  /** Value at each tier, index 0 = tier 0. */
  readonly values: readonly number[];
  /** Fraction of Emax at each tier, index 0 = tier 0. */
  readonly fractions: readonly number[];
}

/**
 * The whole balance table.
 *
 * Snapshotted by `tests/meta/upgrades.test.ts` so that changing a cost or the
 * curve constant produces a **visible table diff** in review. A balance change
 * that only shows up as `0.6` → `0.55` in a config file is a balance change
 * nobody reviewed.
 */
export function upgradeTable(): readonly UpgradeTableRow[] {
  return UPGRADE_TRACKS.map((track) => {
    const costs: number[] = [];
    for (let tier = 1; tier <= MAX_TIER; tier += 1) {
      costs.push(upgradeCost(track, tier));
    }
    const values: number[] = [];
    const fractions: number[] = [];
    for (let tier = 0; tier <= MAX_TIER; tier += 1) {
      values.push(effectValue(track, tier));
      fractions.push(effectFraction(tier));
    }
    return Object.freeze({
      track,
      label: UPGRADES[track].label,
      baseCost: UPGRADES[track].baseCost,
      costs: Object.freeze(costs),
      total: upgradeTrackTotal(track),
      values: Object.freeze(values),
      fractions: Object.freeze(fractions),
    });
  });
}

/** Renders the table as text, for the snapshot and for the verify gate. */
const LABEL_WIDTH = 16;
const COST_WIDTH = 5;
const TOTAL_WIDTH = 7;
const VALUE_WIDTH = 6;
const PERCENT_SCALE = 100;
const VALUE_DECIMALS = 2;
const PERCENT_DECIMALS = 1;

export function formatUpgradeTable(): string {
  const rows = upgradeTable();
  const lines: string[] = [];

  lines.push("COST — cost(tier) = round5(base * 2.15^(tier-1))");
  lines.push("┌──────────────────┬───────┬───────┬───────┬───────┬───────┬───────┬─────────┐");
  lines.push("│ Upgrade          │  base │    T1 │    T2 │    T3 │    T4 │    T5 │   Total │");
  lines.push("├──────────────────┼───────┼───────┼───────┼───────┼───────┼───────┼─────────┤");
  for (const row of rows) {
    const cells = row.costs
      .map((cost) => cost.toLocaleString("en-US").padStart(COST_WIDTH))
      .join(" │ ");
    lines.push(
      `│ ${row.label.padEnd(LABEL_WIDTH)} │ ${String(row.baseCost).padStart(COST_WIDTH)} │ ${cells} │ ${row.total
        .toLocaleString("en-US")
        .padStart(TOTAL_WIDTH)} │`,
    );
  }
  lines.push("└──────────────────┴───────┴───────┴───────┴───────┴───────┴───────┴─────────┘");
  lines.push(`Full clear: ${fullClearCost().toLocaleString("en-US")} Bits`);
  lines.push("");

  lines.push("EFFECT — effect(tier) = Emax * (1 - 0.6^t) / (1 - 0.6^5),  Emax = +65%");
  lines.push("┌──────────────────┬────────┬────────┬────────┬────────┬────────┬────────┐");
  lines.push("│ Upgrade          │     T0 │     T1 │     T2 │     T3 │     T4 │     T5 │");
  lines.push("├──────────────────┼────────┼────────┼────────┼────────┼────────┼────────┤");
  for (const row of rows) {
    const cells = row.values
      .map((value) =>
        (UPGRADES[row.track].stepped ? String(value) : value.toFixed(VALUE_DECIMALS)).padStart(
          VALUE_WIDTH,
        ),
      )
      .join(" │ ");
    lines.push(`│ ${row.label.padEnd(LABEL_WIDTH)} │ ${cells} │`);
  }
  lines.push("└──────────────────┴────────┴────────┴────────┴────────┴────────┴────────┘");

  const first = rows[0];
  if (first !== undefined) {
    const percents = first.fractions
      .map((fraction) =>
        `${(fraction * PERCENT_SCALE).toFixed(PERCENT_DECIMALS)}%`.padStart(VALUE_WIDTH),
      )
      .join(" │ ");
    lines.push(`│ % of Emax        │ ${percents} │`);
  }
  return lines.join("\n");
}
