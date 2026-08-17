import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createEventRing, eventPayloadAt, eventTypeAt, SimEvent } from "@/game/sim/events";
import { stepCollision } from "@/game/sim/collision";
import { createSim } from "@/game/sim/sim";
import { createState, F, Phase, RunStatus, type SimState } from "@/game/sim/state";
import {
  canArmOverdrive,
  overdriveActive,
  overdriveFraction,
  overdriveRemaining,
  startOverdrive,
  stepOverdrive,
} from "@/game/sim/scoring/overdrive";
import { getScore, scoreMultiplier } from "@/game/sim/scoring/score";
import { stepScoring } from "@/game/sim/scoring";
import { EntityType } from "@/game/sim/level/entities";
import { driveEmpty } from "../helpers/drive";
import { startRoll } from "@/game/sim/player/locomotion";

const DT = TUNING.sim.fixedDelta;
const TICK_RATE = TUNING.sim.tickRate;
const FLOW_MAX = TUNING.flow.flowMax;
const DURATION = TUNING.overdrive.overdriveDuration;
const EXIT_FLOW = TUNING.overdrive.overdriveExitFlow;
const MULTIPLIER = TUNING.overdrive.overdriveMultiplier;

function idle(overdrive = false) {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive };
}

/** A sim wound up to a full meter, ready to spend. */
function primed(seed: number) {
  const sim = createSim(seed);
  sim.getState().f[F.flow] = FLOW_MAX;
  return sim;
}

function addObstacle(state: SimState, kind: number, face: number, lane: number, z: number): number {
  const i = state.obstacles.count;
  state.obstacles.active[i] = 1;
  state.obstacles.kind[i] = kind;
  state.obstacles.face[i] = face;
  state.obstacles.lane[i] = lane;
  state.obstacles.x[i] = 0;
  state.obstacles.y[i] = 0;
  state.obstacles.z[i] = z;
  state.obstacles.flags[i] = 0;
  state.obstacles.count = i + 1;
  return i;
}

function countEvents(ring: ReturnType<typeof createEventRing>, type: number): number {
  let n = 0;
  for (let i = 0; i < ring.head; i += 1) {
    if (eventTypeAt(ring, i) === type) {
      n += 1;
    }
  }
  return n;
}

describe("arming", () => {
  it("requires a full meter", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;

    state.f[F.flow] = FLOW_MAX - 0.01;
    expect(canArmOverdrive(state)).toBe(false);

    state.f[F.flow] = FLOW_MAX;
    expect(canArmOverdrive(state)).toBe(true);
  });

  it("is refused during a roll — GAME_BIBLE §4.3", () => {
    // The roll's commit lock is what makes it risky. Handing the player
    // invulnerability inside that exact window would remove the risk.
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    startRoll(state, 1);
    expect(canArmOverdrive(state)).toBe(false);
  });

  it("is refused while already in Overdrive", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    const events = createEventRing();
    expect(startOverdrive(state, events)).toBe(true);

    state.f[F.flow] = FLOW_MAX;
    expect(canArmOverdrive(state)).toBe(false);
  });

  it("is refused while Fracturing or Crashed", () => {
    const state = createState();
    state.f[F.flow] = FLOW_MAX;

    state.runStatus = RunStatus.Fracturing;
    expect(canArmOverdrive(state)).toBe(false);

    state.runStatus = RunStatus.Running;
    state.player.phase = Phase.Crashed;
    expect(canArmOverdrive(state)).toBe(false);
  });

  it("spends the entire meter", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    startOverdrive(state, createEventRing());
    expect(state.f[F.flow]).toBe(0);
  });
});

describe("the full lifecycle", () => {
  it(`lasts exactly ${DURATION}s and exits at ${EXIT_FLOW} Flow`, () => {
    const sim = primed(0xd1);
    sim.tick(idle(true));

    expect(overdriveActive(sim.getState())).toBe(true);

    // 6.0s at 60Hz is exactly 360 ticks, and the window occupies all 360 of
    // them: the trigger tick is the first, and the 360th is the one that
    // expires. So the meter is still hot after ticks 1..359 and cold after 360.
    const expectedTicks = Math.round(DURATION / DT);
    expect(expectedTicks).toBe(360);

    for (let i = 2; i <= expectedTicks - 1; i += 1) {
      sim.tick(idle());
      expect(overdriveActive(sim.getState()), `ended early at tick ${i}`).toBe(true);
    }

    sim.tick(idle());
    expect(overdriveActive(sim.getState())).toBe(false);
    expect(sim.getState().f[F.flow]).toBe(EXIT_FLOW);
  });

  it("the comedown is a landing, not a cliff", () => {
    const sim = primed(0xd2);
    sim.tick(idle(true));
    driveEmpty(sim, TICK_RATE * 7);
    // Non-zero on exit is the whole point: using the mechanic must not read as
    // a punishment. It will have decayed a little since, but not to nothing.
    expect(sim.getState().f[F.flow]).toBeGreaterThan(0);
  });

  it("holds Flow at zero for the whole window, ignoring gains", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    const events = createEventRing();
    startOverdrive(state, events);

    for (let i = 0; i < 100; i += 1) {
      // Something tries to add Flow mid-Overdrive.
      state.f[F.flow] = 40;
      stepOverdrive(state, DT, events);
      expect(state.f[F.flow]).toBe(0);
    }
  });

  it("emits START, a TICK every active tick, and exactly one END", () => {
    // Counted by draining as we go rather than scanning the whole history at the
    // end. A 360-tick Overdrive emits 360 OverdriveTicks through a 256-slot ring,
    // so the START would be legitimately overwritten before the run finished —
    // the ring is doing its job, and a consumer that drains per frame never sees
    // a gap. Anything that scans retrospectively has to account for it.
    const sim = primed(0xd3);
    const events = sim.events;
    const counts = { start: 0, tick: 0, end: 0 };
    let cursor = 0;

    const drain = (): void => {
      for (; cursor < events.head; cursor += 1) {
        const type = eventTypeAt(events, cursor);
        if (type === SimEvent.OverdriveStart) {
          counts.start += 1;
        } else if (type === SimEvent.OverdriveTick) {
          counts.tick += 1;
        } else if (type === SimEvent.OverdriveEnd) {
          counts.end += 1;
        }
      }
    };

    sim.tick(idle(true));
    drain();
    const ticks = Math.round(DURATION / DT);
    for (let i = 0; i < ticks + 10; i += 1) {
      driveEmpty(sim, 1);
      drain();
    }

    expect(counts.start).toBe(1);
    expect(counts.end).toBe(1);
    // One per active tick. The expiry tick emits END instead of TICK, so this
    // is exactly `ticks - 1` — and it is 359 rather than 360 only because the
    // timer uses `tickDown`. With raw subtraction it was 360 and the whole
    // window ran 6.017s.
    expect(counts.tick).toBe(ticks - 1);
  });

  it("saturates the event ring, which consumers must drain per frame", () => {
    // Documented rather than asserted as a defect: OverdriveTick alone produces
    // 360 events over the window against a 256-event ring. A render or audio
    // consumer draining once per frame sees 1-2 events and is never at risk. One
    // that drains lazily WILL lose events, and `ring.dropped` is how it finds out.
    const ticks = Math.round(DURATION / DT);
    expect(ticks).toBeGreaterThan(TUNING.pools.maxEvents);
  });

  it("the TICK payload carries remaining seconds and a falling fraction", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    const events = createEventRing();
    startOverdrive(state, events);

    let previousFraction = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 50; i += 1) {
      stepOverdrive(state, DT, events);
      const index = events.head - 1;
      if (eventTypeAt(events, index) !== SimEvent.OverdriveTick) {
        continue;
      }
      const seconds = eventPayloadAt(events, index, 0);
      const fraction = eventPayloadAt(events, index, 1);

      expect(seconds).toBeCloseTo(overdriveRemaining(state), 10);
      expect(fraction).toBeCloseTo(overdriveFraction(state), 10);
      expect(fraction).toBeLessThanOrEqual(1);
      expect(fraction).toBeLessThan(previousFraction);
      previousFraction = fraction;
    }
  });
});

describe("the multiplier", () => {
  it(`is a flat ${MULTIPLIER}x, overriding the Flow formula`, () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    startOverdrive(state, createEventRing());
    expect(scoreMultiplier(state)).toBe(MULTIPLIER);
  });

  it("beats the best multiplier Flow alone can reach", () => {
    // This is the reason the whole mechanic is worth 100 Flow. If Flow could
    // reach 4.0x on its own, spending the meter would be strictly negative.
    const state = createState();
    state.f[F.flow] = FLOW_MAX;
    const flowOnly = scoreMultiplier(state);

    state.runStatus = RunStatus.Running;
    startOverdrive(state, createEventRing());
    expect(scoreMultiplier(state)).toBeGreaterThan(flowOnly);
  });

  it("pays more per metre than any Flow value can", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    const perMetreAtFullFlow = scoreMultiplier(state);

    startOverdrive(state, createEventRing());
    expect(scoreMultiplier(state) / perMetreAtFullFlow).toBeCloseTo(MULTIPLIER / 3, 10);
  });
});

describe("BALANCE FINDING — Overdrive loses money early in a run", () => {
  /**
   * Spending the meter forfeits the Flow speed bonus, and on DISTANCE SCORE
   * ALONE that costs more than the higher multiplier pays back.
   *
   *   full Flow: 3.0x multiplier, +6 u/s   (a 50% speed uplift at baseSpeed 12)
   *   Overdrive: 4.0x multiplier, +0 u/s
   *
   * 4.0/3.0 is a 33% multiplier gain. Early in a run, losing +6 u/s off a
   * 12 u/s base is a 33% distance loss — they cancel, and the ~10% shortfall
   * below is the remainder. Measured against the real sim:
   *
   * ```
   *   elapsed    Overdrive   at 100 Flow   ratio
   *      0s         299.9        332.9     0.90
   *     60s         474.1        463.6     1.02
   *    180s         616.1        570.0     1.08
   *    600s         671.3        611.5     1.10
   * ```
   *
   * This is NOT a claim that Overdrive is badly tuned. Its real payload is
   * invulnerability, the global magnet and shatter score — and none of those
   * three exist in the sim yet, because nothing spawns. It IS a warning that the
   * headline "4x versus 3x" oversells the score case by a wide margin, and that
   * the true value of Overdrive cannot be judged until P07 puts obstacles and
   * pickups in the tunnel.
   *
   * Deliberately asserted rather than tuned away. TUNING.md is unchanged.
   */
  it("is a net score LOSS on distance alone in the opening seconds", () => {
    const od = primed(0xd4);
    od.tick(idle(true));

    const flowOnly = createSim(0xd4);
    const TICKS = Math.round(DURATION / DT);
    for (let i = 1; i < TICKS; i += 1) {
      driveEmpty(od, 1);
      flowOnly.getState().f[F.flow] = FLOW_MAX;
      driveEmpty(flowOnly, 1);
    }

    const overdriveScore = getScore(od.getState());
    const fullFlowScore = getScore(flowOnly.getState());
    expect(overdriveScore).toBeLessThan(fullFlowScore);
    expect(overdriveScore / fullFlowScore).toBeGreaterThan(0.85);
  });

  it("turns into a modest gain once the time curve has risen", () => {
    const WARMUP = TICK_RATE * 180;

    const od = createSim(0xd7);
    const flowOnly = createSim(0xd7);
    driveEmpty(od, WARMUP);
    driveEmpty(flowOnly, WARMUP);

    // Both start the comparison from the same score and the same time curve.
    od.getState().f[F.scoreFixed] = 0;
    flowOnly.getState().f[F.scoreFixed] = 0;
    od.getState().f[F.flow] = FLOW_MAX;
    od.tick(idle(true));

    for (let i = 1; i < Math.round(DURATION / DT); i += 1) {
      driveEmpty(od, 1);
      flowOnly.getState().f[F.flow] = FLOW_MAX;
      driveEmpty(flowOnly, 1);
    }

    expect(getScore(od.getState())).toBeGreaterThan(getScore(flowOnly.getState()));
  });
});

describe("invulnerability and shatter", () => {
  it("an obstacle that would kill instead shatters, and the run continues", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    state.f[F.worldSpeed] = TUNING.speed.baseSpeed;
    const events = createEventRing();
    startOverdrive(state, events);

    // Kind 0 is Fatal under the placeholder classifier.
    const index = addObstacle(state, EntityType.Stack, state.player.face, state.player.lane, 0);
    stepCollision(state, DT, events);

    expect(state.runStatus).toBe(RunStatus.Running);
    expect(state.player.phase).not.toBe(Phase.Crashed);
    expect(state.obstacles.active[index]).toBe(0);
    expect(countEvents(events, SimEvent.Shatter)).toBe(1);
    expect(countEvents(events, SimEvent.Crash)).toBe(0);
  });

  it("the same obstacle without Overdrive does kill", () => {
    // Proves the previous test is measuring Overdrive and not a broken setup.
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.worldSpeed] = TUNING.speed.baseSpeed;
    const events = createEventRing();

    addObstacle(state, EntityType.Stack, state.player.face, state.player.lane, 0);
    stepCollision(state, DT, events);

    expect(state.player.phase).toBe(Phase.Crashed);
    expect(countEvents(events, SimEvent.Crash)).toBe(1);
  });

  it("shatter score is flat, not multiplied by Overdrive's own 4x", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.flow] = FLOW_MAX;
    state.f[F.worldSpeed] = TUNING.speed.baseSpeed;
    const events = createEventRing();
    startOverdrive(state, events);

    const before = getScore(state);
    const cursor = events.head;
    addObstacle(state, EntityType.Stack, state.player.face, state.player.lane, 0);
    stepCollision(state, DT, events);

    // Drive the scoring pass over just those events.
    stepScoring(state, idle(), DT, events, cursor, 0);

    expect(getScore(state) - before).toBe(TUNING.overdrive.overdriveShatterScore);
  });
});

describe("Overdrive does NOT touch world speed", () => {
  it("worldSpeed during Overdrive matches an identical run without it", () => {
    // A +30% Overdrive speed bonus was proposed at P08 and rejected: 28 x 1.3 is
    // 36.4 against a LOCKED maxSpeed of 34, and it would void every P06 chunk
    // proof, all of which were computed at maxSpeed.
    const od = primed(0xd5);
    const plain = createSim(0xd5);

    od.tick(idle(true));
    plain.tick(idle());

    for (let i = 1; i < Math.round(DURATION / DT); i += 1) {
      driveEmpty(od, 1);
      driveEmpty(plain, 1);
      expect(od.getState().f[F.worldSpeed]).toBeCloseTo(plain.getState().f[F.worldSpeed] ?? 0, 10);
    }
  });

  it("never breaches maxSpeed", () => {
    const sim = primed(0xd6);
    sim.tick(idle(true));
    for (let i = 0; i < TICK_RATE * 30; i += 1) {
      driveEmpty(sim, 1);
      expect(sim.getState().f[F.worldSpeed] ?? 0).toBeLessThanOrEqual(TUNING.speed.maxSpeed);
    }
  });
});
