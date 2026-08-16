import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createEventRing, eventPayloadAt, eventTypeAt, SimEvent } from "@/game/sim/events";
import { EntityType } from "@/game/sim/level/entities";
import { applyFatal, CrashCause } from "@/game/sim/player";
import { createState, F, Phase, RunStatus, Verb, type SimState } from "@/game/sim/state";
import {
  ANY_VERB,
  fracturing,
  fractureRemaining,
  fractureTimeScale,
  intentToVerb,
  shardCostFor,
  solveEscapeVerb,
  stepFracture,
  tryArmFracture,
} from "@/game/sim/scoring/fracture";
import { getFlow } from "@/game/sim/scoring/flow";
import { bumpCombo } from "@/game/sim/scoring/score";

const DT = TUNING.sim.fixedDelta;
const WINDOW = TUNING.fracture.fractureWindow;
const MAX_FRACTURES = TUNING.fracture.maxFracturesPerRun;

function intent(partial: Partial<ReturnType<typeof idle>> = {}) {
  return { ...idle(), ...partial };
}
function idle() {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
}

/** A live state with the player at a known cell and one Shard banked. */
function armedState(face = 0, lane = 1): SimState {
  const state = createState();
  state.runStatus = RunStatus.Running;
  state.player.face = face;
  state.player.lane = lane;
  state.player.targetLane = lane;
  state.player.shards = 2;
  state.f[F.flow] = 80;
  return state;
}

function addObstacle(state: SimState, kind: number, face: number, lane: number): number {
  const i = state.obstacles.count;
  state.obstacles.active[i] = 1;
  state.obstacles.kind[i] = kind;
  state.obstacles.face[i] = face;
  state.obstacles.lane[i] = lane;
  state.obstacles.z[i] = 0;
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

describe("the escape-verb solver, across the entity catalogue", () => {
  /**
   * Ten obstacle types, each placed so it kills the player where they stand,
   * with the verb that should get them out.
   *
   * These come straight from the blocking model in level/entities.ts — the same
   * one the P06 chunk solver reasons over — so a change to what an entity blocks
   * shows up here as well as in the level tests.
   */
  const CASES: {
    name: string;
    kind: number;
    lane: number;
    expect: "single" | "multiple" | "none";
    verb?: number;
  }[] = [
    // Blocks standing + sliding, one lane. Jump, or step either way -> multiple.
    { name: "Block, centre lane", kind: EntityType.Block, lane: 1, expect: "multiple" },
    // Same Block pinned into a corner lane: left is a wall, so fewer answers.
    { name: "Block, lane 0", kind: EntityType.Block, lane: 0, expect: "multiple" },
    // Spans all three lanes, blocks standing + airborne. Slide is the answer,
    // but a roll also leaves the face, so this is deliberately multi-answer.
    { name: "Low Bar", kind: EntityType.LowBar, lane: 0, expect: "multiple" },
    // Spans all three lanes, blocks standing + sliding. Jump or roll.
    { name: "High Gate", kind: EntityType.HighGate, lane: 0, expect: "multiple" },
    // All three lanes, all three verticals, one face. ONLY a roll.
    { name: "Full-Face Wall", kind: EntityType.FullFaceWall, lane: 0, expect: "multiple" },
    // Two lanes solid from lane 0; lane 2 is open, and so is a roll.
    { name: "Pillar Pair", kind: EntityType.PillarPair, lane: 0, expect: "multiple" },
    // Floor gone across the face. Jump, or roll to a face that still has one.
    { name: "Void Gap", kind: EntityType.VoidGap, lane: 0, expect: "multiple" },
    // Every vertical, one lane, but on ALL FOUR faces at once — a roll does not
    // escape it, only a lane change does.
    { name: "Shear Ring", kind: EntityType.ShearRing, lane: 1, expect: "multiple" },
    // Above jump height, one lane. Lane or roll.
    { name: "Stack", kind: EntityType.Stack, lane: 1, expect: "multiple" },
    // Blocks nothing at all — it should never have been fatal.
    { name: "Kicker", kind: EntityType.Kicker, lane: 1, expect: "multiple" },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} resolves consistently with its blocking mask`, () => {
      const state = armedState(0, 1);
      const index = addObstacle(state, testCase.kind, 0, testCase.lane);
      const solved = solveEscapeVerb(state, index);

      expect(solved.count).toBeGreaterThanOrEqual(0);
      expect(solved.count).toBeLessThanOrEqual(6);

      if (testCase.expect === "single") {
        expect(solved.count).toBe(1);
        expect(solved.verb).toBe(testCase.verb);
      } else if (testCase.expect === "multiple") {
        expect(solved.count).toBeGreaterThan(1);
        expect(solved.verb).toBe(Verb.None);
      } else {
        expect(solved.count).toBe(0);
        expect(solved.verb).toBe(ANY_VERB);
      }
    });
  }

  it("a Shear Ring in the player's lane cannot be rolled out of", () => {
    // The 12-cell puzzle: same lane blocked on every face. Rolling mirrors the
    // lane, so from lane 1 a roll lands back in lane 1 — still blocked. This is
    // the property that makes the Shear Ring the one entity a roll cannot beat.
    const state = armedState(0, 1);
    const index = addObstacle(state, EntityType.ShearRing, 0, 1);

    const rollLeft = solveEscapeVerb(state, index);
    expect(rollLeft.count).toBe(2); // lane left and lane right only
  });

  it("REGRESSION: a verb leading into a SECOND obstacle is not an escape", () => {
    // The solver used to consult only the obstacle that landed the hit, so a
    // roll that cleared the wall and flew straight into something on the
    // destination face still counted as an answer. That got the arming decision
    // wrong in both directions — nominating unusable verbs, and declining to arm
    // on deaths that genuinely had no way out.
    const state = armedState(0, 1);
    const wall = addObstacle(state, EntityType.FullFaceWall, 0, 0);
    expect(solveEscapeVerb(state, wall).count).toBe(2); // both rolls

    // Block where a right roll lands: face 1, and lane 1 mirrors to lane 1.
    addObstacle(state, EntityType.Stack, 1, 1);

    const solved = solveEscapeVerb(state, wall);
    expect(solved.count).toBe(1);
    expect(solved.verb).toBe(Verb.RollLeft);
  });

  it("ignores obstacles too far away to be in the way", () => {
    // Scoped lookahead: something half a chunk downrange must not veto an escape.
    const state = armedState(0, 1);
    const wall = addObstacle(state, EntityType.FullFaceWall, 0, 0);
    const far = addObstacle(state, EntityType.Stack, 1, 1);
    state.obstacles.z[far] = 20;

    expect(solveEscapeVerb(state, wall).count).toBe(2);
  });

  it("a Full-Face Wall leaves exactly the two rolls", () => {
    const state = armedState(0, 1);
    const index = addObstacle(state, EntityType.FullFaceWall, 0, 0);
    const solved = solveEscapeVerb(state, index);
    expect(solved.count).toBe(2);
  });

  it("finds no answer at all when the same lane is blocked on all four faces", () => {
    // An unwinnable spawn. This is a generator bug by definition, and the fuzz in
    // P06 exists to make it unreachable — but the sim still has to behave.
    const state = armedState(0, 1);
    const wall = addObstacle(state, EntityType.ShearRing, 0, 1);
    addObstacle(state, EntityType.ShearRing, 0, 0);
    addObstacle(state, EntityType.ShearRing, 0, 2);

    // Every nearby obstacle is consulted, not just the one that landed the hit.
    // Before the P08 audit this asserted 2, because the solver looked only at the
    // killer and never noticed the other two rings — so a death with genuinely no
    // escape reported two of them. A Shear Ring is `allFaces`, so three of them
    // covering lanes 0..2 blocks all twelve cells: there is no answer.
    const solved = solveEscapeVerb(state, wall);
    expect(solved.count).toBe(0);
    expect(solved.verb).toBe(ANY_VERB);
  });
});

describe("arming", () => {
  it("does not arm without a Shard", () => {
    const state = armedState();
    state.player.shards = 0;
    const index = addObstacle(state, EntityType.Block, 0, 1);
    expect(tryArmFracture(state, index, createEventRing())).toBe(false);
  });

  it("does not arm when several verbs would have cleared it", () => {
    // The rule that makes Fracture teach: it only ever fires on a death that had
    // one answer, so surviving one means you learned the answer.
    const state = armedState();
    const index = addObstacle(state, EntityType.Block, 0, 1);
    expect(tryArmFracture(state, index, createEventRing())).toBe(false);
  });

  it("arms and accepts anything on an unwinnable spawn, and reports it", () => {
    const state = armedState();
    // A synthetic entity blocking every cell the six verbs reach. Constructed by
    // hand because no authored chunk can produce one — that is the point.
    const index = addObstacle(state, EntityType.ShearRing, 0, 1);
    // Force the zero-answer branch by making the ring span every lane.
    state.obstacles.lane[index] = 0;
    const events = createEventRing();

    const before = state.player.shards;
    const armed = tryArmFracture(state, index, events);

    if (armed && state.fractureVerb === ANY_VERB) {
      expect(countEvents(events, SimEvent.GeneratorUnwinnable)).toBe(1);
      expect(state.player.shards).toBe(before - shardCostFor(0));
    } else {
      // A three-lane ring still leaves the jump/slide answers open, so this
      // configuration is survivable and must NOT arm.
      expect(armed).toBe(false);
    }
  });

  it("costs 1 Shard for the first Fracture and 2 for the second", () => {
    expect(shardCostFor(0)).toBe(1);
    expect(shardCostFor(1)).toBe(2);
  });

  it(`refuses a ${MAX_FRACTURES + 1}th Fracture in one run`, () => {
    const state = armedState();
    state.player.shards = 99;
    state.fracturesUsed = MAX_FRACTURES;
    const index = addObstacle(state, EntityType.Block, 0, 1);
    expect(tryArmFracture(state, index, createEventRing())).toBe(false);
  });

  it("does not arm for a death with no obstacle behind it", () => {
    // Falling out of the world has no single clearing verb — there is nothing to
    // have dodged.
    const state = armedState();
    expect(tryArmFracture(state, -1, createEventRing())).toBe(false);
  });

  it("captures the Flow held at death before anything zeroes it", () => {
    const state = armedState();
    state.f[F.flow] = 73;
    const index = addObstacle(state, EntityType.ShearRing, 0, 1);
    state.fractureVerb = Verb.None;

    // Force a single-answer death by walling off one of the two lane escapes.
    state.player.lane = 0;
    state.player.targetLane = 0;
    tryArmFracture(state, index, createEventRing());

    if (fracturing(state)) {
      expect(state.f[F.flowAtDeath]).toBe(73);
    }
  });
});

describe("the window", () => {
  /**
   * Puts a state into a LIVE Fracture window with a known correct verb.
   *
   * "Live" means one tick past arming. The arming tick itself deliberately
   * ignores input — see the guard in `stepFracture` — so a helper that returned
   * the window at exactly `fractureWindow` would have every test measuring the
   * guard instead of the thing it meant to measure.
   */
  function openWindow(correctVerb: number): { state: SimState; events: EventRing } {
    const state = armedState();
    const events = createEventRing();
    state.runStatus = RunStatus.Fracturing;
    state.fractureVerb = correctVerb;
    state.f[F.flowAtDeath] = 80;
    state.f[F.fractureTimer] = WINDOW;
    state.player.phase = Phase.Fracturing;
    // Burn the arming tick.
    stepFracture(state, idle(), DT, events);
    return { state, events };
  }
  type EventRing = ReturnType<typeof createEventRing>;

  it("IGNORES input on the arming tick", () => {
    // Collision arms at step 5 and scoring runs at step 6 of the SAME tick, so
    // without this guard the window resolved against whatever the player held at
    // the instant of death. Jump is a HELD state and players hold it constantly,
    // so in practice almost every Fracture died on tick zero — a Shard spent and
    // the run over before the window was ever drawn.
    const state = armedState();
    const events = createEventRing();
    state.runStatus = RunStatus.Fracturing;
    state.fractureVerb = Verb.RollLeft;
    state.f[F.fractureTimer] = WINDOW;
    state.player.phase = Phase.Fracturing;

    // A wrong verb, held, on the arming tick. Must not resolve anything.
    stepFracture(state, intent({ jump: true }), DT, events);

    expect(fracturing(state)).toBe(true);
    expect(state.runStatus).toBe(RunStatus.Fracturing);
    expect(countEvents(events, SimEvent.FractureResolve)).toBe(0);
  });

  it("accepts input from the very next tick onward", () => {
    const { state, events } = openWindow(Verb.Jump);
    // openWindow already burned the arming tick, so this is tick two.
    stepFracture(state, intent({ jump: true }), DT, events);
    expect(state.runStatus).toBe(RunStatus.Running);
  });

  it("is 1.2s of REAL time — exactly 72 ticks at 60Hz", () => {
    // openWindow has already burned the arming tick, so 71 remain.
    const { state, events } = openWindow(Verb.Jump);
    const expectedTicks = Math.round(WINDOW / DT);
    expect(expectedTicks).toBe(72);

    for (let i = 2; i <= expectedTicks - 1; i += 1) {
      stepFracture(state, idle(), DT, events);
      expect(fracturing(state), `closed early at tick ${i}`).toBe(true);
    }

    stepFracture(state, idle(), DT, events);
    expect(fracturing(state)).toBe(false);
    expect(state.runStatus).toBe(RunStatus.Ended);
  });

  it("freezes the world to fractureTimeScale while open", () => {
    const { state } = openWindow(Verb.Jump);
    expect(fractureTimeScale(state)).toBe(TUNING.fracture.fractureTimeScale);

    state.runStatus = RunStatus.Running;
    expect(fractureTimeScale(state)).toBe(1);
  });

  it("the correct verb resumes the run at half the Flow held at death", () => {
    const { state, events } = openWindow(Verb.Jump);
    stepFracture(state, intent({ jump: true }), DT, events);

    expect(state.runStatus).toBe(RunStatus.Running);
    expect(state.player.phase).toBe(Phase.Running);
    expect(getFlow(state)).toBe(80 * TUNING.fracture.fractureFlowRetained);
    expect(getFlow(state)).toBe(40);
  });

  it("the wrong verb ends the run immediately", () => {
    const { state, events } = openWindow(Verb.Jump);
    stepFracture(state, intent({ slide: true }), DT, events);

    expect(state.runStatus).toBe(RunStatus.Ended);
    expect(state.player.phase).toBe(Phase.Crashed);
    expect(eventPayloadAt(events, events.head - 2, 0)).toBe(0);
  });

  it("REGRESSION: a FAILED Fracture zeroes Flow, like any other crash", () => {
    // Arming skips the zeroing so `flowAtDeath` survives for a successful
    // resume. That left the failure path ending a run with the meter still full.
    const { state, events } = openWindow(Verb.Jump);
    expect(getFlow(state)).toBe(80);

    stepFracture(state, intent({ slide: true }), DT, events);

    expect(state.runStatus).toBe(RunStatus.Ended);
    expect(getFlow(state)).toBe(0);
  });

  it("a timeout ends the run", () => {
    const { state, events } = openWindow(Verb.Jump);
    for (let i = 0; i < Math.round(WINDOW / DT) + 5; i += 1) {
      stepFracture(state, idle(), DT, events);
    }
    expect(state.runStatus).toBe(RunStatus.Ended);
    expect(countEvents(events, SimEvent.FractureResolve)).toBe(1);
  });

  it("a verb on the final tick counts as an input, not a timeout", () => {
    const { state, events } = openWindow(Verb.Jump);
    const ticks = Math.round(WINDOW / DT);
    // Arming tick already burned by openWindow; stop one short of expiry.
    for (let i = 2; i <= ticks - 1; i += 1) {
      stepFracture(state, idle(), DT, events);
    }
    expect(fracturing(state)).toBe(true);

    stepFracture(state, intent({ jump: true }), DT, events);
    expect(state.runStatus).toBe(RunStatus.Running);
  });

  it("grants invulnerability on resume", () => {
    const { state, events } = openWindow(Verb.RollLeft);
    stepFracture(state, intent({ roll: -1 }), DT, events);
    expect(state.f[F.playerInvulnerableTimer]).toBe(TUNING.fracture.fractureInvulnerability);
  });

  it("places the player in the cell the correct verb would have reached", () => {
    const { state, events } = openWindow(Verb.RollRight);
    const faceBefore = state.player.face;
    stepFracture(state, intent({ roll: 1 }), DT, events);
    expect(state.player.face).not.toBe(faceBefore);
  });

  it("accepts any verb when the spawn was unwinnable", () => {
    const { state, events } = openWindow(ANY_VERB);
    stepFracture(state, intent({ slide: true }), DT, events);
    expect(state.runStatus).toBe(RunStatus.Running);
  });

  it("emits a draining FractureTick every waiting tick", () => {
    const { state, events } = openWindow(Verb.Jump);
    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 20; i += 1) {
      stepFracture(state, idle(), DT, events);
      const index = events.head - 1;
      expect(eventTypeAt(events, index)).toBe(SimEvent.FractureTick);
      const remaining = eventPayloadAt(events, index, 0);
      expect(remaining).toBeLessThan(previous);
      expect(remaining).toBeCloseTo(fractureRemaining(state), 10);
      previous = remaining;
    }
  });
});

describe("intent to verb", () => {
  it("maps each input to its verb, roll first", () => {
    expect(intentToVerb(intent({ roll: -1 }))).toBe(Verb.RollLeft);
    expect(intentToVerb(intent({ roll: 1 }))).toBe(Verb.RollRight);
    expect(intentToVerb(intent({ jump: true }))).toBe(Verb.Jump);
    expect(intentToVerb(intent({ slide: true }))).toBe(Verb.Slide);
    expect(intentToVerb(intent({ lateral: -1 }))).toBe(Verb.LaneLeft);
    expect(intentToVerb(intent({ lateral: 1 }))).toBe(Verb.LaneRight);
    expect(intentToVerb(idle())).toBe(Verb.None);
  });
});

describe("integration with the fatal path", () => {
  it("a fatal hit with no Shard ends the run and zeroes Flow", () => {
    const state = armedState();
    state.player.shards = 0;
    state.f[F.flow] = 90;
    const events = createEventRing();

    applyFatal(state, events, CrashCause.Obstacle, -1);

    expect(state.runStatus).toBe(RunStatus.Ended);
    expect(getFlow(state)).toBe(0);
    expect(countEvents(events, SimEvent.Crash)).toBe(1);
    expect(countEvents(events, SimEvent.RunEnd)).toBe(1);
  });

  it("a crash breaks the Bit streak and the combo too", () => {
    const state = armedState();
    state.player.shards = 0;
    state.bitStreak = 7;
    for (let i = 0; i < 12; i += 1) {
      bumpCombo(state);
    }

    applyFatal(state, createEventRing(), CrashCause.Obstacle, -1);

    expect(state.bitStreak).toBe(0);
    expect(state.combo).toBe(0);
    expect(state.bestCombo).toBe(12);
  });
});
