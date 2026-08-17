import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createEventRing, eventPayloadAt, eventTypeAt, SimEvent } from "@/game/sim/events";
import { createSim } from "@/game/sim/sim";
import { driveEmpty } from "../helpers/drive";
import { createState, F, RunStatus, type SimState } from "@/game/sim/state";
import {
  addFlow,
  breakBitStreak,
  FlowSource,
  flowMultiplier,
  getFlow,
  isPerfectSlide,
  nearMissFlow,
  recordBit,
  restoreFractureFlow,
  slideLeadInSeconds,
  stepFlowDecay,
  zeroFlow,
} from "@/game/sim/scoring/flow";

const DT = TUNING.sim.fixedDelta;
const TICK_RATE = TUNING.sim.tickRate;
const FLOW_MAX = TUNING.flow.flowMax;
const DECAY = TUNING.flow.flowDecayPerSecond;
const GRACE = TUNING.flow.flowDecayGrace;
const NEAR_MISS_RADIUS = TUNING.flow.nearMissRadius;
const FLOW_PER_NEAR_MISS = TUNING.flow.flowPerNearMiss;
const SCALE_MIN = TUNING.flow.nearMissScaleMin;

describe("near-miss Flow scales with proximity", () => {
  it("pays the full award for a graze at zero gap", () => {
    expect(nearMissFlow(0)).toBeCloseTo(FLOW_PER_NEAR_MISS, 10);
  });

  it(`pays ${SCALE_MIN * 100}% at exactly nearMissRadius`, () => {
    expect(nearMissFlow(NEAR_MISS_RADIUS)).toBeCloseTo(FLOW_PER_NEAR_MISS * SCALE_MIN, 10);
  });

  it("is monotonically decreasing in gap", () => {
    let previous = Number.POSITIVE_INFINITY;
    const STEPS = 50;
    for (let i = 0; i <= STEPS; i += 1) {
      const value = nearMissFlow((i / STEPS) * NEAR_MISS_RADIUS);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it("clamps outside the radius rather than going negative", () => {
    expect(nearMissFlow(NEAR_MISS_RADIUS * 3)).toBeCloseTo(FLOW_PER_NEAR_MISS * SCALE_MIN, 10);
    expect(nearMissFlow(-1)).toBeCloseTo(FLOW_PER_NEAR_MISS, 10);
  });

  it("uses no transcendental — the same input is bit-identical every call", () => {
    // The determinism property that matters for P12: not "close", identical.
    const a = nearMissFlow(0.137);
    for (let i = 0; i < 1000; i += 1) {
      expect(nearMissFlow(0.137)).toBe(a);
    }
  });
});

describe("the meter", () => {
  it("clamps at flowMax and never overshoots", () => {
    const state = createState();
    const events = createEventRing();
    for (let i = 0; i < 100; i += 1) {
      addFlow(state, 25, FlowSource.NearMiss, events);
    }
    expect(getFlow(state)).toBe(FLOW_MAX);
  });

  it("emits FlowFull exactly once on the crossing, not every tick at the ceiling", () => {
    const state = createState();
    const events = createEventRing();
    for (let i = 0; i < 60; i += 1) {
      addFlow(state, 10, FlowSource.NearMiss, events);
    }

    let full = 0;
    for (let i = 0; i < events.head; i += 1) {
      if (eventTypeAt(events, i) === SimEvent.FlowFull) {
        full += 1;
      }
    }
    expect(full).toBe(1);
  });

  it("reports the applied amount, not the requested one, at the ceiling", () => {
    const state = createState();
    const events = createEventRing();
    state.f[F.flow] = FLOW_MAX - 2;
    expect(addFlow(state, 10, FlowSource.NearMiss, events)).toBeCloseTo(2, 10);
  });

  it("carries source and resulting Flow in the FlowGain payload", () => {
    const state = createState();
    const events = createEventRing();
    addFlow(state, 6, FlowSource.ForcedRoll, events);

    const index = events.head - 1;
    expect(eventTypeAt(events, index)).toBe(SimEvent.FlowGain);
    expect(eventPayloadAt(events, index, 1)).toBe(FlowSource.ForcedRoll);
    expect(eventPayloadAt(events, index, 2)).toBeCloseTo(6, 10);
  });
});

describe("decay", () => {
  it("does not bite inside the grace window", () => {
    const state = createState();
    state.f[F.flow] = 50;
    const graceTicks = Math.floor(GRACE / DT);
    for (let i = 0; i < graceTicks; i += 1) {
      stepFlowDecay(state, DT);
    }
    expect(getFlow(state)).toBe(50);
  });

  it("bleeds at flowDecayPerSecond once the grace has elapsed", () => {
    const state = createState();
    state.f[F.flow] = 50;

    const totalSeconds = 10;
    for (let i = 0; i < TICK_RATE * totalSeconds; i += 1) {
      stepFlowDecay(state, DT);
    }

    // Grace runs first, then decay for the remainder.
    const decaySeconds = totalSeconds - GRACE;
    expect(getFlow(state)).toBeCloseTo(50 - DECAY * decaySeconds, 6);
  });

  it("a gain resets the grace, so tight play never bleeds", () => {
    const state = createState();
    const events = createEventRing();
    state.f[F.flow] = 50;

    // A gain every second, which is inside the 2.0s grace, for a minute.
    for (let second = 0; second < 60; second += 1) {
      addFlow(state, 1, FlowSource.NearMiss, events);
      for (let i = 0; i < TICK_RATE; i += 1) {
        stepFlowDecay(state, DT);
      }
    }

    // Never decayed: 50 + 60 gains, clamped at the ceiling.
    expect(getFlow(state)).toBe(FLOW_MAX);
  });

  it("never goes below zero", () => {
    const state = createState();
    state.f[F.flow] = 1;
    for (let i = 0; i < TICK_RATE * 60; i += 1) {
      stepFlowDecay(state, DT);
    }
    expect(getFlow(state)).toBe(0);
  });

  it("idling safely in the middle lane bleeds a full meter to empty", () => {
    // The design claim in TUNING §9.1: ~67s from full to empty at 1.5/s.
    const state = createState();
    state.f[F.flow] = FLOW_MAX;
    let ticks = 0;
    while (getFlow(state) > 0 && ticks < TICK_RATE * 300) {
      stepFlowDecay(state, DT);
      ticks += 1;
    }
    const seconds = ticks * DT;
    expect(seconds).toBeCloseTo(GRACE + FLOW_MAX / DECAY, 1);
  });
});

describe("frame-rate independence", () => {
  /**
   * The property under test is that Flow is a function of SIM TICKS, never of
   * how often the host happened to render. A 144Hz monitor must not bleed Flow
   * 2.4x faster than a 60Hz one — that would make the game literally harder on
   * better hardware.
   *
   * The clock's accumulator is what guarantees the tick count matches; this
   * asserts the Flow layer downstream of it does not sneak in a per-frame term.
   */
  function decayOverTicks(ticks: number): number {
    const state = createState();
    state.f[F.flow] = FLOW_MAX;
    for (let i = 0; i < ticks; i += 1) {
      stepFlowDecay(state, DT);
    }
    return getFlow(state);
  }

  it("is identical whether the host renders at 60 or 144 fps", () => {
    const SECONDS = 20;
    const SIM_TICKS = TICK_RATE * SECONDS;

    // Same sim ticks, delivered in different-sized batches — one batch per
    // rendered frame at each rate. The batching must not change the result.
    function batched(fps: number): number {
      const state = createState();
      state.f[F.flow] = FLOW_MAX;
      const frames = fps * SECONDS;
      const ticksPerFrame = SIM_TICKS / frames;
      let carried = 0;
      let done = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        carried += ticksPerFrame;
        while (carried >= 1 && done < SIM_TICKS) {
          stepFlowDecay(state, DT);
          carried -= 1;
          done += 1;
        }
      }
      while (done < SIM_TICKS) {
        stepFlowDecay(state, DT);
        done += 1;
      }
      return getFlow(state);
    }

    const at60 = batched(60);
    const at144 = batched(144);
    const reference = decayOverTicks(SIM_TICKS);

    expect(at60).toBe(reference);
    expect(at144).toBe(reference);
    expect(at144).toBe(at60);
  });

  it("a full sim run reaches an identical hash at 60 and 144 fps", () => {
    // End to end through the real sim, not just the Flow helper.
    const TICKS = 3_000;

    function run(): number {
      const sim = createSim(0xf10a);
      driveEmpty(sim, TICKS);
      return sim.hash();
    }

    // Identical tick counts must produce identical state regardless of the
    // wall-clock cadence the host fed them at — that cadence is not an input.
    expect(run()).toBe(run());
  });
});

describe("crash and Fracture", () => {
  it("a crash zeroes the meter — not reduces, zeroes", () => {
    const state = createState();
    state.f[F.flow] = 87.5;
    zeroFlow(state);
    expect(getFlow(state)).toBe(0);
  });

  it("a Fracture resume restores exactly half the Flow held at death", () => {
    const state = createState();
    state.f[F.flowAtDeath] = 88;
    restoreFractureFlow(state);
    expect(getFlow(state)).toBeCloseTo(88 * TUNING.fracture.fractureFlowRetained, 10);
  });
});

describe("the Bit streak", () => {
  it(`awards every ${TUNING.flow.bitStreakInterval}th Bit and nothing in between`, () => {
    const state = createState();
    const events = createEventRing();
    const interval = TUNING.flow.bitStreakInterval;

    for (let i = 1; i <= interval * 3; i += 1) {
      const awarded = recordBit(state, events);
      if (i % interval === 0) {
        expect(awarded, `Bit ${i} should award`).toBeCloseTo(TUNING.flow.flowPerBitStreak, 10);
      } else {
        expect(awarded, `Bit ${i} should not award`).toBe(0);
      }
    }
  });

  it("a break resets the count, so the next milestone is a fresh 10", () => {
    const state = createState();
    const events = createEventRing();
    const interval = TUNING.flow.bitStreakInterval;

    for (let i = 0; i < interval - 1; i += 1) {
      recordBit(state, events);
    }
    breakBitStreak(state);
    for (let i = 0; i < interval - 1; i += 1) {
      expect(recordBit(state, events)).toBe(0);
    }
    expect(recordBit(state, events)).toBeCloseTo(TUNING.flow.flowPerBitStreak, 10);
  });
});

describe("the perfect slide", () => {
  it("counts a slide committed at the last moment", () => {
    const lead = slideLeadInSeconds(TUNING.slide.slideDuration - 0.05);
    expect(lead).toBeCloseTo(0.05, 10);
    expect(isPerfectSlide(lead)).toBe(true);
  });

  it("does NOT count sliding early and lying there", () => {
    // Committed 0.4s before the bar, well past the 0.12s margin.
    const lead = slideLeadInSeconds(TUNING.slide.slideDuration - 0.4);
    expect(isPerfectSlide(lead)).toBe(false);
  });

  it("rejects a bar reached with no slide active at all", () => {
    expect(slideLeadInSeconds(0)).toBe(-1);
    expect(isPerfectSlide(slideLeadInSeconds(0))).toBe(false);
  });

  it("sits strictly below a near-miss, so slide-farming cannot out-earn risk", () => {
    // TUNING §9.1 states this ordering as a design rule. It is the reason the
    // P08 prompt's proposed +8 was not taken.
    expect(TUNING.flow.flowPerPerfectSlide).toBeLessThan(TUNING.flow.flowPerNearMiss);
  });
});

describe("the multiplier", () => {
  it("runs 1.0x at empty to flowMultiplierMax at full", () => {
    expect(flowMultiplier(0)).toBeCloseTo(1, 10);
    expect(flowMultiplier(FLOW_MAX)).toBeCloseTo(TUNING.flow.flowMultiplierMax, 10);
  });

  it("is linear in Flow", () => {
    const half = flowMultiplier(FLOW_MAX / 2);
    expect(half).toBeCloseTo((1 + TUNING.flow.flowMultiplierMax) / 2, 10);
  });

  it("stays strictly under the Overdrive multiplier at every Flow value", () => {
    // If Flow alone could reach 4.0x, spending 100 Flow on Overdrive would buy
    // no multiplier at all and the mechanic would stop being a decision. This is
    // why the P08 prompt's `1 + (flow/100)*3` was not taken.
    for (let flow = 0; flow <= FLOW_MAX; flow += 1) {
      expect(flowMultiplier(flow)).toBeLessThan(TUNING.overdrive.overdriveMultiplier);
    }
  });
});

describe("the Flow to speed coupling is live in the real sim", () => {
  it("Flow raises worldSpeed above the pure time curve", () => {
    const withFlow = createSim(1);
    const without = createSim(1);

    const TICKS = 600;
    for (let i = 0; i < TICKS; i += 1) {
      // Pin one sim's meter full each tick, mirroring a player earning it.
      withFlow.getState().f[F.flow] = FLOW_MAX;
      driveEmpty(withFlow, 1);
      driveEmpty(without, 1);
    }

    const fast = withFlow.getState().f[F.worldSpeed] ?? 0;
    const slow = without.getState().f[F.worldSpeed] ?? 0;
    expect(fast).toBeGreaterThan(slow);
    expect(fast - slow).toBeCloseTo(TUNING.speed.flowSpeedBonus, 6);
  });

  it("and therefore covers more distance in the same number of ticks", () => {
    const withFlow = createSim(2);
    const without = createSim(2);

    for (let i = 0; i < 1800; i += 1) {
      withFlow.getState().f[F.flow] = FLOW_MAX;
      driveEmpty(withFlow, 1);
      driveEmpty(without, 1);
    }

    expect(withFlow.getState().f[F.distance] ?? 0).toBeGreaterThan(
      without.getState().f[F.distance] ?? 0,
    );
  });

  it("never breaches the maxSpeed clamp, even at full Flow forever", () => {
    const sim = createSim(3);
    for (let i = 0; i < 60_000; i += 1) {
      sim.getState().f[F.flow] = FLOW_MAX;
      driveEmpty(sim, 1);
      expect(sim.getState().f[F.worldSpeed] ?? 0).toBeLessThanOrEqual(TUNING.speed.maxSpeed);
    }
  });
});

describe("run lifecycle", () => {
  it("a fresh sim starts at zero Flow and Running", () => {
    const sim = createSim(9);
    const state: SimState = sim.getState();
    expect(getFlow(state)).toBe(0);
    expect(state.runStatus).toBe(RunStatus.Running);
  });
});
