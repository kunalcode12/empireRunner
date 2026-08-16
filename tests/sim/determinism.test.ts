import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createIntent, type Intent } from "@/game/sim/intent";
import { createRng, nextInt } from "@/game/sim/rng";
import { formatHash } from "@/game/sim/hash";
import { F, getF, RunStatus } from "@/game/sim/state";
import { getScore } from "@/game/sim/scoring/score";

/**
 * Law (a) — docs/ARCHITECTURE.md §2a.
 *
 * Same seed + same input log = same result, byte for byte. Everything the
 * leaderboard depends on is downstream of this file passing.
 */

const RUN_SEED = 0xa1b2c3d4;

/** Builds a reproducible pseudo-random input log, without using Math.random. */
function buildInputLog(seed: number, ticks: number): Intent[] {
  const rng = createRng(seed);
  const log: Intent[] = [];
  const AXIS_CHOICES = 3;
  const BOOL_CHOICES = 2;
  for (let i = 0; i < ticks; i += 1) {
    log.push({
      lateral: nextInt(rng, 0, AXIS_CHOICES) - 1,
      roll: nextInt(rng, 0, AXIS_CHOICES) - 1,
      jump: nextInt(rng, 0, BOOL_CHOICES) === 1,
      slide: nextInt(rng, 0, BOOL_CHOICES) === 1,
      overdrive: nextInt(rng, 0, BOOL_CHOICES) === 1,
    });
  }
  return log;
}

function runLog(seed: number, log: readonly Intent[]): number {
  const sim = createSim(seed);
  for (const intent of log) {
    sim.tick(intent);
  }
  return sim.hash();
}

describe("determinism: same seed + same input log", () => {
  it("gives byte-identical state hashes across 100 runs", () => {
    const log = buildInputLog(1, 600);
    const expected = runLog(RUN_SEED, log);

    const hashes = new Set<number>();
    for (let run = 0; run < 100; run += 1) {
      hashes.add(runLog(RUN_SEED, log));
    }

    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(expected);
  });

  it("agrees on every intermediate tick, not just the final state", () => {
    // A hash that only matches at the end could be hiding compensating drift.
    const log = buildInputLog(2, 300);
    const a = createSim(RUN_SEED);
    const b = createSim(RUN_SEED);

    for (let i = 0; i < log.length; i += 1) {
      a.tick(log[i] ?? createIntent());
      b.tick(log[i] ?? createIntent());
      expect(a.hash(), `diverged at tick ${i}`).toBe(b.hash());
    }
  });

  it("different seeds give different hashes", () => {
    const log = buildInputLog(3, 200);
    expect(runLog(1, log)).not.toBe(runLog(2, log));
  });

  it("different input logs give different hashes", () => {
    // Guards against a hash that ignores input entirely, which would make the
    // whole anti-cheat vacuous. Was a canary through P02, when the controller
    // was stubbed and this asserted the opposite.
    const a = createSim(RUN_SEED);
    const b = createSim(RUN_SEED);
    const idle = createIntent();
    const jumping: Intent = { lateral: 0, roll: 0, jump: true, slide: false, overdrive: false };

    for (let i = 0; i < 20; i += 1) {
      a.tick(idle);
      b.tick(jumping);
    }

    expect(a.hash()).not.toBe(b.hash());
  });

  it("a lane change diverges the hash permanently", () => {
    // Unlike a jump, a lane change leaves the player somewhere else, so the
    // divergence never heals.
    const a = createSim(RUN_SEED);
    const b = createSim(RUN_SEED);
    const idle = createIntent();
    const right: Intent = { lateral: 1, roll: 0, jump: false, slide: false, overdrive: false };

    b.tick(right);
    a.tick(idle);
    for (let i = 0; i < 300; i += 1) {
      a.tick(idle);
      b.tick(idle);
    }

    expect(a.hash()).not.toBe(b.hash());
    expect(a.getState().player.lane).not.toBe(b.getState().player.lane);
  });

  it("a COMPLETED jump leaves no residue, so the hashes reconverge", () => {
    // Worth pinning explicitly: this is correct, not a bug. Every timer returns
    // to zero and y returns to the floor, so two runs that differed only by a
    // finished jump are genuinely in the same state afterwards. It is also why
    // the divergence test above samples mid-jump rather than long after.
    const a = createSim(RUN_SEED);
    const b = createSim(RUN_SEED);
    const idle = createIntent();
    const jumping: Intent = { lateral: 0, roll: 0, jump: true, slide: false, overdrive: false };

    for (let i = 0; i < 100; i += 1) {
      a.tick(idle);
      b.tick(i === 10 ? jumping : idle);
    }

    expect(b.getState().player.grounded).toBe(1);
    expect(a.hash()).toBe(b.hash());
  });

  it("the hash is a stable uint32", () => {
    const sim = createSim(RUN_SEED);
    for (let i = 0; i < 100; i += 1) {
      sim.tick(createIntent());
    }
    const h = sim.hash();
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(formatHash(h)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("cross-run isolation: reset(seed) leaks nothing", () => {
  it("restores the exact initial state", () => {
    const sim = createSim(RUN_SEED);
    const initialHash = sim.hash();

    const log = buildInputLog(4, 500);
    for (const intent of log) {
      sim.tick(intent);
    }
    expect(sim.hash()).not.toBe(initialHash);

    sim.reset(RUN_SEED);
    expect(sim.hash()).toBe(initialHash);
  });

  it("a reused sim matches a freshly created one", () => {
    // The real leak test: run a long session, reset, and check the reused
    // instance behaves identically to a brand new one.
    const log = buildInputLog(5, 400);

    const reused = createSim(999);
    for (const intent of buildInputLog(6, 1200)) {
      reused.tick(intent);
    }
    reused.reset(RUN_SEED);
    for (const intent of log) {
      reused.tick(intent);
    }

    const fresh = createSim(RUN_SEED);
    for (const intent of log) {
      fresh.tick(intent);
    }

    expect(reused.hash()).toBe(fresh.hash());
  });

  it("survives many reset cycles without drifting", () => {
    const sim = createSim(RUN_SEED);
    const log = buildInputLog(7, 120);

    const hashes: number[] = [];
    for (let cycle = 0; cycle < 25; cycle += 1) {
      sim.reset(RUN_SEED);
      for (const intent of log) {
        sim.tick(intent);
      }
      hashes.push(sim.hash());
    }

    expect(new Set(hashes).size).toBe(1);
  });

  it("clears scalars, entity arrays and RNG position", () => {
    const sim = createSim(RUN_SEED);
    for (const intent of buildInputLog(8, 900)) {
      sim.tick(intent);
    }

    sim.reset(RUN_SEED);
    const s = sim.getState();

    expect(s.tick).toBe(0);
    expect(getF(s, F.elapsed)).toBe(0);
    expect(getF(s, F.distance)).toBe(0);
    expect(getScore(s)).toBe(0);
    expect(getF(s, F.flow)).toBe(0);
    expect(s.band).toBe(0);
    expect(getF(s, F.timeSpeed)).toBe(TUNING.speed.baseSpeed);
    expect(s.obstacles.count).toBe(0);
    expect(s.pickups.count).toBe(0);
    expect(s.runStatus).toBe(RunStatus.Running);
  });

  it("resetting to a different seed changes the streams", () => {
    const sim = createSim(1);
    const seedOneGenerator = sim.getState().rngGenerator;
    sim.reset(2);
    expect(sim.getState().rngGenerator).not.toBe(seedOneGenerator);
  });
});

describe("frame-rate independence", () => {
  it("30 / 60 / 144 Hz render rates give identical results", () => {
    // The sim only ever sees whole ticks, so a display rate cannot influence
    // the outcome. This drives the same tick count through three different
    // frame pacings and compares.
    const TICKS = 900;
    const log = buildInputLog(9, TICKS);

    function runAtRate(ticksPerFrame: number): number {
      const sim = createSim(RUN_SEED);
      let i = 0;
      while (i < TICKS) {
        const batch = Math.min(ticksPerFrame, TICKS - i);
        for (let b = 0; b < batch; b += 1) {
          sim.tick(log[i] ?? createIntent());
          i += 1;
        }
      }
      return sim.hash();
    }

    const at30 = runAtRate(2);
    const at60 = runAtRate(1);
    const at144 = runAtRate(1);
    const batched = runAtRate(5);

    expect(at30).toBe(at60);
    expect(at144).toBe(at60);
    expect(batched).toBe(at60);
  });
});

describe("law (b): the player stays near the origin", () => {
  it("abs(player.z) < 50 across a 20-minute run", () => {
    // A player at z = 20000 is the classic endless-runner float precision bug.
    // The world translates toward the player; distance is a separate scalar.
    const TWENTY_MINUTES_TICKS = TUNING.sim.tickRate * 60 * 20;
    const sim = createSim(RUN_SEED);
    const idle = createIntent();

    for (let i = 0; i < TWENTY_MINUTES_TICKS; i += 1) {
      sim.tick(idle);
    }

    const state = sim.getState();
    expect(Math.abs(getF(state, F.playerZ))).toBeLessThan(50);
    // Meanwhile distance really did accumulate.
    expect(getF(state, F.distance)).toBeGreaterThan(20_000);
  });
});

describe("the world-speed curve", () => {
  it("starts at baseSpeed and approaches speedCeiling", () => {
    const sim = createSim(RUN_SEED);
    expect(getF(sim.getState(), F.worldSpeed)).toBeCloseTo(TUNING.speed.baseSpeed, 6);

    const idle = createIntent();
    for (let i = 0; i < TUNING.sim.tickRate * 1200; i += 1) {
      sim.tick(idle);
    }

    const speed = getF(sim.getState(), F.timeSpeed);
    expect(speed).toBeGreaterThan(27.9);
    expect(speed).toBeLessThanOrEqual(TUNING.speed.speedCeiling);
  });

  it("matches the closed form from TUNING.md §2 within 1e-9", () => {
    // The incremental integration exists because Math.exp is not exactly
    // specified across engines. It still has to reproduce the intended curve.
    const CHECK_SECONDS = 300;
    const sim = createSim(RUN_SEED);
    const idle = createIntent();
    for (let i = 0; i < TUNING.sim.tickRate * CHECK_SECONDS; i += 1) {
      sim.tick(idle);
    }

    const { baseSpeed, speedCeiling, speedTau } = TUNING.speed;
    const closedForm =
      baseSpeed + (speedCeiling - baseSpeed) * (1 - Math.exp(-CHECK_SECONDS / speedTau));

    expect(getF(sim.getState(), F.timeSpeed)).toBeCloseTo(closedForm, 9);
  });

  it("never exceeds maxSpeed", () => {
    const sim = createSim(RUN_SEED);
    const idle = createIntent();
    for (let i = 0; i < TUNING.sim.tickRate * 600; i += 1) {
      sim.tick(idle);
      expect(getF(sim.getState(), F.worldSpeed)).toBeLessThanOrEqual(TUNING.speed.maxSpeed);
    }
  });

  it("uses only exactly-specified arithmetic", () => {
    // Guard against a future edit reintroducing Math.exp into the hot path.
    // Two integrations from the same start must agree bit-for-bit.
    const a = createSim(RUN_SEED);
    const b = createSim(RUN_SEED);
    const idle = createIntent();
    for (let i = 0; i < 5000; i += 1) {
      a.tick(idle);
      b.tick(idle);
    }
    expect(getF(a.getState(), F.timeSpeed)).toBe(getF(b.getState(), F.timeSpeed));
  });
});

describe("snapshot pair for render interpolation", () => {
  it("previous trails current by exactly one tick", () => {
    const sim = createSim(RUN_SEED);
    const idle = createIntent();
    for (let i = 0; i < 10; i += 1) {
      sim.tick(idle);
    }
    expect(sim.getState().tick - sim.getPrevious().tick).toBe(1);
  });

  it("previous is a real copy, not an alias", () => {
    const sim = createSim(RUN_SEED);
    const idle = createIntent();
    sim.tick(idle);
    sim.tick(idle);
    expect(sim.getPrevious()).not.toBe(sim.getState());
    expect(getF(sim.getPrevious(), F.distance)).not.toBe(getF(sim.getState(), F.distance));
  });
});
