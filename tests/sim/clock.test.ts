import { describe, expect, it } from "vitest";
import { advance, createClock, resetClock, resync } from "@/game/sim/clock";
import { TUNING } from "@/game/config/tuning";

const FIXED_DELTA = TUNING.sim.fixedDelta;
const MAX_TICKS = TUNING.sim.maxTicksPerFrame;

describe("the accumulator produces the right tick counts", () => {
  it("runs no ticks for a delta under one timestep", () => {
    const clock = createClock();
    expect(advance(clock, FIXED_DELTA / 2)).toBe(0);
    expect(clock.totalTicks).toBe(0);
  });

  it("runs exactly one tick per timestep at 60Hz", () => {
    const clock = createClock();
    for (let i = 0; i < 600; i += 1) {
      expect(advance(clock, FIXED_DELTA)).toBe(1);
    }
    expect(clock.totalTicks).toBe(600);
  });

  it("carries remainder across frames instead of losing it", () => {
    const clock = createClock();
    // Two-thirds of a tick per frame: 0, 1, 1, 0, 1, 1, ... averaging 2 per 3.
    const FRAMES = 300;
    const PER_FRAME = FIXED_DELTA * (2 / 3);
    let ticks = 0;
    for (let i = 0; i < FRAMES; i += 1) {
      ticks += advance(clock, PER_FRAME);
    }

    // The ideal is 200. Repeated float addition can leave the accumulator an
    // epsilon short of the final boundary, so the count may land one low — that
    // is inherent to any accumulator, not a defect.
    expect(Math.abs(ticks - 200)).toBeLessThanOrEqual(1);

    // What actually matters is that no TIME was lost. Whatever did not become a
    // tick is still sitting in the accumulator, and will on a later frame.
    const timeIn = FRAMES * PER_FRAME;
    const timeAccountedFor = ticks * FIXED_DELTA + clock.accumulator;
    expect(timeAccountedFor).toBeCloseTo(timeIn, 9);
  });

  it("does not lose ticks systematically over a long uneven run", () => {
    // The one-tick shortfall above must not compound. Over 10x the frames the
    // deficit should still be at most one tick, not ten.
    const clock = createClock();
    const FRAMES = 3000;
    const PER_FRAME = FIXED_DELTA * (2 / 3);
    let ticks = 0;
    for (let i = 0; i < FRAMES; i += 1) {
      ticks += advance(clock, PER_FRAME);
    }
    expect(Math.abs(ticks - 2000)).toBeLessThanOrEqual(1);
  });

  it("runs 2 ticks for a 30fps frame", () => {
    const clock = createClock();
    const THIRTY_FPS = 1 / 30;
    expect(advance(clock, THIRTY_FPS)).toBe(2);
  });

  it("averages half a tick per frame at 120fps", () => {
    const clock = createClock();
    const ONE_TWENTY_FPS = 1 / 120;
    let ticks = 0;
    for (let i = 0; i < 240; i += 1) {
      ticks += advance(clock, ONE_TWENTY_FPS);
    }
    expect(ticks).toBe(120);
  });
});

describe("the spiral-of-death guard", () => {
  it("a 4-second frame delta produces exactly 5 ticks, not 240", () => {
    const clock = createClock();
    const ticks = advance(clock, 4);

    expect(ticks).toBe(MAX_TICKS);
    expect(ticks).toBe(5);
    // The naive unclamped answer, for contrast.
    expect(ticks).not.toBe(240);
  });

  it("records that it clamped", () => {
    const clock = createClock();
    advance(clock, 4);
    expect(clock.clampedFrames).toBe(1);
  });

  it("does not bank the discarded time for the next frame", () => {
    // This is what makes it a guard rather than a delay. If surplus time were
    // carried, one slow frame would produce a sustained catch-up burst.
    const clock = createClock();
    advance(clock, 4);
    expect(clock.accumulator).toBeLessThan(FIXED_DELTA);
    expect(advance(clock, FIXED_DELTA)).toBe(1);
  });

  it("never exceeds the cap however long the stall", () => {
    for (const stall of [0.1, 1, 10, 60, 3600]) {
      const clock = createClock();
      expect(advance(clock, stall)).toBeLessThanOrEqual(MAX_TICKS);
    }
  });

  it("survives repeated long stalls without drifting", () => {
    const clock = createClock();
    for (let i = 0; i < 100; i += 1) {
      expect(advance(clock, 4)).toBe(MAX_TICKS);
    }
    expect(clock.totalTicks).toBe(MAX_TICKS * 100);
  });
});

describe("degenerate deltas cannot poison the accumulator", () => {
  it("ignores a zero delta", () => {
    const clock = createClock();
    expect(advance(clock, 0)).toBe(0);
    expect(clock.accumulator).toBe(0);
  });

  it("ignores a negative delta rather than running backwards", () => {
    const clock = createClock();
    advance(clock, FIXED_DELTA / 2);
    const before = clock.accumulator;
    expect(advance(clock, -100)).toBe(0);
    expect(clock.accumulator).toBe(before);
  });

  it("ignores NaN rather than permanently poisoning the accumulator", () => {
    const clock = createClock();
    expect(advance(clock, Number.NaN)).toBe(0);
    expect(Number.isNaN(clock.accumulator)).toBe(false);
    // And still works afterwards.
    expect(advance(clock, FIXED_DELTA)).toBe(1);
  });

  it("clamps Infinity to the cap", () => {
    const clock = createClock();
    expect(advance(clock, Number.POSITIVE_INFINITY)).toBe(MAX_TICKS);
    expect(Number.isFinite(clock.accumulator)).toBe(true);
  });
});

describe("alpha is the render interpolation factor", () => {
  it("stays in [0, 1)", () => {
    const clock = createClock();
    const IRREGULAR = 0.0123;
    for (let i = 0; i < 1000; i += 1) {
      advance(clock, IRREGULAR);
      expect(clock.alpha).toBeGreaterThanOrEqual(0);
      expect(clock.alpha).toBeLessThan(1);
    }
  });

  it("is the fraction of a tick left over", () => {
    const clock = createClock();
    advance(clock, FIXED_DELTA * 1.5);
    expect(clock.alpha).toBeCloseTo(0.5, 9);
  });

  it("is near zero after an exact number of timesteps", () => {
    const clock = createClock();
    advance(clock, FIXED_DELTA * 3);
    expect(clock.alpha).toBeLessThan(1e-9);
  });
});

describe("resync handles the tab-backgrounded case", () => {
  it("drops pending time instead of fast-forwarding", () => {
    // A hidden tab stops firing rAF. On return the elapsed wall time may be
    // minutes; even clamped to 5 ticks that would lurch the world forward
    // through obstacles the player never saw. Dropping resumes where it paused.
    const clock = createClock();
    advance(clock, FIXED_DELTA * 0.75);
    expect(clock.accumulator).toBeGreaterThan(0);

    resync(clock);

    expect(clock.accumulator).toBe(0);
    expect(clock.alpha).toBe(0);
    expect(clock.ticksLastFrame).toBe(0);
  });

  it("runs zero ticks — that is the difference from advance", () => {
    const clockA = createClock();
    const clockB = createClock();

    // advance clamps a huge delta down to 5 ticks...
    expect(advance(clockA, 300)).toBe(MAX_TICKS);

    // ...whereas the resync path runs none at all.
    resync(clockB);
    expect(clockB.totalTicks).toBe(0);
  });

  it("keeps lifetime diagnostics, unlike a full reset", () => {
    const clock = createClock();
    advance(clock, FIXED_DELTA * 10);
    const total = clock.totalTicks;

    resync(clock);
    expect(clock.totalTicks).toBe(total);

    resetClock(clock);
    expect(clock.totalTicks).toBe(0);
    expect(clock.clampedFrames).toBe(0);
  });
});
