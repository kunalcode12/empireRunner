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
  overlaps,
  penetrationX,
  penetrationY,
  penetrationZ,
  playerAabb,
  separation,
  type Aabb,
} from "./player/collider";
import { entityCollider } from "../config/entities";
import { blocksVertical, entityDef, EntityType, Vertical } from "./level/entities";
import { applyFatal, applyStumble, CrashCause } from "./player";
import { overdriveActive } from "./scoring/overdrive";
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
 * Reads the real catalogue in `sim/level/entities.ts`. This replaced an odd/even
 * placeholder at P07 — until then a kind's *parity* decided whether it killed
 * you, which was harmless only because nothing spawned.
 *
 * Three classes, and the mapping is not arbitrary:
 *
 *   - `fatal: false` entities (Kicker, Corner Brace) are **Pass**. A Kicker is a
 *     ramp and a Corner Brace restricts the roll; neither is a hit.
 *   - Anything that blocks **every** vertical state is **Fatal**. There was no
 *     vertical answer, so hitting it is not a mistake of degree.
 *   - Anything that leaves a vertical state open is a **Stumble**. The player
 *     had an out and missed it, which is a fumble rather than a death — this is
 *     what makes the difference between "hard" and "broken" (TUNING §12b).
 */
export function classifyContact(kind: number): number {
  const def = entityDef(kind);
  if (def.pickup || def.type === EntityType.None) {
    return ContactClass.Pass;
  }
  if (!def.fatal) {
    return ContactClass.Pass;
  }

  const blocksAll =
    blocksVertical(kind, Vertical.Standing) &&
    blocksVertical(kind, Vertical.Sliding) &&
    blocksVertical(kind, Vertical.Airborne);

  return blocksAll ? ContactClass.Fatal : ContactClass.Stumble;
}

/** Scratch boxes, reused every tick. Law (d): the tick allocates nothing. */
const playerBox: Aabb = createAabb();
const playerBoxEnd: Aabb = createAabb();
const obstacleBox: Aabb = createAabb();
const pickupBox: Aabb = createAabb();

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
  // Pickups first: collecting a Bit on the same tick a hit lands should still
  // count. The alternative silently voids the last grab of every run.
  stepPickups(state, events);

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
  const inOverdrive = overdriveActive(state);

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

    // Real extents from the catalogue. A Full-Face Wall and a Bit no longer
    // share a hitbox, which they did throughout P02–P06.
    const kind = obstacles.kind[i] ?? 0;
    const collider = entityCollider(kind);
    obstacleAabb(
      obstacleBox,
      obstacles.x[i] ?? 0,
      obstacles.y[i] ?? 0,
      obstacles.z[i] ?? 0,
      collider.halfWidth,
      collider.halfHeight,
      collider.halfDepth,
    );

    const contact = classifyContact(kind);
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

    // Overdrive: obstacles shatter on contact and are removed from the sim,
    // rather than killing. GAME_BIBLE §4.3. Checked before the plain
    // invulnerability branch because a shatter is a scoring event, not a
    // non-event — the score award is the whole reward for ramming during the
    // one window where ramming is free.
    if (inOverdrive) {
      obstacles.flags[i] = flags | EntityFlag.Resolved | EntityFlag.Shattered;
      obstacles.active[i] = 0;
      emit(events, SimEvent.Shatter, state.tick, i, obstacles.kind[i] ?? 0);
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
      applyFatal(state, events, CrashCause.Obstacle, i);
      return;
    }
  }
}

/**
 * Collects any pickup the player is overlapping.
 *
 * Discrete rather than swept, and deliberately so. A missed Bit is a
 * disappointment; a missed *obstacle* is a death, which is why that path sweeps
 * and this one does not. The generous collider extents in `config/entities.ts`
 * do the work instead — a Bit's grab box is 0.45u against a 0.22u visual.
 *
 * During Overdrive the magnet goes global (GAME_BIBLE §4.3), so every pickup on
 * the player's face is collected regardless of distance. That is implemented
 * here rather than as an attraction force because the sim has no notion of
 * pickup velocity, and a visual pull is the render layer's job.
 */
function stepPickups(state: SimState, events: EventRing): void {
  const pickups = state.pickups;
  if (pickups.count === 0) {
    return;
  }

  const player = state.player;
  const px = state.f[F.playerX] ?? 0;
  const py = state.f[F.playerY] ?? 0;
  const pz = state.f[F.playerZ] ?? 0;
  const globalMagnet = overdriveActive(state);

  playerAabb(playerBox, player.phase, px, py, pz);

  for (let i = 0; i < pickups.count; i += 1) {
    if (pickups.active[i] !== 1) {
      continue;
    }
    if (pickups.face[i] !== player.face) {
      continue;
    }

    const kind = pickups.kind[i] ?? 0;
    const z = pickups.z[i] ?? 0;

    if (!globalMagnet) {
      const collider = entityCollider(kind);
      obstacleAabb(
        pickupBox,
        pickups.x[i] ?? 0,
        pickups.y[i] ?? 0,
        z,
        collider.halfWidth,
        collider.halfHeight,
        collider.halfDepth,
      );
      if (!overlaps(playerBox, pickupBox)) {
        continue;
      }
    } else if (z > 0) {
      // Global magnet still only takes what is at or behind the player plane,
      // so Overdrive does not reach forward through the entire visible tunnel.
      continue;
    }

    pickups.active[i] = 0;
    pickups.flags[i] = 0;
    emit(events, SimEvent.Coin, state.tick, kind, i, z);
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
