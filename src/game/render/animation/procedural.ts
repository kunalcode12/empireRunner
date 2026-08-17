/**
 * The procedural layer — three behaviours applied ON TOP of the blended clip.
 *
 * Clips give you the gait. These give you the sense that the character is
 * reacting to the world rather than playing back a loop, and all three are
 * driven by live sim state that no clip could know about.
 *
 * ```
 *   1. lean into a lane change      from the player's lateral input
 *   2. torso counter-rotation       from the in-flight roll
 *   3. head tracking                toward the nearest hazard ahead
 * ```
 *
 * ## Why (2) is not simply "rotate with the world"
 *
 * GAME_BIBLE §3.2: during a roll the entire tunnel rotates 90 degrees and **the
 * player does not**. Taken literally that means the runner is static in their
 * own frame for 0.3 seconds — the most dramatic move in the game and the
 * character does nothing.
 *
 * Counter-rotating the torso AGAINST the world's rotation fixes that without
 * violating the rule: the body still ends up where the sim says it is, but
 * during the roll it twists into the turn like someone driving it. Remove this
 * and the roll reads as the camera doing something to you.
 *
 * ## Why (3) is worth the scan
 *
 * Head tracking is the cheapest possible "this character is alive" signal, and
 * here it does real work: the runner looks at the thing that is about to kill
 * them a beat before the player has consciously registered it. It is a free
 * telegraph, built out of the entity data the renderer already walks.
 */

import { TUNING } from "@/game/config/tuning";
import { damp } from "../interpolate";
import { getMotion } from "../feel/reducedMotion";
import type { EntityColumns } from "@/game/sim/state";
import { entityDef } from "@/game/sim/level/entities";
import type { Pose } from "./rig";

const A = TUNING.animation;

/** Head tracking survives reduced motion at half amplitude: it points at the
 *  hazard, so it is information, but a large head swing is itself motion. */
const REDUCED_HEAD_TRACK = 0.5;

export interface ProceduralState {
  /** Current bank, radians. */
  lean: number;
  /** Current torso counter-rotation, radians. */
  counterRotation: number;
  /** Current head yaw, radians. */
  headYaw: number;
  /** Previous world roll, to derive angular velocity. */
  lastRoll: number;
}

export function createProcedural(): ProceduralState {
  return { lean: 0, counterRotation: 0, headYaw: 0, lastRoll: 0 };
}

export function resetProcedural(state: ProceduralState): void {
  state.lean = 0;
  state.counterRotation = 0;
  state.headYaw = 0;
  state.lastRoll = 0;
}

/**
 * Finds the lateral offset of the nearest hazard worth looking at.
 *
 * Returns `NaN` when there is nothing — the caller centres the head rather than
 * treating "nothing" as "straight ahead", which are different intents.
 *
 * Only obstacles on the player's own face count. A wall on the ceiling is not
 * something the runner would turn toward, and including them made the head
 * twitch constantly during dense sections.
 */
export function nearestHazardX(obstacles: EntityColumns, playerFace: number): number {
  let bestZ = Number.POSITIVE_INFINITY;
  let bestX = Number.NaN;

  for (let i = 0; i < obstacles.count; i += 1) {
    if (obstacles.active[i] !== 1) {
      continue;
    }
    if (obstacles.face[i] !== playerFace) {
      continue;
    }
    const def = entityDef(obstacles.kind[i] ?? 0);
    if (!def.fatal || def.pickup) {
      continue;
    }
    const z = obstacles.z[i] ?? 0;
    if (z <= 0 || z > A.headTrackRange || z >= bestZ) {
      continue;
    }
    bestZ = z;
    bestX = obstacles.x[i] ?? 0;
  }

  return bestX;
}

export interface ProceduralInputs {
  /** -1..1 — the player's lateral intent this frame. */
  laneBias: number;
  /** rad — interpolated world roll. */
  worldRoll: number;
  /** u — player's lateral position. */
  playerX: number;
  /** Lateral offset of the nearest hazard, or NaN for none. */
  hazardX: number;
  /** s — real frame delta. */
  dt: number;
}

/**
 * Applies all three layers to `pose`, in place.
 *
 * Additive rather than overriding, so a clip that already sets `torsoRoll` (the
 * stumble does) keeps its motion and gets the bank on top.
 */
export function applyProcedural(
  state: ProceduralState,
  pose: Pose,
  inputs: ProceduralInputs,
): void {
  const { laneBias, worldRoll, playerX, hazardX, dt } = inputs;
  const motion = getMotion();

  // ── 1. Lean into the lane change ──────────────────────────────────────────
  // Banking AWAY from the direction of travel is the instinct to write and it
  // is wrong: a runner cutting left drops their left shoulder into the turn,
  // like a motorcycle. Hence the negative.
  const leanTarget = -laneBias * A.leanIntoLane;
  state.lean = damp(state.lean, leanTarget, A.leanRate, dt);
  pose.torsoRoll += state.lean;

  // ── 2. Torso counter-rotation during a roll ───────────────────────────────
  // Driven by the world's angular velocity, so it appears only while the roll
  // is actually turning and unwinds once it settles. `tanh` saturates it, so a
  // fast roll does not twist the torso past anatomical nonsense.
  const rollDelta = worldRoll - state.lastRoll;
  state.lastRoll = worldRoll;
  const angularVelocity = dt > 0 ? rollDelta / dt : 0;
  const counterTarget = -Math.tanh(angularVelocity) * A.rollCounterRotation;
  state.counterRotation = damp(state.counterRotation, counterTarget, A.rollCounterRate, dt);
  pose.torsoYaw += state.counterRotation;

  // ── 3. Head tracking ──────────────────────────────────────────────────────
  // Reduced motion keeps this: it is information, not decoration — it points at
  // the hazard. Only the amplitude is trimmed, and only because a large head
  // swing is itself motion.
  let headTarget = 0;
  if (Number.isFinite(hazardX)) {
    const offset = hazardX - playerX;
    const LANE_SPAN = TUNING.geometry.laneWidth * TUNING.geometry.laneCount;
    const normalised = Math.max(-1, Math.min(1, offset / LANE_SPAN));
    headTarget = normalised * A.headTrackMax * (motion.reduced ? REDUCED_HEAD_TRACK : 1);
  }
  state.headYaw = damp(state.headYaw, headTarget, A.headTrackRate, dt);
  pose.headYaw += state.headYaw;
}
