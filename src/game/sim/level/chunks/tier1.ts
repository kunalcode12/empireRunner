/**
 * Difficulty 1 — the teaching band. TUNING.md §10, band 1.
 *
 * Single face only, one idea per chunk, generous spacing. The player learns
 * jump, slide and lane change here before the tunnel ever rotates. Nothing in
 * this tier may require a roll.
 *
 * **28 chunks across all tiers is the floor, not the target.** Variety here is
 * the single thing standing between this game and feeling like a loop after ten
 * minutes. Every chunk added to these files is worth more than any amount of
 * cleverness in the selection grammar — the grammar can only recombine what it
 * is given.
 */

import { Archetype, at, bitLine, chunk, EntityType, VerbFlag } from "./builder";
import type { Chunk } from "../chunk";

const FLOOR = 0;

export const TIER_1: readonly Chunk[] = [
  chunk({
    id: "t1-breather-open",
    difficulty: 1,
    archetype: Archetype.Breather,
    requiredVerbs: 0,
    // Deliberately empty. Pacing needs rest, and the very first thing the
    // player should experience is unobstructed speed.
    entities: [...bitLine(FLOOR, 1, 4, 20, 6)],
    weight: 2,
  }),

  chunk({
    id: "t1-dodge-single",
    difficulty: 1,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane,
    // One block, centre lane, plenty of warning. The primer.
    entities: [at(EntityType.Block, FLOOR, 1, 14), ...bitLine(FLOOR, 0, 16, 22, 3)],
    weight: 2,
  }),

  chunk({
    id: "t1-dodge-outer",
    difficulty: 1,
    archetype: Archetype.PureDodge,
    requiredVerbs: VerbFlag.Lane,
    entities: [at(EntityType.Block, FLOOR, 0, 12), ...bitLine(FLOOR, 2, 14, 22, 4)],
  }),

  chunk({
    id: "t1-jump-single",
    difficulty: 1,
    archetype: Archetype.JumpGauntlet,
    requiredVerbs: VerbFlag.Jump,
    // A full-width High Gate: the lane change is not an option, so JUMP is
    // learned rather than stumbled into.
    entities: [at(EntityType.HighGate, FLOOR, 0, 15), ...bitLine(FLOOR, 1, 17, 21, 3)],
    weight: 2,
  }),

  chunk({
    id: "t1-slide-single",
    difficulty: 1,
    archetype: Archetype.SlideCorridor,
    requiredVerbs: VerbFlag.Slide,
    entities: [at(EntityType.LowBar, FLOOR, 0, 15), ...bitLine(FLOOR, 1, 17, 21, 3)],
    weight: 2,
  }),

  chunk({
    id: "t1-coin-lane",
    difficulty: 1,
    archetype: Archetype.CoinReward,
    requiredVerbs: VerbFlag.Lane,
    // Pure reward. The Bit line is the instruction: this lane is safe.
    entities: [
      ...bitLine(FLOOR, 2, 2, 22, 9),
      at(EntityType.Block, FLOOR, 0, 10),
      at(EntityType.Magnet, FLOOR, 2, 12),
    ],
  }),

  chunk({
    id: "t1-fork-easy",
    difficulty: 1,
    archetype: Archetype.Fork,
    requiredVerbs: VerbFlag.Lane,
    // Two clear lanes, different rewards. Teaches that choosing is a thing.
    entities: [
      at(EntityType.Block, FLOOR, 1, 13),
      ...bitLine(FLOOR, 0, 15, 21, 3),
      at(EntityType.BitCluster, FLOOR, 2, 18),
    ],
  }),
];
