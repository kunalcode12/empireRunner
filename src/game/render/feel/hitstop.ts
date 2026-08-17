/**
 * Hit-stop — a few frames where the picture holds still and the sim does not.
 *
 * ## The distinction that makes this legal
 *
 * **The simulation keeps ticking. Only presentation freezes.**
 *
 * That is not a detail, it is the whole design constraint. Freezing the sim
 * would change gameplay: the player would get 90ms of free time, inputs during
 * the freeze would be swallowed or duplicated, and — fatally — a replay recorded
 * with hit-stop would not re-simulate on a server that has no renderer. Law (a)
 * would be dead. So the sim runs on, and the render layer simply declines to
 * update its transforms for a few frames.
 *
 * The visible result is that the world snaps forward when the freeze lifts. That
 * snap IS the effect. It reads as impact because the brain interprets the
 * discontinuity as force.
 *
 * ## Why this is worth more than particles
 *
 * A collision without hit-stop is a state change: the character was running, now
 * they are not. Nothing communicates that two objects touched with force.
 * Debris, sparks and shake all decorate an impact that the player has already
 * failed to feel. Hit-stop creates the impact itself, and it costs a boolean and
 * a timer.
 *
 * ## The accumulation cap
 *
 * During Overdrive a burst of shatters can arrive in one frame. Each wants a
 * 60ms freeze; six of them would be a 360ms lockup that reads as the game
 * hanging. `hitStopMax` caps the total, so a dense burst freezes once, hard,
 * rather than once per obstacle.
 */

import { TUNING } from "@/game/config/tuning";

const CRASH = TUNING.feel.hitStopCrash;
const SHATTER = TUNING.feel.hitStopShatter;
const MAX = TUNING.feel.hitStopMax;

export interface HitStopState {
  /** s — remaining frozen time. */
  remaining: number;
  /** count — freezes triggered this run. Diagnostic. */
  triggered: number;
}

export function createHitStop(): HitStopState {
  return { remaining: 0, triggered: 0 };
}

/** True while presentation should hold its last frame. */
export function frozen(state: HitStopState): boolean {
  return state.remaining > 0;
}

/**
 * Requests a freeze of `seconds`.
 *
 * Takes the LONGER of the current and requested freeze rather than summing, then
 * clamps. Summing lets a burst stack into a hang; taking the max means the
 * hardest hit in a cluster decides the duration, which is what the player would
 * expect anyway.
 */
export function requestHitStop(state: HitStopState, seconds: number): void {
  if (seconds <= 0) {
    return;
  }
  const next = Math.max(state.remaining, seconds);
  state.remaining = next > MAX ? MAX : next;
  state.triggered += 1;
}

/** Freeze for a fatal crash. */
export function hitStopCrash(state: HitStopState): void {
  requestHitStop(state, CRASH);
}

/** Freeze for an Overdrive shatter. */
export function hitStopShatter(state: HitStopState): void {
  requestHitStop(state, SHATTER);
}

/**
 * Ages the freeze.
 *
 * @param dt real frame delta — this is wall-clock, not sim time.
 * @returns true if presentation is frozen for THIS frame.
 */
export function stepHitStop(state: HitStopState, dt: number): boolean {
  if (state.remaining <= 0) {
    return false;
  }
  state.remaining -= dt;
  if (state.remaining < 0) {
    state.remaining = 0;
  }
  // Frozen for this frame regardless of whether the timer just expired: the
  // frame that consumed the last of the budget is still a frozen frame.
  return true;
}

export function resetHitStop(state: HitStopState): void {
  state.remaining = 0;
  state.triggered = 0;
}
