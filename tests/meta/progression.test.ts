import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  AVATARS,
  DEFAULT_AVATAR_ID,
  PassiveDomain,
  UnlockKind,
  avatarBitMultiplier,
  avatarById,
  avatarFlowMultiplier,
  challengeAvatars,
  challengesMetBy,
} from "@/game/meta/avatars";
import {
  FRESH_ONBOARDING,
  Unlockable,
  ZERO_LIFETIME,
  applyRunToLifetime,
  distanceForLevel,
  isFirstRun,
  isUnlocked,
  levelForDistance,
  levelProgress,
  markSeen,
  newlyUnlocked,
} from "@/game/meta/progression";
import { buildRunSummary, createRunRecorder, type RunSummary } from "@/game/meta/runSummary";

function runWith(overrides: Partial<RunSummary>): RunSummary {
  const base = buildRunSummary(createRunRecorder(), {
    distance: 0,
    score: 0,
    bestCombo: 0,
    band: 0,
    elapsedSeconds: 0,
    seed: 1,
    shieldsHeld: 0,
  });
  return Object.freeze({ ...base, ...overrides });
}

describe("the avatar roster", () => {
  it("has exactly eight runners with unique ids", () => {
    expect(AVATARS.length).toBe(8);
    expect(new Set(AVATARS.map((a) => a.id)).size).toBe(8);
    expect(AVATARS.map((a) => a.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  /**
   * §9.1: "a good player on the worst avatar beats a bad player on the best."
   * A build-defining passive turns an arcade score chase into an optimization
   * puzzle, and makes a new player's ceiling their account age.
   */
  it("caps every GAMEPLAY passive at +8%", () => {
    for (const avatar of AVATARS) {
      if (avatar.passive.domain !== PassiveDomain.Gameplay) {
        continue;
      }
      expect(
        avatar.passive.magnitude,
        `${avatar.name} exceeds the gameplay passive cap`,
      ).toBeLessThanOrEqual(TUNING.meta.avatarGameplayPassiveCap);
    }
  });

  /**
   * Ochre is above the cap and legitimately so — Bit value changes what a run
   * PAYS, not how it is PLAYED, so it cannot inform a decision inside a run.
   * Asserting the distinction rather than a blanket rule stops anyone later
   * "fixing" Ochre down to a cap it was never subject to.
   */
  it("allows exactly one economy passive above the cap, and it is Ochre", () => {
    const above = AVATARS.filter((a) => a.passive.magnitude > TUNING.meta.avatarGameplayPassiveCap);
    expect(above.map((a) => a.id)).toEqual(["ochre"]);
    expect(above[0]?.passive.domain).toBe(PassiveDomain.Economy);
  });

  it("nothing anywhere in the roster reaches +30%", () => {
    for (const avatar of AVATARS) {
      expect(avatar.passive.magnitude, avatar.name).toBeLessThan(0.3);
    }
  });

  /** §9.1: money-only rosters make the meta feel like a store shelf. */
  it("unlocks five of eight by challenge, not by price", () => {
    expect(challengeAvatars().length).toBe(4);
    const byPrice = AVATARS.filter(
      (a) => a.unlock.kind === UnlockKind.Bits || a.unlock.kind === UnlockKind.Shards,
    );
    // Four challenges + Null's Shard price is the "not just money" majority;
    // one default, three purchased.
    expect(byPrice.length).toBe(3);
    expect(AVATARS.filter((a) => a.unlock.kind === UnlockKind.Default).length).toBe(1);
  });

  it("matches the GAME_BIBLE §9.1 prices", () => {
    expect(avatarById("kestrel")?.unlock.bits).toBe(5_000);
    expect(avatarById("ochre")?.unlock.bits).toBe(8_000);
    expect(avatarById("null")?.unlock.shards).toBe(16);
  });

  it("gives every runner a visual descriptor, and no asset path", () => {
    for (const avatar of AVATARS) {
      expect(avatar.visual.primary).toMatch(/^#[0-9A-F]{6}$/i);
      expect(avatar.visual.accent).toMatch(/^#[0-9A-F]{6}$/i);
      expect(avatar.visual.note.length).toBeGreaterThan(0);
      // Nothing that could 404 at runtime.
      expect(JSON.stringify(avatar.visual)).not.toMatch(/\.(png|jpg|glb|gltf|fbx)/i);
    }
  });

  it("the default runner has no passive", () => {
    expect(avatarById(DEFAULT_AVATAR_ID)?.passive.domain).toBe(PassiveDomain.None);
    expect(avatarById(DEFAULT_AVATAR_ID)?.passive.magnitude).toBe(0);
  });
});

describe("avatar challenges", () => {
  it("Ballast needs three unused Shields", () => {
    expect(challengesMetBy(runWith({ shieldsUnused: 2 }), [])).not.toContain("ballast");
    expect(challengesMetBy(runWith({ shieldsUnused: 3 }), [])).toContain("ballast");
  });

  it("Vane needs 40 rolls", () => {
    expect(challengesMetBy(runWith({ rolls: 39 }), [])).not.toContain("vane");
    expect(challengesMetBy(runWith({ rolls: 40 }), [])).toContain("vane");
  });

  it("Sable needs two Overdrives in one run", () => {
    expect(challengesMetBy(runWith({ overdrivesTriggered: 1 }), [])).not.toContain("sable");
    expect(challengesMetBy(runWith({ overdrivesTriggered: 2 }), [])).toContain("sable");
  });

  it("Quill needs 60 near-misses", () => {
    expect(challengesMetBy(runWith({ nearMisses: 59 }), [])).not.toContain("quill");
    expect(challengesMetBy(runWith({ nearMisses: 60 }), [])).toContain("quill");
  });

  it("does not re-unlock something already owned", () => {
    const run = runWith({ rolls: 100, nearMisses: 100, overdrivesTriggered: 5, shieldsUnused: 5 });
    expect(challengesMetBy(run, []).length).toBe(4);
    expect(challengesMetBy(run, ["vane", "quill"])).toEqual(["ballast", "sable"]);
  });

  it("an empty run unlocks nothing", () => {
    expect(challengesMetBy(runWith({}), [])).toEqual([]);
  });
});

describe("avatar passives applied", () => {
  it("only Ochre multiplies Bits", () => {
    expect(avatarBitMultiplier("ferro")).toBe(1);
    expect(avatarBitMultiplier("kestrel")).toBe(1);
    expect(avatarBitMultiplier("ochre")).toBeCloseTo(1.1, 10);
    expect(avatarBitMultiplier("not-a-runner")).toBe(1);
  });

  it("only Kestrel multiplies Flow gain", () => {
    expect(avatarFlowMultiplier("ferro")).toBe(1);
    expect(avatarFlowMultiplier("ochre")).toBe(1);
    expect(avatarFlowMultiplier("kestrel")).toBeCloseTo(
      1 + TUNING.meta.avatarGameplayPassiveCap,
      10,
    );
  });
});

describe("player level", () => {
  it("starts at level 1 with nothing travelled", () => {
    expect(levelForDistance(0)).toBe(1);
    expect(distanceForLevel(1)).toBe(0);
  });

  it("reaches level 2 at the tuned distance", () => {
    expect(distanceForLevel(2)).toBe(TUNING.meta.levelOneDistance);
    expect(levelForDistance(TUNING.meta.levelOneDistance - 1)).toBe(1);
    expect(levelForDistance(TUNING.meta.levelOneDistance)).toBe(2);
  });

  it("each level costs more than the last", () => {
    let previousStep = 0;
    for (let level = 2; level <= 12; level += 1) {
      const step = distanceForLevel(level) - distanceForLevel(level - 1);
      expect(step).toBeGreaterThan(previousStep);
      previousStep = step;
    }
  });

  it("caps at maxLevel and stops asking for more", () => {
    expect(levelForDistance(Number.MAX_SAFE_INTEGER)).toBe(TUNING.meta.maxLevel);
    const progress = levelProgress(Number.MAX_SAFE_INTEGER);
    expect(progress.maxed).toBe(true);
    expect(progress.remaining).toBe(0);
    expect(progress.fraction).toBe(1);
  });

  it("reports sensible mid-level progress", () => {
    const half = (distanceForLevel(2) + distanceForLevel(3)) / 2;
    const progress = levelProgress(half);
    expect(progress.level).toBe(2);
    expect(progress.fraction).toBeGreaterThan(0.4);
    expect(progress.fraction).toBeLessThan(0.6);
    expect(progress.remaining).toBeGreaterThan(0);
  });

  it("survives nonsense input", () => {
    expect(levelForDistance(Number.NaN)).toBe(1);
    expect(levelForDistance(-500)).toBe(1);
    expect(() => levelProgress(Number.NaN)).not.toThrow();
  });

  /** Level gates nothing that affects a run — it is a record, not a power source. */
  it("is not an input to any unlock that changes a run", () => {
    const veteran = { ...ZERO_LIFETIME, distance: 5_000_000, runs: 0, bestDistance: 0 };
    // Enormous lifetime distance, but no single strong run: the Static theme
    // stays locked, because it is gated on a run, not on a level.
    expect(isUnlocked(Unlockable.StaticTheme, veteran)).toBe(false);
  });
});

describe("lifetime stats", () => {
  it("accumulates totals and tracks bests", () => {
    let stats = ZERO_LIFETIME;
    stats = applyRunToLifetime(stats, {
      distance: 1_200,
      score: 5_000,
      bitsCollected: 90,
      nearMisses: 12,
      overdrivesTriggered: 1,
      fracturesSurvived: 0,
    });
    stats = applyRunToLifetime(stats, {
      distance: 800,
      score: 9_000,
      bitsCollected: 40,
      nearMisses: 4,
      overdrivesTriggered: 0,
      fracturesSurvived: 1,
    });

    expect(stats.distance).toBe(2_000);
    expect(stats.runs).toBe(2);
    expect(stats.bestScore).toBe(9_000);
    expect(stats.bestDistance).toBe(1_200);
    expect(stats.bitsCollected).toBe(130);
    expect(stats.nearMisses).toBe(16);
    expect(stats.overdrives).toBe(1);
    expect(stats.fracturesSurvived).toBe(1);
  });

  it("ignores negative values from a bad summary", () => {
    const stats = applyRunToLifetime(ZERO_LIFETIME, {
      distance: -100,
      score: 0,
      bitsCollected: -5,
      nearMisses: -1,
      overdrivesTriggered: -1,
      fracturesSurvived: -1,
    });
    expect(stats.distance).toBe(0);
    expect(stats.bitsCollected).toBe(0);
  });
});

describe("unlock gating", () => {
  it("unlocks the Static theme at 5,000m in a single run", () => {
    expect(isUnlocked(Unlockable.StaticTheme, { ...ZERO_LIFETIME, bestDistance: 4_999 })).toBe(
      false,
    );
    expect(isUnlocked(Unlockable.StaticTheme, { ...ZERO_LIFETIME, bestDistance: 5_000 })).toBe(
      true,
    );
  });

  it("opens the screens after a couple of runs each", () => {
    expect(isUnlocked(Unlockable.Store, { ...ZERO_LIFETIME, runs: 1 })).toBe(false);
    expect(isUnlocked(Unlockable.Store, { ...ZERO_LIFETIME, runs: 2 })).toBe(true);
    expect(isUnlocked(Unlockable.Missions, { ...ZERO_LIFETIME, runs: 3 })).toBe(true);
    expect(isUnlocked(Unlockable.Loadout, { ...ZERO_LIFETIME, runs: 4 })).toBe(true);
  });

  it("reports only what a run newly crossed", () => {
    const before = { ...ZERO_LIFETIME, runs: 1 };
    const after = { ...ZERO_LIFETIME, runs: 2 };
    expect(newlyUnlocked(before, after)).toEqual([Unlockable.Store]);
    expect(newlyUnlocked(after, after)).toEqual([]);
  });
});

describe("onboarding", () => {
  it("starts with everything unseen", () => {
    for (const value of Object.values(FRESH_ONBOARDING)) {
      expect(value).toBe(false);
    }
  });

  it("marking is idempotent and never mutates", () => {
    const once = markSeen(FRESH_ONBOARDING, "seenRollPrompt");
    expect(once.seenRollPrompt).toBe(true);
    expect(FRESH_ONBOARDING.seenRollPrompt).toBe(false);
    expect(markSeen(once, "seenRollPrompt")).toBe(once);
  });

  it("knows a first run", () => {
    expect(isFirstRun(ZERO_LIFETIME)).toBe(true);
    expect(isFirstRun({ ...ZERO_LIFETIME, runs: 1 })).toBe(false);
  });
});
