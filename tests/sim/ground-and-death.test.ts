import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createIntent, type Intent } from "@/game/sim/intent";
import { createEventRing, eventPayloadAt, eventTypeAt, SimEvent } from "@/game/sim/events";
import { createState, F, Phase, RunStatus, type SimState } from "@/game/sim/state";
import { CrashCause, leaveGround } from "@/game/sim/player";
import { coyoteActive } from "@/game/sim/player/forgiveness";
import { stepCollision } from "@/game/sim/collision";

/**
 * Regression tests for three bugs found by auditing P04 rather than by a
 * failing test — the kind that pass every unit test and are still broken in the
 * actual loop.
 *
 *   1. `beginCoyote` was never called, so coyote time was dead in real play
 *      despite passing its own unit tests.
 *   2. `Edge.LeaveGround` was never used, so walking off a ledge did nothing.
 *   3. A fatal hit never set `runStatus`, so the world kept scrolling and
 *      `distance` kept accumulating forever after death.
 */

const DT = TUNING.sim.fixedDelta;

function held(partial: Partial<Intent>): Intent {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false, ...partial };
}

function addFatalObstacle(state: SimState): void {
  const i = state.obstacles.count;
  state.obstacles.active[i] = 1;
  state.obstacles.kind[i] = 2; // even kind = fatal, per the P07 placeholder
  state.obstacles.face[i] = 0;
  state.obstacles.lane[i] = 1;
  state.obstacles.x[i] = 0;
  state.obstacles.y[i] = 0;
  state.obstacles.z[i] = 0.3;
  state.obstacles.flags[i] = 0;
  state.obstacles.count = i + 1;
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

describe("losing ground support arms coyote time", () => {
  it("beginCoyote is actually reached in the real loop", () => {
    // The bug: coyoteTime is LOCKED tuning and had comprehensive unit tests,
    // but nothing in stepPlayer ever armed it. The feature did nothing.
    const state = createState();
    const events = createEventRing();
    expect(coyoteActive(state)).toBe(false);

    leaveGround(state, events);

    expect(coyoteActive(state)).toBe(true);
    expect(state.f[F.playerCoyoteTimer]).toBeCloseTo(TUNING.input.coyoteTime, 12);
  });

  it("drops the phase to FALLING via Edge.LeaveGround", () => {
    const state = createState();
    const events = createEventRing();
    expect(state.player.phase).toBe(Phase.Running);

    leaveGround(state, events);

    expect(state.player.phase).toBe(Phase.Falling);
  });

  it("fires automatically when support is removed", () => {
    // What the Void Gap logic will do at P07: clear `grounded` and let the
    // controller notice on the next tick.
    const sim = createSim(1);
    sim.tick(createIntent());
    expect(sim.getState().player.phase).toBe(Phase.Running);

    sim.getState().player.grounded = 0;
    sim.tick(createIntent());

    // The player re-lands within the same tick, because with no gap geometry
    // the floor plane is unconditionally at y = 0 — so the observable proof is
    // the LAND event, which can only follow a LeaveGround from a grounded phase.
    expect(countEvents(sim.events, SimEvent.Land)).toBeGreaterThan(0);
    expect(sim.getState().player.grounded).toBe(1);
  });

  /**
   * NOTE ON COVERAGE.
   *
   * Coyote time cannot be exercised end to end yet. `stepVertical` treats the
   * floor as unconditionally present at y = 0, so a player who loses support
   * lands again on the same tick and `handleLanding` clears the window. A real
   * Void Gap — where the floor is absent for a stretch of z — arrives with the
   * generator at P06/P07.
   *
   * These two tests therefore drive the state the gap will produce and assert
   * the controller's real decision path, rather than pretending a gap exists.
   */
  /** Puts the player genuinely airborne, clear of the floor plane. */
  function makeAirborne(
    sim: ReturnType<typeof createSim>,
    coyoteRemaining: number,
    height = 2,
  ): void {
    const s = sim.getState();
    s.player.grounded = 0;
    s.player.phase = Phase.Falling;
    s.f[F.playerY] = height;
    s.f[F.playerVy] = -1;
    s.f[F.playerCoyoteTimer] = coyoteRemaining;
  }

  it("a jump inside the coyote window is accepted while airborne", () => {
    const sim = createSim(2);
    sim.tick(createIntent());
    makeAirborne(sim, TUNING.input.coyoteTime);

    sim.tick(held({ jump: true }));

    expect(sim.getState().player.phase).toBe(Phase.Jumping);
    expect(sim.getState().f[F.playerVy]).toBeGreaterThan(0);
  });

  it("a jump past the coyote window does NOT launch — it waits in the buffer", () => {
    const sim = createSim(3);
    sim.tick(createIntent());
    makeAirborne(sim, 0);
    expect(coyoteActive(sim.getState())).toBe(false);

    sim.tick(held({ jump: true }));

    // Still falling: the window had closed, so no launch.
    expect(sim.getState().player.phase).toBe(Phase.Falling);
    expect(sim.getState().f[F.playerVy]).toBeLessThan(0);
  });

  it("the buffered jump then fires the instant the player lands", () => {
    // The other half of the same behaviour, and the thing that stops a slightly
    // early press feeling like it was eaten.
    // Low enough that the fall completes inside inputBuffer (0.15s = 9 ticks).
    // From higher up the press is correctly discarded as stale, which the
    // previous test already covers.
    const sim = createSim(10);
    sim.tick(createIntent());
    makeAirborne(sim, 0, 0.3);

    sim.tick(held({ jump: true }));
    expect(sim.getState().player.phase).toBe(Phase.Falling);

    // Fall to the floor while still holding.
    let guard = 0;
    while (sim.getState().player.phase === Phase.Falling && guard < 60) {
      sim.tick(held({ jump: true }));
      guard += 1;
    }

    expect(sim.getState().player.phase).toBe(Phase.Jumping);
  });

  it("marks the event so a ledge drop is distinguishable from a jump", () => {
    const state = createState();
    const events = createEventRing();
    leaveGround(state, events);
    expect(eventTypeAt(events, 0)).toBe(SimEvent.Jump);
    expect(eventPayloadAt(events, 0, 0)).toBeLessThan(0);
  });
});

describe("a fatal hit ends the run", () => {
  it("sets runStatus to Ended", () => {
    // The bug: only `phase` became Crashed. `runStatus` stayed Running, so
    // sim.tick kept going.
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.worldSpeed] = TUNING.speed.maxSpeed;
    const events = createEventRing();
    addFatalObstacle(state);

    stepCollision(state, DT, events);

    expect(state.player.phase).toBe(Phase.Crashed);
    expect(state.runStatus).toBe(RunStatus.Ended);
  });

  it("emits both Crash and RunEnd", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.worldSpeed] = TUNING.speed.maxSpeed;
    const events = createEventRing();
    addFatalObstacle(state);

    stepCollision(state, DT, events);

    expect(countEvents(events, SimEvent.Crash)).toBe(1);
    expect(countEvents(events, SimEvent.RunEnd)).toBe(1);
  });

  it("STOPS distance accumulating — a dead player must not keep scoring", () => {
    const sim = createSim(4);
    // Run a little, then kill the player.
    for (let i = 0; i < 30; i += 1) {
      sim.tick(createIntent());
    }
    addFatalObstacle(sim.getState());
    sim.tick(createIntent());

    expect(sim.getState().runStatus).toBe(RunStatus.Ended);
    const distanceAtDeath = sim.getState().f[F.distance] ?? 0;

    for (let i = 0; i < 600; i += 1) {
      sim.tick(createIntent());
    }

    expect(sim.getState().f[F.distance]).toBe(distanceAtDeath);
  });

  it("freezes the tick counter too, so replays cannot be padded", () => {
    const sim = createSim(5);
    for (let i = 0; i < 10; i += 1) {
      sim.tick(createIntent());
    }
    addFatalObstacle(sim.getState());
    sim.tick(createIntent());

    const tickAtDeath = sim.getState().tick;
    for (let i = 0; i < 100; i += 1) {
      sim.tick(createIntent());
    }
    expect(sim.getState().tick).toBe(tickAtDeath);
  });

  it("the state hash stops changing once the run is over", () => {
    const sim = createSim(6);
    for (let i = 0; i < 10; i += 1) {
      sim.tick(createIntent());
    }
    addFatalObstacle(sim.getState());
    sim.tick(createIntent());

    const hashAtDeath = sim.hash();
    for (let i = 0; i < 200; i += 1) {
      sim.tick(held({ jump: true, lateral: 1 }));
    }
    expect(sim.hash()).toBe(hashAtDeath);
  });

  it("a stumble does NOT end the run", () => {
    const state = createState();
    state.runStatus = RunStatus.Running;
    state.f[F.worldSpeed] = TUNING.speed.maxSpeed;
    const events = createEventRing();

    const i = state.obstacles.count;
    state.obstacles.active[i] = 1;
    state.obstacles.kind[i] = 3; // odd kind = stumble
    state.obstacles.face[i] = 0;
    state.obstacles.lane[i] = 1;
    state.obstacles.z[i] = 0.3;
    state.obstacles.count = i + 1;

    stepCollision(state, DT, events);

    expect(state.player.phase).toBe(Phase.Stumbling);
    expect(state.runStatus).toBe(RunStatus.Running);
  });
});

describe("the stumble speed penalty reaches worldSpeed", () => {
  it("slows the world while recovering, then restores it", () => {
    const sim = createSim(7);
    for (let i = 0; i < 60; i += 1) {
      sim.tick(createIntent());
    }
    const speedBefore = sim.getState().f[F.worldSpeed] ?? 0;

    const s = sim.getState();
    const i = s.obstacles.count;
    s.obstacles.active[i] = 1;
    s.obstacles.kind[i] = 3;
    s.obstacles.face[i] = 0;
    s.obstacles.lane[i] = 1;
    s.obstacles.z[i] = 0.3;
    s.obstacles.count = i + 1;

    sim.tick(createIntent());
    sim.tick(createIntent());

    const duringStumble = sim.getState().f[F.worldSpeed] ?? 0;
    expect(duringStumble).toBeLessThan(speedBefore);
    expect(duringStumble / speedBefore).toBeCloseTo(TUNING.collision.stumbleSpeedPenalty, 2);

    const recoveryTicks = Math.ceil(TUNING.collision.stumbleRecovery / DT) + 2;
    for (let k = 0; k < recoveryTicks; k += 1) {
      sim.tick(createIntent());
    }

    expect(sim.getState().player.phase).toBe(Phase.Running);
    expect(sim.getState().f[F.worldSpeed]).toBeGreaterThan(duringStumble);
  });
});

describe("the roll sets a readable verb for the HUD", () => {
  it("reports RollLeft and RollRight rather than staying None", () => {
    const left = createSim(8);
    left.tick(held({ roll: -1 }));
    expect(left.getState().player.verb).toBe(5); // Verb.RollLeft

    const right = createSim(9);
    right.tick(held({ roll: 1 }));
    expect(right.getState().player.verb).toBe(6); // Verb.RollRight
  });
});

describe("CrashCause values are distinct", () => {
  it("every cause has its own id", () => {
    const values = Object.values(CrashCause);
    expect(new Set(values).size).toBe(values.length);
  });
});
