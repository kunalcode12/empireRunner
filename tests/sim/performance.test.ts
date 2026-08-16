import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createIntent } from "@/game/sim/intent";

/**
 * Tick cost budget — docs/TUNING.md §14.
 *
 * The frame budget at 60fps is 16.67ms and the renderer needs almost all of it.
 * The sim gets 2ms per tick as a hard ceiling, and in practice must come in far
 * under that: the spiral guard can run up to 5 ticks in one frame, so a 2ms tick
 * would be 10ms of catch-up in a single frame.
 *
 * These numbers are measured on the machine running the suite and reported in
 * the output, not just asserted. A CI runner will be slower than a dev laptop;
 * the budget is set with that headroom in mind.
 *
 * Caveat worth stating: the player controller, generator, collision and scoring
 * are all P02 stubs. The current cost is the loop, the world-speed integration
 * and the per-tick snapshot copy — the last of which is real work that scales
 * with pool capacity and will NOT get cheaper. Treat these numbers as a floor,
 * not as a prediction of the finished sim.
 */

const BENCH_TICKS = TUNING.budgets.benchmarkTicks;
const BUDGET_MS = TUNING.budgets.benchmarkBudgetMs;
const PER_TICK_BUDGET_MS = TUNING.budgets.simTickMs;
const WARMUP_TICKS = 2000;
const MICROSECONDS = 1000;

function benchmark(ticks: number): number {
  const sim = createSim(0xbeef);
  const intent = createIntent();

  for (let i = 0; i < WARMUP_TICKS; i += 1) {
    sim.tick(intent);
  }

  const start = performance.now();
  for (let i = 0; i < ticks; i += 1) {
    sim.tick(intent);
  }
  return performance.now() - start;
}

describe("tick cost", () => {
  it(`runs ${BENCH_TICKS} ticks in under ${BUDGET_MS}ms`, () => {
    // Best of three: the machine may be doing other things, and the floor is
    // the honest measurement of what the code costs.
    const runs = [benchmark(BENCH_TICKS), benchmark(BENCH_TICKS), benchmark(BENCH_TICKS)];
    const best = Math.min(...runs);
    const perTickUs = (best / BENCH_TICKS) * MICROSECONDS;
    const ticksPerSecond = Math.round(BENCH_TICKS / (best / MICROSECONDS));

    console.log(
      `[performance] ${BENCH_TICKS} ticks in ${best.toFixed(2)}ms ` +
        `(runs: ${runs.map((r) => r.toFixed(1)).join(", ")}) | ` +
        `${perTickUs.toFixed(3)}us/tick | ${ticksPerSecond.toLocaleString()} ticks/sec | ` +
        `budget ${BUDGET_MS}ms`,
    );

    expect(best).toBeLessThan(BUDGET_MS);
  });

  it(`averages well under the ${PER_TICK_BUDGET_MS}ms per-tick ceiling`, () => {
    const elapsed = benchmark(BENCH_TICKS);
    const perTickMs = elapsed / BENCH_TICKS;
    expect(perTickMs).toBeLessThan(PER_TICK_BUDGET_MS);
  });

  it("sustains real time far faster than 1x", () => {
    // 10,000 ticks is 166.7 seconds of gameplay. Anything near 1x would mean
    // the sim alone consumes the entire frame budget.
    const elapsed = benchmark(BENCH_TICKS);
    const simulatedSeconds = BENCH_TICKS * TUNING.sim.fixedDelta;
    const realtimeMultiple = simulatedSeconds / (elapsed / MICROSECONDS);

    console.log(
      `[performance] ${simulatedSeconds.toFixed(1)}s of gameplay simulated in ` +
        `${elapsed.toFixed(2)}ms = ${Math.round(realtimeMultiple).toLocaleString()}x realtime`,
    );

    const MIN_REALTIME_MULTIPLE = 100;
    expect(realtimeMultiple).toBeGreaterThan(MIN_REALTIME_MULTIPLE);
  });

  it("cost per tick does not degrade over a long run", () => {
    // Catches an accidental O(n) scan over a growing structure, which would
    // still pass a short benchmark.
    const sim = createSim(0xfeed);
    const intent = createIntent();
    const WINDOW = 20_000;

    for (let i = 0; i < WARMUP_TICKS; i += 1) {
      sim.tick(intent);
    }

    const earlyStart = performance.now();
    for (let i = 0; i < WINDOW; i += 1) {
      sim.tick(intent);
    }
    const early = performance.now() - earlyStart;

    // Push out to ~20 minutes of simulated time.
    while (sim.getState().tick < TUNING.sim.tickRate * 60 * 20) {
      sim.tick(intent);
    }

    const lateStart = performance.now();
    for (let i = 0; i < WINDOW; i += 1) {
      sim.tick(intent);
    }
    const late = performance.now() - lateStart;

    console.log(
      `[performance] early ${WINDOW} ticks ${early.toFixed(2)}ms | ` +
        `late ${WINDOW} ticks ${late.toFixed(2)}ms | ratio ${(late / early).toFixed(2)}x`,
    );

    const MAX_DEGRADATION = 3;
    expect(late).toBeLessThan(early * MAX_DEGRADATION);
  });

  it("replay verification of a 60-second run is fast enough for a server", () => {
    // P12 runs this per submission on a shared endpoint. If it were slow the
    // leaderboard would be trivially DoS-able.
    const SIXTY_SECONDS = TUNING.sim.tickRate * 60;
    const start = performance.now();
    const sim = createSim(0x1234);
    const intent = createIntent();
    for (let i = 0; i < SIXTY_SECONDS; i += 1) {
      sim.tick(intent);
    }
    const elapsed = performance.now() - start;

    console.log(
      `[performance] re-simulating a 60s run took ${elapsed.toFixed(2)}ms ` +
        `(${SIXTY_SECONDS} ticks)`,
    );

    const SERVER_BUDGET_MS = 50;
    expect(elapsed).toBeLessThan(SERVER_BUDGET_MS);
  });
});
