/**
 * The mission catalogue. GAME_BIBLE §9.4.
 *
 * ## Why this file is exempt from `no-magic-numbers`
 *
 * Same case as `sim/level/chunks/**`, `render/animation/clips.ts` and
 * `audio/recipes.ts`: every number here **is** the content. "Travel 4,000m
 * total" is a mission, not a tunable — hoisting 4,000 to `DAILY_DISTANCE_TARGET`
 * would make the catalogue unreadable to the person authoring the next mission,
 * who is exactly who this file is written for.
 *
 * Numbers that govern the *system* rather than an individual mission — how many
 * dailies are active, what a tier pays, when the week rolls over — live in
 * `TUNING.meta`, not here.
 *
 * ## Weights
 *
 * Weighted toward missions any competent run makes progress on. A daily the
 * player cannot picture themselves finishing is a daily they ignore, and three
 * ignored dailies is a dead system that still costs a screen. The spikier
 * entries (surviving a Fracture, a 40 combo) are low-weight and exist to make
 * the set feel different day to day rather than to be reliably completable.
 */

/** What a mission counts. */
export const MissionMetric = {
  DistanceTotal: "distanceTotal",
  DistanceSingleRun: "distanceSingleRun",
  BitsTotal: "bitsTotal",
  BitsSingleRun: "bitsSingleRun",
  ScoreSingleRun: "scoreSingleRun",
  NearMissTotal: "nearMissTotal",
  NearMissSingleRun: "nearMissSingleRun",
  OverdriveTotal: "overdriveTotal",
  OverdriveSingleRun: "overdriveSingleRun",
  RollTotal: "rollTotal",
  JumpTotal: "jumpTotal",
  SlideTotal: "slideTotal",
  ShatterTotal: "shatterTotal",
  FractureSurvivedTotal: "fractureSurvivedTotal",
  ComboSingleRun: "comboSingleRun",
  PeakFlowSingleRun: "peakFlowSingleRun",
  ThemeReached: "themeReached",
  RunsCompleted: "runsCompleted",
} as const;
export type MissionMetricName = (typeof MissionMetric)[keyof typeof MissionMetric];

/**
 * Metrics that take the best single run rather than a sum.
 *
 * The distinction matters enormously to how a mission feels: conflating them
 * turns "collect 500 Bits in a single run" into a mission that completes itself
 * over an afternoon of bad runs, which is a different mission entirely.
 */
export const SINGLE_RUN_METRICS: ReadonlySet<MissionMetricName> = new Set([
  MissionMetric.DistanceSingleRun,
  MissionMetric.BitsSingleRun,
  MissionMetric.ScoreSingleRun,
  MissionMetric.NearMissSingleRun,
  MissionMetric.OverdriveSingleRun,
  MissionMetric.ComboSingleRun,
  MissionMetric.PeakFlowSingleRun,
  MissionMetric.ThemeReached,
]);

/** How a remainder is spoken on the death screen. */
export const MissionUnit = {
  Metres: "m",
  Bits: "Bits",
  Points: "pts",
  Count: "",
  Flow: "Flow",
} as const;
export type MissionUnitName = (typeof MissionUnit)[keyof typeof MissionUnit];

export interface MissionTemplate {
  readonly id: string;
  readonly metric: MissionMetricName;
  readonly target: number;
  /** Selection weight. Higher appears more often. */
  readonly weight: number;
  readonly unit: MissionUnitName;
  /** Death-screen text, without the progress numbers. */
  readonly label: string;
}

export interface WeeklyTemplate {
  readonly id: string;
  readonly metric: MissionMetricName;
  /** Three ascending targets. */
  readonly targets: readonly [number, number, number];
  readonly weight: number;
  readonly unit: MissionUnitName;
  readonly label: string;
}

/** The daily pool. §9.4's five examples are all in here. */
export const DAILY_POOL: readonly MissionTemplate[] = Object.freeze([
  Object.freeze({
    id: "daily-distance-4000",
    metric: MissionMetric.DistanceTotal,
    target: 4000,
    weight: 10,
    unit: MissionUnit.Metres,
    label: "Travel 4,000m total",
  }),
  Object.freeze({
    id: "daily-distance-single-2000",
    metric: MissionMetric.DistanceSingleRun,
    target: 2000,
    weight: 8,
    unit: MissionUnit.Metres,
    label: "Reach 2,000m in one run",
  }),
  Object.freeze({
    id: "daily-bits-1200",
    metric: MissionMetric.BitsTotal,
    target: 1200,
    weight: 10,
    unit: MissionUnit.Bits,
    label: "Collect 1,200 Bits total",
  }),
  Object.freeze({
    id: "daily-bits-single-500",
    metric: MissionMetric.BitsSingleRun,
    target: 500,
    weight: 7,
    unit: MissionUnit.Bits,
    label: "Collect 500 Bits in a single run",
  }),
  Object.freeze({
    id: "daily-nearmiss-45",
    metric: MissionMetric.NearMissTotal,
    target: 45,
    weight: 9,
    unit: MissionUnit.Count,
    label: "Bank 45 near-misses",
  }),
  Object.freeze({
    id: "daily-nearmiss-single-25",
    metric: MissionMetric.NearMissSingleRun,
    target: 25,
    weight: 6,
    unit: MissionUnit.Count,
    label: "Bank 25 near-misses in one run",
  }),
  Object.freeze({
    id: "daily-overdrive-2",
    metric: MissionMetric.OverdriveTotal,
    target: 2,
    weight: 9,
    unit: MissionUnit.Count,
    label: "Trigger Overdrive twice",
  }),
  Object.freeze({
    id: "daily-overdrive-single-2",
    metric: MissionMetric.OverdriveSingleRun,
    target: 2,
    weight: 4,
    unit: MissionUnit.Count,
    label: "Trigger Overdrive twice in one run",
  }),
  Object.freeze({
    id: "daily-shatter-20",
    metric: MissionMetric.ShatterTotal,
    target: 20,
    weight: 6,
    unit: MissionUnit.Count,
    label: "Shatter 20 obstacles in Overdrive",
  }),
  Object.freeze({
    id: "daily-rolls-30",
    metric: MissionMetric.RollTotal,
    target: 30,
    weight: 8,
    unit: MissionUnit.Count,
    label: "Roll 30 times",
  }),
  Object.freeze({
    id: "daily-jumps-60",
    metric: MissionMetric.JumpTotal,
    target: 60,
    weight: 7,
    unit: MissionUnit.Count,
    label: "Jump 60 times",
  }),
  Object.freeze({
    id: "daily-slides-40",
    metric: MissionMetric.SlideTotal,
    target: 40,
    weight: 7,
    unit: MissionUnit.Count,
    label: "Slide 40 times",
  }),
  Object.freeze({
    id: "daily-score-25000",
    metric: MissionMetric.ScoreSingleRun,
    target: 25000,
    weight: 6,
    unit: MissionUnit.Points,
    label: "Score 25,000 in one run",
  }),
  Object.freeze({
    id: "daily-combo-40",
    metric: MissionMetric.ComboSingleRun,
    target: 40,
    weight: 5,
    unit: MissionUnit.Count,
    label: "Reach a 40 combo",
  }),
  Object.freeze({
    id: "daily-flow-100",
    metric: MissionMetric.PeakFlowSingleRun,
    target: 100,
    weight: 6,
    unit: MissionUnit.Flow,
    label: "Fill the Flow meter",
  }),
  Object.freeze({
    id: "daily-fracture-1",
    metric: MissionMetric.FractureSurvivedTotal,
    target: 1,
    weight: 3,
    unit: MissionUnit.Count,
    label: "Survive a Fracture",
  }),
  Object.freeze({
    id: "daily-runs-5",
    metric: MissionMetric.RunsCompleted,
    target: 5,
    weight: 8,
    unit: MissionUnit.Count,
    label: "Finish 5 runs",
  }),
]);

/**
 * The weekly pool. One contract per week, three tiers.
 *
 * §9.4: tier 3 should take roughly 5–6 strong runs, not grinding. Every tier-3
 * target below is set against a ~3,000m run as "strong".
 */
export const WEEKLY_POOL: readonly WeeklyTemplate[] = Object.freeze([
  Object.freeze({
    id: "weekly-distance",
    metric: MissionMetric.DistanceTotal,
    targets: [5000, 12000, 20000] as const,
    weight: 10,
    unit: MissionUnit.Metres,
    label: "Travel far",
  }),
  Object.freeze({
    id: "weekly-distance-single",
    metric: MissionMetric.DistanceSingleRun,
    targets: [1500, 2200, 3000] as const,
    weight: 8,
    unit: MissionUnit.Metres,
    label: "Reach deep in one run",
  }),
  Object.freeze({
    id: "weekly-bits",
    metric: MissionMetric.BitsTotal,
    targets: [1500, 4000, 7500] as const,
    weight: 9,
    unit: MissionUnit.Bits,
    label: "Bank Bits",
  }),
  Object.freeze({
    id: "weekly-nearmiss",
    metric: MissionMetric.NearMissTotal,
    targets: [60, 150, 260] as const,
    weight: 8,
    unit: MissionUnit.Count,
    label: "Shave past hazards",
  }),
  Object.freeze({
    id: "weekly-overdrive",
    metric: MissionMetric.OverdriveTotal,
    targets: [3, 8, 15] as const,
    weight: 7,
    unit: MissionUnit.Count,
    label: "Ride Overdrive",
  }),
  Object.freeze({
    id: "weekly-theme",
    metric: MissionMetric.ThemeReached,
    targets: [1, 2, 3] as const,
    weight: 5,
    unit: MissionUnit.Count,
    label: "Reach a further theme",
  }),
]);
