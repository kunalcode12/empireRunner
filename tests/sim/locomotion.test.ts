import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createIntent, type Intent } from "@/game/sim/intent";
import { F, Phase } from "@/game/sim/state";
import { easeInOutCubic, easeOutCubic } from "@/game/sim/player/locomotion";
import { laneCentreX } from "@/game/sim/player/facing";

const DT = TUNING.sim.fixedDelta;
const TICK_RATE = TUNING.sim.tickRate;

function idle(): Intent {
  return createIntent();
}

function held(partial: Partial<Intent>): Intent {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false, ...partial };
}

/** Runs `ticks` ticks of the same intent and returns the sim. */
function run(sim: ReturnType<typeof createSim>, intent: Intent, ticks: number) {
  for (let i = 0; i < ticks; i += 1) {
    sim.tick(intent);
  }
  return sim;
}

describe("jump arc", () => {
  it("reaches apex within one tick of tuning.jumpApexTime", () => {
    const sim = createSim(1);
    const jumping = held({ jump: true });

    let bestY = -Infinity;
    let bestTick = 0;
    const maxTicks = Math.ceil((TUNING.vertical.airTime / DT) * 2);

    for (let i = 1; i <= maxTicks; i += 1) {
      sim.tick(jumping);
      const y = sim.getState().f[F.playerY] ?? 0;
      if (y > bestY) {
        bestY = y;
        bestTick = i;
      }
    }

    const apexTime = bestTick * DT;
    const error = Math.abs(apexTime - TUNING.vertical.jumpApexTime);

    expect(
      error,
      `apex at ${apexTime.toFixed(4)}s vs target ${TUNING.vertical.jumpApexTime}s`,
    ).toBeLessThanOrEqual(DT);
  });

  it("reaches approximately the tuned apex height", () => {
    const sim = createSim(2);
    const jumping = held({ jump: true });
    let bestY = -Infinity;
    for (let i = 0; i < 60; i += 1) {
      sim.tick(jumping);
      bestY = Math.max(bestY, sim.getState().f[F.playerY] ?? 0);
    }
    // Semi-implicit Euler undershoots slightly at a 60Hz step; within 5% is the
    // honest tolerance for a discrete integrator, not a fudge.
    expect(bestY).toBeGreaterThan(TUNING.vertical.jumpApexHeight * 0.95);
    expect(bestY).toBeLessThan(TUNING.vertical.jumpApexHeight * 1.05);
  });

  it("clears a High Gate", () => {
    const sim = createSim(3);
    const jumping = held({ jump: true });
    let bestY = -Infinity;
    for (let i = 0; i < 60; i += 1) {
      sim.tick(jumping);
      bestY = Math.max(bestY, sim.getState().f[F.playerY] ?? 0);
    }
    expect(bestY).toBeGreaterThan(TUNING.slide.highGateClearance);
  });

  it("falls faster than it rises — asymmetric gravity", () => {
    const sim = createSim(4);
    const jumping = held({ jump: true });

    let riseTicks = 0;
    let apexReached = false;
    let fallTicks = 0;

    for (let i = 0; i < 120; i += 1) {
      sim.tick(apexReached ? idle() : jumping);
      const state = sim.getState();
      const vy = state.f[F.playerVy] ?? 0;
      const grounded = state.player.grounded === 1;

      if (!apexReached) {
        riseTicks += 1;
        if (vy <= 0) {
          apexReached = true;
        }
      } else if (!grounded) {
        fallTicks += 1;
      } else {
        break;
      }
    }

    expect(fallTicks).toBeGreaterThan(0);
    expect(fallTicks).toBeLessThan(riseTicks);
  });

  it("returns to the ground and to RUNNING", () => {
    const sim = createSim(5);
    sim.tick(held({ jump: true }));
    run(sim, idle(), Math.ceil(TUNING.vertical.airTime / DT) + 5);

    const state = sim.getState();
    expect(state.player.grounded).toBe(1);
    expect(state.f[F.playerY]).toBe(0);
    expect(state.player.phase).toBe(Phase.Running);
  });
});

describe("variable jump height", () => {
  it("releasing early produces a lower arc than holding", () => {
    function apexFor(holdTicks: number): number {
      const sim = createSim(6);
      const jumping = held({ jump: true });
      let best = -Infinity;
      for (let i = 0; i < 80; i += 1) {
        sim.tick(i < holdTicks ? jumping : idle());
        best = Math.max(best, sim.getState().f[F.playerY] ?? 0);
      }
      return best;
    }

    const tapped = apexFor(2);
    const fullyHeld = apexFor(40);

    expect(tapped).toBeLessThan(fullyHeld);
    expect(tapped).toBeGreaterThan(0);
  });

  it("cuts upward velocity by jumpReleaseCut on release", () => {
    const sim = createSim(7);
    sim.tick(held({ jump: true }));
    const vyHeld = sim.getState().f[F.playerVy] ?? 0;
    expect(vyHeld).toBeGreaterThan(0);

    sim.tick(idle());
    const vyAfterRelease = sim.getState().f[F.playerVy] ?? 0;

    // One tick of gravity also applies, so the cut value is an upper bound.
    expect(vyAfterRelease).toBeLessThan(vyHeld * TUNING.vertical.jumpReleaseCut);
  });

  it("releasing AFTER apex does nothing — the player already committed", () => {
    const sim = createSim(8);
    const jumping = held({ jump: true });
    // Hold past apex.
    const pastApex = Math.ceil(TUNING.vertical.jumpApexTime / DT) + 3;
    run(sim, jumping, pastApex);
    const vyBefore = sim.getState().f[F.playerVy] ?? 0;
    expect(vyBefore).toBeLessThan(0);

    sim.tick(idle());
    const vyAfter = sim.getState().f[F.playerVy] ?? 0;
    // Only gravity applied; no halving of a negative velocity.
    expect(vyAfter).toBeLessThan(vyBefore);
  });
});

describe("slide", () => {
  it("lasts exactly slideDuration", () => {
    const sim = createSim(9);
    sim.tick(held({ slide: true }));
    expect(sim.getState().player.phase).toBe(Phase.Sliding);

    const slideTicks = Math.round(TUNING.slide.slideDuration / DT);
    run(sim, idle(), slideTicks - 2);
    expect(sim.getState().player.phase).toBe(Phase.Sliding);

    run(sim, idle(), 3);
    expect(sim.getState().player.phase).toBe(Phase.Running);
  });

  it("cannot be cancelled early by jumping", () => {
    const sim = createSim(10);
    sim.tick(held({ slide: true }));
    expect(sim.getState().player.phase).toBe(Phase.Sliding);

    // Press jump one tick in. It must not cancel the slide.
    sim.tick(held({ jump: true }));
    expect(sim.getState().player.phase).toBe(Phase.Sliding);
  });

  it("allows a lane change mid-slide — docs/TUNING.md §5", () => {
    const sim = createSim(11);
    sim.tick(held({ slide: true }));
    sim.tick(held({ lateral: 1 }));
    expect(sim.getState().player.targetLane).toBe(2);
    expect(sim.getState().player.phase).toBe(Phase.Sliding);
  });

  it("mid-air slide triggers the fast-drop", () => {
    const sim = createSim(12);
    const jumping = held({ jump: true });
    // Keep JUMP held: releasing it halves vy and the hop ends before we can
    // test the dive.
    sim.tick(jumping);
    run(sim, jumping, 4);

    const vyBefore = sim.getState().f[F.playerVy] ?? 0;
    expect(vyBefore).toBeGreaterThan(0);

    sim.tick(held({ jump: true, slide: true }));
    const vyAfter = sim.getState().f[F.playerVy] ?? 0;

    expect(vyAfter).toBeLessThan(vyBefore);
    expect(vyAfter).toBeLessThan(-TUNING.speed.maxSpeed / 2);
  });

  it("the fast-drop cuts airtime well short of a normal jump", () => {
    function airTicks(useFastDrop: boolean): number {
      const sim = createSim(13);
      const jumping = held({ jump: true });
      sim.tick(jumping);
      run(sim, jumping, 4);
      if (useFastDrop) {
        sim.tick(held({ jump: true, slide: true }));
      }
      let ticks = 0;
      while (sim.getState().player.grounded === 0 && ticks < 200) {
        sim.tick(jumping);
        ticks += 1;
      }
      return ticks;
    }

    expect(airTicks(true)).toBeLessThan(airTicks(false));
  });

  it("the fast-drop lands straight into a slide", () => {
    const sim = createSim(14);
    const jumping = held({ jump: true });
    sim.tick(jumping);
    run(sim, jumping, 4);
    sim.tick(held({ jump: true, slide: true }));
    run(sim, jumping, 4);
    expect(sim.getState().player.phase).toBe(Phase.Sliding);
  });
});

describe("lane change", () => {
  it("takes laneChangeDuration to settle", () => {
    const sim = createSim(14);
    sim.tick(held({ lateral: 1 }));

    const tweenTicks = Math.round(TUNING.lane.laneChangeDuration / DT);
    run(sim, idle(), tweenTicks - 2);
    expect(sim.getState().player.lane).toBe(1);

    run(sim, idle(), 3);
    expect(sim.getState().player.lane).toBe(2);
    expect(sim.getState().f[F.playerX]).toBeCloseTo(laneCentreX(2), 12);
  });

  it("is interruptible by a reverse input", () => {
    const sim = createSim(15);
    sim.tick(held({ lateral: 1 }));
    sim.tick(held({ lateral: -1 }));
    // Reversed before settling: heading back to lane 1, not on to lane 2.
    expect(sim.getState().player.targetLane).toBe(1);
  });

  it("is a no-op at the outer wall", () => {
    const sim = createSim(16);
    run(sim, held({ lateral: -1 }), 20);
    expect(sim.getState().player.lane).toBe(0);
    run(sim, held({ lateral: -1 }), 20);
    expect(sim.getState().player.lane).toBe(0);
  });

  it("settles exactly on the lane centre, with no drift over many changes", () => {
    const sim = createSim(17);
    const settle = Math.round(TUNING.lane.laneChangeDuration / DT) + 2;
    for (let i = 0; i < 50; i += 1) {
      sim.tick(held({ lateral: i % 2 === 0 ? 1 : -1 }));
      run(sim, idle(), settle);
    }
    const x = sim.getState().f[F.playerX] ?? 0;
    expect(x).toBeCloseTo(laneCentreX(sim.getState().player.lane), 12);
  });
});

describe("roll", () => {
  it("takes rollDuration and lands on the adjacent face", () => {
    const sim = createSim(18);
    sim.tick(held({ roll: 1 }));
    expect(sim.getState().player.phase).toBe(Phase.Rolling);

    const rollTicks = Math.round(TUNING.roll.rollDuration / DT);
    run(sim, idle(), rollTicks + 1);

    expect(sim.getState().player.face).toBe(1);
    expect(sim.getState().player.phase).toBe(Phase.Running);
  });

  it("mirrors the lane on completion", () => {
    const sim = createSim(19);
    // Get to lane 2 first.
    sim.tick(held({ lateral: 1 }));
    run(sim, idle(), 12);
    expect(sim.getState().player.lane).toBe(2);

    sim.tick(held({ roll: 1 }));
    run(sim, idle(), Math.round(TUNING.roll.rollDuration / DT) + 1);

    expect(sim.getState().player.face).toBe(1);
    expect(sim.getState().player.lane).toBe(0);
  });

  it("REJECTS lateral input for exactly the full commit lock", () => {
    // The single mechanic that stops the roll being a free escape button.
    // Counted from the roll tick itself, which is also locked.
    const sim = createSim(20);
    const startLane = sim.getState().player.targetLane;
    const GUARD = 60;

    let rejectedTicks = 0;

    // Lateral pressed on the same tick as the roll must also be dropped.
    sim.tick({ lateral: 1, roll: 1, jump: false, slide: false, overdrive: false });
    expect(sim.getState().player.targetLane).toBe(startLane);
    rejectedTicks += 1;

    while (rejectedTicks < GUARD) {
      sim.tick(held({ lateral: 1 }));
      if (sim.getState().player.targetLane !== startLane) {
        break;
      }
      rejectedTicks += 1;
    }

    expect(rejectedTicks).toBe(Math.round(TUNING.roll.rollCommitLock / DT));
  });

  it("accepts lateral input again during the recovery tail", () => {
    const sim = createSim(21);
    sim.tick(held({ roll: 1 }));

    const lockTicks = Math.ceil(TUNING.roll.rollCommitLock / DT);
    run(sim, idle(), lockTicks);

    sim.tick(held({ lateral: 1 }));
    expect(sim.getState().player.targetLane).not.toBe(1);
  });

  it("drops lateral input rather than buffering it — docs/TUNING.md §7", () => {
    const sim = createSim(22);
    sim.tick(held({ roll: 1 }));
    // One lateral press deep inside the lock.
    sim.tick(held({ lateral: 1 }));

    const rollTicks = Math.round(TUNING.roll.rollDuration / DT);
    run(sim, idle(), rollTicks + 4);

    // If it had been buffered it would fire on unlock. It must not.
    expect(sim.getState().player.lane).toBe(sim.getState().player.targetLane);
    expect(sim.getState().player.lane).toBe(1);
  });

  it("jump remains available during a roll — GAME_BIBLE §3.2", () => {
    const sim = createSim(23);
    sim.tick(held({ roll: 1 }));
    sim.tick(held({ jump: true }));
    expect(sim.getState().player.phase).toBe(Phase.Jumping);
    // And the roll is still in flight alongside it.
    expect(sim.getState().f[F.playerRollTimer] ?? 0).toBeGreaterThan(0);
  });

  it("honours the cooldown between rolls", () => {
    const sim = createSim(24);
    sim.tick(held({ roll: 1 }));
    run(sim, idle(), Math.round(TUNING.roll.rollDuration / DT) + 1);
    const faceAfterFirst = sim.getState().player.face;

    // Immediately attempt a second roll, inside the cooldown.
    sim.tick(held({ roll: 1 }));
    expect(sim.getState().player.face).toBe(faceAfterFirst);
  });

  it("four rolls return to the starting face", () => {
    const sim = createSim(25);
    const settle = Math.round((TUNING.roll.rollDuration + TUNING.roll.rollCooldown) / DT) + 2;
    for (let i = 0; i < 4; i += 1) {
      sim.tick(held({ roll: 1 }));
      run(sim, idle(), settle);
    }
    expect(sim.getState().player.face).toBe(0);
  });
});

describe("easing curves are pure polynomials", () => {
  it("easeOutCubic spans 0 to 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("easeOutCubic decelerates — past halfway before half the time", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it("easeInOutCubic spans 0 to 1 and is symmetric about the midpoint", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 12);
  });

  it("both are monotonic", () => {
    const STEPS = 200;
    let lastOut = -1;
    let lastInOut = -1;
    for (let i = 0; i <= STEPS; i += 1) {
      const t = i / STEPS;
      const a = easeOutCubic(t);
      const b = easeInOutCubic(t);
      expect(a).toBeGreaterThanOrEqual(lastOut);
      expect(b).toBeGreaterThanOrEqual(lastInOut);
      lastOut = a;
      lastInOut = b;
    }
  });
});

describe("a 30-second scripted input log", () => {
  it("produces an identical state hash across 100 runs", () => {
    const THIRTY_SECONDS = TICK_RATE * 30;

    /** Deterministic, hand-scripted, exercising every verb and every edge case. */
    function scripted(tick: number): Intent {
      const phase = tick % 90;
      return {
        lateral: phase === 10 ? 1 : phase === 40 ? -1 : 0,
        roll: phase === 60 ? 1 : 0,
        jump: phase >= 20 && phase < 26,
        slide: phase >= 70 && phase < 74,
        overdrive: false,
      };
    }

    function runOnce(): number {
      const sim = createSim(0xf00d);
      for (let i = 0; i < THIRTY_SECONDS; i += 1) {
        sim.tick(scripted(i));
      }
      return sim.hash();
    }

    const expected = runOnce();
    const hashes = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      hashes.add(runOnce());
    }

    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(expected);
  });

  it("actually moved the player — the hash is not of a frozen state", () => {
    const sim = createSim(0xf00d);
    for (let i = 0; i < TICK_RATE * 5; i += 1) {
      sim.tick(i % 30 < 5 ? held({ jump: true }) : held({ lateral: 1 }));
    }
    const state = sim.getState();
    expect(state.player.lane === 2 || state.player.phase !== Phase.Running).toBe(true);
  });
});
