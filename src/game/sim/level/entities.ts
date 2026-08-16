/**
 * Entity types and their blocking behaviour.
 *
 * ## The blocking model
 *
 * The solver reasons about what an entity blocks in terms of the player's three
 * vertical states, not in terms of world-space AABBs. That is deliberate:
 * per-entity collider extents land with `config/entities.ts` at P07, and a
 * solver built today against `collision.ts`'s placeholder 0.5u cube would be
 * proving chunks safe against geometry that is not the shipping geometry.
 *
 * ```
 *              SLIDING          STANDING         AIRBORNE
 *   box        0.70u tall       1.60u tall       feet up to 1.75u
 * ```
 *
 * Each type declares which of those three it stops. Read the table as
 * "defeated by whichever state it does NOT block":
 *
 * ```
 *   LOW BAR                        HIGH GATE
 *   ████████ ceiling               .        ● apex 1.75u
 *   ████████                       .
 *   ████████ 1.05u underside    ████████ 1.40u top
 *                               ████████
 *     ◄ slide 0.70u fits        ████████
 *   ──────── floor ─────────────████████────────
 *   blocks STANDING + AIRBORNE   blocks SLIDING + STANDING
 * ```
 *
 * GAME_BIBLE §7.1 had these two inverted until P06 — it listed the Low Bar as
 * sitting on the floor and the High Gate as hanging from the ceiling, which
 * contradicted its own "defeated by" column. Corrected there; this file is the
 * executable version of the corrected reading.
 *
 * A cross-check test lands at P07 asserting this logical model and the real
 * AABBs agree. Until then, this is the single source of truth for the solver.
 */

/** What a player is doing vertically. The solver's third axis. */
export const Vertical = {
  Standing: 0,
  Sliding: 1,
  Airborne: 2,
} as const;
export type VerticalValue = (typeof Vertical)[keyof typeof Vertical];

/** Bit per vertical state, for the `blocks` mask. */
export const BlockBit = {
  Standing: 1 << Vertical.Standing,
  Sliding: 1 << Vertical.Sliding,
  Airborne: 1 << Vertical.Airborne,
} as const;

const B_STAND = BlockBit.Standing;
const B_SLIDE = BlockBit.Sliding;
const B_AIR = BlockBit.Airborne;

/** Blocks every vertical state — only a lane change or a roll gets past. */
const B_ALL = B_STAND | B_SLIDE | B_AIR;

/**
 * Entity type ids.
 *
 * The numbering is stable: it is written into chunk data and, once the
 * generator is wired to the live sim, into `EntityColumns.kind` and therefore
 * into replay-adjacent state. Append only.
 */
export const EntityType = {
  None: 0,

  // ── Obstacles, GAME_BIBLE §7.1 ─────────────────────────────────────────────
  Block: 1,
  Stack: 2,
  LowBar: 3,
  HighGate: 4,
  PillarPair: 5,
  FullFaceWall: 6,
  VoidGap: 7,
  Piston: 8,
  Rotor: 9,
  CornerBrace: 10,
  ShearRing: 11,
  Kicker: 12,

  // ── Pickups, GAME_BIBLE §7.3 ───────────────────────────────────────────────
  Bit: 20,
  BitCluster: 21,
  Shard: 22,
  Magnet: 23,
  Shield: 24,
  OverdriveCell: 25,
  Slowfield: 26,
} as const;
export type EntityTypeValue = (typeof EntityType)[keyof typeof EntityType];

export interface EntityDef {
  readonly type: number;
  readonly name: string;
  /** Bitmask of `BlockBit` — which vertical states this entity stops. */
  readonly blocks: number;
  /** True when contact ends the run rather than costing momentum. */
  readonly fatal: boolean;
  /** True when it is collected rather than collided with. */
  readonly pickup: boolean;
  /** How many lanes on its face it occupies, starting at its own lane. */
  readonly laneSpan: number;
  /** True when one instance occupies the same lane on all four faces. */
  readonly allFaces: boolean;
  /** Lowest difficulty band this type may appear in. GAME_BIBLE §10 / TUNING §10. */
  readonly minBand: number;
}

function def(
  type: number,
  name: string,
  blocks: number,
  opts: Partial<Omit<EntityDef, "type" | "name" | "blocks">> = {},
): EntityDef {
  return {
    type,
    name,
    blocks,
    fatal: opts.fatal ?? true,
    pickup: opts.pickup ?? false,
    laneSpan: opts.laneSpan ?? 1,
    allFaces: opts.allFaces ?? false,
    minBand: opts.minBand ?? 1,
  };
}

const LANES_PER_FACE = 3;

/**
 * The catalogue.
 *
 * Keyed by type id rather than an array so a gap in the numbering cannot
 * silently shift every entry.
 */
export const ENTITY_DEFS: Readonly<Record<number, EntityDef>> = Object.freeze({
  // Sits on the floor, under jump height. Jump it, or go around it.
  [EntityType.Block]: def(EntityType.Block, "Block", B_STAND | B_SLIDE),

  // 2.4u tall — above jump apex. Height is not the answer; lane or roll is.
  [EntityType.Stack]: def(EntityType.Stack, "Stack", B_ALL),

  // Hangs from 1.05u. Slide under it.
  [EntityType.LowBar]: def(EntityType.LowBar, "LowBar", B_STAND | B_AIR, {
    laneSpan: LANES_PER_FACE,
  }),

  // Stands to 1.40u. Jump over it.
  [EntityType.HighGate]: def(EntityType.HighGate, "HighGate", B_STAND | B_SLIDE, {
    laneSpan: LANES_PER_FACE,
  }),

  // Two lanes solid; one lane on this face is always clear.
  [EntityType.PillarPair]: def(EntityType.PillarPair, "PillarPair", B_ALL, { laneSpan: 2 }),

  // THE signature entity. All three lanes, full height, one face. Roll only.
  [EntityType.FullFaceWall]: def(EntityType.FullFaceWall, "FullFaceWall", B_ALL, {
    laneSpan: LANES_PER_FACE,
    minBand: 3,
  }),

  // The floor is absent. Only being airborne saves you.
  [EntityType.VoidGap]: def(EntityType.VoidGap, "VoidGap", B_STAND | B_SLIDE, {
    laneSpan: LANES_PER_FACE,
    minBand: 3,
  }),

  // Oscillates; phase derived from z, so it is deterministic every replay.
  [EntityType.Piston]: def(EntityType.Piston, "Piston", B_ALL, { minBand: 3 }),

  // Sweeps; the safe lane moves.
  [EntityType.Rotor]: def(EntityType.Rotor, "Rotor", B_ALL, { minBand: 4 }),

  // Occupies a seam. Non-fatal to touch, but it BLOCKS THE ROLL past it —
  // handled specially by the solver rather than by this mask.
  [EntityType.CornerBrace]: def(EntityType.CornerBrace, "CornerBrace", 0, {
    fatal: false,
    minBand: 4,
  }),

  // The full 12-cell puzzle: same lane blocked on every face at once.
  [EntityType.ShearRing]: def(EntityType.ShearRing, "ShearRing", B_ALL, {
    allFaces: true,
    minBand: 4,
  }),

  // Not a threat. Launches the player into a long airborne beat.
  [EntityType.Kicker]: def(EntityType.Kicker, "Kicker", 0, {
    fatal: false,
    laneSpan: LANES_PER_FACE,
  }),

  // ── Pickups block nothing and never kill ──────────────────────────────────
  [EntityType.Bit]: def(EntityType.Bit, "Bit", 0, { fatal: false, pickup: true }),
  [EntityType.BitCluster]: def(EntityType.BitCluster, "BitCluster", 0, {
    fatal: false,
    pickup: true,
  }),
  [EntityType.Shard]: def(EntityType.Shard, "Shard", 0, { fatal: false, pickup: true }),
  [EntityType.Magnet]: def(EntityType.Magnet, "Magnet", 0, { fatal: false, pickup: true }),
  [EntityType.Shield]: def(EntityType.Shield, "Shield", 0, { fatal: false, pickup: true }),
  [EntityType.OverdriveCell]: def(EntityType.OverdriveCell, "OverdriveCell", 0, {
    fatal: false,
    pickup: true,
  }),
  [EntityType.Slowfield]: def(EntityType.Slowfield, "Slowfield", 0, {
    fatal: false,
    pickup: true,
  }),
});

/** Looks up a definition. Unknown types are treated as inert rather than fatal. */
export function entityDef(type: number): EntityDef {
  return ENTITY_DEFS[type] ?? def(type, "Unknown", 0, { fatal: false });
}

/** True when this entity stops a player in the given vertical state. */
export function blocksVertical(type: number, vertical: number): boolean {
  return (entityDef(type).blocks & (1 << vertical)) !== 0;
}

/** True when the entity participates in collision at all. */
export function isObstacle(type: number): boolean {
  const d = entityDef(type);
  return !d.pickup && d.type !== EntityType.None;
}
