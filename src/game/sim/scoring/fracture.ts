/**
 * Fracture — the revive, as a skill test rather than a purchase.
 *
 * GAME_BIBLE §5. On a fatal hit, if the player holds enough Shards and the death
 * had **exactly one** answer, the world freezes to a crawl, the killing obstacle
 * hangs in the air, and a `fractureWindow` 1.2s window of REAL time opens. The
 * correct verb resumes the run at half Flow. Anything else ends it.
 *
 * ```
 *   t = 0.000   Fatal contact. worldSpeed -> near zero. Obstacle shatters, hangs.
 *   t = 0.000   Time resumes at fractureTimeScale 0.15. Input window opens.
 *   t <= 1.200  A verb is input.  CORRECT -> resume.  WRONG or TIMEOUT -> over.
 * ```
 *
 * ## Real time vs sim time
 *
 * `fractureWindow` is 1.2s of **real** time (TUNING §9.3 is explicit) while the
 * world moves at 0.15x, so the player perceives roughly eight seconds of motion.
 * The sim has only one clock, so the window counts down by `fixedDelta` per tick
 * — exactly 72 ticks at 60Hz — and the *world* is what gets scaled, via
 * `fractureTimeScale()` which `difficulty.ts` multiplies into `worldSpeed`. One
 * speed path, no special-cased stop, and the countdown stays deterministic.
 *
 * ## How the correct verb is found, and how that differs from §5.2
 *
 * GAME_BIBLE §5.2 specifies replaying the last `fractureLookback` 0.40s of state
 * against each of the six verbs. **This implementation does not do that**, and
 * the difference is worth being honest about.
 *
 * A 0.40s lookback needs a ring of 24 full `SimState` snapshots kept live at all
 * times against the chance of a death — two of those already cost every tick's
 * `copyState`, and 24 more is a real budget item for a feature that fires once a
 * run. Instead this asks the question directly: *for each of the six verbs, would
 * the cell that verb reaches have been clear of the obstacle that killed me?*
 * The answer comes from the same logical blocking model the P06 solver uses
 * (`level/entities.ts`), so it is exact and deterministic rather than heuristic —
 * which is the property §5.2 actually cares about.
 *
 * Where it is weaker: it does not know whether the player had *time* to input the
 * verb 0.4s ago, so it can nominate a verb that was technically clearing but
 * practically unreachable. Revisit when the snapshot ring exists.
 *
 * ## The arming rules, which are the interesting part
 *
 *   - **Exactly one** clearing verb -> arm. Fracture therefore *teaches*: it only
 *     ever fires on deaths that had a single answer.
 *   - **Two or more** -> do NOT arm. The death was avoidable several ways and the
 *     player simply misplayed. Run over.
 *   - **Zero** -> an unwinnable spawn, which is a generator bug, not a player
 *     mistake. Ship behaviour is to arm anyway and accept any verb, and emit
 *     `GeneratorUnwinnable` so it can be found. The P06 fuzz exists to keep this
 *     from ever firing.
 */

import { TUNING } from "@/game/config/tuning";
import { emit, SimEvent, type EventRing } from "@/game/sim/events";
import { blocksVertical, entityDef, Vertical } from "@/game/sim/level/entities";
import { breakBitStreak, restoreFractureFlow, zeroFlow } from "./flow";
import { breakCombo } from "./score";
import { rollFace, rollLane } from "@/game/sim/player/facing";
import { tickDown } from "@/game/sim/player/timer";
import { Edge, tryTransition } from "@/game/sim/player/phase";
import type { Intent } from "@/game/sim/intent";
import { F, RunStatus, Verb, type SimState } from "@/game/sim/state";

const FRACTURE_WINDOW = TUNING.fracture.fractureWindow;
const FRACTURE_TIME_SCALE = TUNING.fracture.fractureTimeScale;
const FRACTURE_INVULNERABILITY = TUNING.fracture.fractureInvulnerability;
const MAX_FRACTURES = TUNING.fracture.maxFracturesPerRun;
const SHARD_COST = TUNING.fracture.fractureShardCost;
const LANE_COUNT = TUNING.geometry.laneCount;
const MAX_LANE = LANE_COUNT - 1;

/** The six movement verbs, in the order the solver considers them. */
const ESCAPE_VERBS: readonly number[] = [
  Verb.LaneLeft,
  Verb.LaneRight,
  Verb.Jump,
  Verb.Slide,
  Verb.RollLeft,
  Verb.RollRight,
];

/** Sentinel for "every verb is accepted" — an unwinnable spawn. GAME_BIBLE §5.2. */
export const ANY_VERB = -1;

/** True while a Fracture window is open. */
export function fracturing(state: SimState): boolean {
  return state.runStatus === RunStatus.Fracturing;
}

/** Real seconds left in the window. */
export function fractureRemaining(state: SimState): number {
  return state.f[F.fractureTimer] ?? 0;
}

/**
 * World-time scale for this tick.
 *
 * 1.0 normally, `fractureTimeScale` while a window is open. `difficulty.ts`
 * multiplies `worldSpeed` by this, which is what freezes the world without
 * introducing a second code path for "stopped".
 */
export function fractureTimeScale(state: SimState): number {
  return fracturing(state) ? FRACTURE_TIME_SCALE : 1;
}

/** Shards required for the next Fracture of this run. */
export function shardCostFor(fracturesUsed: number): number {
  return SHARD_COST[fracturesUsed] ?? SHARD_COST[SHARD_COST.length - 1] ?? 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The escape-verb solver
// ─────────────────────────────────────────────────────────────────────────────

/** Where a verb puts the player, and in what vertical state. */
interface Landing {
  face: number;
  lane: number;
  vertical: number;
  legal: boolean;
}

/** Reused, so the solver allocates nothing on the death tick. */
const landing: Landing = { face: 0, lane: 0, vertical: 0, legal: false };

/**
 * Resolves where one verb would have put the player.
 *
 * A lane change into a wall is illegal rather than a no-op that happens to
 * "clear" by staying put — treating it as clearing would nominate a verb that
 * does nothing, and the player would input it and die anyway.
 */
function resolveVerb(face: number, lane: number, verb: number, out: Landing): void {
  out.face = face;
  out.lane = lane;
  out.vertical = Vertical.Standing;
  out.legal = true;

  switch (verb) {
    case Verb.LaneLeft:
      out.lane = lane - 1;
      out.legal = out.lane >= 0;
      return;
    case Verb.LaneRight:
      out.lane = lane + 1;
      out.legal = out.lane <= MAX_LANE;
      return;
    case Verb.Jump:
      out.vertical = Vertical.Airborne;
      return;
    case Verb.Slide:
      out.vertical = Vertical.Sliding;
      return;
    case Verb.RollLeft:
      out.face = rollFace(face, -1);
      out.lane = rollLane(lane, -1);
      return;
    case Verb.RollRight:
      out.face = rollFace(face, 1);
      out.lane = rollLane(lane, 1);
      return;
    default:
      out.legal = false;
  }
}

/** True when the obstacle at `index` occupies the cell a verb would have reached. */
function obstacleCovers(
  state: SimState,
  index: number,
  face: number,
  lane: number,
  vertical: number,
): boolean {
  const obstacles = state.obstacles;
  const kind = obstacles.kind[index] ?? 0;
  const def = entityDef(kind);

  if (!def.allFaces && (obstacles.face[index] ?? 0) !== face) {
    return false;
  }

  const baseLane = obstacles.lane[index] ?? 0;
  if (lane < baseLane || lane >= baseLane + def.laneSpan) {
    return false;
  }

  return blocksVertical(kind, vertical);
}

/**
 * u — how far ahead of the killing obstacle a second one still counts as being
 * "in the way" of an escape verb.
 *
 * A roll takes `rollDuration` and a jump the better part of a second, so a verb
 * that clears the killer only to land inside something 3u further on has not
 * cleared anything. Scoped rather than unbounded so an obstacle half a chunk
 * away does not veto a perfectly good escape.
 */
const ESCAPE_LOOKAHEAD_U = 4.0;

/**
 * True when ANY live obstacle blocks the cell a verb would have reached.
 *
 * Consulting only the killer — which is what this did until the P08 audit — gets
 * the arming decision wrong in both directions. A verb can be nominated as "the
 * single answer" while flying into a second obstacle, and a death with two
 * answers against the killer can have zero real ones once the neighbours are
 * counted, so Fracture declines to arm on a death that genuinely had no escape.
 */
function cellBlocked(state: SimState, face: number, lane: number, vertical: number): boolean {
  const obstacles = state.obstacles;
  for (let i = 0; i < obstacles.count; i += 1) {
    if (obstacles.active[i] !== 1) {
      continue;
    }
    const z = obstacles.z[i] ?? 0;
    if (z < -ESCAPE_LOOKAHEAD_U || z > ESCAPE_LOOKAHEAD_U) {
      continue;
    }
    if (obstacleCovers(state, i, face, lane, vertical)) {
      return true;
    }
  }
  return false;
}

export interface EscapeSolution {
  /** The single clearing verb, `Verb.None` if there were several, or `ANY_VERB`
   *  if there were none and the spawn is unwinnable. */
  verb: number;
  /** How many of the six verbs would have cleared it. */
  count: number;
}

const solution: EscapeSolution = { verb: Verb.None, count: 0 };

/**
 * Finds the verb that would have cleared the death.
 *
 * Tests each verb's destination cell against **every** nearby obstacle, not only
 * the one that landed the hit — see `cellBlocked`.
 *
 * @param obstacleIndex the obstacle that landed the fatal hit. Always counted,
 *        even if it has drifted outside the lookahead window.
 * @returns a reused object — read it before the next call.
 */
export function solveEscapeVerb(state: SimState, obstacleIndex: number): EscapeSolution {
  const player = state.player;
  let found: number = Verb.None;
  let count = 0;

  for (const verb of ESCAPE_VERBS) {
    resolveVerb(player.face, player.lane, verb, landing);
    if (!landing.legal) {
      continue;
    }
    if (obstacleCovers(state, obstacleIndex, landing.face, landing.lane, landing.vertical)) {
      continue;
    }
    if (cellBlocked(state, landing.face, landing.lane, landing.vertical)) {
      continue;
    }
    count += 1;
    if (count === 1) {
      found = verb;
    }
  }

  solution.count = count;
  solution.verb = count === 1 ? found : count === 0 ? ANY_VERB : Verb.None;
  return solution;
}

// ─────────────────────────────────────────────────────────────────────────────
// The window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to open a Fracture window in place of ending the run.
 *
 * Called from `applyFatal` in the player controller, which is the single place a
 * run can die of contact.
 *
 * @returns true if a window opened, in which case the caller must NOT end the run.
 */
export function tryArmFracture(state: SimState, obstacleIndex: number, events: EventRing): boolean {
  if (state.fracturesUsed >= MAX_FRACTURES) {
    return false;
  }

  const cost = shardCostFor(state.fracturesUsed);
  if (state.player.shards < cost) {
    return false;
  }

  // No obstacle to reason about — a fall out of the world, say. There is no
  // single clearing verb for "you left the tunnel", so Fracture does not apply.
  if (obstacleIndex < 0) {
    return false;
  }

  const solved = solveEscapeVerb(state, obstacleIndex);

  if (solved.count === 0) {
    // Unwinnable spawn: a generator bug, not a player mistake. Arm anyway and
    // accept anything, and make the bug findable.
    emit(
      events,
      SimEvent.GeneratorUnwinnable,
      state.tick,
      state.obstacles.kind[obstacleIndex] ?? 0,
      state.player.face,
      state.player.lane,
    );
  } else if (solved.count > 1) {
    // Several answers existed. The player misplayed rather than being trapped,
    // so Fracture stays out of it — this is the rule that makes it teach.
    return false;
  }

  state.player.shards -= cost;
  state.fracturesUsed += 1;
  state.fractureVerb = solved.verb;

  state.f[F.flowAtDeath] = state.f[F.flow] ?? 0;
  state.f[F.fractureTimer] = FRACTURE_WINDOW;
  state.runStatus = RunStatus.Fracturing;

  emit(events, SimEvent.FractureArm, state.tick, solved.verb, cost, state.f[F.flowAtDeath]);
  return true;
}

/** Maps this tick's intent onto the verb it represents, or `Verb.None`. */
export function intentToVerb(intent: Readonly<Intent>): number {
  if (intent.roll < 0) {
    return Verb.RollLeft;
  }
  if (intent.roll > 0) {
    return Verb.RollRight;
  }
  if (intent.jump) {
    return Verb.Jump;
  }
  if (intent.slide) {
    return Verb.Slide;
  }
  if (intent.lateral < 0) {
    return Verb.LaneLeft;
  }
  if (intent.lateral > 0) {
    return Verb.LaneRight;
  }
  return Verb.None;
}

/**
 * Advances an open Fracture window by one tick.
 *
 * Resolution order matters: a verb input on the final tick resolves as an input,
 * not as a timeout. The player pressed it inside the window.
 *
 * ## The arming tick does not accept input
 *
 * Collision arms the Fracture at step 5 of the tick and this pass runs at step 6
 * of the *same* tick, so without a guard the window would be resolved by whatever
 * the player happened to be holding at the instant they died. Since `jump` and
 * `slide` are held states and players hold jump more or less permanently, that
 * meant almost every Fracture resolved on tick zero — spending a Shard and ending
 * the run before the HUD had drawn a single frame of the window.
 *
 * The guard is the timer's own value: it is exactly `fractureWindow` only on the
 * tick it was armed, because this function decrements it on every subsequent one.
 * That costs no extra state and cannot drift out of sync with the arming code.
 */
export function stepFracture(
  state: SimState,
  intent: Readonly<Intent>,
  dt: number,
  events: EventRing,
): void {
  if (!fracturing(state)) {
    return;
  }

  const justArmed = (state.f[F.fractureTimer] ?? 0) >= FRACTURE_WINDOW;
  const verb = justArmed ? Verb.None : intentToVerb(intent);
  if (verb !== Verb.None) {
    const correct = state.fractureVerb === ANY_VERB || verb === state.fractureVerb;
    if (correct) {
      resumeFromFracture(state, verb, events);
    } else {
      failFracture(state, events);
    }
    return;
  }

  // `tickDown` rather than raw subtraction — see the note in overdrive.ts. A
  // 1.2s window is 72 ticks; naive subtraction leaves a residue and gives 73,
  // which is a 1.4% overrun on a LOCKED number.
  const remaining = tickDown(state.f[F.fractureTimer] ?? 0, dt);
  if (remaining <= 0) {
    state.f[F.fractureTimer] = 0;
    failFracture(state, events);
    return;
  }

  state.f[F.fractureTimer] = remaining;
  emit(
    events,
    SimEvent.FractureTick,
    state.tick,
    remaining,
    remaining / FRACTURE_WINDOW,
    state.fractureVerb,
  );
}

/**
 * Resumes the run.
 *
 * The player is placed in the cell the correct verb would have reached
 * (GAME_BIBLE §5.3), which is the whole reason the solver returns a landing
 * rather than just a boolean: resuming in the cell that killed you would be
 * theft of a Shard.
 */
function resumeFromFracture(state: SimState, verb: number, events: EventRing): void {
  const player = state.player;

  resolveVerb(player.face, player.lane, verb, landing);
  if (landing.legal) {
    player.face = landing.face;
    player.lane = landing.lane;
    player.targetLane = landing.lane;
  }

  // GAME_BIBLE §5.3: Flow resumes at 50% of its value at death. Without this the
  // player kept the full meter through a crash, which would make Fracture
  // strictly better than not dying.
  restoreFractureFlow(state);

  // Through the table, not by assignment. `FRACTURING --FractureSuccess--> RUNNING`
  // is a declared edge, and routing around it would skip the dev-mode guard that
  // exists to catch exactly this kind of shortcut.
  player.phase = tryTransition(player.phase, Edge.FractureSuccess);
  player.verb = Verb.None;
  state.runStatus = RunStatus.Running;
  state.fractureVerb = Verb.None;
  state.f[F.fractureTimer] = 0;
  state.f[F.playerInvulnerableTimer] = FRACTURE_INVULNERABILITY;

  emit(events, SimEvent.FractureResolve, state.tick, 1, verb);
}

/**
 * Ends the run after a wrong verb or a timeout.
 *
 * Zeroes Flow here rather than relying on `applyFatal`. Arming a Fracture
 * deliberately skips the zeroing so `flowAtDeath` can be restored on a success —
 * which meant that until the P08 audit, a *failed* Fracture ended the run with
 * the meter still full, contradicting GAME_BIBLE §4.1's "a crash zeroes Flow".
 * Nothing gameplay-facing reads Flow after the run ends, but the death screen
 * does (P14), and an inconsistency here is one nobody would think to look for.
 */
function failFracture(state: SimState, events: EventRing): void {
  state.player.phase = tryTransition(state.player.phase, Edge.FractureFail);
  state.fractureVerb = Verb.None;
  state.f[F.fractureTimer] = 0;
  state.runStatus = RunStatus.Ended;

  zeroFlow(state);
  breakBitStreak(state);
  breakCombo(state);

  emit(events, SimEvent.FractureResolve, state.tick, 0);
  emit(events, SimEvent.RunEnd, state.tick);
}
