import { TUNING } from "@/game/config/tuning";
import type { Intent } from "@/game/sim/intent";
import type { Sim } from "@/game/sim/sim";
import { F, RunStatus } from "@/game/sim/state";

/**
 * Test helpers for driving a live sim.
 *
 * ## Why these exist
 *
 * Before P07 the generator was a no-op, so an idle player ran forever and any
 * test could just call `sim.tick(idle)` in a loop for twenty simulated minutes.
 * With the generator wired in, an idle player now dies inside a minute — which
 * is the game working, and which broke a dozen tests that were measuring
 * something else entirely (the speed curve, the score accumulator, law (b)).
 *
 * There are two failure modes to be aware of, and the second is nastier:
 *
 *   1. The measurement stops early, so a curve that should reach 28 u/s reads
 *      18 and the assertion fails for a reason unrelated to what it tests.
 *   2. `sim.tick()` returns immediately once `runStatus` is `Ended`, so
 *      `state.tick` **stops advancing**. Any loop shaped `while (state.tick < N)`
 *      never terminates. That hung the whole suite the first time the generator
 *      went live.
 *
 * `driveAlive` isolates the thing under test from the thing that kills you.
 */

/** s — topped up every tick so contact cannot end the run. */
const IMMORTAL_INVULN = 999;

/** The do-nothing intent. */
export function idleIntent(): Intent {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
}

export interface DriveOptions {
  /** Intent to feed each tick. Defaults to idle. */
  intent?: Readonly<Intent>;
  /** Seed used if the run has to be restarted. Defaults to the sim's own. */
  resetSeed?: number;
  /** Called after each tick, for per-tick assertions or state pokes. */
  onTick?: (sim: Sim, index: number) => void;
}

/**
 * Ticks `count` times, keeping the run alive throughout.
 *
 * Invulnerability covers contact deaths. It does **not** cover falling out of
 * the world through a Void Gap, so a reset is kept as a backstop — otherwise
 * this helper would reintroduce exactly the early-stop it exists to prevent.
 *
 * @returns the number of times the run had to be restarted. Zero is the norm;
 *          a non-zero count is worth noticing in a test that assumed continuity.
 */
export function driveAlive(sim: Sim, count: number, options: DriveOptions = {}): number {
  const intent = options.intent ?? idleIntent();
  const seed = options.resetSeed ?? sim.getSeed();
  let restarts = 0;

  for (let i = 0; i < count; i += 1) {
    const state = sim.getState();
    if (state.runStatus === RunStatus.Ended) {
      sim.reset(seed);
      restarts += 1;
    }
    sim.getState().f[F.playerInvulnerableTimer] = IMMORTAL_INVULN;
    sim.tick(intent);
    options.onTick?.(sim, i);
  }

  return restarts;
}

/**
 * Ticks until the run ends, or `maxTicks` elapses.
 *
 * @returns ticks actually executed.
 */
export function driveUntilDeath(sim: Sim, maxTicks: number, intent?: Readonly<Intent>): number {
  const feed = intent ?? idleIntent();
  for (let i = 0; i < maxTicks; i += 1) {
    if (sim.getState().runStatus === RunStatus.Ended) {
      return i;
    }
    sim.tick(feed);
  }
  return maxTicks;
}

/** Ticks for `seconds` of simulated time, keeping the run alive. */
export function driveSeconds(sim: Sim, seconds: number, options?: DriveOptions): number {
  return driveAlive(sim, Math.round(seconds * TUNING.sim.tickRate), options);
}

/**
 * Suppresses spawning by emptying the entity columns every tick.
 *
 * For tests that want the pre-P07 world: a clean tunnel with nothing in it, so
 * the thing under test is the only thing happening. Cheaper and clearer than
 * invulnerability when the test does not care about entities at all.
 */
export function driveEmpty(sim: Sim, count: number, intent?: Readonly<Intent>): void {
  const feed = intent ?? idleIntent();
  for (let i = 0; i < count; i += 1) {
    const state = sim.getState();
    state.obstacles.active.fill(0);
    state.obstacles.count = 0;
    state.pickups.active.fill(0);
    state.pickups.count = 0;
    sim.tick(feed);
  }
}
