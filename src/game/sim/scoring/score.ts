/**
 * Score — an integer at all times.
 *
 * ## Why fixed point
 *
 * The obvious implementation is `score += pointsPerMetre * metres * multiplier`
 * in a float. It is also wrong, and wrong in a way that only shows up in
 * production.
 *
 * Each floating-point add rounds to the nearest representable double, and the
 * size of that rounding grows with the running total. Over a 20-minute run —
 * 72,000 ticks — the accumulated rounding is a function of the *order* the adds
 * happened in and of the magnitudes involved. Two machines that agree on every
 * single input can therefore disagree on the total.
 *
 * That is fatal for P12. A submitted replay is re-simulated server-side and the
 * result compared against the client's claim. A one-unit disagreement rejects an
 * honest player as a cheat, and the bug is unreproducible by definition.
 *
 * So the accumulator is an **exact integer count of thousandths of a point**,
 * held in a double. Integers are exact in a double up to 2^53 (~9.0e15). The
 * worst realistic run — 20 minutes at `maxSpeed` 34 u/s under the 4.0x Overdrive
 * multiplier, plus pickups — lands near 1.6e8 thousandths. Eight orders of
 * magnitude of headroom, and not one rounding step anywhere in it.
 *
 * The one place rounding is allowed is converting a per-tick contribution *into*
 * thousandths, which uses `Math.round` on a small quantity before the add. That
 * is a rounding of the increment, not of the total, so it does not accumulate.
 *
 * It does mean the score is not the odometer to the unit. Each tick rounds by at
 * most half a milli-point, so over a 20-minute run the score can sit up to
 * `72,000 * 0.5 / 1000` = 36 points away from `distance * pointsPerMetre`
 * (measured: +8). That gap is bounded, it is identical on every machine, and it
 * is the price of the total never drifting — which is the trade worth making,
 * because only the second property is one P12 can verify.
 *
 * ## Combo
 *
 * `state.combo` counts consecutive scoring events without a stumble or a crash.
 * It is a **statistic**, not a multiplier. Flow is the only multiplier in this
 * game; adding a second one stacked on top would make the two impossible to tune
 * independently, and would double-count the same skilful play the Flow meter is
 * already paying for. The death screen shows it at P14.
 */

import { TUNING } from "@/game/config/tuning";
import { F, type SimState } from "@/game/sim/state";
import { flowMultiplier } from "./flow";
import { overdriveActive, OVERDRIVE_SCORE_MULTIPLIER } from "./overdrive";

const SCALE = TUNING.scoring.scoreFixedPointScale;
const POINTS_PER_METRE = TUNING.scoring.pointsPerMetre;
const POINTS_PER_BIT = TUNING.scoring.pointsPerBit;
const POINTS_PER_NEAR_MISS = TUNING.scoring.pointsPerNearMiss;

/**
 * The multiplier in force this tick.
 *
 * Overdrive's flat `overdriveMultiplier` overrides the Flow formula outright
 * rather than stacking with it — GAME_BIBLE §4.3. Since Flow is pinned at 0
 * during Overdrive anyway, stacking would multiply by 1.0 and the flat value
 * would be indistinguishable from a bug.
 */
export function scoreMultiplier(state: SimState): number {
  if (overdriveActive(state)) {
    return OVERDRIVE_SCORE_MULTIPLIER;
  }
  return flowMultiplier(state.f[F.flow] ?? 0);
}

/** The score, as the integer the player is shown. */
export function getScore(state: SimState): number {
  return Math.floor((state.f[F.scoreFixed] ?? 0) / SCALE);
}

/** The raw fixed-point accumulator. Exposed for the replay hash and tests. */
export function getScoreFixed(state: SimState): number {
  return state.f[F.scoreFixed] ?? 0;
}

/**
 * Adds `points` of score, multiplied and converted to fixed point.
 *
 * `Math.round` here rounds the *increment*, which is bounded and small. The
 * running total is never rounded, so nothing accumulates.
 */
export function addScore(state: SimState, points: number): number {
  if (points <= 0) {
    return 0;
  }
  const units = Math.round(points * scoreMultiplier(state) * SCALE);
  state.f[F.scoreFixed] = (state.f[F.scoreFixed] ?? 0) + units;
  return units;
}

/**
 * Adds score that is NOT subject to the multiplier.
 *
 * Shatter score is the only user: GAME_BIBLE §4.3 says shattering awards the
 * obstacle's value "as score, not Flow", and multiplying it by the 4.0x that
 * Overdrive itself imposes would pay 100 points for ramming something.
 */
export function addFlatScore(state: SimState, points: number): number {
  if (points <= 0) {
    return 0;
  }
  const units = Math.round(points * SCALE);
  state.f[F.scoreFixed] = (state.f[F.scoreFixed] ?? 0) + units;
  return units;
}

/**
 * Distance score for one tick.
 *
 * Takes the distance actually travelled this tick rather than recomputing it
 * from speed, so the score can never disagree with the odometer — including
 * during a Fracture freeze, where the world scroll is scaled and the player must
 * not be paid for time they did not travel.
 */
export function addDistanceScore(state: SimState, metresThisTick: number): number {
  return addScore(state, metresThisTick * POINTS_PER_METRE);
}

/** Score for one Bit. */
export function addBitScore(state: SimState): number {
  return addScore(state, POINTS_PER_BIT);
}

/** Score for a near-miss. Flat in score even though Flow scales with proximity —
 *  the risk taken is the same whether the graze was 0.1u or 0.4u. */
export function addNearMissScore(state: SimState): number {
  return addScore(state, POINTS_PER_NEAR_MISS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Combo
// ─────────────────────────────────────────────────────────────────────────────

/** Extends the combo and tracks the run's best. */
export function bumpCombo(state: SimState): void {
  state.combo += 1;
  if (state.combo > state.bestCombo) {
    state.bestCombo = state.combo;
  }
}

/** Breaks the combo. A stumble counts, not only a crash: contact is contact. */
export function breakCombo(state: SimState): void {
  state.combo = 0;
}

/** End-of-run Bit award, `floor(distance / bitsPerMetreDivisor)`. TUNING §12. */
export function bitsEarned(state: SimState): number {
  return Math.floor((state.f[F.distance] ?? 0) / TUNING.scoring.bitsPerMetreDivisor);
}
