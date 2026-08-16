/**
 * Difficulty 2 — two faces, and the roll is introduced. TUNING.md §10, band 2.
 *
 * Per the band table the roll arrives here, taught the gentle way: a Pillar Pair
 * whose free lane is on an adjacent face, so the player discovers that the
 * answer can be somewhere other than their own floor. Nothing in this tier
 * *forces* a roll — that is tier 3.
 */

import { Archetype, at, bitLine, chunk, EntityType, VerbFlag } from "./builder";
import type { Chunk } from "../chunk";

const FLOOR = 0;
const RIGHT_WALL = 1;
const LEFT_WALL = 3;

export const TIER_2: readonly Chunk[] = [
  chunk({
    id: "t2-dodge-weave",
    difficulty: 2,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane,
    // Two staggered blockers: left, then right. A genuine weave.
    entities: [
      at(EntityType.Block, FLOOR, 0, 8),
      at(EntityType.Block, FLOOR, 2, 18),
      ...bitLine(FLOOR, 1, 10, 16, 4),
    ],
    weight: 2,
  }),

  chunk({
    id: "t2-jump-pair",
    difficulty: 2,
    archetype: Archetype.JumpGauntlet,
    requiredVerbs: VerbFlag.Jump,
    entities: [
      at(EntityType.HighGate, FLOOR, 0, 7),
      at(EntityType.HighGate, FLOOR, 0, 19),
      ...bitLine(FLOOR, 1, 9, 17, 4),
    ],
  }),

  chunk({
    id: "t2-slide-long",
    difficulty: 2,
    archetype: Archetype.SlideCorridor,
    requiredVerbs: VerbFlag.Slide,
    // Two bars close enough that one sustained slide clears both — the slide
    // lasts 0.55s and 8u at speed is well inside that.
    entities: [
      at(EntityType.LowBar, FLOOR, 0, 10),
      at(EntityType.LowBar, FLOOR, 0, 16),
      ...bitLine(FLOOR, 1, 11, 15, 3),
    ],
    weight: 2,
  }),

  chunk({
    id: "t2-pillar-roll-hint",
    difficulty: 2,
    archetype: Archetype.Fork,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Roll,
    // THE ROLL IS INTRODUCED HERE. Two lanes blocked on the floor; the third is
    // clear, so a lane change still works — but the Bit cluster is parked on the
    // right wall, so a player who rolls is rewarded rather than required to.
    entities: [
      at(EntityType.PillarPair, FLOOR, 0, 13),
      ...bitLine(FLOOR, 2, 15, 21, 3),
      at(EntityType.BitCluster, RIGHT_WALL, 1, 17),
    ],
    weight: 2,
  }),

  chunk({
    id: "t2-mixed-jump-dodge",
    difficulty: 2,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane | VerbFlag.Jump,
    entities: [
      at(EntityType.Block, FLOOR, 1, 6),
      at(EntityType.HighGate, FLOOR, 0, 18),
      ...bitLine(FLOOR, 0, 8, 14, 3),
    ],
  }),

  chunk({
    id: "t2-breather-reward",
    difficulty: 2,
    archetype: Archetype.Breather,
    requiredVerbs: 0,
    // Empty of threat, full of reward. This is the beat that makes the next
    // hard chunk land.
    entities: [...bitLine(FLOOR, 1, 2, 22, 9), at(EntityType.OverdriveCell, FLOOR, 1, 12)],
    weight: 2,
  }),

  chunk({
    id: "t2-left-wall-invite",
    difficulty: 2,
    archetype: Archetype.CoinReward,
    requiredVerbs: VerbFlag.Roll,
    // A clear floor and an obvious prize on the left wall. Optional, and the
    // first time most players roll on purpose.
    entities: [
      ...bitLine(LEFT_WALL, 1, 6, 20, 6),
      at(EntityType.Shield, LEFT_WALL, 1, 13),
      at(EntityType.Block, FLOOR, 1, 14),
    ],
  }),
];
