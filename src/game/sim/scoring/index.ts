/**
 * Scoring, Flow, Overdrive and Fracture — step 6 of the tick.
 *
 * ## The sub-order is a contract, like the tick order above it
 *
 * ```
 *   1. fracture      an open window outranks everything; resolve and return
 *   2. overdrive on  the press edge, before gains, so a trigger this tick
 *                    correctly suppresses this tick's Flow
 *   3. drain events  near-miss / coin / roll / shatter -> Flow and score
 *   4. overdrive age countdown and expiry to the comedown value
 *   5. decay         only when Overdrive is not holding Flow at zero
 *   6. distance      paid from the metres the odometer actually recorded
 * ```
 *
 * Gains before decay is what makes `flowDecayGrace` work at all: a gain resets
 * the idle timer to zero, and decay then adds one `dt` to it and finds itself
 * inside the grace window. Reverse the two and a player stringing near-misses
 * together would bleed between every one of them.
 *
 * ## Reading events instead of being called back
 *
 * This pass learns what happened by draining the event ring from a cursor
 * captured at the top of the tick, rather than by collision and the player
 * controller calling into it. That keeps the dependency one-way — `collision.ts`
 * does not know scoring exists — and it means the same code path serves a live
 * run and a server-side replay re-simulation, which is the P12 requirement.
 */

import { TUNING } from "@/game/config/tuning";
import {
  eventPayloadAt,
  eventTypeAt,
  oldestReadable,
  SimEvent,
  type EventRing,
} from "@/game/sim/events";
import type { Intent } from "@/game/sim/intent";
import { EntityType } from "@/game/sim/level/entities";
import { LEAVE_GROUND_MARKER } from "@/game/sim/player";
import { F, RunStatus, type SimState } from "@/game/sim/state";
import {
  addFlow,
  awardForcedRoll,
  awardOverdriveCell,
  awardPerfectSlide,
  awardShard,
  breakBitStreak,
  FlowSource,
  isPerfectSlide,
  nearMissFlow,
  preRollCell,
  recordBit,
  slideLeadInSeconds,
  stepFlowDecay,
  wasForcedRoll,
} from "./flow";
import { overdriveActive, startOverdrive, stepOverdrive } from "./overdrive";
import { addBitScore, addDistanceScore, addNearMissScore, breakCombo, bumpCombo } from "./score";
import { fracturing, stepFracture } from "./fracture";

const SLIDE_DURATION = TUNING.slide.slideDuration;

/** Reused across ticks; the pre-roll cell recovery allocates nothing. */
const preRoll = { face: 0, lane: 0 };

/**
 * Applies scoring and Flow for this tick.
 *
 * @param eventCursor ring index captured before the player step ran, so this
 *        pass sees exactly the events produced by this tick and no others.
 * @param metresThisTick distance the odometer advanced, from `stepDifficulty`.
 */
export function stepScoring(
  state: SimState,
  intent: Readonly<Intent>,
  dt: number,
  events: EventRing,
  eventCursor: number,
  metresThisTick: number,
): void {
  // 1. An open Fracture window suspends normal scoring entirely. The player is
  //    not running, not earning, and not decaying — they are reading geometry.
  if (fracturing(state)) {
    stepFracture(state, intent, dt, events);
    return;
  }

  if (state.runStatus !== RunStatus.Running) {
    return;
  }

  // 2. Overdrive trigger. No press-edge tracking is needed: triggering zeroes
  //    the meter, so `canArmOverdrive` is false on every subsequent tick until
  //    the player has earned another 100. Holding the key therefore spends the
  //    meter the instant it fills, which is a legitimate way to play it.
  if (intent.overdrive) {
    startOverdrive(state, events);
  }

  const inOverdrive = overdriveActive(state);

  // 3. Everything that happened this tick.
  drainEvents(state, events, eventCursor, inOverdrive);

  // Perfect slides are geometric rather than event-driven — nothing emits an
  // event for "a bar passed under me" — so they are sampled directly.
  if (!inOverdrive) {
    checkPerfectSlide(state, events);
  }

  // 4. Age Overdrive. May expire this tick and land Flow on the comedown value.
  const ended = stepOverdrive(state, dt, events);

  // 5. Decay, unless Overdrive is holding the meter at zero. Skipped on the
  //    expiry tick too, so the comedown value is not immediately nibbled.
  if (!overdriveActive(state) && !ended) {
    stepFlowDecay(state, dt);
  }

  // 6. Distance.
  addDistanceScore(state, metresThisTick);
}

/**
 * Converts this tick's events into Flow and score.
 *
 * The cursor is clamped to the oldest readable index, so a pathological tick
 * that overflowed the ring degrades to "scored what survived" rather than
 * reading recycled garbage.
 */
function drainEvents(
  state: SimState,
  events: EventRing,
  cursor: number,
  inOverdrive: boolean,
): void {
  const start = Math.max(cursor, oldestReadable(events));

  for (let i = start; i < events.head; i += 1) {
    const type = eventTypeAt(events, i);

    switch (type) {
      case SimEvent.NearMiss: {
        addNearMissScore(state);
        bumpCombo(state);
        if (!inOverdrive) {
          const gap = eventPayloadAt(events, i, 0);
          addFlow(state, nearMissFlow(gap), FlowSource.NearMiss, events);
        }
        break;
      }

      case SimEvent.Coin: {
        handleCoin(state, events, eventPayloadAt(events, i, 0), inOverdrive);
        break;
      }

      case SimEvent.Shatter: {
        // Flat, not multiplied: GAME_BIBLE §4.3 awards shatter value "as score,
        // not Flow", and running it through Overdrive's own 4.0x would pay a
        // premium for ramming things during the one window where ramming is free.
        addFlatScore(state);
        bumpCombo(state);
        break;
      }

      case SimEvent.RollEnd: {
        if (!inOverdrive) {
          checkForcedRoll(state, events, i);
        }
        break;
      }

      case SimEvent.Stumble: {
        // Contact is contact, even the survivable kind.
        breakCombo(state);
        breakBitStreak(state);
        break;
      }

      default:
        break;
    }
  }
}

/** Shatter score, kept out of the switch so the import stays honest. */
function addFlatScore(state: SimState): void {
  const fixed = state.f[F.scoreFixed] ?? 0;
  state.f[F.scoreFixed] =
    fixed +
    Math.round(TUNING.overdrive.overdriveShatterScore * TUNING.scoring.scoreFixedPointScale);
}

/** Routes a collected pickup to its Flow and score effects. */
function handleCoin(state: SimState, events: EventRing, kind: number, inOverdrive: boolean): void {
  switch (kind) {
    case EntityType.Bit:
    case EntityType.BitCluster:
      addBitScore(state);
      bumpCombo(state);
      if (!inOverdrive) {
        recordBit(state, events);
      }
      break;

    case EntityType.Shard:
      state.player.shards += 1;
      bumpCombo(state);
      if (!inOverdrive) {
        awardShard(state, events);
      }
      break;

    case EntityType.OverdriveCell:
      bumpCombo(state);
      if (!inOverdrive) {
        awardOverdriveCell(state, events);
      }
      break;

    default:
      bumpCombo(state);
      break;
  }
}

/**
 * Awards a forced roll, if the roll that just completed was in fact forced.
 *
 * The `RollEnd` event carries the destination face and lane plus the direction,
 * which is enough to recover where the player rolled *from* — `rollLane` mirrors
 * and is its own inverse, `rollFace` steps and inverts by stepping back.
 */
function checkForcedRoll(state: SimState, events: EventRing, index: number): void {
  const face = eventPayloadAt(events, index, 0);
  const lane = eventPayloadAt(events, index, 1);
  const direction = eventPayloadAt(events, index, 2);
  if (direction === 0) {
    return;
  }

  preRollCell(face, lane, direction, preRoll);
  if (wasForcedRoll(state, preRoll.face, preRoll.lane) >= 0) {
    awardForcedRoll(state, events);
  }
}

/**
 * Samples for a Low Bar crossing the player while a slide is active.
 *
 * "Crossing" is the tick the bar's z passes the player plane. Detected by the
 * bar being at or behind zero now while it was ahead of it a tick ago, computed
 * from `worldSpeed` rather than stored, so this costs no state and no allocation.
 */
function checkPerfectSlide(state: SimState, events: EventRing): void {
  const slideTimer = state.f[F.playerSlideTimer] ?? 0;
  if (slideTimer <= 0) {
    return;
  }

  const obstacles = state.obstacles;
  if (obstacles.count === 0) {
    return;
  }

  const worldSpeed = state.f[F.worldSpeed] ?? 0;
  const travelled = worldSpeed * TUNING.sim.fixedDelta;
  const player = state.player;

  for (let i = 0; i < obstacles.count; i += 1) {
    if (obstacles.active[i] !== 1) {
      continue;
    }
    if ((obstacles.kind[i] ?? 0) !== EntityType.LowBar) {
      continue;
    }
    if ((obstacles.face[i] ?? 0) !== player.face) {
      continue;
    }

    const z = obstacles.z[i] ?? 0;
    // Passed the player plane on this tick, and not on any earlier one.
    if (z > 0 || z + travelled <= 0) {
      continue;
    }

    const leadIn = slideLeadInSeconds(slideTimer);
    if (isPerfectSlide(leadIn)) {
      awardPerfectSlide(state, events);
    }
    return;
  }
}

/** The full slide length, exported so tests can express margins in its terms. */
export const SLIDE_LENGTH_SECONDS = SLIDE_DURATION;

/** Marker re-export so consumers do not have to reach into the player module. */
export { LEAVE_GROUND_MARKER };

export {
  addFlow,
  awardForcedRoll,
  awardOverdriveCell,
  awardPerfectSlide,
  awardShard,
  breakBitStreak,
  FlowSource,
  flowMultiplier,
  getFlow,
  isPerfectSlide,
  MAX_LANE_INDEX,
  nearMissFlow,
  preRollCell,
  recordBit,
  restoreFractureFlow,
  slideLeadInSeconds,
  stepFlowDecay,
  wasForcedRoll,
  zeroFlow,
  type FlowSourceValue,
} from "./flow";

export {
  canArmOverdrive,
  overdriveActive,
  overdriveFraction,
  overdriveRemaining,
  OVERDRIVE_SCORE_MULTIPLIER,
  SHATTER_SCORE,
  startOverdrive,
  stepOverdrive,
} from "./overdrive";

export {
  addBitScore,
  addDistanceScore,
  addNearMissScore,
  addScore,
  bitsEarned,
  breakCombo,
  bumpCombo,
  getScore,
  getScoreFixed,
  scoreMultiplier,
} from "./score";

export {
  ANY_VERB,
  fracturing,
  fractureRemaining,
  fractureTimeScale,
  intentToVerb,
  shardCostFor,
  solveEscapeVerb,
  stepFracture,
  tryArmFracture,
  type EscapeSolution,
} from "./fracture";

export { closedFormSpeed, flowSpeedBonus, INITIAL_SPEED, stepDifficulty } from "./difficulty";
