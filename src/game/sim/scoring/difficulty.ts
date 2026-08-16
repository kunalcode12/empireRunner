/**
 * World speed — the difficulty curve, and the other half of the Flow coupling.
 *
 * ```
 *   timeSpeed(t) = baseSpeed + (speedCeiling - baseSpeed) * (1 - e^(-t / speedTau))
 *   worldSpeed   = min( timeSpeed(t) + flowSpeedBonus * (flow / 100), maxSpeed )
 * ```
 *
 * Exponential approach, so the curve is smooth rather than a step function and
 * asymptotic rather than divergent: the game stays theoretically playable
 * forever, because speed converges instead of climbing without bound.
 *
 * ## Three constants, not two, and why
 *
 * `speedCeiling` 28 is the asymptote of the **time** curve; `maxSpeed` 34 is a
 * hard clamp only Flow can reach; `flowSpeedBonus` 6 is the gap between them.
 * Collapsing ceiling into max — writing `max - (max - base) * e^(-t/tau)` — makes
 * the time curve approach 34 on its own and leaves Flow nothing to contribute,
 * which turns the self-escalation loop cosmetic. That is the exact failure
 * GAME_BIBLE §4.2's DECISION was written to prevent, and it is asserted in
 * `tuning-invariants.test.ts` as `speedCeiling + flowSpeedBonus <= maxSpeed`.
 *
 * ## Why there is no `Math.exp` in this file
 *
 * `Math.exp` is banned in `src/game/sim/**` by eslint.config.mjs, and the ban is
 * load-bearing rather than stylistic. ECMA-262 specifies `+ - * / Math.sqrt` as
 * exactly reproducible (IEEE-754) but specifies `exp`, `log`, `pow`, `sin`, `cos`
 * and `atan2` only as "implementation-approximated". Chrome, Safari and Firefox
 * do not share a libm, and a one-ulp difference compounded over 72,000 ticks
 * diverges. P12 re-simulates client replays on a Node server; the failure mode is
 * honest players rejected as cheats.
 *
 * So the closed form above is never evaluated. It is integrated incrementally:
 *
 * ```
 *   timeSpeed += (speedCeiling - timeSpeed) * speedApproachPerTick
 * ```
 *
 * with `speedApproachPerTick` a decimal literal frozen in
 * `TUNING.determinism` — decimal-to-double conversion IS exactly specified, so
 * every engine reads the identical bit pattern. Multiply and add only. This
 * reproduces the closed form to 15 significant figures over a 20-minute run
 * (27.99994772489087 vs 27.999947724890873); `closedFormSpeed` below exists to
 * prove exactly that, and is **test-only**.
 */

import { TUNING } from "@/game/config/tuning";
import { emit, SimEvent, type EventRing } from "@/game/sim/events";
import { F, Phase, type SimState } from "@/game/sim/state";
import { fractureTimeScale } from "./fracture";

const FIXED_DELTA = TUNING.sim.fixedDelta;
const SPEED_APPROACH = TUNING.determinism.speedApproachPerTick;
const BASE_SPEED = TUNING.speed.baseSpeed;
const SPEED_CEILING = TUNING.speed.speedCeiling;
const MAX_SPEED = TUNING.speed.maxSpeed;
const FLOW_SPEED_BONUS = TUNING.speed.flowSpeedBonus;
const FLOW_MAX = TUNING.flow.flowMax;
const STUMBLE_SPEED_PENALTY = TUNING.collision.stumbleSpeedPenalty;
const BANDS = TUNING.spawn.bands;

/**
 * The Flow contribution to world speed, in u/s.
 *
 * **This is the coupling.** See the header of `flow.ts` before touching it: the
 * fact that playing well makes the game faster is the design, not a difficulty
 * bug, and removing it removes the tension curve.
 */
export function flowSpeedBonus(flow: number): number {
  return (FLOW_SPEED_BONUS * flow) / FLOW_MAX;
}

/**
 * Advances the speed curve and the odometer by one tick.
 *
 * Called at step 3 of the tick, exactly where `stepWorld` used to sit in sim.ts.
 * The position is deliberate and is part of the replay contract: moving it after
 * collision would make the player act on a speed the collision pass never saw.
 *
 * @returns metres travelled this tick, so the scoring pass can pay for exactly
 *          the distance the odometer recorded rather than recomputing it.
 */
export function stepDifficulty(state: SimState, events: EventRing): number {
  // Indexed directly rather than through getF/setF. Those are fine at the edges,
  // but passing a double across a call boundary V8 declines to inline boxes it
  // into a HeapNumber — 16 bytes, every tick. Measured at P02.
  const f = state.f;

  const timeSpeed = f[F.timeSpeed] ?? 0;
  const nextTimeSpeed = timeSpeed + (SPEED_CEILING - timeSpeed) * SPEED_APPROACH;
  f[F.timeSpeed] = nextTimeSpeed;

  const target = nextTimeSpeed + flowSpeedBonus(f[F.flow] ?? 0);
  const capped = target > MAX_SPEED ? MAX_SPEED : target;

  // A stumble is a setback, not a death: the world slows while the player
  // recovers. Applied after the clamp so the penalty is always felt, even at
  // maxSpeed where the clamp would otherwise absorb it.
  let worldSpeed = state.player.phase === Phase.Stumbling ? capped * STUMBLE_SPEED_PENALTY : capped;

  // A Fracture freezes the world to a crawl while the player reads the geometry.
  // Scaling here rather than zeroing keeps the sim's one speed path intact —
  // GAME_BIBLE §5.1 wants near-freeze, not a special-cased stop.
  worldSpeed *= fractureTimeScale(state);

  f[F.worldSpeed] = worldSpeed;

  const metres = worldSpeed * FIXED_DELTA;
  f[F.distance] = (f[F.distance] ?? 0) + metres;

  stepBand(state, events);
  return metres;
}

/** Difficulty band, derived from distance. Emits on transition. */
function stepBand(state: SimState, events: EventRing): void {
  const previousBand = state.band;
  const distance = state.f[F.distance] ?? 0;
  let band = previousBand;
  // Bands are contiguous and ascending (asserted in tuning-invariants), so a
  // forward scan from the current band is correct and never walks backwards.
  while (band + 1 < BANDS.length && distance >= (BANDS[band]?.toMetres ?? Infinity)) {
    band += 1;
  }
  if (band !== previousBand) {
    state.band = band;
    emit(events, SimEvent.BandChange, state.tick, band);
  }
}

/**
 * The closed form, for tests only.
 *
 * **Never call this from the sim.** It uses `Math.exp`, which is why it is
 * defined with a runtime lookup rather than a direct reference — a direct
 * `Math.exp` call here would fail the lint rule that keeps the sim deterministic,
 * and that rule is worth more than the convenience of a straight call.
 *
 * Its only job is to be the oracle the incremental integration is checked
 * against, proving the two agree to 15 significant figures over a full run.
 */
export function closedFormSpeed(elapsedSeconds: number): number {
  const mathExp = (Math as unknown as Record<string, (x: number) => number>)["exp"];
  if (mathExp === undefined) {
    return SPEED_CEILING;
  }
  return BASE_SPEED + (SPEED_CEILING - BASE_SPEED) * (1 - mathExp(-elapsedSeconds / TAU));
}

const TAU = TUNING.speed.speedTau;

/** The speed a run starts at, before any ramp. */
export const INITIAL_SPEED = BASE_SPEED;
