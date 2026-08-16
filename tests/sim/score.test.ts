import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createEventRing } from "@/game/sim/events";
import { createSim } from "@/game/sim/sim";
import { createState, F, RunStatus } from "@/game/sim/state";
import {
  addBitScore,
  addDistanceScore,
  addNearMissScore,
  addScore,
  bitsEarned,
  breakCombo,
  bumpCombo,
  getScore,
  getScoreFixed,
  scoreMultiplier,
} from "@/game/sim/scoring/score";
import { startOverdrive } from "@/game/sim/scoring/overdrive";

const TICK_RATE = TUNING.sim.tickRate;
const SCALE = TUNING.scoring.scoreFixedPointScale;
const FLOW_MAX = TUNING.flow.flowMax;

function idle() {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
}

describe("the accumulator is an exact integer", () => {
  it("holds an integral number of fixed-point units at all times", () => {
    const state = createState();
    for (let i = 0; i < 100_000; i += 1) {
      addDistanceScore(state, 0.3178493 * (1 + (i % 7)));
      expect(Number.isInteger(getScoreFixed(state))).toBe(true);
    }
  });

  it("stays well inside the exact-integer range of a double", () => {
    // A 20-minute run at maxSpeed under the Overdrive multiplier is the worst
    // realistic case. If this ever approached 2^53 the accumulator would start
    // rounding and every guarantee here would quietly evaporate.
    const worstCase =
      20 * 60 * TUNING.speed.maxSpeed * TUNING.overdrive.overdriveMultiplier * SCALE;
    expect(worstCase).toBeLessThan(Number.MAX_SAFE_INTEGER / 1000);
  });

  it("the reported score is an integer", () => {
    const state = createState();
    addDistanceScore(state, 12.3456789);
    expect(Number.isInteger(getScore(state))).toBe(true);
  });

  it("does not drift: 72,000 equal adds land on the exact analytic total", () => {
    // The whole reason for fixed point. Each increment is rounded once, to a
    // known value, and 72,000 identical roundings sum exactly.
    const state = createState();
    const PER_TICK = 0.2;
    const TICKS = 72_000;
    for (let i = 0; i < TICKS; i += 1) {
      addScore(state, PER_TICK);
    }
    // multiplier is 1.0 at zero Flow, so each add is round(0.2 * 1000) = 200.
    expect(getScoreFixed(state)).toBe(TICKS * Math.round(PER_TICK * SCALE));
    expect(getScore(state)).toBe((TICKS * 200) / SCALE);
  });

  it("a naive float accumulator WOULD have drifted on the same input", () => {
    // Demonstrates the bug this design exists to avoid, so nobody "simplifies"
    // the accumulator back to a float later.
    const PER_TICK = 0.1;
    const TICKS = 72_000;
    let naive = 0;
    for (let i = 0; i < TICKS; i += 1) {
      naive += PER_TICK;
    }
    expect(naive).not.toBe(TICKS * PER_TICK);
  });
});

describe("determinism over a 20-minute run", () => {
  const TWENTY_MINUTES = TICK_RATE * 60 * 20;

  /** A full-length run with no input at all. */
  function runIdle(seed: number): { score: number; fixed: number; hash: number } {
    const sim = createSim(seed);
    for (let i = 0; i < TWENTY_MINUTES; i += 1) {
      sim.tick(idle());
    }
    return {
      score: getScore(sim.getState()),
      fixed: getScoreFixed(sim.getState()),
      hash: sim.hash(),
    };
  }

  it("produces a bit-identical score every time", () => {
    const first = runIdle(0x5c04e);
    const second = runIdle(0x5c04e);
    const third = runIdle(0x5c04e);

    expect(second.fixed).toBe(first.fixed);
    expect(third.fixed).toBe(first.fixed);
    expect(second.hash).toBe(first.hash);
  });

  it("lands on an exact, asserted value", () => {
    // A survival-only 20-minute run: no Flow, so a flat 1.0x multiplier the whole
    // way, and the score is exactly the distance in metres. Pinned so that any
    // change to the speed curve, the tick order, or the accumulator shows up here
    // as a diff rather than as a silent rescoring of every leaderboard entry.
    const { score, fixed } = runIdle(0x5c04e);

    expect(fixed).toBe(32_088_964);
    expect(score).toBe(32_088);

    // Cross-check against the odometer. At 1.0 pts/m and a 1.0x multiplier the
    // score tracks distance, but NOT to the unit: each tick's contribution is
    // rounded once into milli-points, so the two can diverge by up to
    // `ticks * 0.5 / scale` = 36 points over a 20-minute run. Measured here at
    // +8.
    //
    // That bound is a property of the design, not a defect: the rounding is of
    // the increment rather than of the total, it is identical on every machine,
    // and it is what stops the total itself from drifting. A score that tracked
    // distance exactly would have to be a float, and would then disagree between
    // a browser and the P12 validation server.
    const sim = createSim(0x5c04e);
    for (let i = 0; i < TWENTY_MINUTES; i += 1) {
      sim.tick(idle());
    }
    const distance = Math.floor(sim.getState().f[F.distance] ?? 0);
    const bound = Math.ceil((TWENTY_MINUTES * 0.5) / SCALE);
    expect(Math.abs(score - distance)).toBeLessThanOrEqual(bound);
    expect(Math.abs(score - distance)).toBe(8);
  });

  it("is unaffected by how the ticks were batched", () => {
    const straight = runIdle(0x5c04e).fixed;

    const sim = createSim(0x5c04e);
    let done = 0;
    // Uneven batches, as a variable frame rate would deliver them.
    const batches = [1, 5, 2, 9, 3, 4, 1, 7];
    let b = 0;
    while (done < TWENTY_MINUTES) {
      const size = Math.min(batches[b % batches.length] ?? 1, TWENTY_MINUTES - done);
      for (let i = 0; i < size; i += 1) {
        sim.tick(idle());
      }
      done += size;
      b += 1;
    }
    expect(getScoreFixed(sim.getState())).toBe(straight);
  });
});

describe("the multiplier applies", () => {
  it("scales distance score by the Flow multiplier", () => {
    const plain = createState();
    addDistanceScore(plain, 100);

    const flowing = createState();
    flowing.f[F.flow] = FLOW_MAX;
    addDistanceScore(flowing, 100);

    expect(getScore(flowing)).toBe(getScore(plain) * TUNING.flow.flowMultiplierMax);
  });

  it("pays pointsPerBit at 1.0x and three times that at full Flow", () => {
    const plain = createState();
    addBitScore(plain);
    expect(getScore(plain)).toBe(TUNING.scoring.pointsPerBit);

    const flowing = createState();
    flowing.f[F.flow] = FLOW_MAX;
    addBitScore(flowing);
    expect(getScore(flowing)).toBe(TUNING.scoring.pointsPerBit * TUNING.flow.flowMultiplierMax);
  });

  it("pays pointsPerNearMiss for a graze", () => {
    const state = createState();
    addNearMissScore(state);
    expect(getScore(state)).toBe(TUNING.scoring.pointsPerNearMiss);
  });

  it("Overdrive's flat multiplier replaces the Flow one rather than stacking", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    startOverdrive(state, createEventRing());

    expect(scoreMultiplier(state)).toBe(TUNING.overdrive.overdriveMultiplier);

    addDistanceScore(state, 100);
    expect(getScore(state)).toBe(100 * TUNING.overdrive.overdriveMultiplier);
  });
});

describe("combo", () => {
  it("counts consecutive scoring events and tracks the best", () => {
    const state = createState();
    for (let i = 0; i < 7; i += 1) {
      bumpCombo(state);
    }
    expect(state.combo).toBe(7);
    expect(state.bestCombo).toBe(7);

    breakCombo(state);
    expect(state.combo).toBe(0);
    expect(state.bestCombo).toBe(7);

    for (let i = 0; i < 3; i += 1) {
      bumpCombo(state);
    }
    expect(state.bestCombo).toBe(7);
  });

  it("does NOT multiply the score", () => {
    // Deliberate: Flow is the only multiplier. A second one stacked on top would
    // pay twice for the same skilful play and make both impossible to tune.
    const withCombo = createState();
    for (let i = 0; i < 50; i += 1) {
      bumpCombo(withCombo);
    }
    addDistanceScore(withCombo, 100);

    const without = createState();
    addDistanceScore(without, 100);

    expect(getScore(withCombo)).toBe(getScore(without));
  });
});

describe("the end-of-run Bit award", () => {
  it("is floor(distance / bitsPerMetreDivisor)", () => {
    const state = createState();
    state.f[F.distance] = 2_575;
    expect(bitsEarned(state)).toBe(Math.floor(2_575 / TUNING.scoring.bitsPerMetreDivisor));
  });
});

describe("guards", () => {
  it("ignores non-positive additions rather than reversing the score", () => {
    const state = createState();
    addScore(state, 100);
    const before = getScoreFixed(state);
    addScore(state, 0);
    addScore(state, -500);
    expect(getScoreFixed(state)).toBe(before);
  });

  it("a dead player stops scoring", () => {
    const sim = createSim(0xdead1);
    for (let i = 0; i < 600; i += 1) {
      sim.tick(idle());
    }
    sim.getState().runStatus = RunStatus.Ended;
    const frozen = getScoreFixed(sim.getState());

    for (let i = 0; i < 600; i += 1) {
      sim.tick(idle());
    }
    expect(getScoreFixed(sim.getState())).toBe(frozen);
  });
});
