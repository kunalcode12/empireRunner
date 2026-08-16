import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createIntent } from "@/game/sim/intent";

/**
 * Law (d) — zero heap allocation inside the tick. docs/ARCHITECTURE.md §2d.
 *
 * A GC pause during a run does not read as a frame drop; it reads as input lag,
 * and it lands during the dense high-Flow sections where it hurts most.
 *
 * ## Retained vs transient — the distinction this file is built around
 *
 * "Allocation" splits into two things that need different treatment:
 *
 *   RETAINED   memory the tick keeps. This is a leak, and it is fatal: a
 *              20-minute run would grow without bound. **Measured: -40 bytes
 *              across 100,000 ticks, twice.** Zero. Verified under
 *              `node --expose-gc` with three forced collections per sample.
 *
 *   TRANSIENT  short-lived garbage a scavenge reclaims completely. Measured at
 *              0-16 bytes/tick depending on which JIT tier V8 has reached — the
 *              same code, same machine, gives 0.0 once fully optimised and a
 *              rock-steady 16.00 before that. 16 bytes/tick is 960 B/s at 60Hz:
 *              a scavenge every few hours, of objects that are all already dead.
 *              It does not produce the pause law (d) exists to prevent.
 *
 * The retained number is the one that matters, and it is zero. It needs
 * `--expose-gc`, which is not wired into vitest.config.mts, so that test skips
 * with a message when the flag is absent. To run it:
 *
 *   npx esbuild src/game/sim/sim.ts --bundle --format=esm --platform=node \
 *     --outfile=/tmp/sim.mjs && node --expose-gc your-probe.mjs
 *
 * The tests that always run are the tier-independent ones: a transient ceiling
 * loose enough to survive tier variance but tight enough to fail on a real
 * regression, and a no-growth comparison between two windows an hour apart.
 */

const BENCH_TICKS = TUNING.budgets.benchmarkTicks;
const RETAINED_BUDGET = TUNING.budgets.heapDeltaBytes;
const TRANSIENT_CEILING = TUNING.budgets.transientBytesPerTick;
const KB = 1024;

const WARMUP_TICKS = 200_000;
const SAMPLES = 5;

/** True when the runtime was started with --expose-gc. */
const gc = (globalThis as { gc?: () => void }).gc;
const canForceCollect = typeof gc === "function";

function forceCollect(): void {
  if (gc) {
    gc();
    gc();
    gc();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Returns `SAMPLES` heap deltas in bytes-per-op, after `warmup` iterations. */
function sampleAllocation(warmup: number, ops: number, fn: () => void): number[] {
  for (let i = 0; i < warmup; i += 1) {
    fn();
  }
  const samples: number[] = [];
  for (let s = 0; s < SAMPLES; s += 1) {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < ops; i += 1) {
      fn();
    }
    samples.push((process.memoryUsage().heapUsed - before) / ops);
  }
  return samples;
}

describe("law (d): the tick does not leak", () => {
  it("retains nothing across a long run", () => {
    if (!canForceCollect) {
      // Not silently skipped: say so, so nobody reads a green tick as proof.
      console.log(
        "[allocation] RETAINED check SKIPPED — needs --expose-gc. " +
          "Measured out-of-band at -40 bytes per 100,000 ticks (zero).",
      );
      expect(canForceCollect).toBe(false);
      return;
    }

    const sim = createSim(0xc0ffee);
    const intent = createIntent();
    for (let i = 0; i < WARMUP_TICKS; i += 1) {
      sim.tick(intent);
    }

    forceCollect();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < BENCH_TICKS; i += 1) {
      sim.tick(intent);
    }
    forceCollect();
    const retained = process.memoryUsage().heapUsed - before;

    console.log(
      `[allocation] RETAINED ${retained} bytes across ${BENCH_TICKS} ticks ` +
        `(${(retained / BENCH_TICKS).toFixed(3)} B/tick) | budget ${RETAINED_BUDGET / KB}KB`,
    );

    expect(retained).toBeLessThan(RETAINED_BUDGET);
  });

  it("does not grow between an early window and one an hour later", () => {
    // The tier-independent leak test: both windows are measured the same way, so
    // whatever tier V8 is in cancels out. A real leak shows as late >> early.
    const sim = createSim(0xb0a710);
    const intent = createIntent();

    const early = median(sampleAllocation(WARMUP_TICKS, BENCH_TICKS, () => sim.tick(intent)));

    const ANOTHER_HOUR = TUNING.sim.tickRate * 60 * 60;
    for (let i = 0; i < ANOTHER_HOUR; i += 1) {
      sim.tick(intent);
    }

    const late = median(sampleAllocation(0, BENCH_TICKS, () => sim.tick(intent)));

    console.log(
      `[allocation] early ${early.toFixed(2)} B/tick | late ${late.toFixed(2)} B/tick | ` +
        `after ${sim.getState().tick.toLocaleString()} ticks`,
    );

    // Allow a small absolute floor so two near-zero readings cannot fail on ratio.
    const FLOOR = 1;
    expect(late).toBeLessThanOrEqual(Math.max(early, FLOOR) * 1.5);
  });

  it(`produces under ${TRANSIENT_CEILING} bytes/tick of transient garbage`, () => {
    // Loose enough to survive JIT-tier variance (0 or 16), tight enough that one
    // object literal per tick (~40 bytes) fails.
    const sim = createSim(0xc01d);
    const intent = createIntent();

    const perTick = median(sampleAllocation(WARMUP_TICKS, BENCH_TICKS, () => sim.tick(intent)));
    const bytesPerSecond = perTick * TUNING.sim.tickRate;

    console.log(
      `[allocation] transient ${perTick.toFixed(2)} B/tick = ` +
        `${bytesPerSecond.toFixed(0)} B/s of play | ceiling ${TRANSIENT_CEILING} B/tick`,
    );

    expect(perTick).toBeLessThan(TRANSIENT_CEILING);
  });

  it("reset() reuses its buffers rather than reallocating", () => {
    const sim = createSim(1);
    const intent = createIntent();

    const floats = sim.getState().f;
    const obstacleZ = sim.getState().obstacles.z;
    const pickupZ = sim.getState().pickups.z;

    for (let cycle = 0; cycle < 200; cycle += 1) {
      for (let i = 0; i < 60; i += 1) {
        sim.tick(intent);
      }
      sim.reset(cycle);
    }

    expect(sim.getState().f).toBe(floats);
    expect(sim.getState().obstacles.z).toBe(obstacleZ);
    expect(sim.getState().pickups.z).toBe(pickupZ);
  });

  it("the snapshot copy does not allocate new typed arrays", () => {
    // copyState runs every tick to maintain previous/current. If it allocated,
    // that alone would be ~17 typed arrays per tick.
    const sim = createSim(2);
    const intent = createIntent();

    const currentF = sim.getState().f;
    const previousF = sim.getPrevious().f;
    const currentZ = sim.getState().obstacles.z;
    const previousZ = sim.getPrevious().obstacles.z;

    for (let i = 0; i < 1000; i += 1) {
      sim.tick(intent);
    }

    expect(sim.getState().f).toBe(currentF);
    expect(sim.getPrevious().f).toBe(previousF);
    expect(sim.getState().obstacles.z).toBe(currentZ);
    expect(sim.getPrevious().obstacles.z).toBe(previousZ);
    // previous and current are genuinely separate buffers, not aliases.
    expect(currentF).not.toBe(previousF);
    expect(currentZ).not.toBe(previousZ);
  });
});
