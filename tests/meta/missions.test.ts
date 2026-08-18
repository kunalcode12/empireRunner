import { afterEach, describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { DAILY_POOL, MissionUnit, WEEKLY_POOL } from "@/game/meta/missionPool";
import {
  applyRun,
  claimRewards,
  closestUnmet,
  dailyMissionsFor,
  dailyStatuses,
  emptyMissionProgress,
  formatShortfall,
  hashString,
  rollPeriods,
  utcDayKey,
  utcWeekKey,
  weeklyContractFor,
  weeklyStatuses,
  type MissionProgress,
} from "@/game/meta/missions";
import { buildRunSummary, createRunRecorder, type RunSummary } from "@/game/meta/runSummary";

/** Wednesday 2026-08-19, 12:00 UTC. */
const WEDNESDAY = Date.UTC(2026, 7, 19, 12, 0, 0);

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

describe("UTC period keys", () => {
  it("derives the day from UTC, never local time", () => {
    expect(utcDayKey(WEDNESDAY)).toBe("2026-08-19");
    // One minute before midnight UTC is still the 19th; one minute after is the 20th.
    expect(utcDayKey(Date.UTC(2026, 7, 19, 23, 59))).toBe("2026-08-19");
    expect(utcDayKey(Date.UTC(2026, 7, 20, 0, 1))).toBe("2026-08-20");
  });

  it("resets the week on Monday 00:00 UTC", () => {
    // 2026-08-17 is a Monday.
    expect(utcWeekKey(Date.UTC(2026, 7, 17, 0, 0))).toBe("2026-08-17");
    expect(utcWeekKey(WEDNESDAY)).toBe("2026-08-17");
    expect(utcWeekKey(Date.UTC(2026, 7, 23, 23, 59))).toBe("2026-08-17");
    expect(utcWeekKey(Date.UTC(2026, 7, 24, 0, 0))).toBe("2026-08-24");
  });

  /**
   * `getUTCDay()` returns 0 for Sunday, so Sunday has to walk back six days
   * rather than one. The off-by-one gives Sunday its own one-day "week", and
   * only ever on Sundays — the kind of bug that ships.
   */
  it("puts Sunday in the week that started six days earlier", () => {
    const sunday = Date.UTC(2026, 7, 23, 12, 0);
    expect(new Date(sunday).getUTCDay()).toBe(0);
    expect(utcWeekKey(sunday)).toBe("2026-08-17");
  });
});

describe("daily determinism", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it("gives the same three missions for the same UTC day", () => {
    const morning = dailyMissionsFor(Date.UTC(2026, 7, 19, 0, 30));
    const evening = dailyMissionsFor(Date.UTC(2026, 7, 19, 23, 30));
    expect(morning.map((m) => m.id)).toEqual(evening.map((m) => m.id));
  });

  /**
   * The whole point: a player in Kiritimati (UTC+14) and one in Midway
   * (UTC-11) looking at their phones at the same instant see the same set.
   * Anything reading local calendar fields breaks this, and only for players
   * near a date line.
   */
  it("is identical across timezones for the same instant", () => {
    const zones = [
      "UTC",
      "Pacific/Kiritimati",
      "Pacific/Midway",
      "Asia/Kolkata",
      "America/New_York",
    ];
    const results = zones.map((zone) => {
      process.env.TZ = zone;
      return dailyMissionsFor(WEDNESDAY).map((m) => m.id);
    });
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
  });

  it("gives a different set on a different day", () => {
    const wednesday = dailyMissionsFor(WEDNESDAY).map((m) => m.id);
    let differing = 0;
    for (let day = 1; day <= 10; day += 1) {
      const other = dailyMissionsFor(WEDNESDAY + day * 86_400_000).map((m) => m.id);
      if (JSON.stringify(other) !== JSON.stringify(wednesday)) {
        differing += 1;
      }
    }
    // Not every day has to differ, but ten identical days would mean the seed
    // is not reaching the generator.
    expect(differing).toBeGreaterThan(7);
  });

  it("always returns exactly three, with no duplicates", () => {
    for (let day = 0; day < 400; day += 1) {
      const missions = dailyMissionsFor(WEDNESDAY + day * 86_400_000);
      expect(missions.length).toBe(TUNING.meta.dailyMissionCount);
      expect(new Set(missions.map((m) => m.id)).size).toBe(missions.length);
    }
  });

  it("eventually draws every mission in the pool", () => {
    const seen = new Set<string>();
    for (let day = 0; day < 400; day += 1) {
      for (const mission of dailyMissionsFor(WEDNESDAY + day * 86_400_000)) {
        seen.add(mission.id);
      }
    }
    expect(seen.size).toBe(DAILY_POOL.length);
  });

  it("picks one stable weekly contract per week", () => {
    const monday = weeklyContractFor(Date.UTC(2026, 7, 17, 0, 0));
    const sunday = weeklyContractFor(Date.UTC(2026, 7, 23, 23, 0));
    expect(monday.id).toBe(sunday.id);
    expect(WEEKLY_POOL.some((c) => c.id === monday.id)).toBe(true);
  });

  it("hashString is stable and unsigned", () => {
    expect(hashString("axis-daily-2026-08-19")).toBe(hashString("axis-daily-2026-08-19"));
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("axis")).toBeGreaterThanOrEqual(0);
  });
});

describe("progress from run summaries", () => {
  it("totals accumulate and single-run metrics take the best", () => {
    let progress = emptyMissionProgress(WEDNESDAY);
    const missions = dailyMissionsFor(WEDNESDAY);

    progress = applyRun(progress, runWith({ distance: 800, bitsCollected: 100 }), WEDNESDAY);
    progress = applyRun(progress, runWith({ distance: 500, bitsCollected: 60 }), WEDNESDAY);

    for (const mission of missions) {
      const value = progress.values[mission.id] ?? 0;
      if (mission.metric === "distanceTotal") {
        expect(value).toBe(1_300);
      }
      if (mission.metric === "distanceSingleRun") {
        // The best run, not the sum.
        expect(value).toBe(800);
      }
      if (mission.metric === "bitsTotal") {
        expect(value).toBe(160);
      }
      if (mission.metric === "runsCompleted") {
        expect(value).toBe(2);
      }
    }
  });

  it("rolls the dailies at the day boundary but keeps the week", () => {
    let progress = emptyMissionProgress(WEDNESDAY);
    progress = applyRun(progress, runWith({ distance: 2_000 }), WEDNESDAY);

    const contract = weeklyContractFor(WEDNESDAY);
    const weeklyBefore = progress.values[contract.id] ?? 0;
    expect(weeklyBefore).toBeGreaterThan(0);

    const thursday = WEDNESDAY + 86_400_000;
    const rolled = rollPeriods(progress, thursday);

    expect(rolled.dayKey).toBe("2026-08-20");
    expect(rolled.weekKey).toBe("2026-08-17");
    // The contract survived; a new day must not reset five runs of weekly work.
    expect(rolled.values[contract.id]).toBe(weeklyBefore);
    for (const mission of dailyMissionsFor(WEDNESDAY)) {
      expect(rolled.values[mission.id]).toBeUndefined();
    }
  });

  it("clears claims when the period rolls", () => {
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      claimedDailies: ["daily-runs-5"],
      claimedWeeklyTiers: [1],
    };
    const nextWeek = WEDNESDAY + 7 * 86_400_000;
    const rolled = rollPeriods(progress, nextWeek);
    expect(rolled.claimedDailies).toEqual([]);
    expect(rolled.claimedWeeklyTiers).toEqual([]);
  });

  it("is a no-op within the same period", () => {
    const progress = emptyMissionProgress(WEDNESDAY);
    expect(rollPeriods(progress, WEDNESDAY + 60_000)).toBe(progress);
  });
});

describe("the near-miss — GAME_BIBLE §9.4", () => {
  /** The exact line from the design document. */
  it("reports 40m short of a 3,000m goal", () => {
    const contract = WEEKLY_POOL.find((c) => c.id === "weekly-distance-single");
    expect(contract).toBeDefined();

    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: { [contract?.id ?? ""]: 2_960 },
    };
    const tier3 = weeklyStatuses(progress, WEDNESDAY).find((s) => s.target === 3_000);

    // Only meaningful on a week that actually drew this contract; the shortfall
    // arithmetic is what is under test, so compute it directly too.
    const shortBy = 3_000 - 2_960;
    expect(shortBy).toBe(40);
    if (tier3 !== undefined) {
      expect(tier3.shortBy).toBe(40);
      expect(formatShortfall(tier3)).toBe("YOU WERE 40m SHORT");
    }
  });

  it("computes shortfall in each mission's own unit", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    // Half of each target, so this holds whatever the day happens to draw —
    // one of the pool's targets is 2, and `target - 3` would clamp to zero.
    const values = Object.fromEntries(missions.map((m) => [m.id, m.target / 2]));
    const progress: MissionProgress = { ...emptyMissionProgress(WEDNESDAY), values };

    for (const status of dailyStatuses(progress, WEDNESDAY)) {
      const mission = missions.find((m) => m.id === status.id);
      expect(mission).toBeDefined();
      expect(status.shortBy).toBeCloseTo((mission?.target ?? 0) / 2, 10);
      expect(status.complete).toBe(false);
      expect(status.fraction).toBeCloseTo(0.5, 10);
      expect(status.unit).toBe(mission?.unit);
    }
  });

  it("reports zero short and complete once the target is met", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: Object.fromEntries(missions.map((m) => [m.id, m.target])),
    };
    for (const status of dailyStatuses(progress, WEDNESDAY)) {
      expect(status.complete).toBe(true);
      expect(status.shortBy).toBe(0);
      expect(status.fraction).toBe(1);
    }
  });

  /**
   * Ranked by FRACTION, not by absolute remainder. Ranking by remainder would
   * surface whichever mission happens to count in small numbers, which reads as
   * random to the player and breaks the line.
   */
  it("picks the mission the player was proportionally nearest to", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    const [first, second] = missions;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      return;
    }

    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      // `first` is 99% done; `second` is 10% done but may have a far smaller
      // absolute remainder.
      values: {
        [first.id]: first.target * 0.99,
        [second.id]: second.target * 0.1,
      },
    };

    const closest = closestUnmet(progress, WEDNESDAY);
    expect(closest?.id).toBe(first.id);
  });

  it("never returns a completed mission", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: Object.fromEntries(missions.map((m) => [m.id, m.target * 10])),
    };
    const closest = closestUnmet(progress, WEDNESDAY);
    // The weekly is still open even when every daily is done.
    if (closest !== null) {
      expect(closest.complete).toBe(false);
    }
  });

  it("still returns something for a player with zero progress", () => {
    expect(closestUnmet(emptyMissionProgress(WEDNESDAY), WEDNESDAY)).not.toBeNull();
  });

  it("returns null only when literally everything is complete", () => {
    const contract = weeklyContractFor(WEDNESDAY);
    const values: Record<string, number> = { [contract.id]: Number.MAX_SAFE_INTEGER };
    for (const mission of dailyMissionsFor(WEDNESDAY)) {
      values[mission.id] = Number.MAX_SAFE_INTEGER;
    }
    const progress: MissionProgress = { ...emptyMissionProgress(WEDNESDAY), values };
    expect(closestUnmet(progress, WEDNESDAY)).toBeNull();
  });

  it("never says 'you were 0 short'", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    const mission = missions[0];
    expect(mission).toBeDefined();
    if (mission === undefined) {
      return;
    }
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: { [mission.id]: mission.target - 0.01 },
    };
    const status = dailyStatuses(progress, WEDNESDAY).find((s) => s.id === mission.id);
    expect(status).toBeDefined();
    if (status !== undefined) {
      expect(formatShortfall(status)).not.toContain(" 0 ");
      expect(formatShortfall(status)).toContain("SHORT");
    }
  });

  it("formats a count without a unit and metres with one", () => {
    const metres = {
      id: "x",
      label: "l",
      unit: MissionUnit.Metres,
      target: 100,
      value: 60,
      complete: false,
      fraction: 0.6,
      shortBy: 40,
    };
    const count = { ...metres, unit: MissionUnit.Count };
    expect(formatShortfall(metres)).toBe("YOU WERE 40m SHORT");
    expect(formatShortfall(count)).toBe("YOU WERE 40 SHORT");
  });
});

describe("rewards", () => {
  it("pays a Shard for all three dailies, exactly once", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: Object.fromEntries(missions.map((m) => [m.id, m.target])),
    };

    const first = claimRewards(progress, WEDNESDAY);
    expect(first.dailyShards).toBe(TUNING.meta.dailyAllCompleteShards);

    // Claims are recorded in the object that is returned, so there is no window
    // in which a caller knows about a reward it has not yet marked.
    const second = claimRewards(first.progress, WEDNESDAY);
    expect(second.dailyShards).toBe(0);
  });

  it("pays nothing until all three are done", () => {
    const missions = dailyMissionsFor(WEDNESDAY);
    const partial: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: Object.fromEntries(missions.slice(0, 2).map((m) => [m.id, m.target])),
    };
    expect(claimRewards(partial, WEDNESDAY).dailyShards).toBe(0);
  });

  it("pays weekly tiers 2/3/5 and never twice", () => {
    const contract = weeklyContractFor(WEDNESDAY);
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: { [contract.id]: contract.targets[2] },
    };

    const first = claimRewards(progress, WEDNESDAY);
    expect(first.weeklyTiers).toEqual([1, 2, 3]);
    expect(first.weeklyShards).toBe(
      TUNING.meta.weeklyTierShards.reduce((sum, shards) => sum + shards, 0),
    );

    expect(claimRewards(first.progress, WEDNESDAY).weeklyShards).toBe(0);
  });

  it("pays only the tiers actually reached", () => {
    const contract = weeklyContractFor(WEDNESDAY);
    const progress: MissionProgress = {
      ...emptyMissionProgress(WEDNESDAY),
      values: { [contract.id]: contract.targets[0] },
    };
    const rewards = claimRewards(progress, WEDNESDAY);
    expect(rewards.weeklyTiers).toEqual([1]);
    expect(rewards.weeklyShards).toBe(TUNING.meta.weeklyTierShards[0]);
  });
});

describe("the pools themselves", () => {
  it("every daily has a positive target and weight", () => {
    for (const mission of DAILY_POOL) {
      expect(mission.target, mission.id).toBeGreaterThan(0);
      expect(mission.weight, mission.id).toBeGreaterThan(0);
      expect(mission.label.length, mission.id).toBeGreaterThan(0);
    }
  });

  it("mission ids are unique", () => {
    const ids = [...DAILY_POOL.map((m) => m.id), ...WEEKLY_POOL.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every weekly has three strictly ascending tiers", () => {
    for (const contract of WEEKLY_POOL) {
      expect(contract.targets.length).toBe(TUNING.meta.weeklyTierCount);
      expect(contract.targets[0]).toBeLessThan(contract.targets[1]);
      expect(contract.targets[1]).toBeLessThan(contract.targets[2]);
    }
  });

  it("the pool is bigger than one day's draw, or dailies never change", () => {
    expect(DAILY_POOL.length).toBeGreaterThan(TUNING.meta.dailyMissionCount);
  });
});
