/**
 * Player level, unlock gating, and the first-run onboarding flags.
 *
 * ## Level is cosmetic, and that is a design position
 *
 * GAME_BIBLE §9.5 (added at P13 — the design had no level system before this
 * phase) makes level a **record of time spent, not a source of power**. It gates
 * nothing that affects a run.
 *
 * The alternative — levels that unlock upgrade tracks or raise a stat — is the
 * standard mobile pattern and it is wrong for this game specifically. AXIS is a
 * score chase, and a score chase where a new player's ceiling is set by their
 * account age rather than their hands is not a score chase, it is a queue. The
 * upgrade tracks in `upgrades.ts` are already the power curve, they are already
 * capped at +65%, and adding a second progression axis on top would undo that
 * cap by the back door.
 *
 * What level is *for*: a legible "you have played a lot" number for the profile
 * screen, and a hook for cosmetic rewards, which cannot affect a run by
 * definition.
 *
 * ## The curve
 *
 * ```
 *   distanceForLevel(n) = levelOneDistance * (levelGrowth^(n-1) - 1) / (levelGrowth - 1)
 * ```
 *
 * A geometric series, so each level costs `levelGrowth` times the last. At 1,500m
 * and 1.18, level 10 is ~30,000m lifetime and level 30 is ~1,000,000m. The shape
 * matters more than the numbers: early levels arrive inside a session, later ones
 * take weeks, and neither ever blocks anything.
 */

import { TUNING } from "@/game/config/tuning";

const META = TUNING.meta;

/** Lifetime totals that survive across runs. */
export interface LifetimeStats {
  /** m — total distance ever travelled. Drives level. */
  distance: number;
  /** count — runs finished. */
  runs: number;
  /** pts — best single-run score. */
  bestScore: number;
  /** m — best single-run distance. */
  bestDistance: number;
  /** count — Bits ever collected, before multipliers. */
  bitsCollected: number;
  /** count — near-misses ever banked. */
  nearMisses: number;
  /** count — Overdrives ever triggered. */
  overdrives: number;
  /** count — Fractures ever survived. */
  fracturesSurvived: number;
}

export const ZERO_LIFETIME: LifetimeStats = Object.freeze({
  distance: 0,
  runs: 0,
  bestScore: 0,
  bestDistance: 0,
  bitsCollected: 0,
  nearMisses: 0,
  overdrives: 0,
  fracturesSurvived: 0,
});

/**
 * Cumulative lifetime distance required to *reach* a level.
 *
 * Level 1 is 0 — everyone starts there. `Math.pow` is fine: this is meta,
 * evaluated between runs, and never reaches the sim.
 */
export function distanceForLevel(level: number): number {
  if (level <= 1) {
    return 0;
  }
  const capped = Math.min(Math.trunc(level), META.maxLevel);
  const growth = META.levelGrowth;
  return Math.round(META.levelOneDistance * ((Math.pow(growth, capped - 1) - 1) / (growth - 1)));
}

/** The level a lifetime distance earns. */
export function levelForDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) {
    return 1;
  }
  let level = 1;
  while (level < META.maxLevel && distance >= distanceForLevel(level + 1)) {
    level += 1;
  }
  return level;
}

/** Everything the profile screen shows about level. */
export interface LevelProgress {
  readonly level: number;
  /** True once `maxLevel` is reached. */
  readonly maxed: boolean;
  /** m — lifetime distance at the current level's start. */
  readonly levelStart: number;
  /** m — lifetime distance the next level needs. Equals `levelStart` when maxed. */
  readonly nextLevel: number;
  /** m — distance into the current level. */
  readonly into: number;
  /** m — distance still needed. Zero when maxed. */
  readonly remaining: number;
  /** 0..1 — progress through the current level. */
  readonly fraction: number;
}

export function levelProgress(distance: number): LevelProgress {
  const level = levelForDistance(distance);
  const maxed = level >= META.maxLevel;
  const levelStart = distanceForLevel(level);
  const nextLevel = maxed ? levelStart : distanceForLevel(level + 1);
  const span = nextLevel - levelStart;
  const into = Math.max(0, distance - levelStart);
  return Object.freeze({
    level,
    maxed,
    levelStart,
    nextLevel,
    into,
    remaining: maxed ? 0 : Math.max(0, nextLevel - distance),
    fraction: maxed || span <= 0 ? 1 : Math.min(1, into / span),
  });
}

/** Folds a finished run into lifetime totals. */
export function applyRunToLifetime(
  stats: LifetimeStats,
  run: {
    distance: number;
    score: number;
    bitsCollected: number;
    nearMisses: number;
    overdrivesTriggered: number;
    fracturesSurvived: number;
  },
): LifetimeStats {
  return Object.freeze({
    distance: stats.distance + Math.max(0, run.distance),
    runs: stats.runs + 1,
    bestScore: Math.max(stats.bestScore, run.score),
    bestDistance: Math.max(stats.bestDistance, run.distance),
    bitsCollected: stats.bitsCollected + Math.max(0, run.bitsCollected),
    nearMisses: stats.nearMisses + Math.max(0, run.nearMisses),
    overdrives: stats.overdrives + Math.max(0, run.overdrivesTriggered),
    fracturesSurvived: stats.fracturesSurvived + Math.max(0, run.fracturesSurvived),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlock gating
// ─────────────────────────────────────────────────────────────────────────────

/** Things that can be locked behind progress. */
export const Unlockable = {
  /** The Static theme. GAME_BIBLE §10: 5,000m in a single run. */
  StaticTheme: "theme.static",
  /** The store. Held back until the player has finished a run and has Bits. */
  Store: "screen.store",
  /** Missions. Held back until the loop is understood. */
  Missions: "screen.missions",
  /** The loadout screen. Pointless before anything is owned. */
  Loadout: "screen.loadout",
} as const;
export type UnlockableName = (typeof Unlockable)[keyof typeof Unlockable];

/** m — single-run distance that unlocks the Static theme. GAME_BIBLE §10.1. */
const STATIC_THEME_DISTANCE = 5_000;
/** runs — before the store is worth showing. */
const STORE_AFTER_RUNS = 2;
/** runs — before missions are worth showing. */
const MISSIONS_AFTER_RUNS = 3;
/** runs — before the loadout is worth showing. */
const LOADOUT_AFTER_RUNS = 4;

/**
 * Whether something is unlocked.
 *
 * The screen gates are deliberately shallow — two to four runs. They exist so a
 * first-time player meets one idea at a time, not to withhold the game. Anything
 * longer would be a drip-feed, and a drip-feed on an arcade runner just reads as
 * a locked menu.
 */
export function isUnlocked(what: UnlockableName, stats: LifetimeStats): boolean {
  switch (what) {
    case Unlockable.StaticTheme:
      return stats.bestDistance >= STATIC_THEME_DISTANCE;
    case Unlockable.Store:
      return stats.runs >= STORE_AFTER_RUNS;
    case Unlockable.Missions:
      return stats.runs >= MISSIONS_AFTER_RUNS;
    case Unlockable.Loadout:
      return stats.runs >= LOADOUT_AFTER_RUNS;
    default: {
      const exhaustive: never = what;
      return exhaustive;
    }
  }
}

/** Every unlock that a run just crossed, so the UI can celebrate it once. */
export function newlyUnlocked(
  before: LifetimeStats,
  after: LifetimeStats,
): readonly UnlockableName[] {
  const all: UnlockableName[] = [
    Unlockable.StaticTheme,
    Unlockable.Store,
    Unlockable.Missions,
    Unlockable.Loadout,
  ];
  return Object.freeze(all.filter((what) => !isUnlocked(what, before) && isUnlocked(what, after)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-shot flags for things the player only ever needs told once.
 *
 * Flat booleans rather than a set of strings because they are migrated with the
 * save, and a missing boolean defaults to `false` — "not yet seen" — which is
 * the safe direction. A missing entry in a set is the same thing, but a
 * *corrupted* set can be a string, a number, or null, and each needs its own
 * repair. Booleans have exactly one repair.
 */
export interface OnboardingFlags {
  /** The player has finished their first run. */
  seenFirstRun: boolean;
  /** The roll has been explained. */
  seenRollPrompt: boolean;
  /** Flow and Overdrive have been explained. */
  seenFlowPrompt: boolean;
  /** The Fracture window has been explained — shown the first time it opens. */
  seenFracturePrompt: boolean;
  /** The store has been opened at least once. */
  seenStore: boolean;
  /** Missions have been opened at least once. */
  seenMissions: boolean;
}

export const FRESH_ONBOARDING: OnboardingFlags = Object.freeze({
  seenFirstRun: false,
  seenRollPrompt: false,
  seenFlowPrompt: false,
  seenFracturePrompt: false,
  seenStore: false,
  seenMissions: false,
});

/** Sets a flag. Pure. */
export function markSeen(flags: OnboardingFlags, flag: keyof OnboardingFlags): OnboardingFlags {
  if (flags[flag]) {
    return flags;
  }
  return Object.freeze({ ...flags, [flag]: true });
}

/** True while the player is still in their very first run. */
export function isFirstRun(stats: LifetimeStats): boolean {
  return stats.runs === 0;
}
