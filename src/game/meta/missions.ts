/**
 * Daily missions and the weekly contract. GAME_BIBLE §9.4.
 *
 * ## The near-miss is the point of this file
 *
 * §9.4 is unusually blunt: *"The death screen is the retention hook... **YOU WERE
 * 40m SHORT**. That line does more for D2 retention than any reward in the
 * game. It is not decoration — it is a required element of the death screen."*
 *
 * So `closestUnmet` is not a convenience. Every incomplete mission reports how
 * far short it came **in its own units**, and the ranking picks the one the
 * player was nearest to finishing. Getting this wrong in a subtle way — ranking
 * by absolute remainder instead of by fraction, say — produces a death screen
 * that says "you were 3,000 Bits short" when the player was 40m from a
 * distance goal, and the line stops working entirely.
 *
 * ## Determinism, and why it is not the sim's PRNG
 *
 * Everyone gets the same three dailies. The seed is derived from the **UTC
 * date**, so a player in Kiritimati (UTC+14) and one in Midway (UTC-11) looking
 * at their phones at the same instant see the same set. That requires deriving
 * the day from the epoch timestamp's UTC fields and never from local ones —
 * `getDate()` would give two different answers for one moment, and the bug
 * would only ever appear for players near a date line.
 *
 * The generator here is a local `mulberry32` rather than `sim/rng.ts`. The sim's
 * stream is part of replay reproducibility and must not be advanced by anything
 * cosmetic; and this needs to be seedable from a string, which that is not.
 * `Math.imul` is exact on every engine, so the selection is identical
 * everywhere.
 */

import { TUNING } from "@/game/config/tuning";
import {
  DAILY_POOL,
  MissionMetric,
  MissionUnit,
  SINGLE_RUN_METRICS,
  WEEKLY_POOL,
  type MissionMetricName,
  type MissionTemplate,
  type MissionUnitName,
  type WeeklyTemplate,
} from "./missionPool";
import type { RunSummary } from "./runSummary";

const META = TUNING.meta;

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

/** True when a metric is a best-of rather than a sum. */
function isSingleRun(metric: MissionMetricName): boolean {
  return SINGLE_RUN_METRICS.has(metric);
}

/** Reads a metric out of one finished run. */
export function readMetric(metric: MissionMetricName, run: RunSummary): number {
  switch (metric) {
    case MissionMetric.DistanceTotal:
    case MissionMetric.DistanceSingleRun:
      return run.distance;
    case MissionMetric.BitsTotal:
    case MissionMetric.BitsSingleRun:
      return run.bitsCollected;
    case MissionMetric.ScoreSingleRun:
      return run.score;
    case MissionMetric.NearMissTotal:
    case MissionMetric.NearMissSingleRun:
      return run.nearMisses;
    case MissionMetric.OverdriveTotal:
    case MissionMetric.OverdriveSingleRun:
      return run.overdrivesTriggered;
    case MissionMetric.RollTotal:
      return run.rolls;
    case MissionMetric.JumpTotal:
      return run.jumps;
    case MissionMetric.SlideTotal:
      return run.slides;
    case MissionMetric.ShatterTotal:
      return run.obstaclesShattered;
    case MissionMetric.FractureSurvivedTotal:
      return run.fracturesSurvived;
    case MissionMetric.ComboSingleRun:
      return run.bestCombo;
    case MissionMetric.PeakFlowSingleRun:
      return run.peakFlow;
    case MissionMetric.ThemeReached:
      return run.themeReached;
    case MissionMetric.RunsCompleted:
      return 1;
    default: {
      const exhaustive: never = metric;
      return exhaustive;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic selection
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a over a string. Exact on every engine — `Math.imul` is specified. */
export function hashString(text: string): number {
  const OFFSET_BASIS = 0x811c9dc5;
  const PRIME = 0x01000193;
  let hash = OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, PRIME);
  }
  return hash >>> 0;
}

/** mulberry32. Small, fast, and uses only exactly-specified integer ops. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  const STEP = 0x6d2b79f5;
  const MUL_A = 61;
  const SHIFT_A = 15;
  const SHIFT_B = 7;
  const SHIFT_C = 14;
  const TWO_32 = 4294967296;
  return () => {
    state = (state + STEP) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> SHIFT_A), t | 1);
    t ^= t + Math.imul(t ^ (t >>> SHIFT_B), t | MUL_A);
    return ((t ^ (t >>> SHIFT_C)) >>> 0) / TWO_32;
  };
}

const MS_PER_DAY = 86_400_000;
/** getUTCDay() for Monday. */
const MONDAY = 1;
const DAYS_PER_WEEK = 7;
const ISO_DATE_LENGTH = 10;

/**
 * The UTC day key, `YYYY-MM-DD`.
 *
 * Built from `toISOString`, which is defined to be UTC. Anything reading local
 * calendar fields would give two different keys for one instant either side of
 * a date line, and the dailies would stop being global.
 */
export function utcDayKey(at: number): string {
  return new Date(at).toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * The key of the week containing `at`, as the UTC date of its Monday.
 *
 * §9.4 resets the contract Monday 00:00 UTC. `getUTCDay()` returns 0 for Sunday,
 * so Sunday has to walk back six days rather than one — the off-by-one here
 * would give Sunday its own one-day "week", and only ever on Sundays.
 */
export function utcWeekKey(at: number): string {
  const date = new Date(at);
  const day = date.getUTCDay();
  const daysSinceMonday = (day - MONDAY + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return utcDayKey(at - daysSinceMonday * MS_PER_DAY);
}

/** Weighted selection without replacement. Pure, given a generator. */
function pickWeighted<T extends { weight: number }>(
  pool: readonly T[],
  count: number,
  random: () => number,
): readonly T[] {
  const remaining = [...pool];
  const picked: T[] = [];

  while (picked.length < count && remaining.length > 0) {
    let total = 0;
    for (const item of remaining) {
      total += item.weight;
    }
    let roll = random() * total;
    let index = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      roll -= remaining[i]?.weight ?? 0;
      if (roll <= 0) {
        index = i;
        break;
      }
    }
    const [chosen] = remaining.splice(index, 1);
    if (chosen !== undefined) {
      picked.push(chosen);
    }
  }
  return Object.freeze(picked);
}

/** The three dailies for a UTC day. Identical for every player worldwide. */
export function dailyMissionsFor(at: number): readonly MissionTemplate[] {
  const key = utcDayKey(at);
  const random = createRandom(hashString(`axis-daily-${key}`));
  return pickWeighted(DAILY_POOL, META.dailyMissionCount, random);
}

/** The weekly contract for the week containing `at`. */
export function weeklyContractFor(at: number): WeeklyTemplate {
  const key = utcWeekKey(at);
  const random = createRandom(hashString(`axis-weekly-${key}`));
  const [chosen] = pickWeighted(WEEKLY_POOL, 1, random);
  // The pool is non-empty and frozen, so this cannot be undefined; the fallback
  // exists to satisfy the type without an assertion.
  return chosen ?? (WEEKLY_POOL[0] as WeeklyTemplate);
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

export interface MissionProgress {
  /** Accumulated value per mission id. */
  readonly values: Readonly<Record<string, number>>;
  /** The UTC day the daily values belong to. */
  readonly dayKey: string;
  /** The UTC week the contract values belong to. */
  readonly weekKey: string;
  /** Daily ids already paid out. */
  readonly claimedDailies: readonly string[];
  /** Weekly tiers already paid out, 1-based. */
  readonly claimedWeeklyTiers: readonly number[];
}

export function emptyMissionProgress(at: number = Date.now()): MissionProgress {
  return Object.freeze({
    values: Object.freeze({}),
    dayKey: utcDayKey(at),
    weekKey: utcWeekKey(at),
    claimedDailies: Object.freeze([]),
    claimedWeeklyTiers: Object.freeze([]),
  });
}

/**
 * Rolls the period over if the day or week has changed.
 *
 * Daily and weekly values are cleared independently — a new day inside the same
 * week must not reset a contract the player is five runs into.
 */
export function rollPeriods(progress: MissionProgress, at: number): MissionProgress {
  const dayKey = utcDayKey(at);
  const weekKey = utcWeekKey(at);
  if (dayKey === progress.dayKey && weekKey === progress.weekKey) {
    return progress;
  }

  const dailyIds = new Set(dailyMissionsFor(at).map((mission) => mission.id));
  const weeklyIds = new Set(WEEKLY_POOL.map((contract) => contract.id));
  const values: Record<string, number> = {};

  for (const [id, value] of Object.entries(progress.values)) {
    const isDaily = dailyIds.has(id) || id.startsWith("daily-");
    const isWeekly = weeklyIds.has(id);
    if (isDaily && dayKey !== progress.dayKey) {
      continue;
    }
    if (isWeekly && weekKey !== progress.weekKey) {
      continue;
    }
    values[id] = value;
  }

  return Object.freeze({
    values: Object.freeze(values),
    dayKey,
    weekKey,
    claimedDailies:
      dayKey === progress.dayKey ? progress.claimedDailies : Object.freeze([] as string[]),
    claimedWeeklyTiers:
      weekKey === progress.weekKey ? progress.claimedWeeklyTiers : Object.freeze([] as number[]),
  });
}

/** Folds one finished run into mission progress. */
export function applyRun(
  progress: MissionProgress,
  run: RunSummary,
  at: number = Date.now(),
): MissionProgress {
  const rolled = rollPeriods(progress, at);
  const values: Record<string, number> = { ...rolled.values };

  const apply = (id: string, metric: MissionMetricName): void => {
    const value = readMetric(metric, run);
    const current = values[id] ?? 0;
    values[id] = isSingleRun(metric) ? Math.max(current, value) : current + value;
  };

  for (const mission of dailyMissionsFor(at)) {
    apply(mission.id, mission.metric);
  }
  const contract = weeklyContractFor(at);
  apply(contract.id, contract.metric);

  return Object.freeze({ ...rolled, values: Object.freeze(values) });
}

// ─────────────────────────────────────────────────────────────────────────────
// The near-miss — GAME_BIBLE §9.4
// ─────────────────────────────────────────────────────────────────────────────

/** One mission's live state, including how close it came. */
export interface MissionStatus {
  readonly id: string;
  readonly label: string;
  readonly unit: MissionUnitName;
  readonly target: number;
  readonly value: number;
  readonly complete: boolean;
  /** 0..1 — how far along, for the progress bar. */
  readonly fraction: number;
  /** How much is left, in the mission's own unit. Zero when complete. */
  readonly shortBy: number;
  /** Weekly tier, 1..3. Absent for dailies. */
  readonly tier?: number;
}

function statusOf(
  id: string,
  label: string,
  unit: MissionUnitName,
  target: number,
  value: number,
  tier?: number,
): MissionStatus {
  const clamped = Math.max(0, value);
  const complete = clamped >= target;
  const status: MissionStatus = {
    id,
    label,
    unit,
    target,
    value: clamped,
    complete,
    fraction: target <= 0 ? 1 : Math.min(1, clamped / target),
    shortBy: complete ? 0 : target - clamped,
  };
  return Object.freeze(tier === undefined ? status : { ...status, tier });
}

/** Every daily's live state. */
export function dailyStatuses(
  progress: MissionProgress,
  at: number = Date.now(),
): readonly MissionStatus[] {
  return dailyMissionsFor(at).map((mission) =>
    statusOf(
      mission.id,
      mission.label,
      mission.unit,
      mission.target,
      progress.values[mission.id] ?? 0,
    ),
  );
}

/** Every weekly tier's live state. */
export function weeklyStatuses(
  progress: MissionProgress,
  at: number = Date.now(),
): readonly MissionStatus[] {
  const contract = weeklyContractFor(at);
  const value = progress.values[contract.id] ?? 0;
  return contract.targets.map((target, index) =>
    statusOf(
      `${contract.id}-t${index + 1}`,
      `${contract.label} — ${target.toLocaleString("en-US")}${contract.unit === MissionUnit.Count ? "" : contract.unit}`,
      contract.unit,
      target,
      value,
      index + 1,
    ),
  );
}

/**
 * The closest unmet objective — the death screen's line.
 *
 * **Ranked by fraction complete, not by absolute remainder.** Being 40m from a
 * 2,000m goal (98%) beats being 2 near-misses from a 45 near-miss goal (95.6%),
 * and both beat being 3,000 Bits into a 7,500 Bit weekly. Ranking by raw
 * remainder would surface whichever mission happens to count in small numbers,
 * which is arbitrary and reads as random to the player.
 *
 * Missions with zero progress are eligible but naturally rank last, so a player
 * who has done nothing still sees something rather than an empty slot.
 */
export function closestUnmet(
  progress: MissionProgress,
  at: number = Date.now(),
): MissionStatus | null {
  let best: MissionStatus | null = null;
  const consider = (status: MissionStatus): void => {
    if (status.complete) {
      return;
    }
    if (best === null || status.fraction > best.fraction) {
      best = status;
    }
  };

  for (const status of dailyStatuses(progress, at)) {
    consider(status);
  }
  for (const status of weeklyStatuses(progress, at)) {
    consider(status);
  }
  return best;
}

/**
 * Formats the near-miss line. `"YOU WERE 40m SHORT"`.
 *
 * Rounded up: telling a player they were "0m short" of a goal they did not
 * reach is worse than saying nothing.
 */
export function formatShortfall(status: MissionStatus): string {
  const short = Math.max(1, Math.ceil(status.shortBy));
  const unit = status.unit === MissionUnit.Count ? "" : status.unit;
  const amount = short.toLocaleString("en-US");
  return `YOU WERE ${amount}${unit === MissionUnit.Metres ? unit : unit === "" ? "" : ` ${unit}`} SHORT`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewards
// ─────────────────────────────────────────────────────────────────────────────

export interface MissionRewards {
  /** Shards owed for completing all three dailies. */
  readonly dailyShards: number;
  /** Weekly tiers newly completed, 1-based. */
  readonly weeklyTiers: readonly number[];
  /** Shards owed for those tiers. */
  readonly weeklyShards: number;
  /** Progress with the claims recorded, so nothing pays twice. */
  readonly progress: MissionProgress;
}

/**
 * Works out what is owed and marks it claimed in one step.
 *
 * Claims are recorded in the same object that is returned, so there is no window
 * in which a caller has been told about a reward it has not yet marked. A
 * two-call design — `pending()` then `claim()` — pays twice the first time
 * anyone forgets the second call, and that bug reaches production as free
 * currency.
 */
export function claimRewards(progress: MissionProgress, at: number = Date.now()): MissionRewards {
  const dailies = dailyStatuses(progress, at);
  const allComplete = dailies.length > 0 && dailies.every((status) => status.complete);
  const alreadyClaimed = dailies.every((status) => progress.claimedDailies.includes(status.id));
  const dailyShards = allComplete && !alreadyClaimed ? TUNING.meta.dailyAllCompleteShards : 0;

  const newTiers: number[] = [];
  let weeklyShards = 0;
  for (const status of weeklyStatuses(progress, at)) {
    const tier = status.tier ?? 0;
    if (status.complete && !progress.claimedWeeklyTiers.includes(tier)) {
      newTiers.push(tier);
      weeklyShards += TUNING.meta.weeklyTierShards[tier - 1] ?? 0;
    }
  }

  return {
    dailyShards,
    weeklyTiers: Object.freeze(newTiers),
    weeklyShards,
    progress: Object.freeze({
      ...progress,
      claimedDailies:
        dailyShards > 0
          ? Object.freeze(dailies.map((status) => status.id))
          : progress.claimedDailies,
      claimedWeeklyTiers: Object.freeze([...progress.claimedWeeklyTiers, ...newTiers]),
    }),
  };
}
