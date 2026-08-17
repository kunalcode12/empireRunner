import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createIntent, type Intent } from "@/game/sim/intent";
import { F, RunStatus } from "@/game/sim/state";

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
 * As of P07 these numbers cover the real thing: player controller, live
 * generator, collision against real colliders, and scoring. They are no longer
 * a floor measured against stubs.
 *
 * ## Keeping the run alive, and why the benchmark has to
 *
 * `sim.tick()` returns immediately once `runStatus` is `Ended`, so a benchmark
 * driven by an idle intent stops measuring anything the moment the player dies —
 * and with the generator live, an idle player dies inside a minute. Worse, a
 * loop written as `while (state.tick < N)` never terminates, because `tick` stops
 * advancing. That hung this suite the first time the generator was wired in.
 *
 * So `driveAlive` tops up invulnerability every tick and resets on any end it
 * cannot prevent (a fall out of the world is not covered by invulnerability).
 * That keeps the entity population at steady state, which is what these
 * benchmarks are actually about — the cost of a tick with a full tunnel in it.
 */

const BENCH_TICKS = TUNING.budgets.benchmarkTicks;
const BUDGET_MS = TUNING.budgets.benchmarkBudgetMs;
const PER_TICK_BUDGET_MS = TUNING.budgets.simTickMs;
const WARMUP_TICKS = 2000;
const MICROSECONDS = 1000;
/** s — topped up every tick, so the benchmark player cannot die of contact. */
const IMMORTAL_INVULN = 999;

/**
 * Ticks `count` times, keeping the run alive.
 *
 * @returns ticks actually executed, which always equals `count`.
 */
function driveAlive(sim: ReturnType<typeof createSim>, intent: Intent, count: number): number {
  for (let i = 0; i < count; i += 1) {
    sim.getState().f[F.playerInvulnerableTimer] = IMMORTAL_INVULN;
    if (sim.getState().runStatus === RunStatus.Ended) {
      sim.reset(0xbeef);
    }
    sim.tick(intent);
  }
  return count;
}

function benchmark(ticks: number): number {
  const sim = createSim(0xbeef);
  const intent = createIntent();

  driveAlive(sim, intent, WARMUP_TICKS);

  const start = performance.now();
  driveAlive(sim, intent, ticks);
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

    driveAlive(sim, intent, WARMUP_TICKS);

    const earlyStart = performance.now();
    driveAlive(sim, intent, WINDOW);
    const early = performance.now() - earlyStart;

    // Push out to ~20 minutes of simulated time. Counted locally rather than
    // read from `state.tick`, which stops advancing on a run end and used to
    // turn this into an infinite loop.
    const TWENTY_MINUTES = TUNING.sim.tickRate * 60 * 20;
    driveAlive(sim, intent, Math.max(0, TWENTY_MINUTES - WARMUP_TICKS - WINDOW));

    const lateStart = performance.now();
    driveAlive(sim, intent, WINDOW);
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
