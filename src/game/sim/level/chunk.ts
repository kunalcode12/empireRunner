/**
 * What a chunk is.
 *
 * A chunk is 24u of hand-authored track. The generator never invents geometry —
 * it selects chunks from a pool by a difficulty-banded grammar and bolts them
 * onto a fixed grid. That hybrid is what shipping runners actually do:
 *
 *   - Pure procedural generation is fair and characterless. Every section reads
 *     like every other section because no human ever decided anything.
 *   - Pure authoring has a hard content ceiling. Ten minutes in, the player has
 *     seen the loop.
 *
 * The grammar buys the variety of the first and the intent of the second.
 *
 * ## Seam constraints are the load-bearing part
 *
 * Two chunks that are each perfectly survivable can bolt together into a wall.
 * A chunk whose only exit is face 2 followed by a chunk whose entry demands
 * face 0 is an instant death that neither chunk is responsible for.
 *
 * So every chunk declares which of the 12 cells are safe at its entry seam and
 * which are safe at its exit seam, as a 12-bit mask. The generator rejects any
 * candidate whose entry mask does not intersect the previous chunk's exit mask.
 * That check is the difference between "usually fine" and "provably survivable".
 */

import { TUNING } from "@/game/config/tuning";
import type { EntityTypeValue } from "./entities";

const FACE_COUNT = TUNING.geometry.faceCount;
const LANE_COUNT = TUNING.geometry.laneCount;

/** u — every chunk is exactly this long. */
export const CHUNK_LENGTH = TUNING.spawn.chunkLength;

/** 4 faces x 3 lanes. The state space the generator authors into. */
export const CELL_COUNT = FACE_COUNT * LANE_COUNT;

/** Every cell safe — an unobstructed seam. */
export const ALL_CELLS = (1 << CELL_COUNT) - 1;

/** Packs a (face, lane) into a bit index 0..11. */
export function cellIndex(face: number, lane: number): number {
  return face * LANE_COUNT + lane;
}

/** The single-bit mask for one cell. */
export function cellBit(face: number, lane: number): number {
  return 1 << cellIndex(face, lane);
}

/** Builds a mask from a list of (face, lane) pairs. */
export function cellMask(cells: readonly (readonly [number, number])[]): number {
  let mask = 0;
  for (const [face, lane] of cells) {
    mask |= cellBit(face, lane);
  }
  return mask;
}

/** Every cell on one face. */
export function faceMask(face: number): number {
  let mask = 0;
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    mask |= cellBit(face, lane);
  }
  return mask;
}

/** True when the mask contains this cell. */
export function maskHas(mask: number, face: number, lane: number): boolean {
  return (mask & cellBit(face, lane)) !== 0;
}

/** How many cells a mask contains. */
export function maskCount(mask: number): number {
  let n = 0;
  let m = mask;
  while (m !== 0) {
    m &= m - 1;
    n += 1;
  }
  return n;
}

/** The movement verbs a chunk demands. Used for coverage auditing, not gating. */
const VERB_BIT_LANE = 0;
const VERB_BIT_JUMP = 1;
const VERB_BIT_SLIDE = 2;
const VERB_BIT_ROLL = 3;

export const VerbFlag = {
  Lane: 1 << VERB_BIT_LANE,
  Jump: 1 << VERB_BIT_JUMP,
  Slide: 1 << VERB_BIT_SLIDE,
  Roll: 1 << VERB_BIT_ROLL,
} as const;
export type VerbFlagValue = (typeof VerbFlag)[keyof typeof VerbFlag];

/**
 * Chunk archetypes.
 *
 * Not a mechanic — a coverage checklist. The test suite asserts every one of
 * these is present in the pool, because "we have 32 chunks" means nothing if 28
 * of them are the same idea with the blocks moved.
 */
export const Archetype = {
  /** Weave between single-lane blockers. No vertical verbs. */
  PureDodge: "pure-dodge",
  /** A run of things to jump, back to back. */
  JumpGauntlet: "jump-gauntlet",
  /** Sustained low bars — one long slide. */
  SlideCorridor: "slide-corridor",
  /** The ONLY exit is on another face. Roll or die. */
  ForcedRoll: "forced-roll",
  /** Roll to a new face, then immediately clear something on it. */
  RollThenJump: "roll-then-jump",
  /** A generous Bit line down a safe lane. Reward, not threat. */
  CoinReward: "coin-reward",
  /** A tight gap worth threading for the Flow, with a safe alternative. */
  NearMissBait: "near-miss-bait",
  /** Deliberately empty. Pacing needs rest. */
  Breather: "breather",
  /** Two clearly separated routes with different risk/reward. */
  Fork: "fork",
  /** Obstacles on three or four faces at once. */
  MultiFaceWeave: "multi-face-weave",
  /** The obstacle-free stretch between themes. */
  Transition: "transition",
} as const;
export type ArchetypeValue = (typeof Archetype)[keyof typeof Archetype];

/** Which themes a chunk suits. Empty means any. GAME_BIBLE §10. */
export const ThemeTag = {
  Kiln: "kiln",
  Undertow: "undertow",
  Bazaar: "bazaar",
  Static: "static",
} as const;
export type ThemeTagValue = (typeof ThemeTag)[keyof typeof ThemeTag];

/** One entity placed inside a chunk, in chunk-local coordinates. */
export interface ChunkEntity {
  readonly type: EntityTypeValue;
  /** 0..3. */
  readonly face: number;
  /** 0..2. Where `laneSpan` > 1, this is the leftmost lane occupied. */
  readonly lane: number;
  /** u — offset from the chunk's leading edge, 0..CHUNK_LENGTH. */
  readonly z: number;
  /** Cosmetic variation. Never affects gameplay or the solver. */
  readonly variant: number;
}

/**
 * What is safe at a chunk boundary.
 *
 * `safeCells` is the 12-bit set of cells **not occupied by this chunk's geometry
 * at that edge**. It is a statement about the track, not about the player.
 *
 * That distinction matters and is easy to get backwards. If a seam mask claimed
 * "the player will be here", then declaring it too narrowly would be dangerous:
 * the generator could pick a follow-on chunk that only accepts cells the player
 * is not actually in. Defining it as geometric safety instead makes the check
 * conservative in the right direction — an unoccupied cell on both sides of the
 * seam is a cell the player can legally occupy across it.
 *
 * Reachability *within* a chunk — can the player actually get from the entry
 * cell to a safe exit cell in 24u — is the solver's job, not the seam's.
 * The two together are what make a sequence provably survivable.
 */
export interface SeamConstraint {
  readonly safeCells: number;
  /** True when this edge is unlandable, so the player must arrive/leave airborne. */
  readonly requiresGrounded: boolean;
}

export interface Chunk {
  readonly id: string;
  /** 1..5, matching the difficulty bands in TUNING.md §10. */
  readonly difficulty: number;
  /** Bitmask of `VerbFlag` — what this chunk asks of the player. */
  readonly requiredVerbs: number;
  readonly entryConstraint: SeamConstraint;
  readonly exitConstraint: SeamConstraint;
  readonly entities: readonly ChunkEntity[];
  readonly themeTags: readonly ThemeTagValue[];
  /** Relative selection weight within its difficulty tier. */
  readonly weight: number;
  readonly archetype: ArchetypeValue;
}

/** A seam that accepts or produces any position. */
export const OPEN_SEAM: SeamConstraint = Object.freeze({
  safeCells: ALL_CELLS,
  requiresGrounded: false,
});

/** A seam open everywhere but requiring both feet down. */
export const OPEN_GROUNDED_SEAM: SeamConstraint = Object.freeze({
  safeCells: ALL_CELLS,
  requiresGrounded: true,
});

/** Builds a seam constraint from explicit cells. */
export function seam(safeCells: number, requiresGrounded = false): SeamConstraint {
  return Object.freeze({ safeCells, requiresGrounded });
}

/**
 * True when `previous`'s exit can legally feed `next`'s entry.
 *
 * The masks must overlap: there has to be at least one cell the player can both
 * leave the first chunk in and survive entering the second in. A grounded
 * requirement on the entry is only satisfiable if the exit guarantees grounded.
 */
export function seamsCompatible(previous: SeamConstraint, next: SeamConstraint): boolean {
  if ((previous.safeCells & next.safeCells) === 0) {
    return false;
  }
  if (next.requiresGrounded && !previous.requiresGrounded) {
    return false;
  }
  return true;
}

/** Cells that survive both sides of a seam. */
export function seamOverlap(previous: SeamConstraint, next: SeamConstraint): number {
  return previous.safeCells & next.safeCells;
}
