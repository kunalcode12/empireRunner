/**
 * Difficulty 5 — terminal density. TUNING.md §10, band 5.
 *
 * Density does NOT rise past this tier. Beyond 5,000m the game gets harder
 * because it gets *faster*, not because it gets more crowded — stacking both is
 * how endless runners turn into unwinnable noise at minute six.
 *
 * So these chunks are not "tier 4 with more stuff". They are tier 4 ideas that
 * demand the verbs in a tighter sequence, and they are the ones the solver's
 * slack report matters most for: a tier-5 chunk that is survivable only with a
 * frame-perfect input is a bug, not a challenge.
 */

import { Archetype, at, bitLine, chunk, EntityType, seam, VerbFlag } from "./builder";
import { allExceptFace } from "./builder";
import type { Chunk } from "../chunk";

const FLOOR = 0;
const RIGHT_WALL = 1;
const CEILING = 2;
const LEFT_WALL = 3;

export const TIER_5: readonly Chunk[] = [
  chunk({
    id: "t5-wrong-way-wall",
    difficulty: 5,
    archetype: Archetype.ForcedRoll,
    requiredVerbs: VerbFlag.Roll,
    // Walls on the floor AND the right wall at the same z. A roll is forced and
    // one of the two directions is fatal.
    //
    // This started life as a double-roll and the solver proved it impossible:
    // two rolls cost 20.4u plus cooldown and a chunk is only 24u. Reframing it
    // as one roll with a wrong answer is both survivable and a better chunk —
    // the tension is the decision, not the repetition.
    entities: [
      at(EntityType.FullFaceWall, FLOOR, 0, 13),
      at(EntityType.FullFaceWall, RIGHT_WALL, 0, 13),
      ...bitLine(LEFT_WALL, 1, 16, 22, 3),
    ],
    exit: seam(allExceptFace(FLOOR) & allExceptFace(RIGHT_WALL), true),
    weight: 2,
  }),

  chunk({
    id: "t5-braced-roll-jump",
    difficulty: 5,
    archetype: Archetype.RollThenJump,
    requiredVerbs: VerbFlag.Roll | VerbFlag.Jump,
    // Roll, but a Corner Brace makes the right-hand roll wrong; then clear a
    // gate on the destination face almost immediately after landing on it.
    //
    // Originally asked for roll + jump + slide. The solver proved that
    // impossible: at maxSpeed a jump is 36 ticks and a slide 33, and the whole
    // chunk is 43. **No 24u chunk can demand two vertical verbs.** That is a
    // property of the chunk length, not of this chunk.
    entities: [
      at(EntityType.FullFaceWall, FLOOR, 0, 12),
      at(EntityType.CornerBrace, FLOOR, 2, 12),
      at(EntityType.HighGate, LEFT_WALL, 0, 21),
      ...bitLine(LEFT_WALL, 1, 15, 19, 3),
    ],
    exit: seam(allExceptFace(FLOOR), true),
  }),

  chunk({
    id: "t5-shear-and-weave",
    difficulty: 5,
    archetype: Archetype.MultiFaceWeave,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Roll,
    // A Shear Ring closes lane 1 everywhere, then the outer lanes get pinched.
    entities: [
      at(EntityType.ShearRing, FLOOR, 1, 8),
      at(EntityType.Block, FLOOR, 0, 18),
      at(EntityType.Block, RIGHT_WALL, 2, 18),
      ...bitLine(FLOOR, 2, 11, 15, 3),
    ],
    weight: 2,
  }),

  chunk({
    id: "t5-gauntlet-terminal",
    difficulty: 5,
    archetype: Archetype.JumpGauntlet,
    requiredVerbs: VerbFlag.Jump | VerbFlag.Slide,
    entities: [
      at(EntityType.HighGate, FLOOR, 0, 5),
      at(EntityType.LowBar, FLOOR, 0, 13),
      at(EntityType.HighGate, FLOOR, 0, 21),
      ...bitLine(FLOOR, 1, 8, 11, 2),
    ],
  }),

  chunk({
    id: "t5-near-miss-corridor",
    difficulty: 5,
    archetype: Archetype.NearMissBait,
    requiredVerbs: VerbFlag.Lane,
    // A whole corridor of near-misses. Maximum Flow for a player willing to run
    // the centre line; the outer lanes stay open for anyone who is not.
    entities: [
      at(EntityType.Block, FLOOR, 0, 7),
      at(EntityType.Block, FLOOR, 2, 7),
      at(EntityType.Block, FLOOR, 0, 15),
      at(EntityType.Block, FLOOR, 2, 15),
      ...bitLine(FLOOR, 1, 6, 20, 6),
      at(EntityType.Shard, FLOOR, 1, 22),
    ],
    weight: 2,
  }),

  chunk({
    id: "t5-gap-and-wall",
    difficulty: 5,
    archetype: Archetype.ForcedRoll,
    requiredVerbs: VerbFlag.Jump | VerbFlag.Roll,
    // Jump the gap, then the floor ends entirely. Rolling mid-gap lands on a
    // face that still has a floor — GAME_BIBLE §7.1, Void Gap.
    entities: [
      at(EntityType.VoidGap, FLOOR, 0, 8),
      at(EntityType.FullFaceWall, FLOOR, 0, 19),
      ...bitLine(LEFT_WALL, 1, 13, 22, 4),
    ],
    exit: seam(allExceptFace(FLOOR), true),
  }),

  chunk({
    id: "t5-breather-earned",
    difficulty: 5,
    archetype: Archetype.Breather,
    requiredVerbs: 0,
    // Even at terminal density the pacing rule holds. This is the chunk the
    // breather rule forces in after three hard ones, and it is deliberately
    // generous — the player has earned it.
    entities: [
      ...bitLine(FLOOR, 1, 2, 22, 10),
      at(EntityType.OverdriveCell, FLOOR, 1, 8),
      at(EntityType.Shield, FLOOR, 1, 16),
    ],
    weight: 3,
  }),

  chunk({
    id: "t5-rotor-sweep",
    difficulty: 5,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Jump,
    entities: [
      at(EntityType.Rotor, FLOOR, 0, 11),
      at(EntityType.HighGate, FLOOR, 0, 21),
      ...bitLine(CEILING, 1, 6, 18, 4),
    ],
  }),
];
