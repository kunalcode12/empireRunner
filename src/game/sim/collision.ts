/**
 * Collision — swept AABB, hand-rolled and deterministic.
 *
 * docs/ARCHITECTURE.md law (e): the player controller and all gameplay collision
 * are hand-rolled. Rapier is cosmetic-only and never touches anything the sim
 * reads. If a Rapier body position is ever read back into this file, determinism
 * is dead and so is the leaderboard.
 *
 * ## Why swept and not discrete
 *
 * At `maxSpeed` 34 u/s the world advances **0.567u per tick**. A Bit is ~0.3u
 * across and a thin obstacle can be 0.2u deep. A discrete overlap test sampled
 * once per tick steps straight over anything thinner than the per-tick motion —
 * the player passes through a wall untouched. This is not a rare edge case; at
 * band-5 speeds it is the common case for thin geometry.
 *
 * So every test here sweeps the player's box against the obstacle's box along
 * the tick's relative motion and solves for the earliest time of impact.
 *
 * ## The classification
 *
 * ```
 *   FATAL    ends the run (or consumes a shield)
 *   STUMBLE  non-fatal: speed penalty plus a recovery window
 *   PASS     no interaction
 * ```
 *
 * The kind -> class table below is a placeholder that **P07 replaces** with the
 * real catalogue in `config/entities.ts`. Nothing spawns obstacles yet — the
 * generator is a P06 stub — so in P02/P04 this runs against an empty array and
 * the tests construct obstacles by hand.
 */

import { TUNING } from "../config/tuning";
import { emit, SimEvent, type EventRing } from "./events";
import {
  createAabb,
  obstacleAabb,
  penetrationX,
  penetrationY,
  penetrationZ,
  playerAabb,
  separation,
  type Aabb,
} from "./player/collider";
import { applyFatal, applyStumble, CrashCause } from "./player";
import { F, type SimState } from "./state";

const NEAR_MISS_RADIUS = TUNING.flow.nearMissRadius;
const CORNER_FORGIVENESS = TUNING.collision.cornerForgiveness;

/** How an obstacle responds to contact. */
export const ContactClass = {
  Pass: 0,
  Stumble: 1,
  Fatal: 2,
} as const;
export type ContactClassValue = (typeof ContactClass)[keyof typeof ContactClass];

/** Per-entity flag bits stored in `EntityColumns.flags`. */
export const EntityFlag = {
  /** A near-miss has already been awarded for this instance. Once, ever. */
  NearMissAwarded: 1 << 0,
  /** Already resolved a contact; do not resolve twice. */
  Resolved: 1 << 1,
  /** Shattered during Overdrive. */
  Shattered: 1 << 2,
} as const;

/**
 * Obstacle kind -> contact class.
 *
 * PLACEHOLDER. P07 replaces this with the real table in `config/entities.ts`,
 * keyed by the 12 obstacles and 4 hazards in GAME_BIBLE §7. Kept here rather
 * than guessed at in config so P07 has one obvious place to delete.
 */
export function classifyContact(kind: number): number {
  if (kind < 0) {
    return ContactClass.Pass;
  }
  // Until the catalogue exists, odd kinds stumble and even kinds kill. This is
  // a stand-in that lets the swept tests exercise both paths, NOT a design.
  return kind % 2 === 1 ? ContactClass.Stumble : ContactClass.Fatal;
}

/** Scratch boxes, reused every tick. Law (d): the tick allocates nothing. */
const playerBox: Aabb = createAabb();
const playerBoxEnd: Aabb = createAabb();
const obstacleBox: Aabb = createAabb();

/** Default obstacle half-extents until the P07 catalogue supplies real ones. */
const DEFAULT_OBSTACLE_HALF = 0.5;

/**
 * Swept overlap test along relative motion.
 *
 * Standard slab method: for each axis, solve the interval `[entry, exit]` during
 * which the two boxes overlap on that axis, then intersect the three intervals.
 * The boxes collide iff the intersection is non-empty within `[0, 1]`.
 *
 * @returns time of impact in `[0, 1]` as a fraction of the tick, or -1 for no hit.
 */
export function sweptOverlap(
  a: Aabb,
  b: Aabb,
  relativeDx: number,
  relativeDy: number,
  relativeDz: number,
): number {
  let entry = 0;
  let exit = 1;

  const axes = 3;
  for (let axis = 0; axis < axes; axis += 1) {
    let centreDelta: number;
    let extentSum: number;
    let motion: number;

    if (axis === 0) {
      centreDelta = b.cx - a.cx;
      extentSum = a.hx + b.hx;
      motion = relativeDx;
    } else if (axis === 1) {
      centreDelta = b.cy - a.cy;
      extentSum = a.hy + b.hy;
      motion = relativeDy;
    } else {
      centreDelta = b.cz - a.cz;
      extentSum = a.hz + b.hz;
      motion = relativeDz;
    }

    if (motion === 0) {
      // Parallel on this axis: either already overlapping, or never.
      if (Math.abs(centreDelta) >= extentSum) {
        return -1;
      }
      continue;
    }

    // Separation on this axis at time t is `centreDelta + motion * t`, and the
    // boxes overlap while its magnitude is under `extentSum`. Solving
    //     -extentSum < centreDelta + motion * t < extentSum
    // for t gives the two roots below. Note the sign on centreDelta: dividing by
    // a negative `motion` flips the inequality, which is why the roots are
    // ordered by comparison rather than assumed.
    const t0 = (-centreDelta - extentSum) / motion;
    const t1 = (-centreDelta + extentSum) / motion;
    const axisEntry = t0 < t1 ? t0 : t1;
    const axisExit = t0 < t1 ? t1 : t0;

    if (axisEntry > entry) {
      entry = axisEntry;
    }
    if (axisExit < exit) {
      exit = axisExit;
    }
    if (entry > exit) {
      return -1;
    }
  }

  return entry >= 0 && entry <= 1 ? entry : -1;
}

/**
 * Shallowest penetration depth between two overlapping boxes.
 *
 * Corner forgiveness keys off this: if the player is only barely inside an
 * obstacle's edge, nudging them out is fairer than killing them.
 */
function shallowestPenetration(a: Aabb, b: Aabb): number {
  const px = penetrationX(a, b);
  const py = penetrationY(a, b);
  const pz = penetrationZ(a, b);
  return Math.min(px, Math.min(py, pz));
}

/**
 * Pushes the player out along the axis of shallowest penetration.
 *
 * Only ever called for penetrations under `cornerForgiveness`, so the nudge is
 * sub-0.12u and invisible.
 */
function nudgeClear(state: SimState, a: Aabb, b: Aabb): void {
  const px = penetrationX(a, b);
  const py = penetrationY(a, b);
  const pz = penetrationZ(a, b);

  if (px <= py && px <= pz) {
    const direction = a.cx < b.cx ? -1 : 1;
    state.f[F.playerX] = (state.f[F.playerX] ?? 0) + direction * px;
    return;
  }
  if (py <= pz) {
    const direction = a.cy < b.cy ? -1 : 1;
    state.f[F.playerY] = (state.f[F.playerY] ?? 0) + direction * py;
  }
  // A shallow Z penetration needs no correction: the world scrolls past on its
  // own next tick, so nudging along Z would fight the treadmill.
}

/**
 * Resolves every obstacle against the player for this tick.
 *
 * Runs after the player has moved (tick order in sim.ts), so the sweep is from
 * the player's previous position to their current one, against the obstacle's
 * motion along -Z at `worldSpeed`.
 */
export function stepCollision(state: SimState, dt: number, events: EventRing): void {
  const obstacles = state.obstacles;
  if (obstacles.count === 0) {
    return;
  }

  const player = state.player;
  const phase = player.phase;
  const px = state.f[F.playerX] ?? 0;
  const py = state.f[F.playerY] ?? 0;
  const pz = state.f[F.playerZ] ?? 0;
  const worldSpeed = state.f[F.worldSpeed] ?? 0;

  playerAabb(playerBoxEnd, phase, px, py, pz);

  // The world moves toward the player (law (b)), so relative Z motion over the
  // tick is the distance the obstacle travels.
  const relativeDz = -worldSpeed * dt;
  const invulnerable = (state.f[F.playerInvulnerableTimer] ?? 0) > 0;

  for (let i = 0; i < obstacles.count; i += 1) {
    if (obstacles.active[i] !== 1) {
      continue;
    }
    if (obstacles.face[i] !== player.face) {
      // A different face cannot be touched, but it also cannot be a near-miss:
      // the tunnel wall is between them.
      continue;
    }

    const flags = obstacles.flags[i] ?? 0;
    if ((flags & EntityFlag.Resolved) !== 0) {
      continue;
    }

    obstacleAabb(
      obstacleBox,
      obstacles.x[i] ?? 0,
      obstacles.y[i] ?? 0,
      obstacles.z[i] ?? 0,
      DEFAULT_OBSTACLE_HALF,
      DEFAULT_OBSTACLE_HALF,
      DEFAULT_OBSTACLE_HALF,
    );

    const contact = classifyContact(obstacles.kind[i] ?? 0);
    if (contact === ContactClass.Pass) {
      recordNearMiss(state, obstacles, i, events);
      continue;
    }

    const toi = sweptOverlap(playerBoxEnd, obstacleBox, 0, 0, relativeDz);
    if (toi < 0) {
      recordNearMiss(state, obstacles, i, events);
      continue;
    }

    // Corner forgiveness: a graze into an edge nudges clear instead of killing.
    playerAabb(playerBox, phase, px, py, pz);
    const depth = shallowestPenetration(playerBox, obstacleBox);
    if (depth > 0 && depth < CORNER_FORGIVENESS) {
      nudgeClear(state, playerBox, obstacleBox);
      player.cornerForgiveCount += 1;
      obstacles.flags[i] = flags | EntityFlag.Resolved;
      emit(events, SimEvent.CornerForgive, state.tick, depth, i);
      continue;
    }

    if (invulnerable) {
      obstacles.flags[i] = flags | EntityFlag.Resolved;
      continue;
    }

    obstacles.flags[i] = flags | EntityFlag.Resolved;

    if (contact === ContactClass.Stumble) {
      applyStumble(state, events);
    } else {
      applyFatal(state, events, CrashCause.Obstacle);
      return;
    }
  }
}

/**
 * Emits NEAR_MISS when the player passed close without touching.
 *
 * Surface to surface, per GAME_BIBLE §4.1 — not centre to centre. Awarded at
 * most once per obstacle instance, ever, which is what the flag bit is for:
 * without it a slow pass would emit a near-miss every tick and inflate Flow to
 * the ceiling in a single obstacle.
 */
function recordNearMiss(
  state: SimState,
  obstacles: SimState["obstacles"],
  index: number,
  events: EventRing,
): void {
  const flags = obstacles.flags[index] ?? 0;
  if ((flags & EntityFlag.NearMissAwarded) !== 0) {
    return;
  }

  const gap = separation(playerBoxEnd, obstacleBox);
  if (gap < 0 || gap > NEAR_MISS_RADIUS) {
    return;
  }

  obstacles.flags[index] = flags | EntityFlag.NearMissAwarded;
  emit(events, SimEvent.NearMiss, state.tick, gap, index);
}
