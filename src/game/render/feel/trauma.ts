/**
 * Trauma-based screen shake.
 *
 * One scalar, `trauma`, in `[0, 1]`. Events add to it; it decays linearly; the
 * actual offset is driven by **`trauma²`**.
 *
 * ## Why the square matters
 *
 * With a linear mapping, a small trauma still produces a visible nudge, so the
 * screen is permanently slightly unsettled and the big hits have nowhere to go.
 * Squaring collapses the bottom of the range — trauma 0.3 gives 0.09 of the
 * amplitude — so small events are almost silent and a real crash is dramatic.
 * It also makes the tail fast: as trauma decays linearly through the low values,
 * the visible shake is already gone.
 *
 * This is the standard trauma model (Squirrel Eiserloh's GDC talk) and the
 * reason to name it here is that "shake amount" as a directly-set value is the
 * obvious alternative and is much worse — it has no natural accumulation
 * behaviour when two things happen at once.
 *
 * ## Accumulation
 *
 * Trauma adds and clamps at 1. Two near-misses in quick succession therefore
 * shake more than one, but ten do not shake ten times as much. That is the
 * correct behaviour for a game with a Flow meter built on chaining near-misses:
 * without the clamp, a good run would vibrate itself unreadable.
 */

import { TUNING } from "@/game/config/tuning";
import { getMotion } from "./reducedMotion";
import { NOISE_AXIS_ROLL, NOISE_AXIS_X, NOISE_AXIS_Y, noise1DOctaves } from "./noise";

const DECAY = TUNING.feel.traumaDecay;
const MAX_OFFSET = TUNING.feel.shakeMaxOffset;
const MAX_ROLL = TUNING.feel.shakeMaxRoll;
const FREQUENCY = TUNING.feel.shakeFrequency;

export interface ShakeOffset {
  x: number;
  y: number;
  roll: number;
}

export interface TraumaState {
  /** 0..1. */
  trauma: number;
  /** s — accumulated time, for sampling the noise. */
  elapsed: number;
  /** The current offset. Reused; do not retain. */
  readonly offset: ShakeOffset;
}

export function createTrauma(): TraumaState {
  return { trauma: 0, elapsed: 0, offset: { x: 0, y: 0, roll: 0 } };
}

/** Adds trauma, clamped at 1. */
export function addTrauma(state: TraumaState, amount: number): void {
  if (amount <= 0) {
    return;
  }
  const next = state.trauma + amount;
  state.trauma = next > 1 ? 1 : next;
}

/** Clears trauma outright. Used on reset, never mid-run. */
export function resetTrauma(state: TraumaState): void {
  state.trauma = 0;
  state.elapsed = 0;
  state.offset.x = 0;
  state.offset.y = 0;
  state.offset.roll = 0;
}

/**
 * Decays trauma and recomputes the offset.
 *
 * @param dt real frame delta. Shake is presentation, so it runs on frame time
 *           rather than sim time — it must decay at the same wall-clock rate
 *           regardless of how many sim ticks a frame produced.
 * @returns the reused offset object.
 */
export function stepTrauma(state: TraumaState, dt: number): ShakeOffset {
  state.elapsed += dt;

  const next = state.trauma - DECAY * dt;
  state.trauma = next < 0 ? 0 : next;

  const motion = getMotion();
  const offset = state.offset;

  if (state.trauma <= 0 || motion.shakeScale <= 0) {
    offset.x = 0;
    offset.y = 0;
    offset.roll = 0;
    return offset;
  }

  // The square. See the header.
  const amount = state.trauma * state.trauma * motion.shakeScale;
  const t = state.elapsed * FREQUENCY;

  offset.x = MAX_OFFSET * amount * noise1DOctaves(t + NOISE_AXIS_X);
  offset.y = MAX_OFFSET * amount * noise1DOctaves(t + NOISE_AXIS_Y);
  offset.roll = MAX_ROLL * amount * noise1DOctaves(t + NOISE_AXIS_ROLL);

  return offset;
}

/** Current shake amount, `trauma²`. Exposed for tests and diagnostics. */
export function shakeAmount(state: TraumaState): number {
  return state.trauma * state.trauma;
}
