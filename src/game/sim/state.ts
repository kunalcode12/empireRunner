/**
 * SimState — the entire simulation as plain data.
 *
 * Two of these exist at a time, `previous` and `current`, so the renderer can
 * interpolate between them by `alpha` without ever reading a partially-ticked
 * state (law (c)).
 *
 * ## Why the doubles live in a Float64Array
 *
 * This is not premature optimisation; it is law (d), and it was measured.
 *
 * V8 removed double-field unboxing in 7.6. Since then, storing a non-Smi double
 * into a plain object property **heap-allocates a HeapNumber** — 16 bytes, every
 * time. Writing `state.distance += x` once per tick is therefore 16 bytes/tick,
 * which measured at a dead-consistent 320KB per 20,000 ticks and blows the
 * budget in TUNING.budgets.heapDeltaBytes by 6x.
 *
 * So every value that is a real number lives in the flat `f` array, indexed by
 * the `F` constants. This is exactly what docs/ARCHITECTURE.md §2d means by
 * "flat Float32Array fields on SimState".
 *
 * Integers stay as ordinary object properties: a 32-bit signed integer is a Smi,
 * which V8 stores inline in the pointer and never allocates. That keeps the
 * fields game logic reads most — `tick`, `band`, `player.face`, `player.lane` —
 * readable as plain properties.
 *
 * The RNG stream states are stored **signed** (`| 0`) for the same reason: a
 * uint32 above 2^31 exceeds Smi range and would box. Read them back with `>>> 0`.
 */

import { TUNING } from "../config/tuning";

const MAX_OBSTACLES = TUNING.pools.maxObstacles;
const MAX_PICKUPS = TUNING.pools.maxPickups;

/**
 * Slot indices into `SimState.f`.
 *
 * Append only. The order is baked into every state hash, and therefore into
 * every stored replay — reordering these silently invalidates all of them. If
 * you add a slot, add it at the end and bump `TUNING.replay.formatVersion`.
 */
export const F = {
  /** s — tick * fixedDelta. */
  elapsed: 0,
  /** m — total distance travelled. An accumulated scalar, not a transform. Law (b). */
  distance: 1,
  /** u/s — the time-based speed curve, integrated incrementally. */
  timeSpeed: 2,
  /** u/s — timeSpeed plus the Flow bonus, clamped to maxSpeed. */
  worldSpeed: 3,
  /** pts — run score. */
  score: 4,
  /** 0..100 — the Flow meter. */
  flow: 5,
  /** s — time since the last Flow gain, for the decay grace window. */
  flowIdleTimer: 6,
  /** s — remaining Overdrive. Zero when not in Overdrive. */
  overdriveTimer: 7,
  /** u — lateral offset within the current face. Interpolates during a lane change. */
  playerX: 8,
  /** u — height above the current floor plane. */
  playerY: 9,
  /** u — position along the tunnel. Stays near 0. Law (b). */
  playerZ: 10,
  /** u/s — vertical velocity. Negative is falling. */
  playerVy: 11,
  /** radians — accumulated roll of the world about the tunnel axis. */
  playerRoll: 12,
  /** s — time remaining in the current verb. */
  playerVerbTimer: 13,
  /** s — remaining lane-input lockout from a roll. Input here is DROPPED, not buffered. */
  playerRollCommitTimer: 14,
  /** s — remaining cooldown before another roll is legal. */
  playerRollCooldownTimer: 15,
  /** s — remaining coyote window. JUMP stays legal while this is positive. */
  playerCoyoteTimer: 16,
  /** s — remaining life of the buffered verb before it is discarded. */
  playerBufferedTimer: 17,
  /** s — remaining invulnerability from a shield or a Fracture resume. */
  playerInvulnerableTimer: 18,

  // ── P04 — player controller ────────────────────────────────────────────────
  /** s — remaining stumble recovery. Control returns at zero. */
  playerStumbleTimer: 19,
  /** u — lane tween origin. Captured when the tween starts. */
  playerLaneFromX: 20,
  /** u — lane tween destination, the centre of the target lane. */
  playerLaneTargetX: 21,
  /** s — elapsed lane tween time. >= laneChangeDuration means settled. */
  playerLaneTweenElapsed: 22,
  /** s — remaining roll time. Runs CONCURRENTLY with any phase (GAME_BIBLE §3.2). */
  playerRollTimer: 23,
  /** s — elapsed roll time, for interpolating the 90 degree world rotation. */
  playerRollElapsed: 24,
  /** s — remaining slide time. Separate from verbTimer because a slide can run
   *  while a roll is also in flight. */
  playerSlideTimer: 25,
  /** s — remaining slide stand-up tail. Jump is illegal until this reaches zero. */
  playerSlideRecoveryTimer: 26,
} as const;

/** Number of Float64 slots. Keep in step with `F`. */
export const FLOAT_SLOTS = 27;

export type FloatSlot = (typeof F)[keyof typeof F];

/** Lifecycle of a run. */
export const RunStatus = {
  Idle: 0,
  Running: 1,
  /** Fatal hit landed; the Fracture input window is open (P09). */
  Fracturing: 2,
  /** Run is over. Further ticks are no-ops. */
  Ended: 3,
} as const;
export type RunStatusValue = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * The player's current verb. Exactly the movement verbs from GAME_BIBLE §6.
 * A seventh needs a design review, not a new enum member.
 */
export const Verb = {
  None: 0,
  LaneLeft: 1,
  LaneRight: 2,
  Jump: 3,
  Slide: 4,
  RollLeft: 5,
  RollRight: 6,
} as const;
export type VerbValue = (typeof Verb)[keyof typeof Verb];

/**
 * The player's phase — the exhaustive state machine from P04.
 *
 * **Roll is deliberately NOT a member of this enum's exclusivity.** GAME_BIBLE
 * §3.2 requires jump and slide to remain available throughout a roll, so a roll
 * runs as a concurrent axis (`playerRollTimer` + `rollDirection`) that can
 * overlap any phase. `Rolling` here means "rolling while otherwise idle on the
 * ground"; a roll begun mid-jump leaves the phase at `Jumping`.
 *
 * Full transition table lives in `player/phase.ts`.
 */
export const Phase = {
  Running: 0,
  Jumping: 1,
  Falling: 2,
  Sliding: 3,
  Rolling: 4,
  Stumbling: 5,
  Crashed: 6,
  Fracturing: 7,
} as const;
export type PhaseValue = (typeof Phase)[keyof typeof Phase];

/** Player state — integers only. Every double lives in `SimState.f`. */
export interface PlayerState {
  /** 0..3 — which face is currently the floor. */
  face: number;
  /** 0..2 — lane on the current face, ordered left to right from the player's view. */
  lane: number;
  /** Phase — the state machine's current node. */
  phase: number;
  /** Verb — what the player is currently doing. Kept for the HUD and events. */
  verb: number;
  /** Verb — a verb issued early and held until it becomes legal. */
  bufferedVerb: number;
  /** 0 or 1 — whether the player is on the floor plane. */
  grounded: number;
  /** count — shields held. Absorbs a fatal hit without resetting Flow. */
  shields: number;
  /** -1 left, 0 none, +1 right — direction of the in-flight roll. Concurrent. */
  rollDirection: number;
  /** 0 or 1 — whether JUMP was held last tick, for the release edge. */
  jumpHeld: number;
  /** 0 or 1 — whether SLIDE was held last tick, for the press edge. */
  slideHeld: number;
  /** 0..2 — lane the in-flight tween is heading for. Equals `lane` when settled. */
  targetLane: number;
  /** count — corner forgiveness activations this run. Diagnostic: if this climbs,
   *  the generator is placing unfair geometry. */
  cornerForgiveCount: number;
  /** count — stumbles this run. */
  stumbleCount: number;
}

/**
 * Entities as struct-of-arrays.
 *
 * `count` is the high-water mark of used slots, not the number of live entities:
 * iterate `0..count` and skip where `active` is 0.
 */
export interface EntityColumns {
  count: number;
  readonly capacity: number;
  readonly active: Uint8Array;
  /** Entity kind id. The catalogue lands in config/entities.ts at P07. */
  readonly kind: Int32Array;
  readonly face: Int32Array;
  readonly lane: Int32Array;
  /** u — position along the tunnel, relative to the player. */
  readonly z: Float64Array;
  /** u — lateral offset within the face. */
  readonly x: Float64Array;
  /** u — height above the face. */
  readonly y: Float64Array;
  /** Bitfield: collected, near-miss awarded, shattered. */
  readonly flags: Int32Array;
}

export interface SimState {
  /** All real-valued state, indexed by `F`. See the module header. */
  readonly f: Float64Array;

  /** Ticks elapsed since the run started. The sim's only notion of time. */
  tick: number;
  /** RunStatus. */
  runStatus: number;
  /** Index into TUNING.spawn.bands. */
  band: number;
  /** count — Fractures spent this run. */
  fracturesUsed: number;
  /** int32 — serialised generator stream. Signed to stay a Smi; read with `>>> 0`. */
  rngGenerator: number;
  /** int32 — serialised pickup stream. */
  rngPickup: number;
  /** int32 — serialised cosmetic stream. Never affects gameplay. */
  rngCosmetic: number;

  readonly player: PlayerState;
  readonly obstacles: EntityColumns;
  readonly pickups: EntityColumns;
}

/** The three named stream seeds a run starts from. */
export interface RngSeeds {
  generator: number;
  pickup: number;
  cosmetic: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Float slot accessors.
//
// `noUncheckedIndexedAccess` is on, so a raw `state.f[F.distance]` is typed
// `number | undefined`. These helpers keep call sites honest without scattering
// `?? 0` through the hot path. V8 inlines all three.
// ─────────────────────────────────────────────────────────────────────────────

/** Reads a float slot. */
export function getF(state: SimState, slot: number): number {
  return state.f[slot] ?? 0;
}

/** Writes a float slot. */
export function setF(state: SimState, slot: number, value: number): void {
  state.f[slot] = value;
}

/** Adds to a float slot. */
export function addF(state: SimState, slot: number, delta: number): void {
  state.f[slot] = (state.f[slot] ?? 0) + delta;
}

function createEntityColumns(capacity: number): EntityColumns {
  return {
    count: 0,
    capacity,
    active: new Uint8Array(capacity),
    kind: new Int32Array(capacity),
    face: new Int32Array(capacity),
    lane: new Int32Array(capacity),
    z: new Float64Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    flags: new Int32Array(capacity),
  };
}

/**
 * Allocates a fresh SimState. Called once per sim, never inside the tick.
 *
 * This is the ONLY place in the sim that allocates typed arrays.
 */
export function createState(): SimState {
  const state: SimState = {
    f: new Float64Array(FLOAT_SLOTS),
    tick: 0,
    runStatus: RunStatus.Idle,
    band: 0,
    fracturesUsed: 0,
    rngGenerator: 0,
    rngPickup: 0,
    rngCosmetic: 0,
    player: {
      face: 0,
      lane: 1,
      phase: Phase.Running,
      verb: Verb.None,
      bufferedVerb: Verb.None,
      grounded: 1,
      shields: TUNING.pickups.maxShields,
      rollDirection: 0,
      jumpHeld: 0,
      slideHeld: 0,
      targetLane: 1,
      cornerForgiveCount: 0,
      stumbleCount: 0,
    },
    obstacles: createEntityColumns(MAX_OBSTACLES),
    pickups: createEntityColumns(MAX_PICKUPS),
  };
  resetState(state, ZERO_SEEDS);
  return state;
}

const ZERO_SEEDS: RngSeeds = { generator: 0, pickup: 0, cosmetic: 0 };

/**
 * Resets a state in place to run-start values. Allocates nothing.
 *
 * `TypedArray.fill(0)` reuses the existing buffers, which is what makes
 * `reset(seed)` safe to call between runs without churning the heap.
 */
export function resetState(state: SimState, seeds: RngSeeds): void {
  state.f.fill(0);
  state.f[F.timeSpeed] = TUNING.speed.baseSpeed;
  state.f[F.worldSpeed] = TUNING.speed.baseSpeed;

  state.tick = 0;
  state.runStatus = RunStatus.Idle;
  state.band = 0;
  state.fracturesUsed = 0;
  state.rngGenerator = seeds.generator | 0;
  state.rngPickup = seeds.pickup | 0;
  state.rngCosmetic = seeds.cosmetic | 0;

  const player = state.player;
  player.face = 0;
  player.lane = 1;
  player.phase = Phase.Running;
  player.verb = Verb.None;
  player.bufferedVerb = Verb.None;
  player.grounded = 1;
  player.shields = TUNING.pickups.maxShields;
  player.rollDirection = 0;
  player.jumpHeld = 0;
  player.slideHeld = 0;
  player.targetLane = 1;
  player.cornerForgiveCount = 0;
  player.stumbleCount = 0;

  resetEntityColumns(state.obstacles);
  resetEntityColumns(state.pickups);
}

function resetEntityColumns(columns: EntityColumns): void {
  columns.count = 0;
  columns.active.fill(0);
  columns.kind.fill(0);
  columns.face.fill(0);
  columns.lane.fill(0);
  columns.z.fill(0);
  columns.x.fill(0);
  columns.y.fill(0);
  columns.flags.fill(0);
}

/**
 * Copies `src` into `dst` in place. Allocates nothing.
 *
 * Runs once per tick to maintain the previous/current snapshot pair, so it is on
 * the hot path. `TypedArray.set` is a memmove into an existing buffer.
 */
export function copyState(dst: SimState, src: SimState): void {
  dst.f.set(src.f);

  dst.tick = src.tick;
  dst.runStatus = src.runStatus;
  dst.band = src.band;
  dst.fracturesUsed = src.fracturesUsed;
  dst.rngGenerator = src.rngGenerator;
  dst.rngPickup = src.rngPickup;
  dst.rngCosmetic = src.rngCosmetic;

  dst.player.face = src.player.face;
  dst.player.lane = src.player.lane;
  dst.player.phase = src.player.phase;
  dst.player.verb = src.player.verb;
  dst.player.bufferedVerb = src.player.bufferedVerb;
  dst.player.grounded = src.player.grounded;
  dst.player.shields = src.player.shields;
  dst.player.rollDirection = src.player.rollDirection;
  dst.player.jumpHeld = src.player.jumpHeld;
  dst.player.slideHeld = src.player.slideHeld;
  dst.player.targetLane = src.player.targetLane;
  dst.player.cornerForgiveCount = src.player.cornerForgiveCount;
  dst.player.stumbleCount = src.player.stumbleCount;

  copyEntityColumns(dst.obstacles, src.obstacles);
  copyEntityColumns(dst.pickups, src.pickups);
}

function copyEntityColumns(dst: EntityColumns, src: EntityColumns): void {
  dst.count = src.count;
  dst.active.set(src.active);
  dst.kind.set(src.kind);
  dst.face.set(src.face);
  dst.lane.set(src.lane);
  dst.z.set(src.z);
  dst.x.set(src.x);
  dst.y.set(src.y);
  dst.flags.set(src.flags);
}
