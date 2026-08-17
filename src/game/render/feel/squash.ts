/**
 * Squash and stretch on landing.
 *
 * The oldest trick in animation and still the cheapest way to give a jump
 * weight. A character that lands and instantly resumes its idle silhouette has
 * no mass; one that compresses on contact and springs back has been accelerated
 * by gravity and stopped by the ground.
 *
 * ## Scaled by impact velocity, which is the part usually skipped
 *
 * A fixed squash on every landing is worse than none: a small hop and a fall
 * from apex produce the same compression, so the effect stops carrying
 * information and becomes a tic. Scaling by the vertical speed at contact makes
 * the squash *tell* the player how hard they landed — and after a fast-drop, which
 * slams down at `fastDropSpeed` 28 u/s, it is dramatic, which is exactly right
 * for a technique that is supposed to feel decisive.
 *
 * ## Volume preservation
 *
 * Squashing y without widening x and z reads as the model shrinking rather than
 * deforming. The horizontal scale is the inverse square root of the vertical
 * one, which holds volume roughly constant — the standard approximation, and
 * close enough that nobody will measure it.
 *
 * Disabled entirely under reduced motion: it is pure decoration and carries no
 * information the landing itself does not already convey.
 */

import { TUNING } from "@/game/config/tuning";
import { getMotion } from "./reducedMotion";

const SQUASH_MAX = TUNING.feel.squashMax;
const FULL_IMPACT = TUNING.feel.squashFullImpactSpeed;
const RECOVERY = TUNING.feel.squashRecovery;
const STRETCH_MAX = TUNING.feel.stretchMax;
const JUMP_IMPULSE = TUNING.vertical.jumpImpulse;

export interface SquashState {
  /** Current deformation. Negative squashes, positive stretches. */
  amount: number;
}

export function createSquash(): SquashState {
  return { amount: 0 };
}

/**
 * Registers a landing.
 *
 * @param impactSpeed u/s — downward speed at contact, as a positive magnitude.
 */
export function land(state: SquashState, impactSpeed: number): void {
  const motion = getMotion();
  if (motion.squashScale <= 0) {
    return;
  }
  const strength = Math.min(1, Math.abs(impactSpeed) / FULL_IMPACT);
  state.amount = -SQUASH_MAX * strength * motion.squashScale;
}

/**
 * Applies airborne stretch.
 *
 * Only while rising, and only a fraction of the squash magnitude. Stretching on
 * the way down as well would fight the squash that is about to happen.
 */
export function setRisingStretch(state: SquashState, verticalSpeed: number): void {
  const motion = getMotion();
  if (motion.squashScale <= 0 || verticalSpeed <= 0) {
    return;
  }
  const strength = Math.min(1, verticalSpeed / JUMP_IMPULSE);
  const target = STRETCH_MAX * strength * motion.squashScale;
  if (target > state.amount) {
    state.amount = target;
  }
}

/** Springs the deformation back toward neutral. `dt` is real frame time. */
export function stepSquash(state: SquashState, dt: number): void {
  if (state.amount === 0) {
    return;
  }
  // Exponential recovery, frame-rate independent for the same reason the camera
  // damping is — see interpolate.damp.
  state.amount *= Math.exp(-RECOVERY * dt);
  const EPSILON = 1e-4;
  if (Math.abs(state.amount) < EPSILON) {
    state.amount = 0;
  }
}

/** Vertical scale multiplier to apply to the rig. */
export function verticalScale(state: SquashState): number {
  return 1 + state.amount;
}

/**
 * Horizontal scale multiplier. Inverse-square-root of vertical, so volume is
 * roughly preserved and the character deforms rather than shrinking.
 */
export function horizontalScale(state: SquashState): number {
  const vertical = verticalScale(state);
  if (vertical <= 0) {
    return 1;
  }
  return 1 / Math.sqrt(vertical);
}

export function resetSquash(state: SquashState): void {
  state.amount = 0;
}
