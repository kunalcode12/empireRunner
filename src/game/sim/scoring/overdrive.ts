/**
 * Overdrive — spend the full meter for six seconds of power fantasy.
 *
 * GAME_BIBLE §4.3. At exactly `overdriveCost` 100 Flow the prompt arms; the
 * player spends the whole meter and gets:
 *
 * ```
 *   invulnerable          obstacles SHATTER instead of killing
 *   magnet goes global    every pickup in the tunnel is drawn in
 *   multiplier -> 4.0x    flat, overriding the Flow formula entirely
 *   Flow frozen at 0      accrues nothing for the duration
 *   palette inverts       the only place bloom is permitted (§11.1)
 * ```
 *
 * On expiry Flow lands at `overdriveExitFlow` 25, not 0. Exiting a triumphant six
 * seconds into a dead meter reads as a punishment for using the mechanic, and the
 * comedown should be a landing rather than a cliff.
 *
 * ## What Overdrive deliberately does NOT do: change worldSpeed
 *
 * A `+30%` speed bonus was proposed for this phase and rejected. Two reasons, and
 * both are hard rather than aesthetic:
 *
 *   1. `maxSpeed` 34 u/s is LOCKED, and `speedCeiling` 28 x 1.3 = 36.4 breaches
 *      it. `tests/sim/tuning-invariants.test.ts` asserts the clamp holds.
 *   2. Every chunk in the P06 pool was proven survivable *at maxSpeed* by the BFS
 *      solver. Running the world faster than that voids all 43 proofs at once.
 *
 * Overdrive already reads as fast because the palette inverts and the player
 * stops dodging. It does not need to also break the speed model.
 */

import { TUNING } from "@/game/config/tuning";
import { emit, SimEvent, type EventRing } from "@/game/sim/events";
import { Phase, RunStatus, type SimState } from "@/game/sim/state";
import { rollActive } from "@/game/sim/player/locomotion";
import { tickDown } from "@/game/sim/player/timer";
import { F } from "@/game/sim/state";

const OVERDRIVE_DURATION = TUNING.overdrive.overdriveDuration;
const OVERDRIVE_COST = TUNING.overdrive.overdriveCost;
const OVERDRIVE_EXIT_FLOW = TUNING.overdrive.overdriveExitFlow;
const OVERDRIVE_MULTIPLIER = TUNING.overdrive.overdriveMultiplier;
const OVERDRIVE_SHATTER_SCORE = TUNING.overdrive.overdriveShatterScore;

/** True while the invulnerable shatter window is running. */
export function overdriveActive(state: SimState): boolean {
  return (state.f[F.overdriveTimer] ?? 0) > 0;
}

/** Seconds left. Zero when not in Overdrive. */
export function overdriveRemaining(state: SimState): number {
  return state.f[F.overdriveTimer] ?? 0;
}

/** Remaining fraction in `[0, 1]`, for the HUD ring and the palette fade. */
export function overdriveFraction(state: SimState): number {
  return overdriveRemaining(state) / OVERDRIVE_DURATION;
}

/** The flat multiplier Overdrive imposes. */
export const OVERDRIVE_SCORE_MULTIPLIER = OVERDRIVE_MULTIPLIER;

/** Score awarded per obstacle shattered. */
export const SHATTER_SCORE = OVERDRIVE_SHATTER_SCORE;

/**
 * Whether Overdrive may be triggered right now.
 *
 * The three exclusions are GAME_BIBLE §4.3 verbatim: not during a roll, not
 * during a Fracture, and not in the tail of a theme transition. The roll
 * exclusion is the one that matters — triggering mid-roll would hand the player
 * invulnerability during the exact window `rollCommitLock` exists to make risky.
 *
 * The transition-tunnel exclusion cannot be enforced yet: the generator is not
 * wired into the live tick (P06 shipped it unwired), so the sim has no notion of
 * being inside a transition. Noted here rather than silently skipped.
 */
export function canArmOverdrive(state: SimState): boolean {
  if (overdriveActive(state)) {
    return false;
  }
  if ((state.f[F.flow] ?? 0) < OVERDRIVE_COST) {
    return false;
  }
  if (state.runStatus !== RunStatus.Running) {
    return false;
  }
  if (state.player.phase === Phase.Crashed || state.player.phase === Phase.Fracturing) {
    return false;
  }
  if (rollActive(state)) {
    return false;
  }
  return true;
}

/**
 * Spends the meter and opens the window.
 *
 * @returns true if Overdrive actually started.
 */
export function startOverdrive(state: SimState, events: EventRing): boolean {
  if (!canArmOverdrive(state)) {
    return false;
  }

  state.f[F.overdriveTimer] = OVERDRIVE_DURATION;
  // The full meter, spent. This is the deal.
  state.f[F.flow] = 0;
  state.f[F.flowIdleTimer] = 0;

  emit(events, SimEvent.OverdriveStart, state.tick, OVERDRIVE_DURATION, OVERDRIVE_MULTIPLIER);
  return true;
}

/**
 * Ages the window by one tick and resolves expiry.
 *
 * Emits `OverdriveTick` every tick it is active, carrying both the absolute
 * seconds remaining and the fraction, so the audio layer can schedule the
 * comedown ahead of time and the renderer can fade the palette inversion without
 * re-deriving the countdown.
 *
 * @returns true on the tick Overdrive ended.
 */
export function stepOverdrive(state: SimState, dt: number, events: EventRing): boolean {
  const remaining = state.f[F.overdriveTimer] ?? 0;
  if (remaining <= 0) {
    return false;
  }

  // `tickDown`, not raw subtraction. 6.0 is not representable as a sum of 1/60
  // doubles: after 360 subtractions the residue is +1.63e-14, which a naive
  // `> 0` test reads as "still running" and Overdrive lasts 361 ticks — 6.017s
  // against a LOCKED 6.0. The same class of bug ran every P04 timer one tick
  // long and was fixed centrally in player/timer.ts; this reuses that fix.
  const next = tickDown(remaining, dt);

  if (next <= 0) {
    state.f[F.overdriveTimer] = 0;
    // The comedown is a landing, not a cliff — GAME_BIBLE §4.3.
    state.f[F.flow] = OVERDRIVE_EXIT_FLOW;
    state.f[F.flowIdleTimer] = 0;
    emit(events, SimEvent.OverdriveEnd, state.tick, OVERDRIVE_EXIT_FLOW);
    return true;
  }

  state.f[F.overdriveTimer] = next;
  // Frozen at 0 and accruing nothing for the duration. Written every tick rather
  // than once at start, so a gain landing mid-Overdrive cannot leak in.
  state.f[F.flow] = 0;
  emit(events, SimEvent.OverdriveTick, state.tick, next, next / OVERDRIVE_DURATION);
  return false;
}
