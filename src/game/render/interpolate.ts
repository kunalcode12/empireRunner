/**
 * Snapshot interpolation — law (c), docs/ARCHITECTURE.md §2c.
 *
 * The sim ticks at a fixed 60Hz. The display does not. Between two sim ticks the
 * renderer is asked to draw frames for moments that the sim never computed, and
 * the only correct answer is to blend the two most recent snapshots by `alpha`.
 *
 * ## Why nothing may read `current` directly for a transform
 *
 * At `maxSpeed` 34 u/s the world advances **0.567u per tick**. On a 144Hz display
 * that is 2.4 frames per tick, so drawing raw `current` holds a position still
 * for two frames and then jumps 0.567u on the third. That is not a subtle
 * artifact — it is a visible 34-unit-per-second stutter, and it is the single
 * most common way an otherwise correct fixed-timestep loop looks broken.
 *
 * So: **every rendered transform comes from this module.** If a component reads
 * `sim.getState()` and writes a position from it, that component is wrong.
 * Reading `current` for a *discrete* value — a phase, a lane index, a count — is
 * fine, because those do not interpolate.
 *
 * ## The roll is a slerp, not a lerp
 *
 * §2c is explicit: "Rotations (the roll) interpolate as quaternion slerp, not
 * euler lerp." For the roll specifically, both give the same path — it is
 * rotation about a single fixed axis, where slerp degenerates to a scalar lerp
 * of the angle. The rule still holds because it costs nothing here and stops the
 * habit forming before a rotation arrives that does need it.
 *
 * `Math.exp` and friends are permitted in this file. The transcendental ban in
 * eslint.config.mjs is scoped to `src/game/sim/**` for P12 bit-reproducibility;
 * presentation never feeds back into the sim.
 */

import { F, Phase, type SimState } from "@/game/sim/state";

/** Scalar linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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

/**
 * Frame-rate independent exponential damping.
 *
 * `x += (target - x) * (1 - e^(-rate * dt))`.
 *
 * The naive form — `x = lerp(x, target, k)` with a constant `k` — converges at a
 * rate proportional to the frame rate, so the camera is stiffer on a 144Hz
 * monitor than a 60Hz one and the game feels measurably different on better
 * hardware. This form is invariant, which is why every rate in `TUNING.camera`
 * is expressed in 1/s rather than as a per-frame fraction.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (rate <= 0) {
    return target;
  }
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Shortest-path interpolation between two angles, in radians. */
export function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let delta = (b - a) % TAU;
  if (delta > Math.PI) {
    delta -= TAU;
  } else if (delta < -Math.PI) {
    delta += TAU;
  }
  return a + delta * t;
}

/**
 * Everything the render layer needs from the sim for one frame.
 *
 * A flat struct rather than a partial `SimState`, because the two are different
 * things: this is the *presented* state at an arbitrary moment between ticks,
 * and conflating it with the authoritative state is how a renderer ends up
 * writing back into the sim.
 */
export interface RenderView {
  /** u — interpolated lateral offset within the current face. */
  x: number;
  /** u — interpolated height above the floor plane. */
  y: number;
  /** u — interpolated position along the tunnel. Near zero, per law (b). */
  z: number;
  /** rad — interpolated world roll about the tunnel axis. */
  roll: number;
  /** m — interpolated distance travelled. Drives tunnel scroll. */
  distance: number;
  /** u/s — interpolated world speed. Drives FOV. */
  worldSpeed: number;
  /** 0..100 — interpolated Flow. */
  flow: number;

  // ── Discrete. Taken from `current`; these do not interpolate. ──────────────
  /** 0..3 — which face is the floor. */
  face: number;
  /** 0..2 — lane on that face. */
  lane: number;
  /** Phase — the state machine node, for the animation state. */
  phase: number;
  /** -1 / 0 / +1 — in-flight roll direction. */
  rollDirection: number;
  /** Sim tick of `current`. */
  tick: number;
}

/** Allocates a view. Called once; the loop reuses it every frame. */
export function createRenderView(): RenderView {
  return {
    x: 0,
    y: 0,
    z: 0,
    roll: 0,
    distance: 0,
    worldSpeed: 0,
    flow: 0,
    face: 0,
    lane: 1,
    phase: Phase.Running,
    rollDirection: 0,
    tick: 0,
  };
}

/**
 * Fills `out` by blending `previous` and `current` at `alpha`. Allocates nothing.
 *
 * ## The roll needs care
 *
 * `F.playerRoll` is folded back to 0 on the tick a roll completes, so a naive
 * lerp across that boundary sweeps backwards through 90 degrees in one frame —
 * the camera whips the wrong way at the exact moment the player is watching it.
 * `lerpAngle` takes the shortest path, which for the completion tick means
 * holding near the final angle rather than unwinding.
 */
export function readInterpolated(
  out: RenderView,
  previous: SimState,
  current: SimState,
  alpha: number,
): RenderView {
  const t = saturate(alpha);
  const p = previous.f;
  const c = current.f;

  out.x = lerp(p[F.playerX] ?? 0, c[F.playerX] ?? 0, t);
  out.y = lerp(p[F.playerY] ?? 0, c[F.playerY] ?? 0, t);
  out.z = lerp(p[F.playerZ] ?? 0, c[F.playerZ] ?? 0, t);
  out.roll = lerpAngle(p[F.playerRoll] ?? 0, c[F.playerRoll] ?? 0, t);
  out.distance = lerp(p[F.distance] ?? 0, c[F.distance] ?? 0, t);
  out.worldSpeed = lerp(p[F.worldSpeed] ?? 0, c[F.worldSpeed] ?? 0, t);
  out.flow = lerp(p[F.flow] ?? 0, c[F.flow] ?? 0, t);

  out.face = current.player.face;
  out.lane = current.player.lane;
  out.phase = current.player.phase;
  out.rollDirection = current.player.rollDirection;
  out.tick = current.tick;

  return out;
}

/**
 * The animation state a rig should be in.
 *
 * Derived from the sim's `Phase` rather than invented here, so P07 can bind a
 * real animation graph to values that already exist in the simulation.
 */
export const AnimationState = {
  Running: "running",
  Jumping: "jumping",
  Falling: "falling",
  Sliding: "sliding",
  Rolling: "rolling",
  Stumbling: "stumbling",
  Crashed: "crashed",
  Fracturing: "fracturing",
} as const;
export type AnimationStateValue = (typeof AnimationState)[keyof typeof AnimationState];

const PHASE_TO_ANIMATION: readonly AnimationStateValue[] = [
  AnimationState.Running,
  AnimationState.Jumping,
  AnimationState.Falling,
  AnimationState.Sliding,
  AnimationState.Rolling,
  AnimationState.Stumbling,
  AnimationState.Crashed,
  AnimationState.Fracturing,
];

/** Maps a sim `Phase` to its animation state. */
export function animationForPhase(phase: number): AnimationStateValue {
  return PHASE_TO_ANIMATION[phase] ?? AnimationState.Running;
}
