/**
 * Countdown timers with an epsilon snap.
 *
 * ## Why this exists
 *
 * `fixedDelta` is `1/60 = 0.016666...`, which is not exactly representable in
 * binary. Counting a 0.10s window down by that step six times leaves
 * `1.4e-17` on the clock rather than zero:
 *
 * ```
 *   6 * (1/60) = 0.09999999999999999
 *   0.10 - 0.09999999999999999 = 1.4e-17   > 0
 * ```
 *
 * A naive `timer > 0` check therefore keeps the window open for a seventh tick,
 * and every duration in tuning.ts silently runs one tick longer than it says.
 * At 60Hz that is a 16% error on `coyoteTime` — which is exactly the kind of
 * "the numbers say one thing and the game does another" drift that makes tuning
 * by playtest impossible.
 *
 * Snapping any residue below `TIMER_EPSILON` to zero makes a 0.10s window
 * exactly 6 ticks, a 0.55s slide exactly 33, and a 0.30s roll exactly 18.
 *
 * The epsilon is far below any meaningful duration (the shortest tuned value is
 * `slideRecovery` at 0.08s) and far above the accumulated float error of a few
 * thousand subtractions, so it can never swallow a real remainder.
 */

/** s — residue at or below this counts as expired. */
export const TIMER_EPSILON = 1e-9;

/**
 * Counts `value` down by `dt`, snapping to exactly zero at expiry.
 *
 * @returns the new value, never negative.
 */
export function tickDown(value: number, dt: number): number {
  if (value <= 0) {
    return 0;
  }
  const next = value - dt;
  return next > TIMER_EPSILON ? next : 0;
}

/** True when a timer is still running, accounting for the epsilon. */
export function timerActive(value: number): boolean {
  return value > TIMER_EPSILON;
}
