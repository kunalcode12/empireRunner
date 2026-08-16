/**
 * The player's collision box, which changes with phase.
 *
 * Three shapes, per docs/TUNING.md §3:
 *
 * ```
 *   STANDING   0.70w x 1.60h x 0.60d    running, rolling, stumbling
 *   SLIDING    0.70w x 0.70h x 1.10d    shorter and deeper — clears a Low Bar
 *                                       at 1.05u, but the extra depth means a
 *                                       slide has a cost
 *   AIRBORNE   0.70w x 1.60h x 0.60d    same as standing
 * ```
 *
 * Airborne deliberately reuses the standing box. There is no separate tuning
 * value for it, and inventing one would be a gameplay change smuggled in as an
 * implementation detail — a smaller airborne box would silently make jumps
 * clear things they visually should not.
 *
 * The box is axis-aligned in the **current face's local frame**: `x` lateral
 * across the face, `y` up from the face, `z` along the tunnel. The roll rotates
 * the world, not the player, so the collider never needs to rotate.
 */

import { TUNING } from "@/game/config/tuning";
import { Phase } from "@/game/sim/state";

const WIDTH = TUNING.geometry.playerWidth;
const HEIGHT_STAND = TUNING.geometry.playerHeightStand;
const DEPTH_STAND = TUNING.geometry.playerDepthStand;
const HEIGHT_SLIDE = TUNING.geometry.playerHeightSlide;
const DEPTH_SLIDE = TUNING.geometry.playerDepthSlide;

const HALF = 0.5;

/**
 * An axis-aligned box, stored as centre + half-extents.
 *
 * Half-extents rather than min/max because every collision test below wants the
 * centre distance and the summed extents, and storing it this way avoids
 * recomputing them per pair.
 */
export interface Aabb {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
}

/** Creates a zeroed box. Called at setup, never inside the tick. */
export function createAabb(): Aabb {
  return { cx: 0, cy: 0, cz: 0, hx: 0, hy: 0, hz: 0 };
}

/** Half-height of the player's box in a given phase. */
export function colliderHalfHeight(phase: number): number {
  return (phase === Phase.Sliding ? HEIGHT_SLIDE : HEIGHT_STAND) * HALF;
}

/** Half-depth of the player's box in a given phase. */
export function colliderHalfDepth(phase: number): number {
  return (phase === Phase.Sliding ? DEPTH_SLIDE : DEPTH_STAND) * HALF;
}

/** Half-width. Constant across phases — the player never gets narrower. */
export function colliderHalfWidth(): number {
  return WIDTH * HALF;
}

/**
 * Fills `out` with the player's box for the given phase and position.
 *
 * `y` is the height of the player's **feet** above the face, so the box centre
 * sits half a height above it. Getting this wrong by half a height is the
 * classic "my jump clips the ceiling" bug.
 */
export function playerAabb(out: Aabb, phase: number, x: number, y: number, z: number): Aabb {
  const hy = colliderHalfHeight(phase);
  out.cx = x;
  out.cy = y + hy;
  out.cz = z;
  out.hx = colliderHalfWidth();
  out.hy = hy;
  out.hz = colliderHalfDepth(phase);
  return out;
}

/** Fills `out` with an obstacle's box from its centre and half-extents. */
export function obstacleAabb(
  out: Aabb,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): Aabb {
  out.cx = cx;
  out.cy = cy;
  out.cz = cz;
  out.hx = hx;
  out.hy = hy;
  out.hz = hz;
  return out;
}

/** True when two boxes overlap on every axis. */
export function overlaps(a: Aabb, b: Aabb): boolean {
  return (
    Math.abs(a.cx - b.cx) < a.hx + b.hx &&
    Math.abs(a.cy - b.cy) < a.hy + b.hy &&
    Math.abs(a.cz - b.cz) < a.hz + b.hz
  );
}

/**
 * Surface-to-surface gap between two boxes, per axis, as the largest separation.
 *
 * Negative means overlapping on every axis, and the magnitude is the shallowest
 * penetration depth — which is exactly what corner forgiveness needs. Positive
 * means separated, and the value is the distance on the most-separated axis,
 * which is the correct conservative measure for a near-miss.
 */
export function separation(a: Aabb, b: Aabb): number {
  const dx = Math.abs(a.cx - b.cx) - (a.hx + b.hx);
  const dy = Math.abs(a.cy - b.cy) - (a.hy + b.hy);
  const dz = Math.abs(a.cz - b.cz) - (a.hz + b.hz);
  return Math.max(dx, Math.max(dy, dz));
}

/** Penetration depth on the X axis. Positive when overlapping. */
export function penetrationX(a: Aabb, b: Aabb): number {
  return a.hx + b.hx - Math.abs(a.cx - b.cx);
}

/** Penetration depth on the Y axis. Positive when overlapping. */
export function penetrationY(a: Aabb, b: Aabb): number {
  return a.hy + b.hy - Math.abs(a.cy - b.cy);
}

/** Penetration depth on the Z axis. Positive when overlapping. */
export function penetrationZ(a: Aabb, b: Aabb): number {
  return a.hz + b.hz - Math.abs(a.cz - b.cz);
}
