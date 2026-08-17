/**
 * The runner's skeleton — a pose, as plain numbers.
 *
 * ## No model files, deliberately
 *
 * There is no `.glb` in this repo and this file references none. A blocky
 * character built from primitives and animated by hand reads better than a
 * detailed model that T-poses because its clip failed to load, and it cannot
 * 404 at runtime — which CLAUDE.md bans outright.
 *
 * The trade is real and worth stating: procedural animation gets you weight,
 * timing and readability, and it does not get you personality or secondary
 * motion. When a rigged model arrives it replaces `RunnerRig`'s internals; this
 * file's `Pose` is what an animation graph would output anyway, so the boundary
 * survives the swap.
 *
 * ## A pose is a flat struct, not a scene graph
 *
 * Every field is a scalar the rig applies to one primitive. No `Object3D`, no
 * matrices, no nesting — those live in `RunnerRig.tsx`, and keeping them out of
 * here means clips and blending are pure maths that unit-test without a WebGL
 * context.
 *
 * All rotations are radians. All offsets are world units at the rig's own scale.
 */

import { TUNING } from "@/game/config/tuning";

const HEIGHT = TUNING.geometry.playerHeightStand;

/**
 * One frame of the runner, fully specified.
 *
 * Sixteen numbers. That is the whole character, and it is enough: the eye reads
 * a run cycle from hip and shoulder counter-swing plus a two-per-stride bob, and
 * almost nothing else at this silhouette size.
 */
export interface Pose {
  /** u — root vertical offset, for the run bob and the crouch. */
  rootY: number;
  /** rad — torso pitch. Positive leans forward. */
  torsoPitch: number;
  /** rad — torso roll, for banking into a lane change. */
  torsoRoll: number;
  /** rad — torso yaw, for the roll counter-rotation. */
  torsoYaw: number;
  /** u — how much the torso compresses toward the hips. Slide and crash. */
  torsoCrouch: number;

  /** rad — head pitch. */
  headPitch: number;
  /** rad — head yaw, for hazard tracking. */
  headYaw: number;

  /** rad — left/right arm swing about the shoulder. Positive swings forward. */
  armLeft: number;
  armRight: number;
  /** rad — elbow bend. */
  elbowLeft: number;
  elbowRight: number;

  /** rad — left/right leg swing about the hip. Positive swings forward. */
  legLeft: number;
  legRight: number;
  /** rad — knee bend. Always positive; a knee does not bend forward. */
  kneeLeft: number;
  kneeRight: number;

  /** x — overall vertical scale, for squash and stretch. */
  scaleY: number;
  /** x — overall horizontal scale. */
  scaleXZ: number;
}

/** A neutral standing pose. */
export function createPose(): Pose {
  return {
    rootY: 0,
    torsoPitch: 0,
    torsoRoll: 0,
    torsoYaw: 0,
    torsoCrouch: 0,
    headPitch: 0,
    headYaw: 0,
    armLeft: 0,
    armRight: 0,
    elbowLeft: 0,
    elbowRight: 0,
    legLeft: 0,
    legRight: 0,
    kneeLeft: 0,
    kneeRight: 0,
    scaleY: 1,
    scaleXZ: 1,
  };
}

/** Copies `src` into `dst`. Allocates nothing. */
export function copyPose(dst: Pose, src: Pose): void {
  dst.rootY = src.rootY;
  dst.torsoPitch = src.torsoPitch;
  dst.torsoRoll = src.torsoRoll;
  dst.torsoYaw = src.torsoYaw;
  dst.torsoCrouch = src.torsoCrouch;
  dst.headPitch = src.headPitch;
  dst.headYaw = src.headYaw;
  dst.armLeft = src.armLeft;
  dst.armRight = src.armRight;
  dst.elbowLeft = src.elbowLeft;
  dst.elbowRight = src.elbowRight;
  dst.legLeft = src.legLeft;
  dst.legRight = src.legRight;
  dst.kneeLeft = src.kneeLeft;
  dst.kneeRight = src.kneeRight;
  dst.scaleY = src.scaleY;
  dst.scaleXZ = src.scaleXZ;
}

/**
 * Blends `a` toward `b` by `t`, into `out`. Allocates nothing.
 *
 * Every field is a plain scalar lerp. That is correct here because no field is
 * an angle that can wrap — a knee never rotates past pi, a torso never spins —
 * so shortest-path logic would only add cost and a branch. The one field that
 * DOES wrap, the world roll, is not in this struct; it is applied by the scene
 * graph outside the rig.
 */
export function blendPose(out: Pose, a: Pose, b: Pose, t: number): void {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  out.rootY = a.rootY + (b.rootY - a.rootY) * k;
  out.torsoPitch = a.torsoPitch + (b.torsoPitch - a.torsoPitch) * k;
  out.torsoRoll = a.torsoRoll + (b.torsoRoll - a.torsoRoll) * k;
  out.torsoYaw = a.torsoYaw + (b.torsoYaw - a.torsoYaw) * k;
  out.torsoCrouch = a.torsoCrouch + (b.torsoCrouch - a.torsoCrouch) * k;
  out.headPitch = a.headPitch + (b.headPitch - a.headPitch) * k;
  out.headYaw = a.headYaw + (b.headYaw - a.headYaw) * k;
  out.armLeft = a.armLeft + (b.armLeft - a.armLeft) * k;
  out.armRight = a.armRight + (b.armRight - a.armRight) * k;
  out.elbowLeft = a.elbowLeft + (b.elbowLeft - a.elbowLeft) * k;
  out.elbowRight = a.elbowRight + (b.elbowRight - a.elbowRight) * k;
  out.legLeft = a.legLeft + (b.legLeft - a.legLeft) * k;
  out.legRight = a.legRight + (b.legRight - a.legRight) * k;
  out.kneeLeft = a.kneeLeft + (b.kneeLeft - a.kneeLeft) * k;
  out.kneeRight = a.kneeRight + (b.kneeRight - a.kneeRight) * k;
  out.scaleY = a.scaleY + (b.scaleY - a.scaleY) * k;
  out.scaleXZ = a.scaleXZ + (b.scaleXZ - a.scaleXZ) * k;
}

/**
 * Proportions, as fractions of `playerHeightStand`.
 *
 * Derived from the collider height rather than invented, so the grey-box is
 * honest about how big the player actually is. A character visibly larger or
 * smaller than its hitbox teaches the wrong thing about the game's fairness for
 * as long as it is on screen.
 */
export const PROPORTIONS = {
  totalHeight: HEIGHT,
  hipHeight: HEIGHT * 0.48,
  torsoLength: HEIGHT * 0.3,
  headRadius: HEIGHT * 0.1,
  neckHeight: HEIGHT * 0.8,
  shoulderWidth: HEIGHT * 0.19,
  hipWidth: HEIGHT * 0.12,
  upperLimb: HEIGHT * 0.24,
  lowerLimb: HEIGHT * 0.24,
  limbThickness: HEIGHT * 0.075,
  torsoWidth: HEIGHT * 0.22,
  torsoDepth: HEIGHT * 0.14,
} as const;
