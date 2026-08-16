/**
 * Fixed-timestep accumulator — docs/ARCHITECTURE.md §2c.
 *
 * The sim ticks at exactly 60Hz regardless of display rate. A 144Hz monitor and a
 * 60Hz monitor produce identical runs; gameplay is never tied to frame delta.
 *
 * This module never reads a wall clock. `Date.now` and `performance.now` are
 * banned in sim/ — the caller measures the frame and passes the delta in. That
 * keeps the clock itself testable and deterministic.
 */

import { TUNING } from "../config/tuning";

const FIXED_DELTA = TUNING.sim.fixedDelta;
const MAX_ACCUMULATOR = TUNING.sim.maxAccumulator;
const MAX_TICKS_PER_FRAME = TUNING.sim.maxTicksPerFrame;

export interface Clock {
  /** s — unconsumed time carried into the next frame. Always < fixedDelta after advance. */
  accumulator: number;
  /** 0..1 — accumulator remainder as a fraction of a tick. The render interpolation factor. */
  alpha: number;
  /** Ticks produced by the most recent `advance`. Diagnostic. */
  ticksLastFrame: number;
  /** Total ticks this clock has produced. Diagnostic. */
  totalTicks: number;
  /** How many times the spiral guard has clamped a frame delta. Diagnostic. */
  clampedFrames: number;
}

export function createClock(): Clock {
  return {
    accumulator: 0,
    alpha: 0,
    ticksLastFrame: 0,
    totalTicks: 0,
    clampedFrames: 0,
  };
}

/**
 * Feeds a frame delta in and returns how many sim ticks to run.
 *
 * **The spiral-of-death guard.** The delta is clamped to `maxAccumulator`
 * (0.0833s = 5 ticks) *before* it is accumulated. A 4-second stall therefore
 * yields exactly 5 ticks, not 240. Without the clamp, a slow frame produces a
 * burst of catch-up ticks, which takes longer than a frame, which produces a
 * bigger burst — the spiral. Surplus time is discarded, never simulated.
 *
 * Negative deltas are clamped to zero. A backwards clock is a caller bug, but it
 * must not run the sim in reverse.
 *
 * @returns ticks to run this frame, 0..maxTicksPerFrame
 */
export function advance(clock: Clock, deltaSeconds: number): number {
  let delta = deltaSeconds;
  if (!(delta > 0)) {
    // Also catches NaN, which would poison the accumulator permanently.
    delta = 0;
  }
  if (delta > MAX_ACCUMULATOR) {
    delta = MAX_ACCUMULATOR;
    clock.clampedFrames += 1;
  }

  clock.accumulator += delta;

  let ticks = 0;
  while (clock.accumulator >= FIXED_DELTA && ticks < MAX_TICKS_PER_FRAME) {
    clock.accumulator -= FIXED_DELTA;
    ticks += 1;
  }

  // If the cap stopped the loop early there is still a tick's worth of time
  // banked. Drop it rather than carrying it: carrying it is what turns one slow
  // frame into a sustained catch-up burst.
  if (clock.accumulator >= FIXED_DELTA) {
    clock.accumulator = 0;
  }

  clock.alpha = clock.accumulator / FIXED_DELTA;
  clock.ticksLastFrame = ticks;
  clock.totalTicks += ticks;
  return ticks;
}

/**
 * Drops all pending time without running any ticks.
 *
 * **This is the tab-backgrounded case, and it is deliberately not the same path
 * as `advance`.** When a tab is hidden the browser stops firing rAF; on return,
 * the elapsed wall time may be minutes. Clamping that to 5 ticks would still
 * lurch the world forward through obstacles the player never saw. Dropping it
 * resumes exactly where the run paused.
 *
 * The render layer calls this from its `visibilitychange` handler (P05). The sim
 * itself cannot observe focus — it has no DOM.
 */
export function resync(clock: Clock): void {
  clock.accumulator = 0;
  clock.alpha = 0;
  clock.ticksLastFrame = 0;
}

/** Resets a clock to its initial state, including diagnostics. */
export function resetClock(clock: Clock): void {
  clock.accumulator = 0;
  clock.alpha = 0;
  clock.ticksLastFrame = 0;
  clock.totalTicks = 0;
  clock.clampedFrames = 0;
}
