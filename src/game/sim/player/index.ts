/**
 * The player controller.
 *
 * Deterministic, hand-rolled, no physics engine — docs/ARCHITECTURE.md law (e).
 * Every shipped endless runner writes its own character controller, because a
 * rigid-body player is floaty, non-deterministic and unreplayable.
 *
 * ## Order within the step, and why it matters
 *
 *   1. terminal check     crashed/fracturing players do not move
 *   2. edge detection     press/release edges from held intent
 *   3. roll               concurrent axis, aged first so the commit lock is
 *                         correct for this tick's lateral input
 *   4. lateral            lane input, subject to the commit lock
 *   5. vertical           gravity, landing
 *   6. slide              timers, stand-up
 *   7. stumble            recovery
 *   8. buffered verbs     fire anything now legal
 *   9. age forgiveness    coyote and buffer windows
 *
 * Roll before lateral is load-bearing: the commit lock has to be evaluated
 * against this tick's roll state, or a lateral input on the exact tick a roll
 * starts would slip through.
 *
 * Forgiveness is aged LAST so a window opened this tick gets its full stated
 * duration rather than losing its first tick to the same step that created it.
 */

import { TUNING } from "@/game/config/tuning";
import { emit, SimEvent, type EventRing } from "@/game/sim/events";
import type { Intent } from "@/game/sim/intent";
import { F, Phase, RunStatus, Verb, type SimState } from "@/game/sim/state";
import { applyRoll, clampLane, createFaceLane, laneCentreX, RollDirection } from "./facing";
import {
  ageForgiveness,
  beginCoyote,
  bufferVerb,
  clearBuffer,
  clearCoyote,
  consumeBuffer,
  coyoteActive,
  peekBuffer,
} from "./forgiveness";
import {
  canStartRoll,
  cutJump,
  fastDrop,
  fellOutOfWorld,
  launchJump,
  mirrorLaneTween,
  rollCommitted,
  slideActive,
  slideRecovering,
  startLaneTween,
  startRoll,
  startSlide,
  stepLaneTween,
  stepRoll,
  stepSlide,
  stepVertical,
} from "./locomotion";
import { Edge, isGroundedPhase, isTerminalPhase, tryTransition } from "./phase";
import { tickDown } from "./timer";

const STUMBLE_RECOVERY = TUNING.collision.stumbleRecovery;
const STUMBLE_INVULNERABILITY = TUNING.collision.stumbleInvulnerability;

/** Reused across ticks so the roll transform allocates nothing. */
const scratchFaceLane = createFaceLane();

/**
 * Advances the player by one fixed tick.
 *
 * `intent.jump` and `intent.slide` are **held** states, not press events — the
 * controller derives the edges itself from `player.jumpHeld` / `player.slideHeld`.
 * That is what makes variable jump height possible: the release edge is what
 * cuts the arc short. It is also why the replay format version went to 2.
 */
export function stepPlayer(state: SimState, intent: Intent, dt: number, events: EventRing): void {
  const player = state.player;

  if (isTerminalPhase(player.phase)) {
    player.jumpHeld = intent.jump ? 1 : 0;
    player.slideHeld = intent.slide ? 1 : 0;
    return;
  }

  // 2. edges
  const jumpPressed = intent.jump && player.jumpHeld === 0;
  const jumpReleased = !intent.jump && player.jumpHeld === 1;
  const slidePressed = intent.slide && player.slideHeld === 0;

  // 3. roll — concurrent, aged before lateral so the commit lock is current.
  if (stepRoll(state, dt)) {
    completeRoll(state, events);
  }
  if (intent.roll !== RollDirection.None && canStartRoll(state)) {
    startRoll(state, intent.roll);
    player.verb = intent.roll < 0 ? Verb.RollLeft : Verb.RollRight;
    if (player.phase === Phase.Running) {
      player.phase = tryTransition(player.phase, Edge.RollStart);
    }
    emit(events, SimEvent.RollStart, state.tick, intent.roll, player.face);
  }

  // 4. lateral — dropped, not buffered, while the roll is committed.
  if (intent.lateral !== 0 && !rollCommitted(state)) {
    tryLaneChange(state, intent.lateral, events);
  }
  stepLaneTween(state, dt);

  // 5. vertical
  if (jumpPressed) {
    requestJump(state, events);
  }
  if (jumpReleased) {
    cutJump(state);
  }
  if (slidePressed) {
    requestSlide(state, events);
  }

  // Lost ground support without jumping — walked off a Void Gap edge. This is
  // the ONLY place coyote time is armed, and the only user of Edge.LeaveGround.
  // The support check itself belongs to the gap geometry, which arrives at P07;
  // until then anything that clears `grounded` routes through here.
  if (player.grounded === 0 && isGroundedPhase(player.phase)) {
    leaveGround(state, events);
  }

  const wasAirborne = player.grounded === 0;
  if (wasAirborne) {
    const landed = stepVertical(state, dt);
    if (landed) {
      handleLanding(state, events);
    } else if (fellOutOfWorld(state)) {
      // Checked before Apex: falling out of the world outranks reaching apex,
      // and Apex is only legal from JUMPING anyway.
      if (player.phase === Phase.Jumping) {
        player.phase = tryTransition(player.phase, Edge.Apex);
      }
      player.phase = tryTransition(player.phase, Edge.FellOutOfWorld);
      endRun(state, events, CrashCause.FellOutOfWorld);
    } else if (player.phase === Phase.Jumping && (state.f[F.playerVy] ?? 0) <= 0) {
      player.phase = tryTransition(player.phase, Edge.Apex);
    }
  }

  // 6. slide
  if (stepSlide(state, dt) && player.phase === Phase.Sliding) {
    player.phase = tryTransition(player.phase, Edge.SlideEnd);
    player.verb = Verb.None;
    emit(events, SimEvent.SlideEnd, state.tick);
  }

  // 7. stumble
  if (player.phase === Phase.Stumbling) {
    const timer = tickDown(state.f[F.playerStumbleTimer] ?? 0, dt);
    state.f[F.playerStumbleTimer] = timer;
    if (timer <= 0) {
      player.phase = tryTransition(player.phase, Edge.StumbleRecovered);
      emit(events, SimEvent.StumbleEnd, state.tick);
    }
  }

  // 8. buffered verbs that have become legal
  drainBuffer(state, events);

  // 9. forgiveness windows
  ageForgiveness(state, dt);

  state.f[F.playerInvulnerableTimer] = tickDown(state.f[F.playerInvulnerableTimer] ?? 0, dt);

  player.jumpHeld = intent.jump ? 1 : 0;
  player.slideHeld = intent.slide ? 1 : 0;
}

/** Why a run ended. Payload 0 of `SimEvent.Crash`. GAME_BIBLE §12. */
export const CrashCause = {
  Obstacle: 0,
  Hazard: 1,
  FellOutOfWorld: 2,
  RolledIntoGeometry: 3,
} as const;

/** Applies the face/lane transform when a roll finishes. */
function completeRoll(state: SimState, events: EventRing): void {
  const player = state.player;
  applyRoll(player.face, player.lane, player.rollDirection, scratchFaceLane);

  // The tween target mirrors too, so a lane change in flight survives the roll.
  const mirroredTarget = clampLane(TUNING.geometry.laneCount - 1 - player.targetLane);
  mirrorLaneTween(state);

  player.face = scratchFaceLane.face;
  player.lane = scratchFaceLane.lane;
  player.targetLane = mirroredTarget;
  player.rollDirection = RollDirection.None;

  if (player.lane === player.targetLane) {
    state.f[F.playerX] = laneCentreX(player.lane);
  }

  if (player.phase === Phase.Rolling) {
    player.phase = tryTransition(player.phase, Edge.RollEnd);
  }
  emit(events, SimEvent.RollEnd, state.tick, player.face, player.lane);
}

/** Attempts a lane change in `direction`. A wall is a no-op, not an error. */
function tryLaneChange(state: SimState, direction: number, events: EventRing): void {
  const player = state.player;
  const desired = clampLane(player.targetLane + direction);
  if (desired === player.targetLane) {
    return;
  }
  startLaneTween(state, desired);
  player.verb = direction < 0 ? Verb.LaneLeft : Verb.LaneRight;
  emit(events, SimEvent.LaneChange, state.tick, direction, desired);
}

/** Jumps if legal, buffers the intent if not. */
function requestJump(state: SimState, events: EventRing): void {
  const player = state.player;

  // A slide cannot be cancelled, and the stand-up tail keeps jump illegal a
  // little longer — docs/TUNING.md §5.
  if (slideActive(state) || slideRecovering(state)) {
    bufferVerb(state, Verb.Jump);
    return;
  }

  const grounded = player.grounded === 1;
  const coyote = coyoteActive(state);
  if (!grounded && !coyote) {
    bufferVerb(state, Verb.Jump);
    return;
  }

  // FALLING is legal ONLY inside the coyote window — that is the whole point of
  // coyote time, and gating it any other way makes the window unreachable.
  // Anything else is a double jump, which this game does not have.
  const legalPhase =
    player.phase === Phase.Running ||
    player.phase === Phase.Rolling ||
    (player.phase === Phase.Falling && coyote);
  if (!legalPhase) {
    bufferVerb(state, Verb.Jump);
    return;
  }

  player.phase = tryTransition(player.phase, Edge.JumpStart);
  player.verb = Verb.Jump;
  launchJump(state);
  clearCoyote(state);
  emit(events, SimEvent.Jump, state.tick);
}

/** Slides if grounded; dives if airborne. */
function requestSlide(state: SimState, events: EventRing): void {
  const player = state.player;

  if (player.grounded === 0) {
    // The undocumented fast-drop. Buffer the slide so it fires on landing.
    fastDrop(state);
    bufferVerb(state, Verb.Slide);
    return;
  }

  if (player.phase !== Phase.Running && player.phase !== Phase.Rolling) {
    bufferVerb(state, Verb.Slide);
    return;
  }

  player.phase = tryTransition(player.phase, Edge.SlideStart);
  player.verb = Verb.Slide;
  startSlide(state);
  emit(events, SimEvent.SlideStart, state.tick);
}

/** Resolves the landing tick, honouring a buffered slide. */
function handleLanding(state: SimState, events: EventRing): void {
  const player = state.player;
  const buffered = peekBuffer(state);

  if (buffered === Verb.Slide) {
    clearBuffer(state);
    player.phase = tryTransition(player.phase, Edge.LandIntoSlide);
    player.verb = Verb.Slide;
    startSlide(state);
    emit(events, SimEvent.SlideStart, state.tick);
  } else if (player.phase === Phase.Jumping || player.phase === Phase.Falling) {
    player.phase = tryTransition(player.phase, Edge.Land);
    player.verb = Verb.None;
  }

  emit(events, SimEvent.Land, state.tick, state.f[F.playerVy] ?? 0);
  clearCoyote(state);
}

/** Fires a buffered verb the moment it becomes legal. */
function drainBuffer(state: SimState, events: EventRing): void {
  const buffered = peekBuffer(state);
  if (buffered === Verb.None) {
    return;
  }

  const player = state.player;
  const idle = player.phase === Phase.Running || player.phase === Phase.Rolling;
  if (!idle || player.grounded === 0) {
    return;
  }

  if (buffered === Verb.Jump) {
    if (slideActive(state) || slideRecovering(state)) {
      return;
    }
    consumeBuffer(state);
    player.phase = tryTransition(player.phase, Edge.JumpStart);
    player.verb = Verb.Jump;
    launchJump(state);
    clearCoyote(state);
    emit(events, SimEvent.Jump, state.tick);
    return;
  }

  if (buffered === Verb.Slide) {
    consumeBuffer(state);
    player.phase = tryTransition(player.phase, Edge.SlideStart);
    player.verb = Verb.Slide;
    startSlide(state);
    emit(events, SimEvent.SlideStart, state.tick);
  }
}

/** Puts the player into a stumble. Called by collision. */
export function applyStumble(state: SimState, events: EventRing): void {
  const player = state.player;
  if (player.phase === Phase.Stumbling) {
    return;
  }
  player.phase = tryTransition(player.phase, Edge.StumbleHit);
  if (player.phase !== Phase.Stumbling) {
    return;
  }
  state.f[F.playerStumbleTimer] = STUMBLE_RECOVERY;
  state.f[F.playerInvulnerableTimer] = STUMBLE_INVULNERABILITY;
  player.stumbleCount += 1;
  emit(events, SimEvent.Stumble, state.tick, player.stumbleCount);
}

/**
 * Loses ground support without jumping.
 *
 * Arms the coyote window and drops to FALLING. Exported so the Void Gap logic
 * in P07 can call it directly when the floor under the player disappears.
 */
export function leaveGround(state: SimState, events: EventRing): void {
  const player = state.player;
  beginCoyote(state);
  player.phase = tryTransition(player.phase, Edge.LeaveGround);
  emit(events, SimEvent.Jump, state.tick, LEAVE_GROUND_MARKER);
}

/** payload0 on a Jump event, distinguishing a ledge drop from a real jump. */
export const LEAVE_GROUND_MARKER = -1;

/**
 * Ends the run.
 *
 * Without this the world keeps scrolling and `distance` keeps accumulating
 * after death, so a crashed player would go on scoring forever. `sim.tick`
 * short-circuits on `RunStatus.Ended`.
 *
 * P09 replaces the unconditional end with a Fracture window: it will set
 * `RunStatus.Fracturing` instead when a Shard is held and the death had exactly
 * one clearing verb.
 */
function endRun(state: SimState, events: EventRing, cause: number): void {
  state.player.verb = Verb.None;
  emit(events, SimEvent.Crash, state.tick, cause);
  state.runStatus = RunStatus.Ended;
  emit(events, SimEvent.RunEnd, state.tick, cause);
}

/** Kills the player. Called by collision. */
export function applyFatal(state: SimState, events: EventRing, cause: number): void {
  const player = state.player;
  player.phase = tryTransition(player.phase, Edge.FatalHit);
  endRun(state, events, cause);
}

export {
  Edge,
  IllegalTransitionError,
  TRANSITIONS,
  canTransition,
  destinationOf,
  isGroundedPhase,
  isPhaseDevMode,
  isTerminalPhase,
  phaseName,
  setPhaseDevMode,
  tryTransition,
} from "./phase";

export {
  RollDirection,
  applyRoll,
  clampLane,
  createFaceLane,
  isValidFace,
  isValidLane,
  laneCentreX,
  mirrorLateral,
  rollFace,
  rollLane,
  type FaceLane,
} from "./facing";

export {
  createAabb,
  colliderHalfDepth,
  colliderHalfHeight,
  colliderHalfWidth,
  obstacleAabb,
  overlaps,
  penetrationX,
  penetrationY,
  penetrationZ,
  playerAabb,
  separation,
  type Aabb,
} from "./collider";

export {
  FLOOR_Y,
  ROLL_ANGLE,
  easeInOutCubic,
  easeOutCubic,
  rollActive,
  rollCommitted,
  saturate,
  slideActive,
  slideRecovering,
} from "./locomotion";

export { coyoteActive, peekBuffer } from "./forgiveness";
export { TIMER_EPSILON, tickDown, timerActive } from "./timer";
