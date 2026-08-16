import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { F, Phase } from "@/game/sim/state";
import { applyStumble } from "@/game/sim/player";
import { closedFormSpeed, flowSpeedBonus } from "@/game/sim/scoring/difficulty";
import { difficultyFor } from "@/game/sim/level";

const TICK_RATE = TUNING.sim.tickRate;
const DT = TUNING.sim.fixedDelta;
const BASE = TUNING.speed.baseSpeed;
const CEILING = TUNING.speed.speedCeiling;
const MAX = TUNING.speed.maxSpeed;
const BONUS = TUNING.speed.flowSpeedBonus;
const FLOW_MAX = TUNING.flow.flowMax;

function idle() {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
}

describe("the exponential approach", () => {
  it("starts at baseSpeed", () => {
    const sim = createSim(1);
    expect(sim.getState().f[F.timeSpeed]).toBe(BASE);
  });

  it("is smooth — never a step, and monotonically increasing", () => {
    const sim = createSim(2);
    let previous: number = BASE;
    for (let i = 0; i < TICK_RATE * 120; i += 1) {
      sim.tick(idle());
      const speed = sim.getState().f[F.timeSpeed] ?? 0;
      expect(speed).toBeGreaterThan(previous);
      // No tick may move the speed by more than a hair; a step function here
      // would read as the game lurching.
      expect(speed - previous).toBeLessThan(0.01);
      previous = speed;
    }
  });

  it("is asymptotic — approaches speedCeiling and never passes it", () => {
    const sim = createSim(3);
    // An hour. The game must stay theoretically playable forever, which means
    // the curve converges rather than diverging.
    for (let i = 0; i < TICK_RATE * 3600; i += 1) {
      sim.tick(idle());
    }
    const speed = sim.getState().f[F.timeSpeed] ?? 0;
    expect(speed).toBeLessThan(CEILING);
    expect(speed).toBeCloseTo(CEILING, 4);
  });

  it("reaches ~63% of the way to the ceiling after one tau", () => {
    const sim = createSim(4);
    for (let i = 0; i < Math.round(TUNING.speed.speedTau / DT); i += 1) {
      sim.tick(idle());
    }
    const speed = sim.getState().f[F.timeSpeed] ?? 0;
    const fraction = (speed - BASE) / (CEILING - BASE);
    expect(fraction).toBeCloseTo(0.632, 2);
  });
});

describe("the incremental integration matches the closed form", () => {
  /**
   * The sim may not call `Math.exp` — it is only "implementation-approximated"
   * by ECMA-262 and browsers disagree in the last ulp, which would break P12's
   * server-side replay validation. So the curve is integrated with a frozen
   * per-tick constant instead.
   *
   * This is the proof that the substitution is sound: the incremental form and
   * the analytic one must agree to well within any tolerance a player could
   * perceive, over a full-length run.
   */
  it("agrees to 12 significant figures over 20 minutes", () => {
    const sim = createSim(5);
    const CHECKS = [1, 10, 60, 300, 600, 1200];
    let elapsed = 0;

    for (const seconds of CHECKS) {
      while (elapsed < seconds) {
        sim.tick(idle());
        elapsed += DT;
      }
      const incremental = sim.getState().f[F.timeSpeed] ?? 0;
      const analytic = closedFormSpeed(elapsed);
      expect(incremental, `at ${seconds}s`).toBeCloseTo(analytic, 10);
    }
  });

  it("the residual after 20 minutes is under a millionth of a u/s", () => {
    const sim = createSim(6);
    const TICKS = TICK_RATE * 60 * 20;
    for (let i = 0; i < TICKS; i += 1) {
      sim.tick(idle());
    }
    const incremental = sim.getState().f[F.timeSpeed] ?? 0;
    const analytic = closedFormSpeed(TICKS * DT);
    expect(Math.abs(incremental - analytic)).toBeLessThan(1e-6);
  });
});

describe("the Flow bonus", () => {
  it("is zero at empty and flowSpeedBonus at full", () => {
    expect(flowSpeedBonus(0)).toBe(0);
    expect(flowSpeedBonus(FLOW_MAX)).toBe(BONUS);
  });

  it("is linear", () => {
    expect(flowSpeedBonus(FLOW_MAX / 2)).toBeCloseTo(BONUS / 2, 10);
  });

  it("makes maxSpeed reachable ONLY with Flow", () => {
    // GAME_BIBLE §4.2's DECISION: the time curve alone approaches 28, and the
    // last 6 u/s are earned. Collapsing ceiling into max would make the
    // self-escalation cosmetic.
    expect(CEILING).toBeLessThan(MAX);
    expect(CEILING + BONUS).toBeLessThanOrEqual(MAX);

    const sim = createSim(7);
    for (let i = 0; i < TICK_RATE * 3600; i += 1) {
      sim.tick(idle());
    }
    expect(sim.getState().f[F.worldSpeed] ?? 0).toBeLessThan(MAX);
  });
});

describe("the Flow / speed coupling raises real difficulty", () => {
  /**
   * The property the whole phase exists to produce: an expert is not merely
   * scoring more, they are playing a genuinely faster and harder game at the
   * same distance than a survivor is.
   */
  it("an expert log reaches a higher speed at the same distance than a survivor", () => {
    const TARGET_DISTANCE = 1_500;

    /** Runs until the odometer passes `TARGET_DISTANCE`, holding `flow`. */
    function runTo(flow: number): { speed: number; seconds: number } {
      const sim = createSim(0xe4);
      let ticks = 0;
      while ((sim.getState().f[F.distance] ?? 0) < TARGET_DISTANCE) {
        sim.getState().f[F.flow] = flow;
        sim.tick(idle());
        ticks += 1;
      }
      return { speed: sim.getState().f[F.worldSpeed] ?? 0, seconds: ticks * DT };
    }

    const expert = runTo(FLOW_MAX);
    const survivor = runTo(0);

    // Same distance, more speed.
    expect(expert.speed).toBeGreaterThan(survivor.speed);
    // And got there sooner, which is what "the game escalates around you" means.
    expect(expert.seconds).toBeLessThan(survivor.seconds);
  });

  it("and a higher generator difficulty band at the same distance", () => {
    // P06 wired Flow into chunk selection as well as speed. At the same metre
    // mark, the expert is handed harder track.
    const AT_METRES = 600;
    expect(difficultyFor(AT_METRES, FLOW_MAX)).toBeGreaterThan(difficultyFor(AT_METRES, 0));
  });

  it("a scripted expert log outscores a survival-only log at the same distance", () => {
    // End to end through the real sim: the multiplier half of the coupling.
    const TARGET_DISTANCE = 1_500;

    function scoreAt(flow: number): number {
      const sim = createSim(0xe5);
      while ((sim.getState().f[F.distance] ?? 0) < TARGET_DISTANCE) {
        sim.getState().f[F.flow] = flow;
        sim.tick(idle());
      }
      return sim.getState().f[F.scoreFixed] ?? 0;
    }

    const expert = scoreAt(FLOW_MAX);
    const survivor = scoreAt(0);

    expect(expert).toBeGreaterThan(survivor);
    // Roughly the multiplier ratio, since both covered the same distance.
    expect(expert / survivor).toBeCloseTo(TUNING.flow.flowMultiplierMax, 1);
  });
});

describe("the stumble penalty", () => {
  it("slows the world below the unstumbled speed", () => {
    const sim = createSim(8);
    for (let i = 0; i < 300; i += 1) {
      sim.tick(idle());
    }
    const before = sim.getState().f[F.worldSpeed] ?? 0;

    // Through the real entry point. Setting `phase` by hand does not work: with
    // no stumble timer set, stepPlayer recovers it back to RUNNING in the same
    // tick, before stepDifficulty ever reads it.
    applyStumble(sim.getState(), sim.events);
    expect(sim.getState().player.phase).toBe(Phase.Stumbling);

    sim.tick(idle());
    const during = sim.getState().f[F.worldSpeed] ?? 0;

    expect(during).toBeLessThan(before);
    expect(during / before).toBeCloseTo(TUNING.collision.stumbleSpeedPenalty, 2);
  });
});

describe("difficulty bands", () => {
  it("advance with distance and emit on transition", () => {
    const sim = createSim(9);
    const bands = new Set<number>();
    for (let i = 0; i < TICK_RATE * 300; i += 1) {
      sim.tick(idle());
      bands.add(sim.getState().band);
    }
    expect(bands.size).toBeGreaterThan(1);
  });

  it("never walk backwards", () => {
    const sim = createSim(10);
    let previous = 0;
    for (let i = 0; i < TICK_RATE * 300; i += 1) {
      sim.tick(idle());
      expect(sim.getState().band).toBeGreaterThanOrEqual(previous);
      previous = sim.getState().band;
    }
  });
});
