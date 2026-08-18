/**
 * Settling a finished run — the one entry point the death screen calls.
 *
 * The prompt for this layer described it as code that *"reads a completed run
 * summary and applies rewards after"*. Every other file here is a piece of that
 * sentence; this is the sentence. Without it, P14 would have to know the order
 * in which economy, missions, progression and avatar challenges must be applied,
 * and that ordering is not obvious — it is the kind of knowledge that gets
 * reimplemented slightly differently in the death screen, the debug menu and the
 * test fixture until three of them disagree.
 *
 * ## Order matters, and here is why
 *
 * 1. **Fracture costs first.** They were incurred *during* the run, so they are
 *    charged before anything is paid out. Paying the run reward first would let
 *    a player Fracture with a balance they did not have when they Fractured.
 * 2. **Run reward.** Bits from pickups and distance, Shards picked up.
 * 3. **Missions**, then their Shard rewards — a run can complete a daily and
 *    that Shard belongs to this settlement, not the next one.
 * 4. **Avatar challenges**, then their Shards.
 * 5. **Lifetime and unlocks last**, because unlock checks read the *post*-run
 *    totals.
 *
 * ## Nothing here can fail destructively
 *
 * Every currency movement goes through `EconomyBackend`, which refuses rather
 * than throws. A refused Fracture charge — a save that somehow has fewer Shards
 * than the run spent — is recorded in `shortfalls` and the settlement continues.
 * Refusing to settle the whole run because one charge did not fit would cost the
 * player everything they just earned, which is a far worse outcome than an
 * uncharged Shard.
 */

import { TUNING } from "@/game/config/tuning";
import type { EconomyBackend } from "./backend";
import { bitsEarned, fractureShardCost, type Balances, type Transaction } from "./economy";
import { avatarBitMultiplier, challengesMetBy } from "./avatars";
import { boostBitMultiplier, type BoostId } from "./inventory";
import { bitValueMultiplier, type UpgradeLevels } from "./upgrades";
import {
  applyRun as applyRunToMissions,
  claimRewards,
  type MissionProgress,
  type MissionRewards,
} from "./missions";
import {
  applyRunToLifetime,
  newlyUnlocked,
  type LifetimeStats,
  type UnlockableName,
} from "./progression";
import type { RunSummary } from "./runSummary";

/** Shards — a first-time avatar challenge. GAME_BIBLE §8.1. */
const AVATAR_CHALLENGE_SHARDS = 1;

const WEEKLY_TIER_SHARDS = TUNING.meta.weeklyTierShards;

/** Shards for a weekly tier, 1-based. */
function weeklyShardsForTier(tier: number): number {
  return WEEKLY_TIER_SHARDS[tier - 1] ?? 0;
}

export interface SettleInput {
  run: RunSummary;
  upgrades: UpgradeLevels;
  /** The avatar equipped for this run. */
  avatarId: string;
  /** The boosts consumed at run start. */
  boosts: readonly BoostId[];
  missions: MissionProgress;
  lifetime: LifetimeStats;
  /** Avatar ids whose challenge Shard has already been paid. */
  avatarChallengesClaimed: readonly string[];
  /** Avatar ids the player owns, so an owned one is not "unlocked" twice. */
  ownedAvatars: readonly string[];
}

export interface RunSettlement {
  readonly balances: Balances;
  /** Bits this run paid, before deductions. */
  readonly bitsAwarded: number;
  readonly bitsFromPickups: number;
  readonly bitsFromDistance: number;
  /** Shards picked up plus every Shard reward earned. */
  readonly shardsAwarded: number;
  /** Shards spent on Fractures. */
  readonly shardsSpent: number;
  readonly missions: MissionProgress;
  readonly missionRewards: MissionRewards;
  readonly lifetime: LifetimeStats;
  readonly unlocked: readonly UnlockableName[];
  /** Avatar ids newly unlocked by challenge this run. */
  readonly avatarsUnlocked: readonly string[];
  readonly avatarChallengesClaimed: readonly string[];
  /** Transactions the backend refused, with the reason. Empty in the normal case. */
  readonly shortfalls: readonly string[];
}

/** The Bit multiplier a run earned, from upgrades, avatar and boosts combined. */
export function totalBitMultiplier(
  upgrades: UpgradeLevels,
  avatarId: string,
  boosts: readonly BoostId[],
): { bitValue: number; boost: number } {
  return {
    // Upgrade and avatar multiply together; both are "Bit value". The 2x boost
    // is kept separate because GAME_BIBLE §8.1's formula applies it as its own
    // factor, and the worked example only reproduces if it stays separate.
    bitValue: bitValueMultiplier(upgrades) * avatarBitMultiplier(avatarId),
    boost: boostBitMultiplier(boosts),
  };
}

/** Settles a run. Applies every reward and returns the new meta state. */
export async function settleRun(
  backend: EconomyBackend,
  input: SettleInput,
  at: number = Date.now(),
): Promise<RunSettlement> {
  const shortfalls: string[] = [];

  const commit = async (transaction: Transaction, label: string): Promise<void> => {
    const result = await backend.commit(transaction);
    if (!result.ok) {
      shortfalls.push(`${label}:${result.rejection}`);
    }
  };

  // 1. Fractures were spent during the run. Charge before paying out.
  let shardsSpent = 0;
  for (let index = 1; index <= input.run.fracturesUsed; index += 1) {
    const shards = fractureShardCost(index);
    shardsSpent += shards;
    await commit({ kind: "fracture", index, shards, seed: input.run.seed }, `fracture-${index}`);
  }

  // 2. The run reward.
  const multipliers = totalBitMultiplier(input.upgrades, input.avatarId, input.boosts);
  const earned = bitsEarned(
    input.run.bitsCollected,
    input.run.distance,
    multipliers.bitValue,
    multipliers.boost,
  );
  await commit(
    {
      kind: "run-reward",
      fromPickups: earned.fromPickups,
      fromDistance: earned.fromDistance,
      shards: input.run.shardsCollected,
      seed: input.run.seed,
    },
    "run-reward",
  );

  // 3. Missions, then their rewards.
  const missions = applyRunToMissions(input.missions, input.run, at);
  const rewards = claimRewards(missions, at);
  let shardsAwarded = input.run.shardsCollected;

  if (rewards.dailyShards > 0) {
    shardsAwarded += rewards.dailyShards;
    await commit(
      { kind: "daily-complete", day: missions.dayKey, shards: rewards.dailyShards },
      "daily",
    );
  }
  // Weekly tiers are committed individually so the ledger records which tier
  // paid, rather than one opaque lump the player cannot reconcile.
  for (const tier of rewards.weeklyTiers) {
    const shards = weeklyShardsForTier(tier);
    shardsAwarded += shards;
    await commit({ kind: "weekly-tier", week: missions.weekKey, tier, shards }, `weekly-${tier}`);
  }

  // 4. Avatar challenges. One Shard each, first time only.
  const avatarsUnlocked = challengesMetBy(input.run, input.ownedAvatars);
  const claimed = [...input.avatarChallengesClaimed];
  for (const avatarId of avatarsUnlocked) {
    if (claimed.includes(avatarId)) {
      continue;
    }
    claimed.push(avatarId);
    shardsAwarded += AVATAR_CHALLENGE_SHARDS;
    await commit(
      { kind: "avatar-challenge", avatarId, shards: AVATAR_CHALLENGE_SHARDS },
      `avatar-${avatarId}`,
    );
  }

  // 5. Lifetime and unlocks, from the post-run totals.
  const lifetime = applyRunToLifetime(input.lifetime, input.run);
  const unlocked = newlyUnlocked(input.lifetime, lifetime);

  return {
    balances: await backend.getBalances(),
    bitsAwarded: earned.total,
    bitsFromPickups: earned.fromPickups,
    bitsFromDistance: earned.fromDistance,
    shardsAwarded,
    shardsSpent,
    missions: rewards.progress,
    missionRewards: rewards,
    lifetime,
    unlocked,
    avatarsUnlocked,
    avatarChallengesClaimed: Object.freeze(claimed),
    shortfalls: Object.freeze(shortfalls),
  };
}
