/**
 * The Flow meter — the game's whole tension curve, as one number in `0..100`.
 *
 * ## THE COUPLING. READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * Flow drives **two** outputs at once, and that is not an accident, an
 * optimisation, or a bug:
 *
 * ```
 *   scoreMultiplier = 1.0 + (flowMultiplierMax - 1.0) * flow / 100     -> 1.0x .. 3.0x
 *   worldSpeed     += flowSpeedBonus * flow / 100                      -> +0 .. +6 u/s
 * ```
 *
 * Playing well raises Flow. Raising Flow makes the world faster. A faster world
 * makes obstacles arrive sooner, which turns optional near-misses into
 * unavoidable ones, which raises Flow faster still — until the player crashes and
 * loses all of it at once. That runaway IS the design (GAME_BIBLE §4.2).
 *
 * **Someone will eventually read "Flow makes the game speed up" as a difficulty
 * bug and try to decouple it.** Doing that removes the self-escalation, turns the
 * meter into a passive score bonus, and leaves the game with no tension curve at
 * all. The speed half lives in `difficulty.ts` and the multiplier half in
 * `score.ts`; neither is allowed to read Flow for any other purpose, so the two
 * effects stay visible and stay together.
 *
 * ## What this module owns
 *
 * `F.flow` and `F.flowIdleTimer` — nothing outside this file writes either. Gains
 * and decay both route through here so the grace window cannot be bypassed by a
 * caller that "just adds a bit of Flow".
 *
 * ## Divergence from GAME_BIBLE §4.1, approved at P08
 *
 *   - Near-miss Flow is **scaled by proximity** rather than flat. See
 *     `TUNING.flow.nearMissScaleMin`.
 *   - A **forced roll** awards `flowPerForcedRoll`. New source; the roll had none.
 *
 * The values for perfect slide (4) and Bit streak (3) are the documented ones,
 * NOT the 8 and 4 floated during the P08 prompt: TUNING §9.1 keeps perfect slide
 * strictly under near-miss on purpose, so that slide-farming can never out-earn
 * risk, and 8 would have inverted that.
 */

import { TUNING } from "@/game/config/tuning";
import { emit, SimEvent, type EventRing } from "@/game/sim/events";
import { blocksVertical, entityDef, Vertical } from "@/game/sim/level/entities";
import { rollFace, rollLane } from "@/game/sim/player/facing";
import { F, type SimState } from "@/game/sim/state";

const FLOW_MAX = TUNING.flow.flowMax;
const FLOW_PER_NEAR_MISS = TUNING.flow.flowPerNearMiss;
const NEAR_MISS_RADIUS = TUNING.flow.nearMissRadius;
const NEAR_MISS_SCALE_MIN = TUNING.flow.nearMissScaleMin;
const FLOW_PER_PERFECT_SLIDE = TUNING.flow.flowPerPerfectSlide;
const FLOW_PER_BIT_STREAK = TUNING.flow.flowPerBitStreak;
const BIT_STREAK_INTERVAL = TUNING.flow.bitStreakInterval;
const FLOW_PER_FORCED_ROLL = TUNING.flow.flowPerForcedRoll;
const FLOW_PER_OVERDRIVE_CELL = TUNING.flow.flowPerOverdriveCell;
const FLOW_PER_SHARD = TUNING.flow.flowPerShard;
const FLOW_DECAY_PER_SECOND = TUNING.flow.flowDecayPerSecond;
const FLOW_DECAY_GRACE = TUNING.flow.flowDecayGrace;
const FLOW_GAIN_MULTIPLIER = TUNING.flow.flowGainMultiplier;
const FLOW_MULTIPLIER_MAX = TUNING.flow.flowMultiplierMax;
const FRACTURE_FLOW_RETAINED = TUNING.fracture.fractureFlowRetained;
const SLIDE_DURATION = TUNING.slide.slideDuration;
const PERFECT_SLIDE_MARGIN = TUNING.slide.perfectSlideMargin;
const ROLL_DURATION = TUNING.roll.rollDuration;
const LANE_COUNT = TUNING.geometry.laneCount;
const MAX_LANE = LANE_COUNT - 1;

/** Payload1 of `SimEvent.FlowGain`, so the HUD can label the floating number. */
export const FlowSource = {
  NearMiss: 0,
  PerfectSlide: 1,
  BitStreak: 2,
  ForcedRoll: 3,
  OverdriveCell: 4,
  Shard: 5,
} as const;
export type FlowSourceValue = (typeof FlowSource)[keyof typeof FlowSource];

/** Reads the meter. */
export function getFlow(state: SimState): number {
  return state.f[F.flow] ?? 0;
}

/**
 * The score multiplier at a given Flow.
 *
 * Half of the coupling described in the module header. Overdrive overrides this
 * with a flat `overdriveMultiplier` — see `overdrive.ts`.
 */
export function flowMultiplier(flow: number): number {
  return 1 + ((FLOW_MULTIPLIER_MAX - 1) * flow) / FLOW_MAX;
}

/**
 * Flow awarded for a near-miss at `gap` surface-to-surface separation.
 *
 * Linear from the full award at zero gap down to `nearMissScaleMin` of it at
 * exactly `nearMissRadius`. Linear rather than curved because a curve needs
 * `Math.pow`, which is banned in the sim for the P12 cross-engine reason.
 */
export function nearMissFlow(gap: number): number {
  const clamped = gap < 0 ? 0 : gap > NEAR_MISS_RADIUS ? NEAR_MISS_RADIUS : gap;
  const closeness = 1 - clamped / NEAR_MISS_RADIUS;
  return FLOW_PER_NEAR_MISS * (NEAR_MISS_SCALE_MIN + (1 - NEAR_MISS_SCALE_MIN) * closeness);
}

/**
 * Adds Flow, clamps, resets the decay grace, and emits.
 *
 * **The only way Flow ever goes up.** `flowGainMultiplier` (the Flow Gain upgrade
 * times the avatar passive) applies here and therefore to every source at once —
 * TUNING §9.1 is explicit that it never applies to decay.
 */
export function addFlow(
  state: SimState,
  amount: number,
  source: number,
  events: EventRing,
): number {
  if (amount <= 0) {
    return 0;
  }

  const scaled = amount * FLOW_GAIN_MULTIPLIER;
  const before = state.f[F.flow] ?? 0;
  const raw = before + scaled;
  const after = raw > FLOW_MAX ? FLOW_MAX : raw;

  state.f[F.flow] = after;
  // Any gain resets the grace window, so a player stringing near-misses together
  // never bleeds between them.
  state.f[F.flowIdleTimer] = 0;

  const applied = after - before;
  if (applied > 0) {
    emit(events, SimEvent.FlowGain, state.tick, applied, source, after);
  }

  // Fires on the crossing only, not every tick at the ceiling — otherwise the
  // Overdrive prompt would re-arm 60 times a second and the audio sting with it.
  if (before < FLOW_MAX && after >= FLOW_MAX) {
    emit(events, SimEvent.FlowFull, state.tick, after);
  }

  return applied;
}

/**
 * Bleeds Flow once the grace window has elapsed with no gain.
 *
 * This is why standing still is punished: a player who takes the safe middle lane
 * through a clean stretch is not being attacked, they are simply not being paid,
 * and the meter falls at `flowDecayPerSecond`. Surviving is not the same as
 * playing.
 */
export function stepFlowDecay(state: SimState, dt: number): void {
  const flow = state.f[F.flow] ?? 0;
  if (flow <= 0) {
    // Still age the timer so the grace window is not indefinitely re-armed by
    // sitting at zero.
    state.f[F.flowIdleTimer] = (state.f[F.flowIdleTimer] ?? 0) + dt;
    return;
  }

  const idle = (state.f[F.flowIdleTimer] ?? 0) + dt;
  state.f[F.flowIdleTimer] = idle;

  if (idle < FLOW_DECAY_GRACE) {
    return;
  }

  const next = flow - FLOW_DECAY_PER_SECOND * dt;
  state.f[F.flow] = next < 0 ? 0 : next;
}

/**
 * Zeroes the meter. Not reduces — zeroes. GAME_BIBLE §4.1.
 *
 * The entire point of the escalation loop is that the fall is total: a run's
 * accumulated Flow is unbanked, and crashing forfeits all of it at once.
 */
export function zeroFlow(state: SimState): void {
  state.f[F.flow] = 0;
  state.f[F.flowIdleTimer] = 0;
}

/** Restores `fractureFlowRetained` of the Flow held at death. GAME_BIBLE §5.3. */
export function restoreFractureFlow(state: SimState): void {
  state.f[F.flow] = (state.f[F.flowAtDeath] ?? 0) * FRACTURE_FLOW_RETAINED;
  state.f[F.flowIdleTimer] = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bit streak
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records one collected Bit and awards the streak milestone every Nth.
 *
 * @returns the Flow awarded, which is zero on all but every `bitStreakInterval`th.
 */
export function recordBit(state: SimState, events: EventRing): number {
  state.bitStreak += 1;
  if (state.bitStreak % BIT_STREAK_INTERVAL !== 0) {
    return 0;
  }
  return addFlow(state, FLOW_PER_BIT_STREAK, FlowSource.BitStreak, events);
}

/** Breaks the streak. A missed Bit or a crash, per GAME_BIBLE §4.1. */
export function breakBitStreak(state: SimState): void {
  state.bitStreak = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Perfect slide
//
// GAME_BIBLE §4.1: "A slide clears a low bar with <= perfectSlideMargin 0.12s of
// spare clearance at either end. Sliding early and lying there does not count."
//
// ## That sentence cannot be implemented literally, so here is the reading used
//
// A slide lasts `slideDuration` 0.55s. The time before reaching the bar and the
// time remaining after it always sum to 0.55. Requiring BOTH ends to be under
// 0.12s demands a sum under 0.24s, which is impossible — no slide would ever
// qualify and the mechanic would be dead on arrival.
//
// The second sentence disambiguates it. "Sliding early and lying there does not
// count" is a constraint on the LEADING edge only: the award is for committing
// late, at the last moment the slide still works. The trailing edge is not a
// skill measurement at all — it is just 0.55 minus the leading edge.
//
// So: perfect iff the slide began at most `perfectSlideMargin` before the bar
// arrived, and was still active when it did. docs/GAME_BIBLE.md §4.1 has been
// corrected to state this rather than the unsatisfiable version.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seconds between the slide starting and the bar arriving.
 *
 * A bar is thin relative to a 0.55s slide, so entry and exit are effectively the
 * same instant and one sample at the crossing is enough. That also means this
 * needs no stored state across ticks, which keeps the tick allocation-free.
 *
 * @param slideTimerAtBar the remaining slide time when the bar reached the player.
 * @returns lead-in seconds, or -1 if no slide was active and the bar was not
 *          actually cleared by sliding.
 */
export function slideLeadInSeconds(slideTimerAtBar: number): number {
  if (slideTimerAtBar <= 0) {
    return -1;
  }
  return SLIDE_DURATION - slideTimerAtBar;
}

/** True when the slide was committed late enough to count as perfect. */
export function isPerfectSlide(leadInSeconds: number): boolean {
  return leadInSeconds >= 0 && leadInSeconds <= PERFECT_SLIDE_MARGIN;
}

/** Awards a perfect slide. */
export function awardPerfectSlide(state: SimState, events: EventRing): number {
  return addFlow(state, FLOW_PER_PERFECT_SLIDE, FlowSource.PerfectSlide, events);
}

// ─────────────────────────────────────────────────────────────────────────────
// Forced roll
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the cell the player rolled off was blocked by something no other
 * verb could have beaten — i.e. the roll was the only answer.
 *
 * "Forced" is checked, not assumed. A player who rolls for fun on empty track
 * earns nothing; the award exists to pay for reading a Full-Face Wall or a Shear
 * Ring correctly under pressure. The test is: on the face just left, in the lane
 * just left, is there an obstacle that blocks **all three** vertical states
 * (so neither jump nor slide would have worked) and spans **every lane**
 * (so no lane change would have worked either)?
 *
 * The z window is the distance the world travelled during the roll, because by
 * the time the roll completes the wall is behind the player.
 */
export function wasForcedRoll(state: SimState, previousFace: number, previousLane: number): number {
  const obstacles = state.obstacles;
  if (obstacles.count === 0) {
    return -1;
  }

  const worldSpeed = state.f[F.worldSpeed] ?? 0;
  const behind = -(worldSpeed * ROLL_DURATION);

  for (let i = 0; i < obstacles.count; i += 1) {
    if (obstacles.active[i] !== 1) {
      continue;
    }
    const kind = obstacles.kind[i] ?? 0;
    const def = entityDef(kind);
    if (def.pickup || !def.fatal) {
      continue;
    }

    // Must have been on the face the player abandoned, unless it wraps all four.
    if (!def.allFaces && obstacles.face[i] !== previousFace) {
      continue;
    }

    const z = obstacles.z[i] ?? 0;
    if (z < behind || z > 0) {
      continue;
    }

    // A lane change would have beaten anything that does not span the face.
    if (def.laneSpan < LANE_COUNT) {
      continue;
    }

    // A jump or a slide would have beaten anything that leaves a vertical open.
    const blocksAll =
      blocksVertical(kind, Vertical.Standing) &&
      blocksVertical(kind, Vertical.Sliding) &&
      blocksVertical(kind, Vertical.Airborne);
    if (!blocksAll) {
      continue;
    }

    // The lane the player left has to be one this entity actually occupied.
    // Checked at both ends: the earlier one-sided `previousLane < lane` test let
    // an entity spanning lanes 1..3 count as having blocked lane 0.
    const lane = obstacles.lane[i] ?? 0;
    if (previousLane < lane || previousLane >= lane + def.laneSpan) {
      continue;
    }

    return i;
  }

  return -1;
}

/** Awards a forced roll. */
export function awardForcedRoll(state: SimState, events: EventRing): number {
  return addFlow(state, FLOW_PER_FORCED_ROLL, FlowSource.ForcedRoll, events);
}

/**
 * Recovers the (face, lane) the player occupied before a roll in `direction`.
 *
 * `rollLane` mirrors in both directions, so it is its own inverse; `rollFace`
 * steps around the prism, so the inverse is a step the other way.
 */
export function preRollCell(
  face: number,
  lane: number,
  direction: number,
  out: { face: number; lane: number },
): void {
  out.face = rollFace(face, -direction);
  out.lane = rollLane(lane, direction);
}

/** Exported so tests can assert the mirror without reaching into facing.ts. */
export const MAX_LANE_INDEX = MAX_LANE;

// ─────────────────────────────────────────────────────────────────────────────
// Pickup gains
// ─────────────────────────────────────────────────────────────────────────────

/** Flow from an Overdrive Cell. */
export function awardOverdriveCell(state: SimState, events: EventRing): number {
  return addFlow(state, FLOW_PER_OVERDRIVE_CELL, FlowSource.OverdriveCell, events);
}

/** Flow from a Shard. The Shard itself is banked by the pickup handler. */
export function awardShard(state: SimState, events: EventRing): number {
  return addFlow(state, FLOW_PER_SHARD, FlowSource.Shard, events);
}
