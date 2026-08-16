/**
 * Movement integration — lane tween, jump arc, slide, roll.
 *
 * Every constant comes from tuning.ts. Nothing here hardcodes a force: gravity
 * and the launch impulse are **solved** from `jumpApexTime` and `jumpApexHeight`
 * so that changing the desired apex in the tuning table changes the feel without
 * anyone re-deriving physics.
 *
 * ## Determinism
 *
 * Every curve here is written as an explicit polynomial. There is no `Math.pow`,
 * no `Math.sin`, no `Math.exp`. ECMA-262 specifies `+ - * /` and `Math.sqrt`
 * exactly; the transcendentals are only "implementation-approximated" and differ
 * between browser engines, which would break the client-vs-server replay check
 * in P12. Same reasoning as the frozen constant in `TUNING.determinism`.
 *
 * ## Integration scheme
 *
 * Semi-implicit (symplectic) Euler: velocity first, then position from the new
 * velocity. Chosen over explicit Euler because it does not gain energy over
 * time, so a long airborne section cannot drift upward, and over RK4 because it
 * is exactly reproducible in one arithmetic pass with no intermediate rounding.
 */

import { TUNING } from "@/game/config/tuning";
import { F, Phase, type SimState } from "@/game/sim/state";
import { laneCentreX } from "./facing";
import { tickDown, timerActive } from "./timer";

const LANE_CHANGE_DURATION = TUNING.lane.laneChangeDuration;
const SLIDE_DURATION = TUNING.slide.slideDuration;
const SLIDE_RECOVERY = TUNING.slide.slideRecovery;
const ROLL_DURATION = TUNING.roll.rollDuration;
const ROLL_COMMIT_LOCK = TUNING.roll.rollCommitLock;
const ROLL_COOLDOWN = TUNING.roll.rollCooldown;
const GRAVITY_RISE = TUNING.vertical.gravityRise;
const GRAVITY_FALL = TUNING.vertical.gravityFall;
const JUMP_IMPULSE = TUNING.vertical.jumpImpulse;
const JUMP_RELEASE_CUT = TUNING.vertical.jumpReleaseCut;
const FAST_DROP_SPEED = TUNING.vertical.fastDropSpeed;
const FALL_KILL_DEPTH = TUNING.geometry.fallKillDepth;

/** A quarter turn, in radians. The roll rotates the world by exactly this. */
const QUARTER_TURN = Math.PI / 2;

const GROUND_Y = 0;

/** Midpoint of an ease-in-out curve, where it switches branches. */
const EASE_MIDPOINT = 0.5;
/** Scale factor on the ease-in half of easeInOutCubic. */
const EASE_IN_SCALE = 4;
/** Slope of the reflected input on the ease-out half. */
const EASE_OUT_SLOPE = -2;
/** Divisor that normalises the reflected cubic back into [0, 1]. */
const EASE_OUT_DIVISOR = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Easing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ease-out cubic: `1 - (1 - t)^3`.
 *
 * Written out rather than via `Math.pow` — see the determinism note above.
 * Cubic rather than quadratic decelerates harder into the settle, which makes a
 * 0.14s lane change read as decisive rather than drifting. docs/TUNING.md §6 has
 * been corrected to match.
 */
export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Ease-in-out cubic, for the roll's world rotation.
 *
 * Linear rotation is the most nausea-inducing curve available, which is why
 * docs/TUNING.md §7 specifies easing here at all.
 */
export function easeInOutCubic(t: number): number {
  if (t < EASE_MIDPOINT) {
    return EASE_IN_SCALE * t * t * t;
  }
  const u = EASE_OUT_SLOPE * t + EASE_OUT_DIVISOR;
  return 1 - (u * u * u) / EASE_OUT_DIVISOR;
}

/** Clamps to `[0, 1]`. */
export function saturate(t: number): number {
  if (t < 0) {
    return 0;
  }
  if (t > 1) {
    return 1;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane change
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts or redirects a lane tween.
 *
 * **Interruptible by a reverse input**: the tween restarts from wherever the
 * player currently is, not from the lane centre they left. Without that, a
 * left-then-immediately-right input would snap backwards. Restarting from the
 * live `x` keeps the reversal continuous.
 *
 * A roll does NOT interrupt a tween — the roll mirrors the lateral axis instead,
 * see `mirrorLaneTween`.
 */
export function startLaneTween(state: SimState, targetLane: number): void {
  state.f[F.playerLaneFromX] = state.f[F.playerX] ?? 0;
  state.f[F.playerLaneTargetX] = laneCentreX(targetLane);
  state.f[F.playerLaneTweenElapsed] = 0;
  state.player.targetLane = targetLane;
}

/** True while a lane tween is still running. */
export function laneTweenActive(state: SimState): boolean {
  return state.player.lane !== state.player.targetLane;
}

/**
 * Advances the lane tween.
 *
 * On completion `lane` snaps to `targetLane` and `x` snaps to the exact lane
 * centre, so floating point drift cannot accumulate across hundreds of lane
 * changes in a long run.
 */
export function stepLaneTween(state: SimState, dt: number): void {
  if (!laneTweenActive(state)) {
    return;
  }

  const elapsed = (state.f[F.playerLaneTweenElapsed] ?? 0) + dt;
  state.f[F.playerLaneTweenElapsed] = elapsed;

  if (elapsed >= LANE_CHANGE_DURATION) {
    state.player.lane = state.player.targetLane;
    state.f[F.playerX] = laneCentreX(state.player.lane);
    state.f[F.playerLaneTweenElapsed] = LANE_CHANGE_DURATION;
    return;
  }

  const t = easeOutCubic(saturate(elapsed / LANE_CHANGE_DURATION));
  const from = state.f[F.playerLaneFromX] ?? 0;
  const to = state.f[F.playerLaneTargetX] ?? 0;
  state.f[F.playerX] = from + (to - from) * t;
}

/**
 * Mirrors an in-flight lane tween across a roll.
 *
 * Because lane centres are symmetric about zero, a roll is exactly a negation of
 * the lateral axis (see facing.ts). Negating the tween's endpoints as well as
 * the live position means a lane change survives a roll landing mid-tween
 * without a special case and without a visible snap.
 */
export function mirrorLaneTween(state: SimState): void {
  state.f[F.playerX] = -(state.f[F.playerX] ?? 0);
  state.f[F.playerLaneFromX] = -(state.f[F.playerLaneFromX] ?? 0);
  state.f[F.playerLaneTargetX] = -(state.f[F.playerLaneTargetX] ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Jump
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launches a jump.
 *
 * `jumpImpulse` is `2h/t` and `gravityRise` is `2h/t^2`, both derived in
 * tuning.ts from `jumpApexHeight` and `jumpApexTime`. Under semi-implicit Euler
 * this reaches apex within one tick of the stated time — asserted in
 * `locomotion.test.ts`.
 */
export function launchJump(state: SimState): void {
  state.f[F.playerVy] = JUMP_IMPULSE;
  state.player.grounded = 0;
}

/**
 * Cuts a jump short when JUMP is released while still rising.
 *
 * Variable jump height, and the cheapest thing that makes a jump feel authored:
 * a tap is a short hop, a hold is the full 1.75u arc. Only applies while rising —
 * releasing after apex does nothing, because the player has already committed.
 */
export function cutJump(state: SimState): void {
  const vy = state.f[F.playerVy] ?? 0;
  if (vy > 0) {
    state.f[F.playerVy] = vy * JUMP_RELEASE_CUT;
  }
}

/**
 * The mid-air fast-drop.
 *
 * Pressing SLIDE while airborne dives to the ground instead of doing nothing.
 * An intentionally undocumented advanced technique — it is absent from the verb
 * list in GAME_BIBLE §6 and from any tutorial, the way Subway Surfers hides its
 * air-control depth from new players. Experts use it to recover a mistimed jump.
 */
export function fastDrop(state: SimState): void {
  state.f[F.playerVy] = -FAST_DROP_SPEED;
}

/**
 * Integrates vertical motion for one tick.
 *
 * Asymmetric gravity: rising uses `gravityRise`, falling uses `gravityFall`,
 * which is 1.8x heavier. This is what makes the jump snappy instead of floaty —
 * the player hangs briefly at apex and then comes down with weight.
 *
 * @returns true if the player landed this tick.
 */
export function stepVertical(state: SimState, dt: number): boolean {
  const vy = state.f[F.playerVy] ?? 0;
  const gravity = vy > 0 ? GRAVITY_RISE : GRAVITY_FALL;

  const nextVy = vy - gravity * dt;
  const nextY = (state.f[F.playerY] ?? 0) + nextVy * dt;

  if (nextY <= GROUND_Y && nextVy <= 0) {
    state.f[F.playerY] = GROUND_Y;
    state.f[F.playerVy] = 0;
    state.player.grounded = 1;
    return true;
  }

  state.f[F.playerVy] = nextVy;
  state.f[F.playerY] = nextY;
  state.player.grounded = 0;
  return false;
}

/** True when the player has fallen far enough below the floor plane to die. */
export function fellOutOfWorld(state: SimState): boolean {
  return (state.f[F.playerY] ?? 0) <= -FALL_KILL_DEPTH;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide
// ─────────────────────────────────────────────────────────────────────────────

/** Starts a slide. Cannot be cancelled early — only the timer ends it. */
export function startSlide(state: SimState): void {
  state.f[F.playerSlideTimer] = SLIDE_DURATION;
  state.f[F.playerSlideRecoveryTimer] = 0;
}

/** True while the slide's collider is still collapsed. */
export function slideActive(state: SimState): boolean {
  return timerActive(state.f[F.playerSlideTimer] ?? 0);
}

/** True while standing back up. Jump is illegal until this clears. */
export function slideRecovering(state: SimState): boolean {
  return timerActive(state.f[F.playerSlideRecoveryTimer] ?? 0);
}

/**
 * Ages the slide.
 *
 * @returns true on the tick the slide's active phase ends.
 */
export function stepSlide(state: SimState, dt: number): boolean {
  const timer = state.f[F.playerSlideTimer] ?? 0;
  if (timerActive(timer)) {
    const next = tickDown(timer, dt);
    state.f[F.playerSlideTimer] = next;
    if (next <= 0) {
      state.f[F.playerSlideRecoveryTimer] = SLIDE_RECOVERY;
      return true;
    }
    return false;
  }

  state.f[F.playerSlideRecoveryTimer] = tickDown(state.f[F.playerSlideRecoveryTimer] ?? 0, dt);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roll — concurrent with every phase. GAME_BIBLE §3.2.
// ─────────────────────────────────────────────────────────────────────────────

/** True when a roll may legally start. */
export function canStartRoll(state: SimState): boolean {
  return (
    !timerActive(state.f[F.playerRollTimer] ?? 0) &&
    !timerActive(state.f[F.playerRollCooldownTimer] ?? 0)
  );
}

/** Starts a roll, arming the commit lock. */
export function startRoll(state: SimState, direction: number): void {
  state.f[F.playerRollTimer] = ROLL_DURATION;
  state.f[F.playerRollElapsed] = 0;
  state.f[F.playerRollCommitTimer] = ROLL_COMMIT_LOCK;
  state.player.rollDirection = direction;
}

/** True while a roll is in flight. */
export function rollActive(state: SimState): boolean {
  return timerActive(state.f[F.playerRollTimer] ?? 0);
}

/**
 * True while lateral input must be DROPPED.
 *
 * Not buffered — dropped. This is the single mechanic that stops the roll being
 * a free escape button, and buffering the input would hand the correction back.
 */
export function rollCommitted(state: SimState): boolean {
  return timerActive(state.f[F.playerRollCommitTimer] ?? 0);
}

/**
 * Ages the roll and interpolates the world rotation.
 *
 * @returns true on the tick the roll completes, when the caller must apply the
 *          face/lane transform.
 */
export function stepRoll(state: SimState, dt: number): boolean {
  state.f[F.playerRollCooldownTimer] = tickDown(state.f[F.playerRollCooldownTimer] ?? 0, dt);
  state.f[F.playerRollCommitTimer] = tickDown(state.f[F.playerRollCommitTimer] ?? 0, dt);

  const timer = state.f[F.playerRollTimer] ?? 0;
  if (!timerActive(timer)) {
    return false;
  }

  const elapsed = (state.f[F.playerRollElapsed] ?? 0) + dt;
  const next = tickDown(timer, dt);

  if (next <= 0) {
    state.f[F.playerRollTimer] = 0;
    state.f[F.playerRollElapsed] = ROLL_DURATION;
    state.f[F.playerRollCommitTimer] = 0;
    state.f[F.playerRollCooldownTimer] = ROLL_COOLDOWN;
    // The world has turned exactly 90 degrees; fold it back to zero so the angle
    // never accumulates unbounded over a long run.
    state.f[F.playerRoll] = 0;
    return true;
  }

  state.f[F.playerRollTimer] = next;
  state.f[F.playerRollElapsed] = elapsed;

  const t = easeInOutCubic(saturate(elapsed / ROLL_DURATION));
  state.f[F.playerRoll] = state.player.rollDirection * QUARTER_TURN * t;
  return false;
}

/** Exposed for the render layer and tests: a full roll is a quarter turn. */
export const ROLL_ANGLE = QUARTER_TURN;

/** True when the phase means the player is standing on the floor plane. */
export function onGround(state: SimState): boolean {
  return state.player.grounded === 1 && (state.f[F.playerY] ?? 0) <= GROUND_Y;
}

/** The floor plane height. Exported so collision and tests agree on it. */
export const FLOOR_Y = GROUND_Y;

/** Phases in which the player's collider is the collapsed slide box. */
export function isSlidingPhase(phase: number): boolean {
  return phase === Phase.Sliding;
}
