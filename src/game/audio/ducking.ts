/**
 * Side-chain ducking — the music steps out of the way of gameplay sounds.
 *
 * ## Why this is not just "mix the music quieter"
 *
 * Music and impacts occupy the same frequency ranges. Without ducking there are
 * only two stable outcomes: music loud enough to matter, which masks the crash
 * that just ended the run, or music quiet enough to never mask anything, which
 * is music nobody notices. Ducking gets both — the music sits at a real level
 * and gets out of the way for 180 milliseconds whenever something happens.
 *
 * ## The shape
 *
 * Attack is a **linear** ramp over 8ms. Fast enough to have cleared the way
 * before the transient it is ducking for arrives, slow enough that the gain
 * change itself is not a click.
 *
 * Release is `setTargetAtTime`, which is exponential — the same curve a
 * hardware compressor releases on, and the reason a duck breathes rather than
 * snapping back. `setTargetAtTime` takes a *time constant*, not a duration: it
 * reaches roughly 95% of the way back after three of them, so the tuned
 * `duckRelease` of 180ms is divided by three to get the constant.
 *
 * ## Dips coalesce instead of stacking
 *
 * A shatter burst during Overdrive fires eight sounds inside one frame. Eight
 * independent dips of 0.3 multiply out to 0.06 — the music is gone, and the
 * ducking has silently become a mute button. So a new dip is only scheduled if
 * it is deeper than what is already in progress, estimated from the release
 * curve. The loudest sound in a cluster owns the duck; the rest ride it.
 *
 * ## This node is owned exclusively
 *
 * The ducker automates `buses.musicDuck` and nothing else may touch it. The
 * player's music volume lives on a separate node upstream (`buses.music`) for
 * exactly this reason — see `engine.ts`. Two writers on one `AudioParam`
 * overwrite each other's automation, and the symptom is music that gets quieter
 * with every crash and never recovers.
 */

import { TUNING } from "@/game/config/tuning";

/** `setTargetAtTime` reaches ~95% after three time constants. */
const RELEASE_TAU_DIVISOR = 3;
/** The un-ducked level. The node is a pure attenuator. */
const NEUTRAL = 1;

export interface Ducker {
  /**
   * Requests a dip.
   *
   * @param now    absolute context time the dip should begin
   * @param amount 0..1 — the triggering sound's loudness, scaling `duckDepth`
   */
  trigger(now: number, amount: number): void;
  /** The dip currently scheduled, as a depth in 0..1. Diagnostic. */
  depthAt(now: number): number;
  /** Cancels any dip and returns to neutral. Run end and teardown. */
  reset(now: number): void;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

export function createDucker(param: AudioParam): Ducker {
  const attack = TUNING.audio.duckAttack;
  const tau = TUNING.audio.duckRelease / RELEASE_TAU_DIVISOR;

  let activeDepth = 0;
  let attackEnd = Number.NEGATIVE_INFINITY;

  /**
   * How deep the existing dip still is.
   *
   * During the attack the dip is still deepening, so it counts as already at
   * full depth — otherwise a second sound 2ms later would re-trigger and reset
   * the ramp, which produces a staircase instead of a duck.
   */
  function remaining(now: number): number {
    if (activeDepth <= 0) {
      return 0;
    }
    if (now < attackEnd) {
      return activeDepth;
    }
    // Math.exp is permitted outside src/game/sim/**. This is presentation and
    // never reaches a replay.
    return activeDepth * Math.exp(-(now - attackEnd) / tau);
  }

  return {
    trigger(now: number, amount: number): void {
      const depth = Math.min(TUNING.audio.duckMaxDepth, TUNING.audio.duckDepth * clamp01(amount));
      if (depth <= 0 || depth <= remaining(now)) {
        return;
      }

      const end = now + attack;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(NEUTRAL - depth, end);
      param.setTargetAtTime(NEUTRAL, end, tau);

      activeDepth = depth;
      attackEnd = end;
    },

    depthAt(now: number): number {
      return remaining(now);
    },

    reset(now: number): void {
      param.cancelScheduledValues(now);
      param.setValueAtTime(NEUTRAL, now);
      activeDepth = 0;
      attackEnd = Number.NEGATIVE_INFINITY;
    },
  };
}
