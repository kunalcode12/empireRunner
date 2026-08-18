import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { SimEvent } from "@/game/sim/events";
import { EntityType } from "@/game/sim/level/entities";
import { createSim } from "@/game/sim/sim";
import { F } from "@/game/sim/state";
import { getScore } from "@/game/sim/scoring";
import {
  CoinKind,
  buildRunSummary,
  createRunRecorder,
  emptyRunSummary,
  recordEvent,
  recordFlow,
  resetRunRecorder,
  themeForDistance,
} from "@/game/meta/runSummary";
import { createLocalEconomyBackend } from "@/game/meta/backend";
import { emptyMissionProgress } from "@/game/meta/missions";
import { ZERO_LIFETIME } from "@/game/meta/progression";
import { ZERO_UPGRADES } from "@/game/meta/upgrades";
import { settleRun } from "@/game/meta/settle";
import { driveAlive } from "../helpers/drive";

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

describe("the recorder", () => {
  /**
   * The kinds are read from the sim's own entity table, not restated. Restating
   * them is what produced the ThemeChange bug at P11 — a consumer held its own
   * copy, the sim's value moved, and nothing failed until someone read the
   * output. The first draft of runSummary.ts guessed 1/2/3.
   */
  it("reads pickup kinds from the sim, not from a local copy", () => {
    expect(CoinKind.Bit).toBe(EntityType.Bit);
    expect(CoinKind.BitCluster).toBe(EntityType.BitCluster);
    expect(CoinKind.Shard).toBe(EntityType.Shard);
    expect(CoinKind.Bit).toBe(20);
  });

  it("counts Bits, clusters and Shards separately", () => {
    const recorder = createRunRecorder();
    recordEvent(recorder, SimEvent.Coin, CoinKind.Bit);
    recordEvent(recorder, SimEvent.Coin, CoinKind.Bit);
    recordEvent(recorder, SimEvent.Coin, CoinKind.BitCluster);
    recordEvent(recorder, SimEvent.Coin, CoinKind.Shard);

    // A cluster is 8 Bits — GAME_BIBLE §7.3.
    expect(recorder.bitsCollected).toBe(10);
    expect(recorder.shardsCollected).toBe(1);
  });

  it("counts every verb and outcome the summary reports", () => {
    const recorder = createRunRecorder();
    const events: [number, number][] = [
      [SimEvent.NearMiss, 0],
      [SimEvent.NearMiss, 0],
      [SimEvent.OverdriveStart, 0],
      [SimEvent.Shatter, 0],
      [SimEvent.RollEnd, 0],
      [SimEvent.Jump, 0],
      [SimEvent.SlideStart, 0],
      [SimEvent.Stumble, 0],
      [SimEvent.ShieldAbsorb, 0],
      [SimEvent.FractureArm, 0],
      [SimEvent.FractureResolve, 1],
      [SimEvent.Crash, 0],
    ];
    for (const [type, payload] of events) {
      recordEvent(recorder, type, payload);
    }

    expect(recorder.nearMisses).toBe(2);
    expect(recorder.overdrivesTriggered).toBe(1);
    expect(recorder.obstaclesShattered).toBe(1);
    expect(recorder.rolls).toBe(1);
    expect(recorder.jumps).toBe(1);
    expect(recorder.slides).toBe(1);
    expect(recorder.stumbles).toBe(1);
    expect(recorder.shieldsUsed).toBe(1);
    expect(recorder.fracturesUsed).toBe(1);
    expect(recorder.fracturesSurvived).toBe(1);
    expect(recorder.died).toBe(true);
  });

  it("counts a failed Fracture as used but not survived", () => {
    const recorder = createRunRecorder();
    recordEvent(recorder, SimEvent.FractureArm, 0);
    recordEvent(recorder, SimEvent.FractureResolve, 0);
    expect(recorder.fracturesUsed).toBe(1);
    expect(recorder.fracturesSurvived).toBe(0);
  });

  it("ignores events it has no business counting", () => {
    const recorder = createRunRecorder();
    const before = JSON.stringify(recorder);
    recordEvent(recorder, SimEvent.OverdriveTick, 0);
    recordEvent(recorder, SimEvent.FlowGain, 0);
    recordEvent(recorder, SimEvent.BandChange, 0);
    expect(JSON.stringify(recorder)).toBe(before);
  });

  it("tracks Flow as a high-water mark", () => {
    const recorder = createRunRecorder();
    recordFlow(recorder, 40);
    recordFlow(recorder, 100);
    recordFlow(recorder, 12);
    expect(recorder.peakFlow).toBe(100);
  });

  it("resets in place, allocating nothing", () => {
    const recorder = createRunRecorder();
    recordEvent(recorder, SimEvent.NearMiss, 0);
    recordFlow(recorder, 80);
    resetRunRecorder(recorder);
    expect(recorder).toEqual(createRunRecorder());
  });
});

describe("theme derivation", () => {
  it("matches the milestone table the generator uses", () => {
    const [first, second, third] = TUNING.level.themeMilestones;
    expect(themeForDistance(0)).toBe(0);
    expect(themeForDistance((first ?? 0) - 1)).toBe(0);
    expect(themeForDistance(first ?? 0)).toBe(1);
    expect(themeForDistance(second ?? 0)).toBe(2);
    expect(themeForDistance(third ?? 0)).toBe(3);
    expect(themeForDistance(Number.MAX_SAFE_INTEGER)).toBe(TUNING.level.themeMilestones.length);
  });
});

describe("buildRunSummary", () => {
  it("freezes the result so several systems can share it", () => {
    const summary = emptyRunSummary();
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("clamps negative sim values rather than propagating them", () => {
    const summary = buildRunSummary(createRunRecorder(), {
      distance: -50,
      score: -10,
      bestCombo: 0,
      band: 0,
      elapsedSeconds: -1,
      seed: 7,
      shieldsHeld: -2,
    });
    expect(summary.distance).toBe(0);
    expect(summary.score).toBe(0);
    expect(summary.durationSeconds).toBe(0);
    expect(summary.shieldsUnused).toBe(0);
  });

  it("counts obstacles cleared as near-misses plus shatters, without double-counting", () => {
    const recorder = createRunRecorder();
    recordEvent(recorder, SimEvent.NearMiss, 0);
    recordEvent(recorder, SimEvent.NearMiss, 0);
    recordEvent(recorder, SimEvent.Shatter, 0);

    const summary = buildRunSummary(recorder, {
      distance: 100,
      score: 0,
      bestCombo: 0,
      band: 0,
      elapsedSeconds: 0,
      seed: 1,
      shieldsHeld: 0,
    });
    expect(summary.obstaclesCleared).toBe(3);
    expect(summary.obstaclesShattered).toBe(1);
  });

  it("carries the replay blob only when one is supplied", () => {
    const blob = new Uint8Array([1, 2, 3]);
    const end = {
      distance: 0,
      score: 0,
      bestCombo: 0,
      band: 0,
      elapsedSeconds: 0,
      seed: 1,
      shieldsHeld: 0,
    };
    expect(buildRunSummary(createRunRecorder(), end).replay).toBeUndefined();
    expect(buildRunSummary(createRunRecorder(), end, blob).replay).toBe(blob);
  });
});

describe("end to end, from a real sim run", () => {
  /**
   * The recorder is fed from the same event ring the render layer drains, so
   * this drives an actual sim and folds its real events. If the ring's event
   * kinds move, this fails here rather than in a player's mission progress.
   */
  it("summarises a live run and settles it into rewards", async () => {
    const sim = createSim(7);
    const recorder = createRunRecorder();
    const ring = sim.events;

    let cursor = 0;
    driveAlive(sim, TUNING.sim.tickRate * 30, {
      onTick: () => {
        for (; cursor < ring.head; cursor += 1) {
          const slot = cursor % ring.capacity;
          recordEvent(recorder, ring.type[slot] ?? 0, ring.payload[slot * ring.payloadSlots] ?? 0);
        }
        recordFlow(recorder, sim.getState().f[F.flow] ?? 0);
      },
    });

    const state = sim.getState();
    const summary = buildRunSummary(recorder, {
      distance: state.f[F.distance] ?? 0,
      score: getScore(state),
      bestCombo: state.bestCombo,
      band: state.band,
      elapsedSeconds: state.f[F.elapsed] ?? 0,
      seed: 7,
      shieldsHeld: 0,
    });

    // A real 30-second run travels and scores.
    expect(summary.distance).toBeGreaterThan(0);
    expect(summary.durationSeconds).toBeGreaterThan(0);
    expect(summary.themeReached).toBeGreaterThanOrEqual(0);

    const backend = createLocalEconomyBackend({ now: () => AT });
    const settlement = await settleRun(
      backend,
      {
        run: summary,
        upgrades: ZERO_UPGRADES,
        avatarId: "ferro",
        boosts: [],
        missions: emptyMissionProgress(AT),
        lifetime: ZERO_LIFETIME,
        avatarChallengesClaimed: [],
        ownedAvatars: ["ferro"],
      },
      AT,
    );

    // Distance alone pays Bits, so a real run always earns something.
    expect(settlement.bitsAwarded).toBeGreaterThan(0);
    expect(settlement.balances.bits).toBe(settlement.bitsAwarded);
    expect(settlement.lifetime.runs).toBe(1);
    expect(settlement.lifetime.distance).toBeCloseTo(summary.distance, 6);
    expect(settlement.shortfalls).toEqual([]);
  });
});
