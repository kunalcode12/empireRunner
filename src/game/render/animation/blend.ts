/**
 * State blending, with cross-fade durations authored **per pair**.
 *
 * ## Why per-pair and not one global value
 *
 * A single blend time is the most common animation mistake and it is wrong in
 * both directions at once:
 *
 * ```
 *   run  -> jump   0.06s   must be near-instant, or the launch feels heavy and
 *                          the player's input appears to be ignored
 *   jump -> fall   0.12s   the apex hang; the ONE moment the arc should float
 *   land -> run    0.10s   a settle, not a snap
 *   *    -> slide  0.05s   a slide is a commitment; it should look decided
 *   *    -> crash  0.03s   the impact IS the readable moment
 * ```
 *
 * Pick 0.09s for all of them and the jump feels sluggish while the crash feels
 * mushy. There is no single number that serves both, which is the argument for
 * a table.
 *
 * ## One source blend, not a stack
 *
 * This blends exactly two poses: the state being left and the state being
 * entered. A full animation system would keep a weighted stack so a fast
 * sequence never pops. That is real, and it is not needed here — the states are
 * mutually exclusive and the longest fade is 120ms, so a third state arriving
 * mid-blend is rare and the visible artefact is a slightly quicker transition.
 * The cost of a stack is a per-frame allocation or a fixed pool, and neither is
 * worth paying for an artefact this small.
 */

import { TUNING } from "@/game/config/tuning";
import { AnimationState, type AnimationStateValue } from "../interpolate";
import { blendPose, copyPose, createPose, type Pose } from "./rig";

const A = TUNING.animation;

/** Smoothstep coefficients: `t² (3 − 2t)`. */
const SMOOTHSTEP_A = 3;
const SMOOTHSTEP_B = 2;

/**
 * Cross-fade duration for a specific transition, in seconds.
 *
 * Keyed on the destination first because most rules are about what you are
 * entering — a crash should be instant regardless of where it came from.
 */
export function blendDuration(from: AnimationStateValue, to: AnimationStateValue): number {
  if (to === AnimationState.Crashed || to === AnimationState.Fracturing) {
    return A.blendToCrash;
  }
  if (to === AnimationState.Sliding) {
    return A.blendToSlide;
  }
  if (from === AnimationState.Running && to === AnimationState.Jumping) {
    return A.blendRunToJump;
  }
  if (from === AnimationState.Jumping && to === AnimationState.Falling) {
    return A.blendJumpToFall;
  }
  // "Land into run" is the transition out of the landing beat. The landing beat
  // itself is a sub-state of Running, so this is Falling -> Running.
  if (from === AnimationState.Falling && to === AnimationState.Running) {
    return A.blendLandToRun;
  }
  return A.blendDefault;
}

export interface BlendState {
  /** The state being blended toward. */
  current: AnimationStateValue;
  /** The state being blended away from. */
  previous: AnimationStateValue;
  /** s — how long the active cross-fade lasts. */
  duration: number;
  /** s — how far through it we are. */
  elapsed: number;
  /** Snapshot of the pose at the moment the transition began. */
  readonly from: Pose;
  /** Scratch for the destination clip's pose this frame. */
  readonly to: Pose;
  /** The blended result. */
  readonly out: Pose;
}

export function createBlend(): BlendState {
  return {
    current: AnimationState.Running,
    previous: AnimationState.Running,
    duration: 0,
    elapsed: 0,
    from: createPose(),
    to: createPose(),
    out: createPose(),
  };
}

/**
 * Switches state, if it actually changed.
 *
 * Snapshots the CURRENT OUTPUT rather than the previous clip's ideal pose. That
 * matters when a transition is interrupted: blending away from where the body
 * actually is produces a continuous motion, whereas blending from where the old
 * clip says it should be pops.
 */
export function setState(state: BlendState, next: AnimationStateValue): void {
  if (next === state.current) {
    return;
  }
  copyPose(state.from, state.out);
  state.previous = state.current;
  state.current = next;
  state.duration = blendDuration(state.previous, next);
  state.elapsed = 0;
}

/**
 * Advances the cross-fade and writes the blended pose into `state.out`.
 *
 * @param destination the destination clip's pose for this frame.
 * @param dt real frame delta.
 */
export function stepBlend(state: BlendState, destination: Pose, dt: number): Pose {
  copyPose(state.to, destination);

  if (state.duration <= 0) {
    copyPose(state.out, state.to);
    return state.out;
  }

  state.elapsed += dt;
  if (state.elapsed >= state.duration) {
    state.duration = 0;
    state.elapsed = 0;
    copyPose(state.out, state.to);
    return state.out;
  }

  const t = state.elapsed / state.duration;
  // Smoothstep rather than linear: a linear cross-fade has a velocity
  // discontinuity at both ends, which on a 60ms blend reads as a tick.
  const eased = t * t * (SMOOTHSTEP_A - SMOOTHSTEP_B * t);
  blendPose(state.out, state.from, state.to, eased);
  return state.out;
}

/** True while a cross-fade is in progress. Diagnostic and test hook. */
export function blending(state: BlendState): boolean {
  return state.duration > 0;
}

export function resetBlend(state: BlendState): void {
  state.current = AnimationState.Running;
  state.previous = AnimationState.Running;
  state.duration = 0;
  state.elapsed = 0;
}
