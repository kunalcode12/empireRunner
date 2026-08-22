/**
 * The two heuristics that catch a replay which is genuine but not human.
 *
 * ## Why re-simulation is not enough on its own
 *
 * Re-simulation proves the score follows from the inputs. It says nothing about
 * where the inputs came from. A bot that reads the generated track and emits a
 * perfect answer every tick produces a replay that validates flawlessly — the
 * hash matches, because it really did play that log. It just did not play it
 * with hands.
 *
 * Nothing here is a proof, and it is important to be honest about that: these
 * are *plausibility* bounds. A sufficiently patient bot that plays at human
 * speed defeats them, and that is fine — the point is to make cheating cost
 * roughly as much as playing, which is where the economics stop favouring it.
 *
 * ## The bias is deliberately toward letting cheats through
 *
 * A false negative costs the leaderboard one bad score. A false positive tells a
 * real player, who really did play that run, that they are a cheat — and they
 * cannot appeal, because the thing they would appeal with is the replay that was
 * just rejected. So every threshold sits well past the human record rather than
 * near it, and `TUNING.input.plausibility` says so in its own comments.
 *
 * ## Everything here is pure
 *
 * No clock, no store, no I/O. Given a byte array it returns the same verdict
 * every time, which is what makes it testable against hand-built replays.
 */

import { TUNING } from "@/game/config/tuning";
import { unpackIntent } from "@/game/sim/replay";
import { createIntent } from "@/game/sim/intent";

const PLAUSIBILITY = TUNING.input.plausibility;
const TICK_RATE = TUNING.sim.tickRate;
const HEADER_BYTES = TUNING.replay.headerBytes;

/** Why an input log was judged implausible. */
export const ImplausibleReason = {
  None: "none",
  /** Fewer ticks than the shortest submittable run. */
  TooFewTicks: "too-few-ticks",
  /** Sustained direction changes above a human rate. */
  DirectionRateSustained: "direction-rate-sustained",
  /** A one-second window above even the burst allowance. */
  DirectionRateBurst: "direction-rate-burst",
  /** Claimed wall-clock duration is impossibly short for the tick count. */
  WallClockTooShort: "wall-clock-too-short",
  /** Claimed wall-clock duration is nonsensically long. */
  WallClockTooLong: "wall-clock-too-long",
} as const;
export type ImplausibleReasonValue = (typeof ImplausibleReason)[keyof typeof ImplausibleReason];

export interface DensityReport {
  readonly plausible: boolean;
  readonly reason: ImplausibleReasonValue;
  /** Direction changes across the whole run, per second. Diagnostics. */
  readonly sustainedRate: number;
  /** The densest one-second window, per second. Diagnostics. */
  readonly peakRate: number;
  readonly totalChanges: number;
}

/**
 * Counts direction changes and measures both the sustained and the peak rate.
 *
 * A "direction change" is any tick whose lateral or roll axis differs from the
 * previous tick's. Jump and slide are excluded deliberately: they are held
 * states with meaningful durations (P04 made `jump` mean "held" so variable
 * jump height can read the release edge), so counting their edges would punish
 * a player for holding a button, which is the opposite of the signal wanted.
 *
 * The peak is measured with a sliding window rather than fixed buckets. Fixed
 * one-second buckets have the same seam problem a fixed-window rate limiter
 * does — 30 changes at 0.9s and 30 more at 1.1s reads as two quiet seconds.
 */
export function analyseDensity(bytes: Uint8Array, tickCount: number): DensityReport {
  if (tickCount < PLAUSIBILITY.minTicks) {
    return {
      plausible: false,
      reason: ImplausibleReason.TooFewTicks,
      sustainedRate: 0,
      peakRate: 0,
      totalChanges: 0,
    };
  }

  const current = createIntent();
  const previous = createIntent();

  /** Tick index of each change, in order. The sliding window reads this. */
  const changeTicks: number[] = [];

  for (let tick = 0; tick < tickCount; tick += 1) {
    unpackIntent(bytes[HEADER_BYTES + tick] ?? 0, current);
    if (tick > 0 && (current.lateral !== previous.lateral || current.roll !== previous.roll)) {
      changeTicks.push(tick);
    }
    previous.lateral = current.lateral;
    previous.roll = current.roll;
  }

  const seconds = tickCount / TICK_RATE;
  const sustainedRate = changeTicks.length / seconds;

  // Sliding one-second window over the change list. O(changes), not O(ticks).
  let peakInWindow = 0;
  let windowStart = 0;
  for (let i = 0; i < changeTicks.length; i += 1) {
    const at = changeTicks[i] ?? 0;
    while ((changeTicks[windowStart] ?? 0) <= at - TICK_RATE) {
      windowStart += 1;
    }
    const inWindow = i - windowStart + 1;
    if (inWindow > peakInWindow) {
      peakInWindow = inWindow;
    }
  }

  if (peakInWindow > PLAUSIBILITY.maxBurstDirectionChangesPerSecond) {
    return {
      plausible: false,
      reason: ImplausibleReason.DirectionRateBurst,
      sustainedRate,
      peakRate: peakInWindow,
      totalChanges: changeTicks.length,
    };
  }

  if (sustainedRate > PLAUSIBILITY.maxDirectionChangesPerSecond) {
    return {
      plausible: false,
      reason: ImplausibleReason.DirectionRateSustained,
      sustainedRate,
      peakRate: peakInWindow,
      totalChanges: changeTicks.length,
    };
  }

  return {
    plausible: true,
    reason: ImplausibleReason.None,
    sustainedRate,
    peakRate: peakInWindow,
    totalChanges: changeTicks.length,
  };
}

/**
 * Checks the client's claimed wall-clock duration against the tick count.
 *
 * The sim is a fixed-rate accumulator, so `tickCount / tickRate` is exactly how
 * much GAME time a run took, on every machine, at every frame rate. Wall clock
 * can legitimately exceed it — a paused run, a backgrounded tab, a throttled
 * timer — but it can never meaningfully undercut it, because there is no
 * mechanism that makes a 60Hz sim advance faster than 60Hz.
 *
 * So the band is tight downward and loose upward, and a submission claiming
 * 3,600 ticks in four seconds is the one this catches: a script that fed the sim
 * an input log as fast as the CPU allowed rather than playing it.
 *
 * `elapsedMs` is the client's own figure and is therefore untrusted — which is
 * exactly why it is only ever used to reject, never to score. A liar can set it
 * to anything plausible; they simply gain nothing by doing so.
 */
export function checkWallClock(
  tickCount: number,
  elapsedMs: number,
): { plausible: boolean; reason: ImplausibleReasonValue; ratio: number } {
  const MS_PER_SECOND = 1000;
  const expectedMs = (tickCount / TICK_RATE) * MS_PER_SECOND;

  // A zero or missing figure is not evidence of anything. Old clients and
  // offline submissions may not carry one, and refusing those would break real
  // players to catch a cheat who would simply start sending a number.
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { plausible: true, reason: ImplausibleReason.None, ratio: 0 };
  }

  const ratio = elapsedMs / expectedMs;

  if (ratio < PLAUSIBILITY.minWallClockRatio) {
    return { plausible: false, reason: ImplausibleReason.WallClockTooShort, ratio };
  }
  if (ratio > PLAUSIBILITY.maxWallClockRatio) {
    return { plausible: false, reason: ImplausibleReason.WallClockTooLong, ratio };
  }
  return { plausible: true, reason: ImplausibleReason.None, ratio };
}
