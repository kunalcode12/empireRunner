/**
 * The face/lane transform — what a roll does to your position in the prism.
 *
 * This is the single easiest thing in the controller to get subtly wrong, so it
 * lives here on its own, as pure functions with no state, and `facing.test.ts`
 * exercises all 24 cases (4 faces x 3 lanes x 2 directions) exhaustively.
 *
 * ## The rule, and why
 *
 * ```
 *   roll RIGHT:  face -> (face + 1) mod 4      lane -> (laneCount - 1) - lane
 *   roll LEFT:   face -> (face + 3) mod 4      lane -> (laneCount - 1) - lane
 * ```
 *
 * The lane mirrors in **both** directions. That surprises people, so here is the
 * derivation from GAME_BIBLE §3.2, using a right roll:
 *
 * Lane 2 on face 0 sits nearest the corner shared by face 0 and face 1. Roll
 * right and face 1 becomes the floor — but that shared corner is now at the
 * *left* edge of the new floor. The player was near that corner and is still
 * near that corner, so they land in lane 0.
 *
 * Concretely, with the floor spanning x in [-3.6, +3.6] at y = -3.6 and the
 * right wall at x = +3.6, a right roll maps world points (x, y) -> (y, -x):
 *
 * ```
 *   corner (face0/face1) = (+3.6, -3.6)  ->  (-3.6, -3.6)   left edge of new floor
 *   corner (face0/face3) = (-3.6, -3.6)  ->  (-3.6, +3.6)   ceiling, far away
 * ```
 *
 * So "near the shared corner" becomes "near the left edge": lane 2 -> lane 0.
 * By symmetry the same mirror holds rolling left. Preserving the lane index
 * instead would teleport the player laterally across the tunnel, which is the
 * alternative GAME_BIBLE §3.2 explicitly rejects.
 *
 * ## The lateral coordinate follows for free
 *
 * Lane centres are `x = (lane - 1) * laneWidth`. Substituting the mirror:
 *
 * ```
 *   x' = (2 - lane - 1) * w = (1 - lane) * w = -(lane - 1) * w = -x
 * ```
 *
 * A roll simply negates `x`. That holds mid-tween too, which is what lets a lane
 * change survive a roll without a special case — see `mirrorLateral`.
 */

import { TUNING } from "@/game/config/tuning";

const FACE_COUNT = TUNING.geometry.faceCount;
const LANE_COUNT = TUNING.geometry.laneCount;
const LANE_WIDTH = TUNING.geometry.laneWidth;

/** Highest valid lane index. */
const MAX_LANE = LANE_COUNT - 1;
/** Lane index of centre. Used to centre `x` on zero. */
const CENTRE_LANE = (LANE_COUNT - 1) / 2;

/** Roll directions. Matches `Intent.roll`. */
export const RollDirection = {
  None: 0,
  Left: -1,
  Right: 1,
} as const;
export type RollDirectionValue = (typeof RollDirection)[keyof typeof RollDirection];

/**
 * The face a roll lands on.
 *
 * Right advances +1, left advances -1, both modulo `faceCount`. Adding
 * `FACE_COUNT` before the modulo keeps the result non-negative — JavaScript's `%`
 * is a remainder, not a modulus, so `(0 - 1) % 4` is `-1`, not `3`.
 */
export function rollFace(face: number, direction: number): number {
  if (direction === RollDirection.None) {
    return face;
  }
  const step = direction > 0 ? 1 : FACE_COUNT - 1;
  return (face + step) % FACE_COUNT;
}

/**
 * The lane a roll lands on. Mirrors, in both directions. See the header.
 */
export function rollLane(lane: number, direction: number): number {
  if (direction === RollDirection.None) {
    return lane;
  }
  return MAX_LANE - lane;
}

/** The lateral offset of a lane centre, in world units, centred on zero. */
export function laneCentreX(lane: number): number {
  return (lane - CENTRE_LANE) * LANE_WIDTH;
}

/**
 * Mirrors a lateral offset across a roll.
 *
 * Works for any `x`, not just lane centres, so a lane tween in flight when the
 * roll completes carries over correctly rather than snapping.
 */
export function mirrorLateral(x: number): number {
  return -x;
}

/** True when `face` is a valid face index. */
export function isValidFace(face: number): boolean {
  return Number.isInteger(face) && face >= 0 && face < FACE_COUNT;
}

/** True when `lane` is a valid lane index. */
export function isValidLane(lane: number): boolean {
  return Number.isInteger(lane) && lane >= 0 && lane < LANE_COUNT;
}

/**
 * Clamps a lane index into range.
 *
 * Lane input at the outer lanes is a no-op rather than an error — walking into
 * the wall should feel like nothing happened, not like a rejected command.
 */
export function clampLane(lane: number): number {
  if (lane < 0) {
    return 0;
  }
  if (lane > MAX_LANE) {
    return MAX_LANE;
  }
  return lane;
}

/**
 * Applies a roll to a `(face, lane)` pair, writing into `out` to avoid
 * allocating inside the tick.
 */
export interface FaceLane {
  face: number;
  lane: number;
}

/** A reusable result object. See `applyRoll`. */
export function createFaceLane(): FaceLane {
  return { face: 0, lane: 0 };
}

/**
 * Applies a roll. Writes into `out` and returns it. Allocates nothing.
 *
 * Rolling twice in the same direction is a 180 degree turn and returns the lane
 * to where it started — the mirror is its own inverse. That is correct: you are
 * on the opposite face, in the same relative lane.
 */
export function applyRoll(face: number, lane: number, direction: number, out: FaceLane): FaceLane {
  out.face = rollFace(face, direction);
  out.lane = rollLane(lane, direction);
  return out;
}
