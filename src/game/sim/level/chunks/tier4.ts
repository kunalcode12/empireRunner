/**
 * Difficulty 4 — all four faces, and a roll can now be wrong. TUNING.md §10, band 4.
 *
 * The Corner Brace and the Shear Ring unlock here. Up to now every roll was at
 * worst neutral; from this tier the player has to pick a *direction*, and one of
 * them is a wall. That is what turns the roll from an escape into a decision.
 */

import { Archetype, at, bitLine, chunk, EntityType, seam, VerbFlag } from "./builder";
import { ALL_CELLS, cellBit, type Chunk } from "../chunk";
import { allExceptFace } from "./builder";

const FLOOR = 0;
const RIGHT_WALL = 1;
const CEILING = 2;
const LEFT_WALL = 3;

export const TIER_4: readonly Chunk[] = [
  chunk({
    id: "t4-roll-then-jump",
    difficulty: 4,
    archetype: Archetype.RollThenJump,
    requiredVerbs: VerbFlag.Roll | VerbFlag.Jump,
    // Wall on the floor forces the roll; a gate on the destination face has to
    // be cleared almost immediately after landing on it. The combo.
    entities: [
      at(EntityType.FullFaceWall, FLOOR, 0, 12),
      at(EntityType.HighGate, RIGHT_WALL, 0, 21),
      ...bitLine(RIGHT_WALL, 1, 14, 19, 3),
    ],
    exit: seam(allExceptFace(FLOOR), true),
    weight: 3,
  }),

  chunk({
    id: "t4-roll-then-slide",
    difficulty: 4,
    archetype: Archetype.RollThenJump,
    requiredVerbs: VerbFlag.Roll | VerbFlag.Slide,
    entities: [
      at(EntityType.FullFaceWall, FLOOR, 0, 12),
      at(EntityType.LowBar, LEFT_WALL, 0, 21),
      ...bitLine(LEFT_WALL, 1, 14, 19, 3),
    ],
    exit: seam(allExceptFace(FLOOR), true),
    weight: 2,
  }),

  chunk({
    id: "t4-shear-ring",
    difficulty: 4,
    archetype: Archetype.MultiFaceWeave,
    requiredVerbs: VerbFlag.Lane,
    // The full 12-cell puzzle: lane 1 is blocked on EVERY face at the same z.
    // Rolling does not help; only a lane change does. The inverse lesson to the
    // Full-Face Wall, and the reason both exist.
    entities: [at(EntityType.ShearRing, FLOOR, 1, 14), ...bitLine(FLOOR, 0, 16, 22, 3)],
    weight: 2,
  }),

  chunk({
    id: "t4-corner-brace-trap",
    difficulty: 4,
    archetype: Archetype.ForcedRoll,
    requiredVerbs: VerbFlag.Roll | VerbFlag.Lane,
    // A wall on the floor and a Corner Brace on the floor/right seam. Rolling
    // right is punished; rolling left is the answer. A roll with a wrong option
    // is the entire point of this tier.
    entities: [
      at(EntityType.FullFaceWall, FLOOR, 0, 15),
      at(EntityType.CornerBrace, FLOOR, 2, 15),
      ...bitLine(LEFT_WALL, 1, 12, 22, 5),
    ],
    exit: seam(allExceptFace(FLOOR) & ~cellBit(RIGHT_WALL, 0), true),
    weight: 2,
  }),

  chunk({
    id: "t4-multiface-weave",
    difficulty: 4,
    archetype: Archetype.MultiFaceWeave,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Roll,
    entities: [
      at(EntityType.PillarPair, FLOOR, 0, 11),
      at(EntityType.PillarPair, RIGHT_WALL, 1, 17),
      at(EntityType.Block, CEILING, 1, 22),
      ...bitLine(LEFT_WALL, 1, 8, 20, 5),
    ],
  }),

  chunk({
    id: "t4-near-miss-thread",
    difficulty: 4,
    archetype: Archetype.NearMissBait,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Slide,
    // Thread the gap and slide under the bar for a big Flow payout. The safe
    // route exists but costs the cluster.
    entities: [
      at(EntityType.Block, FLOOR, 0, 9),
      at(EntityType.Block, FLOOR, 2, 9),
      at(EntityType.LowBar, FLOOR, 0, 17),
      at(EntityType.BitCluster, FLOOR, 1, 12),
      ...bitLine(FLOOR, 1, 18, 22, 3),
    ],
    weight: 2,
  }),

  chunk({
    id: "t4-gauntlet-mixed",
    difficulty: 4,
    archetype: Archetype.JumpGauntlet,
    requiredVerbs: VerbFlag.Jump | VerbFlag.Slide,
    // Alternating gate and bar: jump, then immediately slide. The two verbs
    // back to back are harder than either three times.
    entities: [
      at(EntityType.HighGate, FLOOR, 0, 7),
      at(EntityType.LowBar, FLOOR, 0, 16),
      ...bitLine(FLOOR, 1, 9, 14, 3),
    ],
    weight: 2,
  }),

  chunk({
    id: "t4-fork-committed",
    difficulty: 4,
    archetype: Archetype.Fork,
    requiredVerbs: VerbFlag.Roll | VerbFlag.Lane,
    // Both faces are viable but they diverge early, so the choice is real.
    entities: [
      at(EntityType.PillarPair, FLOOR, 1, 12),
      at(EntityType.Block, CEILING, 1, 15),
      at(EntityType.Shard, CEILING, 0, 20),
      ...bitLine(FLOOR, 0, 12, 22, 4),
    ],
  }),

  chunk({
    id: "t4-breather-tense",
    difficulty: 4,
    archetype: Archetype.Breather,
    requiredVerbs: 0,
    // A breather that still reads as dangerous: empty floor, walls dressed with
    // Bits. Rest without dropping the tension.
    entities: [
      ...bitLine(RIGHT_WALL, 1, 4, 20, 6),
      ...bitLine(LEFT_WALL, 1, 4, 20, 6),
      at(EntityType.Slowfield, FLOOR, 1, 12),
    ],
    weight: 2,
  }),

  chunk({
    id: "t4-dodge-dense",
    difficulty: 4,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane,
    entities: [
      at(EntityType.Block, FLOOR, 0, 5),
      at(EntityType.Block, FLOOR, 1, 12),
      at(EntityType.Block, FLOOR, 2, 19),
      ...bitLine(FLOOR, 2, 7, 10, 2),
    ],
  }),
];

void ALL_CELLS;
