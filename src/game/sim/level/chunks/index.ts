/**
 * The chunk pool.
 *
 * **32 chunks. That is the floor, not the target.**
 *
 * Everything clever in `generator.ts` — the banded grammar, the weighting, the
 * recency penalty, the seam validation — can only ever recombine what is in
 * this directory. The grammar cannot invent variety it was not given. When the
 * game starts feeling like a loop at minute ten, the fix is almost never a
 * smarter selector; it is more chunks.
 *
 * Coverage the test suite enforces:
 *   - at least 5 chunks per difficulty tier
 *   - every archetype in `Archetype` present at least once
 *   - every chunk solvable at maxSpeed, with reported slack
 *
 * A good rule when adding one: if you can describe a new chunk using the same
 * sentence as an existing chunk with two numbers changed, it is not a new chunk.
 */

import { Archetype, seam, ALL_CELLS, type Chunk } from "../chunk";
import { TIER_1 } from "./tier1";
import { TIER_2 } from "./tier2";
import { TIER_3 } from "./tier3";
import { TIER_4 } from "./tier4";
import { TIER_5 } from "./tier5";

/**
 * The obstacle-free stretch between themes.
 *
 * Kept out of the tiers because it is never selected by difficulty — the
 * generator inserts it at the distance milestones in GAME_BIBLE §10.1. It is
 * the run's only guaranteed place to breathe, and the natural home for the
 * theme title card.
 */
export const TRANSITION_CHUNK: Chunk = Object.freeze({
  id: "transition",
  difficulty: 1,
  requiredVerbs: 0,
  entryConstraint: seam(ALL_CELLS, true),
  exitConstraint: seam(ALL_CELLS, true),
  entities: Object.freeze([]),
  themeTags: Object.freeze([]),
  weight: 1,
  archetype: Archetype.Transition,
});

/** Every selectable chunk, in tier order. */
export const ALL_CHUNKS: readonly Chunk[] = Object.freeze([
  ...TIER_1,
  ...TIER_2,
  ...TIER_3,
  ...TIER_4,
  ...TIER_5,
]);

/** Chunks grouped by difficulty tier. Index 0 is unused; tiers are 1..5. */
export const CHUNKS_BY_TIER: readonly (readonly Chunk[])[] = Object.freeze([
  Object.freeze([]),
  TIER_1,
  TIER_2,
  TIER_3,
  TIER_4,
  TIER_5,
]);

export const MIN_TIER = 1;
export const MAX_TIER = 5;

export { TIER_1, TIER_2, TIER_3, TIER_4, TIER_5 };
