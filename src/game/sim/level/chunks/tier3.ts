/**
 * Difficulty 3 — the roll stops being optional. TUNING.md §10, band 3.
 *
 * The Full-Face Wall unlocks here, and with it the signature moment of the whole
 * game: a wall with no gap on your face, and a clear lane on the face beside
 * you. Not a jump, not a slide, not a dodge — a roll. GAME_BIBLE §3.3.
 *
 * Void Gaps and Pistons also arrive. Three faces may carry geometry at once.
 */

import { Archetype, at, bitLine, chunk, EntityType, faceMask, seam, VerbFlag } from "./builder";
import { ALL_CELLS, type Chunk } from "../chunk";
import { allExceptFace } from "./builder";

const FLOOR = 0;
const RIGHT_WALL = 1;
const CEILING = 2;
const LEFT_WALL = 3;

export const TIER_3: readonly Chunk[] = [
  chunk({
    id: "t3-forced-roll-floor",
    difficulty: 3,
    archetype: Archetype.ForcedRoll,
    requiredVerbs: VerbFlag.Roll,
    // THE signature chunk. Full-Face Wall across the floor near the trailing
    // edge; the only survivable cells at the exit seam are on another face.
    entities: [at(EntityType.FullFaceWall, FLOOR, 0, 17), ...bitLine(RIGHT_WALL, 1, 12, 22, 5)],
    exit: seam(allExceptFace(FLOOR), true),
    weight: 3,
  }),

  chunk({
    id: "t3-forced-roll-wall",
    difficulty: 3,
    archetype: Archetype.ForcedRoll,
    requiredVerbs: VerbFlag.Roll,
    // Same idea entered from a wall face, so the answer is not always "roll
    // right off the floor".
    entities: [at(EntityType.FullFaceWall, RIGHT_WALL, 0, 16), ...bitLine(FLOOR, 1, 11, 21, 5)],
    entry: seam(ALL_CELLS, true),
    exit: seam(allExceptFace(RIGHT_WALL), true),
    weight: 2,
  }),

  chunk({
    id: "t3-slide-corridor-long",
    difficulty: 3,
    archetype: Archetype.SlideCorridor,
    requiredVerbs: VerbFlag.Slide,
    // Three bars in a row. One slide covers 0.55s; at 34 u/s that is 18.7u, so
    // this is a single sustained commitment rather than three separate ones.
    entities: [
      at(EntityType.LowBar, FLOOR, 0, 6),
      at(EntityType.LowBar, FLOOR, 0, 12),
      at(EntityType.LowBar, FLOOR, 0, 18),
      ...bitLine(FLOOR, 1, 7, 17, 5),
    ],
  }),

  chunk({
    id: "t3-jump-gauntlet",
    difficulty: 3,
    archetype: Archetype.JumpGauntlet,
    requiredVerbs: VerbFlag.Jump,
    entities: [
      at(EntityType.HighGate, FLOOR, 0, 5),
      at(EntityType.HighGate, FLOOR, 0, 14),
      at(EntityType.HighGate, FLOOR, 0, 22),
      ...bitLine(FLOOR, 1, 8, 12, 3),
    ],
  }),

  chunk({
    id: "t3-near-miss-bait",
    difficulty: 3,
    archetype: Archetype.NearMissBait,
    requiredVerbs: VerbFlag.Lane,
    // A tight thread between two blockers, worth Flow — and a wide safe lane
    // right beside it. The bait only works if declining it is genuinely fine.
    entities: [
      at(EntityType.Block, FLOOR, 0, 12),
      at(EntityType.Block, FLOOR, 2, 12),
      ...bitLine(FLOOR, 1, 10, 16, 4),
      at(EntityType.BitCluster, FLOOR, 1, 13),
    ],
    weight: 2,
  }),

  chunk({
    id: "t3-fork-risk-reward",
    difficulty: 3,
    archetype: Archetype.Fork,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Jump,
    // Left: jump a gate for a Shard. Right: walk around it for nothing.
    entities: [
      at(EntityType.PillarPair, FLOOR, 1, 13),
      at(EntityType.HighGate, LEFT_WALL, 0, 16),
      at(EntityType.Shard, LEFT_WALL, 1, 19),
      ...bitLine(FLOOR, 0, 12, 22, 4),
    ],
  }),

  chunk({
    id: "t3-multiface-intro",
    difficulty: 3,
    archetype: Archetype.MultiFaceWeave,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Roll,
    // Geometry on three faces at once. The ceiling is clear, which is the
    // lesson: sometimes up is the answer.
    entities: [
      at(EntityType.Block, FLOOR, 1, 8),
      at(EntityType.Block, RIGHT_WALL, 1, 14),
      at(EntityType.Block, LEFT_WALL, 1, 20),
      ...bitLine(CEILING, 1, 6, 22, 6),
    ],
  }),

  chunk({
    id: "t3-gap-jump",
    difficulty: 3,
    archetype: Archetype.JumpGauntlet,
    requiredVerbs: VerbFlag.Jump,
    // A Void Gap. Coyote time applies at the leading edge, which is the whole
    // reason coyote time exists.
    entities: [at(EntityType.VoidGap, FLOOR, 0, 13), ...bitLine(FLOOR, 1, 17, 22, 3)],
    exit: seam(ALL_CELLS, true),
  }),

  chunk({
    id: "t3-breather-mid",
    difficulty: 3,
    archetype: Archetype.Breather,
    requiredVerbs: 0,
    // Mid-run rest. Not free — the reward is on the ceiling, so a player who
    // wants it has to spend two rolls getting there and back.
    entities: [...bitLine(CEILING, 1, 4, 20, 7), at(EntityType.OverdriveCell, CEILING, 1, 12)],
    weight: 2,
  }),

  chunk({
    id: "t3-piston-timing",
    difficulty: 3,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane,
    // Pistons phase off z, so this reads identically on every replay.
    entities: [
      at(EntityType.Piston, FLOOR, 0, 10),
      at(EntityType.Piston, FLOOR, 2, 18),
      ...bitLine(FLOOR, 1, 12, 16, 3),
    ],
  }),
];

void faceMask;
