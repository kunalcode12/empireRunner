/**
 * The clips — hand-authored pose curves, one per animation state.
 *
 * Each is a pure function of a phase value, so they are testable without a
 * renderer and cost nothing to evaluate.
 *
 * ## The run cycle is driven by DISTANCE, not time
 *
 * `runClip` takes a phase derived from `distance / strideLength`, so one stride
 * always covers exactly one stride's worth of ground and **the feet never
 * skate**. The alternative — a time-driven cycle whose playback rate is
 * multiplied by speed — is the same idea done indirectly, and it drifts: any
 * error in the rate integrates into a permanent phase offset, and `worldSpeed`
 * here ranges over nearly 3x, so the error is not small.
 *
 * ## Why the poses are what they are
 *
 * A run reads from three things and almost nothing else at this silhouette
 * size: arms and legs in **counter-phase** (left arm forward with right leg),
 * a **two-per-stride vertical bob** (the body rises on each push-off, so twice
 * per full cycle), and a **forward torso lean**. Knees bend only on the
 * recovery half of each leg's swing, because a knee that bends while the leg is
 * planted looks broken.
 */

import { TUNING } from "@/game/config/tuning";
import { createPose, type Pose } from "./rig";

const A = TUNING.animation;
const TAU = Math.PI * 2;

/**
 * ⚠ **EVERY CLIP RETURNS THIS SAME OBJECT.**
 *
 * Clips are evaluated once per frame in the hot path, and returning a fresh
 * `Pose` from each would be one 17-field allocation per frame per call. So they
 * all write into one shared scratch and return a reference to it — the same
 * pattern the sim uses for `EscapeSolution` and `advanceVertical`.
 *
 * The consequence, which is a genuine trap:
 *
 * ```ts
 *   const a = runClip(0);      // a and b are THE SAME OBJECT
 *   const b = jumpClip();      // and both now hold the jump pose
 * ```
 *
 * **Read or copy the result before calling another clip.** `RunnerRig` is safe
 * because `stepBlend` copies into its own buffer immediately; `rollClip` is safe
 * because it deliberately mutates the run pose it just built. Anything else that
 * wants to hold two poses must `copyPose` first.
 *
 * This was found by a test that compared seven clips and got seven identical
 * silhouettes.
 */
const scratch: Pose = createPose();

function reset(): Pose {
  const p = scratch;
  p.rootY = 0;
  p.torsoPitch = 0;
  p.torsoRoll = 0;
  p.torsoYaw = 0;
  p.torsoCrouch = 0;
  p.headPitch = 0;
  p.headYaw = 0;
  p.armLeft = 0;
  p.armRight = 0;
  p.elbowLeft = 0;
  p.elbowRight = 0;
  p.legLeft = 0;
  p.legRight = 0;
  p.kneeLeft = 0;
  p.kneeRight = 0;
  p.scaleY = 1;
  p.scaleXZ = 1;
  return p;
}

/**
 * The run cycle.
 *
 * @param phase 0..1 through one full stride (both feet). Derived from distance.
 */
export function runClip(phase: number): Pose {
  const p = reset();
  const t = phase * TAU;

  const swing = Math.sin(t);
  const counter = Math.sin(t + Math.PI);

  p.legLeft = A.runSwing * swing;
  p.legRight = A.runSwing * counter;
  // Arms counter-swing the legs. Slightly smaller amplitude — real arms swing
  // less than legs, and matching them exactly reads as a march.
  const ARM_RATIO = 0.75;
  p.armLeft = A.runSwing * counter * ARM_RATIO;
  p.armRight = A.runSwing * swing * ARM_RATIO;

  // Knees bend on the recovery half only: when the leg is swinging FORWARD it
  // is off the ground and folds; when it is swinging back it is planted.
  const KNEE_MAX = 1.15;
  p.kneeLeft = Math.max(0, -swing) * KNEE_MAX;
  p.kneeRight = Math.max(0, -counter) * KNEE_MAX;

  // Elbows hold a constant working bend rather than animating; at this size an
  // animated elbow is invisible and just costs a sine.
  const ELBOW_HOLD = 0.55;
  p.elbowLeft = ELBOW_HOLD;
  p.elbowRight = ELBOW_HOLD;

  // Two bounces per stride — one per push-off. `abs(sin)` would give the same
  // count with a sharper trough, which reads as a limp; cos(2t) is smoother.
  p.rootY = -A.runBob * Math.cos(t * 2);
  p.torsoPitch = A.runLean;

  return p;
}

/** Rising. Legs tucked, arms up — a committed launch silhouette. */
export function jumpClip(): Pose {
  const p = reset();
  p.legLeft = A.jumpTuck * 0.6;
  p.legRight = A.jumpTuck * 0.4;
  p.kneeLeft = A.jumpTuck;
  p.kneeRight = A.jumpTuck * 0.8;
  p.armLeft = -A.jumpTuck * 0.9;
  p.armRight = -A.jumpTuck * 0.9;
  p.elbowLeft = 0.3;
  p.elbowRight = 0.3;
  p.torsoPitch = -0.1;
  p.rootY = 0.04;
  return p;
}

/** Falling. Legs reaching down for the ground — the anticipation of landing. */
export function fallClip(): Pose {
  const p = reset();
  p.legLeft = -A.fallReach * 0.4;
  p.legRight = -A.fallReach * 0.2;
  p.kneeLeft = A.fallReach * 0.4;
  p.kneeRight = A.fallReach * 0.3;
  p.armLeft = -A.fallReach;
  p.armRight = -A.fallReach * 0.7;
  p.elbowLeft = 0.5;
  p.elbowRight = 0.5;
  p.torsoPitch = 0.12;
  return p;
}

/** The landing beat. Deep crouch; the squash layer adds the rest. */
export function landClip(): Pose {
  const p = reset();
  const CROUCH = 0.22;
  p.rootY = -CROUCH;
  p.kneeLeft = 1.1;
  p.kneeRight = 1.1;
  p.legLeft = 0.25;
  p.legRight = 0.25;
  p.torsoPitch = 0.4;
  p.armLeft = -0.5;
  p.armRight = -0.5;
  p.elbowLeft = 0.9;
  p.elbowRight = 0.9;
  return p;
}

/** Sliding. Nearly flat, trailing leg extended. */
export function slideClip(): Pose {
  const p = reset();
  p.torsoPitch = A.slidePitch;
  p.torsoCrouch = 0.5;
  p.rootY = -TUNING.geometry.playerHeightStand * 0.3;
  p.legLeft = 0.9;
  p.legRight = -0.2;
  p.kneeLeft = 1.4;
  p.kneeRight = 0.2;
  p.armLeft = 0.8;
  p.armRight = -0.6;
  p.elbowLeft = 0.4;
  p.elbowRight = 0.2;
  p.headPitch = -0.5;
  return p;
}

/**
 * Rolling, as a grounded state.
 *
 * Deliberately close to the run: GAME_BIBLE §3.2 says the WORLD rotates and the
 * player does not, so the runner should look like they are holding their line
 * while everything swings around them. The visible drama comes from the torso
 * counter-rotation in the procedural layer, not from a distinct pose.
 */
export function rollClip(phase: number): Pose {
  const p = runClip(phase);
  const BRACE = 0.3;
  p.armLeft -= BRACE;
  p.armRight -= BRACE;
  p.torsoPitch += 0.08;
  return p;
}

/** Stumbling. Fast, ugly flailing — a fumble, and it should look like one. */
export function stumbleClip(elapsed: number): Pose {
  const p = reset();
  const t = elapsed * A.stumbleFrequency;
  p.torsoPitch = 0.55 + Math.sin(t) * 0.2;
  p.torsoRoll = Math.sin(t * 1.7) * 0.3;
  p.armLeft = A.stumbleFlail * Math.sin(t * 1.3);
  p.armRight = A.stumbleFlail * Math.sin(t * 1.1 + 2);
  p.elbowLeft = 0.7;
  p.elbowRight = 0.5;
  p.legLeft = 0.5 * Math.sin(t * 0.9);
  p.legRight = 0.5 * Math.sin(t * 0.9 + Math.PI);
  p.kneeLeft = 0.6;
  p.kneeRight = 0.4;
  p.rootY = -0.1;
  return p;
}

/** Crashed. Collapsed and still. P09's ragdoll replaces this. */
export function crashClip(): Pose {
  const p = reset();
  p.torsoPitch = 1.4;
  p.torsoCrouch = 0.7;
  p.rootY = -TUNING.geometry.playerHeightStand * 0.35;
  p.armLeft = 1.2;
  p.armRight = 0.9;
  p.elbowLeft = 1.1;
  p.elbowRight = 0.8;
  p.legLeft = 0.6;
  p.legRight = 0.3;
  p.kneeLeft = 1.3;
  p.kneeRight = 0.9;
  p.headPitch = 0.6;
  return p;
}

/** Idle. Standing, breathing. Only seen before a run starts. */
export function idleClip(elapsed: number): Pose {
  const p = reset();
  const BREATH_RATE = 1.6;
  const BREATH_DEPTH = 0.012;
  p.rootY = Math.sin(elapsed * BREATH_RATE) * BREATH_DEPTH;
  p.elbowLeft = 0.25;
  p.elbowRight = 0.25;
  p.armLeft = 0.08;
  p.armRight = -0.08;
  return p;
}

/** Fracturing. Frozen mid-fall, suspended. */
export function fracturingClip(): Pose {
  const p = reset();
  p.torsoPitch = 0.7;
  p.armLeft = -0.9;
  p.armRight = -1.1;
  p.elbowLeft = 0.6;
  p.elbowRight = 0.4;
  p.legLeft = -0.4;
  p.legRight = 0.5;
  p.kneeLeft = 0.5;
  p.kneeRight = 0.8;
  p.rootY = 0.1;
  return p;
}

/** Celebrating. Not reachable in a run yet; P14's end screen uses it. */
export function celebrateClip(elapsed: number): Pose {
  const p = reset();
  const RATE = 4.0;
  p.armLeft = -2.2 + Math.sin(elapsed * RATE) * 0.2;
  p.armRight = -2.2 + Math.sin(elapsed * RATE + 1) * 0.2;
  p.elbowLeft = 0.2;
  p.elbowRight = 0.2;
  p.rootY = Math.abs(Math.sin(elapsed * RATE * 0.5)) * 0.12;
  p.torsoPitch = -0.15;
  p.headPitch = -0.2;
  return p;
}
