/**
 * Track spawning — the bridge between the P06 chunk generator and live entities.
 *
 * P06 built, proved and fuzzed the generator but deliberately left it
 * disconnected: wiring it needed real per-entity colliders and a real contact
 * classifier, both of which arrived with `config/entities.ts`. This is that
 * connection, and it is the point at which the game stops being an empty tunnel.
 *
 * ## What happens every tick
 *
 * ```
 *   1. scroll     every live entity moves -worldSpeed * dt along z
 *   2. recycle    anything past the player by `despawnBehind` is freed
 *   3. spawn      chunks are emitted while the lookahead is not full
 * ```
 *
 * Scroll before spawn, so a chunk emitted this tick is not immediately moved by
 * a tick it was never present for.
 *
 * ## Law (b): entities move, the player does not
 *
 * Entity `z` is relative to the player, who stays at the origin. A chunk emitted
 * at `spawnAhead` counts down to 0 as it approaches and negative as it passes.
 * Nothing ever accumulates an absolute world position, so float precision does
 * not decay over a 20-minute run.
 *
 * ## Law (d): no allocation
 *
 * `LevelState` is created once by the sim and reset in place. Free entity slots
 * are found by a linear scan over the existing columns rather than by any
 * structure that grows. The scan is O(capacity) at 256 slots and only runs when
 * a chunk is actually emitted — a few times a second, not per entity per tick.
 *
 * ## Determinism
 *
 * Spawning is driven by `distance`, which is itself a pure function of the tick
 * count and the speed curve, and by the `generator` RNG stream, whose position
 * is serialised into `SimState`. Same seed and same input log therefore produce
 * the same track — which is what P12 re-validation depends on.
 */

import { TUNING } from "../config/tuning";
import { entityCollider } from "../config/entities";
import { emit, SimEvent, type EventRing } from "./events";
import { entityCentreX, entityDef, type ChunkEntity } from "./level";
import {
  createLevelState,
  generateNext,
  resetLevelState,
  type LevelState,
} from "./level/generator";
import type { RngState } from "./rng";
import { F, type EntityColumns, type SimState } from "./state";

const CHUNK_LENGTH = TUNING.spawn.chunkLength;
const SPAWN_AHEAD = TUNING.spawn.spawnAhead;
const DESPAWN_BEHIND = TUNING.spawn.despawnBehind;
const MAX_OBSTACLES = TUNING.pools.maxObstacles;
const MAX_PICKUPS = TUNING.pools.maxPickups;
const MAX_CHUNKS_PER_TICK = TUNING.spawn.maxChunksPerTick;

/**
 * Per-sim generator state.
 *
 * Held by the sim alongside the RNG streams rather than inside `SimState`. It is
 * a pure function of the seed and the tick count, so a re-simulation rebuilds it
 * identically — the same reasoning that lets the RNG live outside the hash and
 * be restored from a single serialised word.
 */
export interface SpawnState {
  level: LevelState;
  /** u — distance at which the next chunk's leading edge will be placed,
   *  measured from the player. Counts down as the world scrolls. */
  nextChunkZ: number;
}

export function createSpawnState(): SpawnState {
  return { level: createLevelState(), nextChunkZ: 0 };
}

/** Resets in place. Allocates nothing. */
export function resetSpawnState(spawn: SpawnState): void {
  resetLevelState(spawn.level);
  // The first chunk starts a full lookahead away, so the player never boots
  // already inside geometry.
  spawn.nextChunkZ = SPAWN_AHEAD;
}

/** Finds a free slot, or -1 when the pool is full. */
function freeSlot(columns: EntityColumns, limit: number): number {
  for (let i = 0; i < columns.count; i += 1) {
    if (columns.active[i] === 0) {
      return i;
    }
  }
  if (columns.count < limit) {
    const index = columns.count;
    columns.count = index + 1;
    return index;
  }
  return -1;
}

/** Writes one chunk entity into the appropriate column set. */
function spawnEntity(state: SimState, entity: ChunkEntity, chunkZ: number): void {
  const def = entityDef(entity.type);
  const columns = def.pickup ? state.pickups : state.obstacles;
  const limit = def.pickup ? MAX_PICKUPS : MAX_OBSTACLES;

  const index = freeSlot(columns, limit);
  if (index < 0) {
    // Pool full. Dropping a spawn is strictly better than growing the pool
    // inside the tick (law d) — and the pools are sized to the band-5 worst
    // case, so this should be unreachable. It is not an error path worth
    // throwing over, but it IS worth being visible if it ever happens.
    return;
  }

  const collider = entityCollider(entity.type);

  columns.active[index] = 1;
  columns.kind[index] = entity.type;
  columns.face[index] = entity.face;
  columns.lane[index] = entity.lane;
  // Lateral centre resolved once here rather than per tick in collision.
  columns.x[index] = entityCentreX(entity.lane, entity.type);
  columns.y[index] = collider.centreY;
  columns.z[index] = chunkZ + entity.z;
  columns.flags[index] = 0;
}

/** Moves every live entity toward the player and frees the ones that passed. */
function scrollAndRecycle(columns: EntityColumns, delta: number): void {
  for (let i = 0; i < columns.count; i += 1) {
    if (columns.active[i] !== 1) {
      continue;
    }
    const z = (columns.z[i] ?? 0) - delta;
    columns.z[i] = z;
    if (z < -DESPAWN_BEHIND) {
      // Freed for reuse. Flags are cleared here rather than on acquire so a
      // stale NearMissAwarded bit can never survive into the next occupant.
      columns.active[i] = 0;
      columns.flags[i] = 0;
    }
  }
}

/**
 * Advances spawning by one tick.
 *
 * @param state     mutated in place: entity columns only
 * @param spawn     the generator's own state, owned by the sim
 * @param generator the generator RNG stream — never the cosmetic one
 * @param events    where ThemeChange is emitted
 * @param dt        fixed timestep
 */
export function stepGenerator(
  state: SimState,
  spawn: SpawnState,
  generator: RngState,
  events: EventRing,
  dt: number,
): void {
  const worldSpeed = state.f[F.worldSpeed] ?? 0;
  const delta = worldSpeed * dt;

  // 1 + 2. Scroll and recycle.
  scrollAndRecycle(state.obstacles, delta);
  scrollAndRecycle(state.pickups, delta);
  spawn.nextChunkZ -= delta;

  // 3. Spawn. Bounded per tick for the same reason the clock's accumulator is:
  // an unbounded catch-up loop turns one slow moment into a stall. In steady
  // state this emits a chunk roughly every 24u, so at most one per tick.
  let emitted = 0;
  while (spawn.nextChunkZ <= SPAWN_AHEAD && emitted < MAX_CHUNKS_PER_TICK) {
    const flow = state.f[F.flow] ?? 0;
    const placed = generateNext(spawn.level, generator, flow);

    for (const entity of placed.chunk.entities) {
      spawnEntity(state, entity, spawn.nextChunkZ);
    }

    // The EDGE of a boundary, not every chunk inside it. A transition is five
    // chunks long, and `chunk.id === "transition"` is true for all five — which
    // fired five theme changes for one transition, each carrying the chunk
    // ordinal rather than the theme id its own contract in sim/events.ts
    // promises. Both halves are fixed here.
    if (placed.themeChanged) {
      emit(events, SimEvent.ThemeChange, state.tick, placed.themeIndex);
    }

    spawn.nextChunkZ += CHUNK_LENGTH;
    emitted += 1;
  }
}

/** Live entity count. Diagnostic, and the render layer's instance budget check. */
export function liveCount(columns: EntityColumns): number {
  let n = 0;
  for (let i = 0; i < columns.count; i += 1) {
    if (columns.active[i] === 1) {
      n += 1;
    }
  }
  return n;
}
