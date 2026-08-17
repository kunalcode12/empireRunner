import { beforeEach, describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createEventRing, emit, SimEvent } from "@/game/sim/events";
import { createEventDrain } from "@/game/render/events";
import {
  createFeel,
  handleFeelEvent,
  resetFeel,
  stepFeel,
  type FeelState,
} from "@/game/render/feel";
import { addTrauma, createTrauma, shakeAmount, stepTrauma } from "@/game/render/feel/trauma";
import {
  createHitStop,
  frozen,
  hitStopCrash,
  hitStopShatter,
  requestHitStop,
  stepHitStop,
} from "@/game/render/feel/hitstop";
import {
  createSquash,
  horizontalScale,
  land,
  setRisingStretch,
  stepSquash,
  verticalScale,
} from "@/game/render/feel/squash";
import {
  parseMotionOverride,
  resetMotion,
  resolveMotion,
  setMotion,
} from "@/game/render/feel/reducedMotion";
import { noise1D, noise1DOctaves } from "@/game/render/feel/noise";
import { createParticlePool, spawnParticle, stepParticles } from "@/game/render/vfx/ParticleSystem";

const F = TUNING.feel;
const FRAME = 1 / 60;

beforeEach(() => {
  setMotion(false);
});

describe("hit-stop", () => {
  it("freezes for the crash duration and no longer", () => {
    const state = createHitStop();
    hitStopCrash(state);
    expect(frozen(state)).toBe(true);

    const frames = Math.ceil(F.hitStopCrash / FRAME);
    for (let i = 0; i < frames; i += 1) {
      expect(stepHitStop(state, FRAME), `frame ${i}`).toBe(true);
    }
    expect(stepHitStop(state, FRAME)).toBe(false);
  });

  it("is 60-90ms — the band where it reads as impact", () => {
    // Below ~50ms nobody perceives it; above ~120ms it reads as a hitch.
    expect(F.hitStopShatter).toBeGreaterThanOrEqual(0.05);
    expect(F.hitStopCrash).toBeLessThanOrEqual(0.12);
  });

  it("takes the LONGER of two requests rather than summing", () => {
    // Summing lets an Overdrive burst of shatters stack into a hang.
    const state = createHitStop();
    hitStopShatter(state);
    hitStopShatter(state);
    hitStopShatter(state);
    expect(state.remaining).toBeCloseTo(F.hitStopShatter, 10);
  });

  it("caps accumulated freeze so a burst cannot lock the game", () => {
    const state = createHitStop();
    for (let i = 0; i < 20; i += 1) {
      requestHitStop(state, F.hitStopCrash);
    }
    expect(state.remaining).toBeLessThanOrEqual(F.hitStopMax);
  });

  it("a crash freezes longer than a shatter", () => {
    expect(F.hitStopCrash).toBeGreaterThan(F.hitStopShatter);
  });
});

describe("trauma shake", () => {
  it("uses trauma SQUARED, so small events are near-silent", () => {
    const state = createTrauma();
    addTrauma(state, 0.3);
    // 0.3^2 = 0.09 — an order of magnitude below a full hit.
    expect(shakeAmount(state)).toBeCloseTo(0.09, 10);

    state.trauma = 1;
    expect(shakeAmount(state)).toBe(1);
  });

  it("accumulates but clamps at 1", () => {
    const state = createTrauma();
    for (let i = 0; i < 20; i += 1) {
      addTrauma(state, F.traumaNearMiss);
    }
    expect(state.trauma).toBe(1);
  });

  it("decays to zero and stays there", () => {
    const state = createTrauma();
    addTrauma(state, 1);
    const frames = Math.ceil(1 / F.traumaDecay / FRAME) + 5;
    for (let i = 0; i < frames; i += 1) {
      stepTrauma(state, FRAME);
    }
    expect(state.trauma).toBe(0);
    expect(state.offset.x).toBe(0);
    expect(state.offset.y).toBe(0);
    expect(state.offset.roll).toBe(0);
  });

  it("is NOT a sine — the offset does not repeat on a fixed period", () => {
    // The specific failure being avoided: a periodic shake reads as a wobble
    // because the eye locks onto the rhythm.
    const state = createTrauma();
    state.trauma = 1;

    const samples: number[] = [];
    for (let i = 0; i < 240; i += 1) {
      state.trauma = 1; // hold it, so only the noise varies
      stepTrauma(state, FRAME);
      samples.push(state.offset.x);
    }

    // A sine at any period would repeat. Check that no lag from 1 to 60 frames
    // reproduces the signal closely.
    for (let lag = 1; lag <= 60; lag += 1) {
      let error = 0;
      let count = 0;
      for (let i = 0; i + lag < samples.length; i += 1) {
        error += Math.abs((samples[i] ?? 0) - (samples[i + lag] ?? 0));
        count += 1;
      }
      expect(error / count, `period ${lag} repeats`).toBeGreaterThan(1e-3);
    }
  });

  it("the three axes are uncorrelated", () => {
    // Sampling one noise walk at three offsets. If they lined up the shake
    // would be a diagonal line rather than a jolt.
    const state = createTrauma();
    state.trauma = 1;
    let matches = 0;
    for (let i = 0; i < 120; i += 1) {
      state.trauma = 1;
      stepTrauma(state, FRAME);
      if (Math.abs(state.offset.x - state.offset.y) < 1e-6) {
        matches += 1;
      }
    }
    expect(matches).toBe(0);
  });

  it("never exceeds the configured maximum offset", () => {
    const state = createTrauma();
    for (let i = 0; i < 600; i += 1) {
      addTrauma(state, 1);
      stepTrauma(state, FRAME);
      expect(Math.abs(state.offset.x)).toBeLessThanOrEqual(F.shakeMaxOffset);
      expect(Math.abs(state.offset.roll)).toBeLessThanOrEqual(F.shakeMaxRoll);
    }
  });
});

describe("the noise itself", () => {
  it("is continuous — no jumps between adjacent samples", () => {
    let previous = noise1D(0);
    for (let x = 0; x < 100; x += 0.01) {
      const value = noise1D(x);
      expect(Math.abs(value - previous)).toBeLessThan(0.2);
      previous = value;
    }
  });

  it("stays roughly in [-1, 1]", () => {
    for (let x = 0; x < 1000; x += 0.37) {
      expect(Math.abs(noise1DOctaves(x))).toBeLessThanOrEqual(1.2);
    }
  });

  it("is deterministic", () => {
    expect(noise1D(12.34)).toBe(noise1D(12.34));
  });

  it("actually varies — it is not a constant", () => {
    const values = new Set<number>();
    for (let x = 0; x < 50; x += 1.7) {
      values.add(Math.round(noise1D(x) * 1000));
    }
    expect(values.size).toBeGreaterThan(10);
  });
});

describe("squash and stretch", () => {
  it("scales with impact velocity rather than being fixed", () => {
    const soft = createSquash();
    land(soft, 2);
    const hard = createSquash();
    land(hard, F.squashFullImpactSpeed);

    expect(verticalScale(hard)).toBeLessThan(verticalScale(soft));
    expect(verticalScale(soft)).toBeLessThan(1);
  });

  it("caps at squashMax however hard the landing", () => {
    const state = createSquash();
    land(state, 1000);
    expect(verticalScale(state)).toBeCloseTo(1 - F.squashMax, 10);
  });

  it("preserves volume — squashing down widens out", () => {
    const state = createSquash();
    land(state, F.squashFullImpactSpeed);
    expect(horizontalScale(state)).toBeGreaterThan(1);
    // y * xz^2 should be near 1.
    const volume = verticalScale(state) * horizontalScale(state) ** 2;
    expect(volume).toBeCloseTo(1, 6);
  });

  it("springs back to neutral", () => {
    const state = createSquash();
    land(state, F.squashFullImpactSpeed);
    for (let i = 0; i < 120; i += 1) {
      stepSquash(state, FRAME);
    }
    expect(verticalScale(state)).toBeCloseTo(1, 4);
  });

  it("stretches while rising but not while falling", () => {
    const rising = createSquash();
    setRisingStretch(rising, TUNING.vertical.jumpImpulse);
    expect(verticalScale(rising)).toBeGreaterThan(1);

    const falling = createSquash();
    setRisingStretch(falling, -10);
    expect(verticalScale(falling)).toBe(1);
  });
});

describe("reduced motion", () => {
  it("disables shake, aberration and speed lines", () => {
    const reduced = resolveMotion(true, null);
    expect(reduced.shakeScale).toBe(0);
    expect(reduced.aberrationScale).toBe(0);
    expect(reduced.speedLineScale).toBe(0);
    expect(reduced.squashScale).toBe(0);
    expect(reduced.rollLeanScale).toBe(0);
  });

  it("KEEPS the FOV ramp and particles, at reduced strength", () => {
    // Removing the FOV ramp entirely leaves the player unable to judge approach
    // speed, which makes the game less playable rather than more accessible.
    const reduced = resolveMotion(true, null);
    expect(reduced.fovScale).toBeGreaterThan(0);
    expect(reduced.fovScale).toBeLessThan(1);
    expect(reduced.particleScale).toBeGreaterThan(0);
  });

  it("an explicit setting overrides the OS preference in BOTH directions", () => {
    expect(resolveMotion(true, false).reduced).toBe(false);
    expect(resolveMotion(false, true).reduced).toBe(true);
  });

  it("parses the URL override and ignores junk", () => {
    expect(parseMotionOverride("reduced")).toBe(true);
    expect(parseMotionOverride("full")).toBe(false);
    expect(parseMotionOverride("banana")).toBeNull();
    expect(parseMotionOverride(null)).toBeNull();
  });

  it("gates the shake at source, so nothing downstream has to remember", () => {
    setMotion(true);
    const state = createTrauma();
    addTrauma(state, 1);
    stepTrauma(state, FRAME);
    expect(state.offset.x).toBe(0);
    expect(state.offset.roll).toBe(0);
    resetMotion();
    setMotion(false);
  });

  it("gates the squash at source too", () => {
    setMotion(true);
    const state = createSquash();
    land(state, 100);
    expect(verticalScale(state)).toBe(1);
    setMotion(false);
  });
});

describe("particles", () => {
  it("never exceeds the pool, however many are requested", () => {
    const pool = createParticlePool(64);
    for (let i = 0; i < 1000; i += 1) {
      spawnParticle(pool, {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 10,
        size: 1,
        r: 1,
        g: 1,
        b: 1,
        physical: false,
      });
    }
    expect(pool.live).toBeLessThanOrEqual(64);
  });

  it("recycles dead slots", () => {
    const pool = createParticlePool(8);
    for (let i = 0; i < 8; i += 1) {
      spawnParticle(pool, {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0.1,
        size: 1,
        r: 1,
        g: 1,
        b: 1,
        physical: false,
      });
    }
    expect(pool.live).toBe(8);

    // Age them all out.
    stepParticles(pool, 1, 0);
    expect(pool.live).toBe(0);

    // The pool is reusable, not exhausted.
    expect(
      spawnParticle(pool, {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 1,
        size: 1,
        r: 1,
        g: 1,
        b: 1,
        physical: false,
      }),
    ).toBe(true);
  });

  it("rides the treadmill, so a puff does not hang while the ground moves", () => {
    const pool = createParticlePool(4);
    spawnParticle(pool, {
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 10,
      size: 1,
      r: 1,
      g: 1,
      b: 1,
      physical: false,
    });
    const WORLD_DELTA = 0.5;
    stepParticles(pool, FRAME, WORLD_DELTA);
    expect(pool.pz[0]).toBeCloseTo(-WORLD_DELTA, 10);
  });

  it("applies gravity to physical particles only", () => {
    const pool = createParticlePool(4);
    const base = {
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 10,
      size: 1,
      r: 1,
      g: 1,
      b: 1,
    };
    spawnParticle(pool, { ...base, physical: true });
    spawnParticle(pool, { ...base, physical: false });

    for (let i = 0; i < 30; i += 1) {
      stepParticles(pool, FRAME, 0);
    }
    expect(pool.py[0] ?? 0).toBeLessThan(0);
    expect(pool.py[1] ?? 0).toBe(0);
  });

  it("tracks a peak, for the perf report", () => {
    const pool = createParticlePool(32);
    for (let i = 0; i < 10; i += 1) {
      spawnParticle(pool, {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 1,
        size: 1,
        r: 1,
        g: 1,
        b: 1,
        physical: false,
      });
    }
    expect(pool.peak).toBe(10);
    stepParticles(pool, 5, 0);
    expect(pool.live).toBe(0);
    expect(pool.peak).toBe(10);
  });
});

describe("the event to effect mapping", () => {
  let feel: FeelState;
  const pool = createParticlePool(256);
  const context = { playerX: 0, playerY: 0, playerZ: 0, landingSpeed: 0 };

  beforeEach(() => {
    feel = createFeel();
    resetFeel(feel);
  });

  function fire(type: number, payload0 = 0): void {
    const ring = createEventRing();
    const drain = createEventDrain();
    drain.subscribe((e) => handleFeelEvent(feel, e, pool, context));
    emit(ring, type, 0, payload0);
    drain.drain(ring);
  }

  it("a crash freezes and shakes hard", () => {
    fire(SimEvent.Crash);
    expect(frozen(feel.hitStop)).toBe(true);
    expect(feel.trauma.trauma).toBe(F.traumaCrash);
  });

  it("a shatter freezes less and shakes less than a crash", () => {
    const crash = createFeel();
    const shatter = createFeel();
    const ring = createEventRing();
    const d1 = createEventDrain();
    d1.subscribe((e) => handleFeelEvent(crash, e, pool, context));
    emit(ring, SimEvent.Crash, 0);
    d1.drain(ring);

    const ring2 = createEventRing();
    const d2 = createEventDrain();
    d2.subscribe((e) => handleFeelEvent(shatter, e, pool, context));
    emit(ring2, SimEvent.Shatter, 0);
    d2.drain(ring2);

    expect(shatter.hitStop.remaining).toBeLessThan(crash.hitStop.remaining);
    expect(shatter.trauma.trauma).toBeLessThan(crash.trauma.trauma);
  });

  it("a near-miss shakes a little and pulses — the Flow lesson", () => {
    // The feedback that teaches the Flow system with no tutorial. It must be
    // present and it must be small enough to survive being chained.
    fire(SimEvent.NearMiss);
    expect(feel.nearMisses).toBe(1);
    expect(feel.trauma.trauma).toBe(F.traumaNearMiss);
    expect(feel.aberration).toBeGreaterThan(0);
    expect(frozen(feel.hitStop)).toBe(false);
  });

  it("chaining ten near-misses does not shake the screen to pieces", () => {
    for (let i = 0; i < 10; i += 1) {
      fire(SimEvent.NearMiss);
    }
    expect(feel.trauma.trauma).toBeLessThanOrEqual(1);
  });

  it("a landing shakes in proportion to impact speed", () => {
    const soft = createFeel();
    const hard = createFeel();
    const ring = createEventRing();

    const d1 = createEventDrain();
    d1.subscribe((e) => handleFeelEvent(soft, e, pool, context));
    emit(ring, SimEvent.Land, 0, -1);
    d1.drain(ring);

    const ring2 = createEventRing();
    const d2 = createEventDrain();
    d2.subscribe((e) => handleFeelEvent(hard, e, pool, context));
    emit(ring2, SimEvent.Land, 0, -TUNING.vertical.fastDropSpeed);
    d2.drain(ring2);

    expect(hard.trauma.trauma).toBeGreaterThan(soft.trauma.trauma);
  });

  it("a coin makes particles and nothing else", () => {
    const before = pool.live;
    fire(SimEvent.Coin);
    expect(pool.live).toBeGreaterThan(before);
    expect(feel.trauma.trauma).toBe(0);
    expect(frozen(feel.hitStop)).toBe(false);
  });

  it("the aberration pulse decays to zero", () => {
    fire(SimEvent.NearMiss);
    const frames = Math.ceil(F.nearMissPulseDuration / FRAME) + 2;
    for (let i = 0; i < frames; i += 1) {
      stepFeel(feel, FRAME);
    }
    expect(feel.aberration).toBe(0);
  });

  it("reduced motion suppresses the pulse but keeps the hit-stop", () => {
    setMotion(true);
    fire(SimEvent.Crash);
    expect(feel.aberration).toBe(0);
    expect(frozen(feel.hitStop)).toBe(true);
    setMotion(false);
  });
});
