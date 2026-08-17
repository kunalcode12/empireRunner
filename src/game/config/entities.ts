/**
 * Entity dimensions — the collider table.
 *
 * Lives in `config/` for two reasons. docs/ARCHITECTURE.md §1 names this exact
 * path, and `no-magic-numbers` exempts `src/game/config/**` because this is
 * DATA: every number here *is* the content, the same way the chunk files are.
 *
 * ## This replaces the 0.5u cube placeholder
 *
 * Until P07 every obstacle collided as a single 0.5u cube regardless of what it
 * was, so a Full-Face Wall and a Bit had identical hitboxes. Nothing detected it
 * because nothing spawned. These are the real extents, and they are derived from
 * the numbers the rest of the game already commits to:
 *
 *   - A **Low Bar**'s underside is `lowBarClearance` 1.05u, so its box starts
 *     there and runs to the ceiling. The 0.70u slide box fits; the 1.60u
 *     standing box does not. That is the entire mechanic.
 *   - A **High Gate**'s top is `highGateClearance` 1.40u, so its box runs from
 *     the floor to there. Jump apex is 1.75u, clearing it by 0.35u.
 *   - A **Stack** is 2.4u tall — above jump apex — which is what makes "height
 *     is not always the answer" true rather than merely stated.
 *
 * If a number here disagrees with `sim/level/entities.ts`'s blocking mask, the
 * mask is what the solver proved chunks against and the collider is what the
 * player actually hits. They must agree, and `tests/sim/collider-model.test.ts`
 * asserts it — that is the cross-check P06 deferred.
 */

import { TUNING } from "./tuning";

const LANE_WIDTH = TUNING.geometry.laneWidth;
const LANE_COUNT = TUNING.geometry.laneCount;
const PRISM = TUNING.geometry.prismInnerSize;
const LOW_BAR_UNDERSIDE = TUNING.slide.lowBarClearance;
const HIGH_GATE_TOP = TUNING.slide.highGateClearance;

/** u — the full width of one face, all three lanes. */
const FACE_WIDTH = LANE_WIDTH * LANE_COUNT;
/** u — floor to ceiling on a face. */
const FACE_HEIGHT = PRISM;

/**
 * One entity's collider, as a box in its face's local frame.
 *
 * `centreY` is measured from the face surface, `halfHeight` outward from there.
 * `halfWidth` is lateral, `halfDepth` along the tunnel.
 */
export interface EntityCollider {
  /** u — lateral half-extent. */
  halfWidth: number;
  /** u — vertical half-extent. */
  halfHeight: number;
  /** u — half-extent along z. */
  halfDepth: number;
  /** u — box centre height above the face surface. */
  centreY: number;
}

function collider(
  halfWidth: number,
  halfHeight: number,
  halfDepth: number,
  centreY: number,
): EntityCollider {
  return { halfWidth, halfHeight, halfDepth, centreY };
}

/** u — standard depth along the tunnel for a thin obstacle. */
const THIN_DEPTH = 0.5;
const HALF = 0.5;

/**
 * Colliders keyed by `EntityType`.
 *
 * Numeric keys rather than an array so a gap in the type numbering cannot
 * silently shift every entry — the same reasoning as `ENTITY_DEFS`.
 */
export const ENTITY_COLLIDERS: Readonly<Record<number, EntityCollider>> = Object.freeze({
  // ── Obstacles, GAME_BIBLE §7.1 ─────────────────────────────────────────────

  /** Block — one lane, 1.0u cube on the floor. Jumpable. */
  1: collider(LANE_WIDTH * HALF * 0.8, 0.5, THIN_DEPTH, 0.5),

  /** Stack — one lane, 2.4u tall. Above jump apex 1.75u on purpose. */
  2: collider(LANE_WIDTH * HALF * 0.8, 1.2, THIN_DEPTH, 1.2),

  /** Low Bar — all three lanes, hanging from 1.05u to the ceiling. */
  3: collider(
    FACE_WIDTH * HALF,
    (FACE_HEIGHT - LOW_BAR_UNDERSIDE) * HALF,
    THIN_DEPTH,
    LOW_BAR_UNDERSIDE + (FACE_HEIGHT - LOW_BAR_UNDERSIDE) * HALF,
  ),

  /** High Gate — all three lanes, floor up to 1.40u. */
  4: collider(FACE_WIDTH * HALF, HIGH_GATE_TOP * HALF, THIN_DEPTH, HIGH_GATE_TOP * HALF),

  /** Pillar Pair — two lanes solid, full height. One lane on the face is clear. */
  5: collider(LANE_WIDTH, FACE_HEIGHT * HALF, THIN_DEPTH, FACE_HEIGHT * HALF),

  /** Full-Face Wall — the signature entity. All three lanes, full height. */
  6: collider(FACE_WIDTH * HALF, FACE_HEIGHT * HALF, THIN_DEPTH, FACE_HEIGHT * HALF),

  /** Void Gap — the floor is absent. The collider sits BELOW the floor plane, so
   *  only a player who has fallen into it is inside the box. */
  7: collider(FACE_WIDTH * HALF, 0.6, TUNING.spawn.chunkLength * 0.1, -0.6),

  /** Piston — one to two lanes, oscillating. Extent is its extended state. */
  8: collider(LANE_WIDTH * HALF, FACE_HEIGHT * 0.35, THIN_DEPTH, FACE_HEIGHT * 0.35),

  /** Rotor — sweeps the face. Sized as a bar across one lane at a time. */
  9: collider(LANE_WIDTH * HALF, 0.35, THIN_DEPTH, 1.0),

  /** Corner Brace — occupies a seam. Non-fatal to touch; it blocks the ROLL,
   *  which the solver handles separately. Small physical presence. */
  10: collider(0.4, 0.4, THIN_DEPTH, 0.4),

  /** Shear Ring — one lane on all four faces at the same z. */
  11: collider(LANE_WIDTH * HALF, FACE_HEIGHT * HALF, THIN_DEPTH, FACE_HEIGHT * HALF),

  /** Kicker — a ramp. Not a threat; it launches. */
  12: collider(FACE_WIDTH * HALF, 0.3, THIN_DEPTH * 2, 0.3),

  // ── Pickups, GAME_BIBLE §7.3 ───────────────────────────────────────────────
  // Generous relative to their visual size. A Bit the player clearly ran through
  // but did not collect is far more annoying than one that snapped in early.

  /** Bit. */
  20: collider(0.45, 0.45, 0.45, 1.0),
  /** Bit Cluster — a tight ring, so a wider grab box. */
  21: collider(0.8, 0.8, 0.6, 1.0),
  /** Shard. */
  22: collider(0.5, 0.5, 0.5, 1.0),
  /** Magnet. */
  23: collider(0.5, 0.5, 0.5, 1.0),
  /** Shield. */
  24: collider(0.5, 0.5, 0.5, 1.0),
  /** Overdrive Cell. */
  25: collider(0.5, 0.5, 0.5, 1.0),
  /** Slowfield. */
  26: collider(0.5, 0.5, 0.5, 1.0),
});

/** Fallback for an unknown type. Small and harmless rather than large and fatal. */
const DEFAULT_COLLIDER: EntityCollider = collider(0.25, 0.25, 0.25, 0.25);

/** Looks up a collider. Never throws — an unknown type is inert, not lethal. */
export function entityCollider(type: number): EntityCollider {
  return ENTITY_COLLIDERS[type] ?? DEFAULT_COLLIDER;
}

/**
 * How many Bits an entity is worth when collected.
 *
 * A Bit Cluster is authored as ONE entity rather than eight, because eight
 * entities is eight collision tests, eight instance slots and eight events for
 * something the player experiences as a single grab.
 */
export const PICKUP_BIT_VALUE: Readonly<Record<number, number>> = Object.freeze({
  20: 1,
  21: 8,
});
