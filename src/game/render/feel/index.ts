/**
 * The feel orchestrator — sim events in, presentation effects out.
 *
 * One place that knows which event causes which effect, so the mapping is
 * readable as a table rather than scattered through the loop. Everything here
 * is driven by the event ring or by interpolated sim state; nothing invents a
 * source of truth and nothing writes back.
 *
 * ```
 *   Crash          hit-stop 90ms · trauma 1.00 · shatter debris at the player
 *   Shatter        hit-stop 60ms · trauma 0.30 · shatter debris at the obstacle
 *   Stumble        trauma 0.42
 *   NearMiss       trauma 0.16 · aberration pulse · (Flow flare -> HUD, P14)
 *   Coin           coin burst
 *   Land           squash scaled by impact vy · trauma scaled by impact vy
 *   FractureArm    fracture shards
 *   (continuous)   Overdrive trail · foot dust · speed lines
 * ```
 *
 * ## The near-miss is the important row
 *
 * GAME_BIBLE has no tutorial for the Flow system. The player learns that
 * shaving an obstacle pays because **the first accidental near-miss is loudly
 * rewarding** — a kick, a pulse, and a visible Flow gain. Get this wrong and
 * Flow is an unexplained bar that fills for reasons nobody identifies.
 *
 * The audio half (a directional whoosh) lands at P11 and the Flow-meter flare at
 * P14 with the HUD; `nearMissPulse` is published here for both to read, so
 * neither has to re-derive when a near-miss happened.
 */

import { TUNING } from "@/game/config/tuning";
import { SimEvent } from "@/game/sim/events";
import type { DrainedEvent } from "../events";
import { addTrauma, createTrauma, resetTrauma, stepTrauma, type TraumaState } from "./trauma";
import {
  createHitStop,
  hitStopCrash,
  hitStopShatter,
  resetHitStop,
  stepHitStop,
  type HitStopState,
} from "./hitstop";
import { getMotion } from "./reducedMotion";
import { emitCoinBurst, emitFractureShards, emitShatter } from "../vfx/emitters";
import type { ParticlePool } from "../vfx/ParticleSystem";

const F = TUNING.feel;

/** A stumble pulses at half a near-miss: it is contact, but survivable. */
const STUMBLE_PULSE_SCALE = 0.5;

export interface FeelState {
  readonly trauma: TraumaState;
  readonly hitStop: HitStopState;
  /** 0..1 — decaying chromatic-aberration pulse. Consumed by the post-FX pass.
   *  GAME_BIBLE §11.3 permits aberration ONLY as a transient; this is one. */
  aberration: number;
  /** s — accumulator for the rate-based Overdrive trail. */
  trailAccumulator: number;
  /** count — near-misses this run. Diagnostic. */
  nearMisses: number;
}

export function createFeel(): FeelState {
  return {
    trauma: createTrauma(),
    hitStop: createHitStop(),
    aberration: 0,
    trailAccumulator: 0,
    nearMisses: 0,
  };
}

export function resetFeel(state: FeelState): void {
  resetTrauma(state.trauma);
  resetHitStop(state.hitStop);
  state.aberration = 0;
  state.trailAccumulator = 0;
  state.nearMisses = 0;
}

/** Where the player is this frame, for effects that spawn at them. */
export interface FeelContext {
  playerX: number;
  playerY: number;
  playerZ: number;
  /** u/s — vertical speed at the moment of a Land event. */
  landingSpeed: number;
}

/**
 * Routes one sim event to its effects.
 *
 * Called for every event drained this frame, before the per-frame step.
 */
export function handleFeelEvent(
  state: FeelState,
  event: Readonly<DrainedEvent>,
  pool: ParticlePool,
  context: FeelContext,
): void {
  switch (event.type) {
    case SimEvent.Crash: {
      hitStopCrash(state.hitStop);
      addTrauma(state.trauma, F.traumaCrash);
      pulse(state, 1);
      emitShatter(pool, context.playerX, context.playerY, context.playerZ);
      break;
    }

    case SimEvent.Shatter: {
      hitStopShatter(state.hitStop);
      addTrauma(state.trauma, F.traumaShatter);
      // payload0 is the obstacle index; the debris should come from the
      // obstacle, but its position is not in the event. Spawning at the player
      // is close enough — a shatter happens on contact, so they are within a
      // metre of each other by definition.
      emitShatter(pool, context.playerX, context.playerY, context.playerZ);
      break;
    }

    case SimEvent.Stumble: {
      addTrauma(state.trauma, F.traumaStumble);
      pulse(state, STUMBLE_PULSE_SCALE);
      break;
    }

    case SimEvent.NearMiss: {
      state.nearMisses += 1;
      addTrauma(state.trauma, F.traumaNearMiss);
      pulse(state, 1);
      break;
    }

    case SimEvent.Coin: {
      emitCoinBurst(pool, context.playerX, context.playerY, context.playerZ);
      break;
    }

    case SimEvent.Land: {
      // payload0 is the impact vy, which is negative coming down.
      const speed = Math.abs(event.payload0);
      const strength = Math.min(1, speed / TUNING.feel.squashFullImpactSpeed);
      addTrauma(state.trauma, F.traumaLanding * strength);
      break;
    }

    case SimEvent.FractureArm: {
      emitFractureShards(pool, context.playerX, context.playerY, context.playerZ);
      pulse(state, 1);
      break;
    }

    default:
      break;
  }
}

/** Adds an aberration pulse, scaled and gated by reduced motion. */
function pulse(state: FeelState, scale: number): void {
  const motion = getMotion();
  if (motion.aberrationScale <= 0) {
    return;
  }
  const value = F.nearMissPulseStrength * scale * motion.aberrationScale;
  if (value > state.aberration) {
    state.aberration = value;
  }
}

/**
 * Advances the per-frame decays.
 *
 * @param dt real frame delta.
 * @returns true when presentation should hold this frame (hit-stop).
 */
export function stepFeel(state: FeelState, dt: number): boolean {
  const held = stepHitStop(state.hitStop, dt);

  // Trauma and the pulse keep decaying THROUGH a hit-stop. Freezing them would
  // mean the shake starts from full only after the freeze lifts, which reads as
  // two separate events rather than one impact.
  stepTrauma(state.trauma, dt);

  if (state.aberration > 0) {
    state.aberration -= dt / F.nearMissPulseDuration;
    if (state.aberration < 0) {
      state.aberration = 0;
    }
  }

  return held;
}

export {
  addTrauma,
  createTrauma,
  resetTrauma,
  shakeAmount,
  stepTrauma,
  type ShakeOffset,
  type TraumaState,
} from "./trauma";

export {
  createHitStop,
  frozen,
  hitStopCrash,
  hitStopShatter,
  requestHitStop,
  resetHitStop,
  stepHitStop,
  type HitStopState,
} from "./hitstop";

export {
  createSquash,
  horizontalScale,
  land,
  resetSquash,
  setRisingStretch,
  stepSquash,
  verticalScale,
  type SquashState,
} from "./squash";

export {
  effectiveFovBoost,
  getMotion,
  parseMotionOverride,
  prefersReducedMotion,
  resetMotion,
  resolveMotion,
  setMotion,
  type MotionSettings,
} from "./reducedMotion";

export { noise1D, noise1DOctaves } from "./noise";
export { SpeedLines, SPEED_LINE_DRAW_CALLS, type SpeedLinesHandle } from "./SpeedLines";
