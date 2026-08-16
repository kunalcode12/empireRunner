/**
 * Dev-only world seeding — **not part of the game.**
 *
 * ## Why this exists
 *
 * P06 built, proved and fuzzed the level generator but deliberately did not wire
 * it into the live tick, so `state.obstacles.count` is permanently 0. Without
 * something here, the grey-box tunnel is empty: `EntityRenderer` cannot be
 * evaluated by eye, and the draw-call figure from a play session would be the
 * empty-scene number rather than a realistic one.
 *
 * So this walks the **real** P06 generator, takes the **real** authored chunks,
 * and writes their entities into the sim's entity columns once, before the first
 * tick. The geometry on screen is genuine authored track, not invented shapes.
 *
 * ## What it is not
 *
 * It is not the generator being wired in. Nothing here runs per tick, nothing
 * recycles, and the entities do not move relative to the world — they sit at
 * fixed z and the tunnel scrolls past them, so they drift out of alignment with
 * the treadmill over time. That is fine for looking at instancing and counting
 * draw calls, and it is useless as gameplay. **P07 does the real wiring.**
 *
 * ## Why it does not violate "render never writes sim state"
 *
 * It is not the render layer. It is a separate dev module that the render layer
 * calls exactly once at mount, before the loop starts, behind a build-time flag.
 * The per-frame path still reads and never writes. If this file ever grows a
 * function that runs inside `useFrame`, that rule is broken and this comment is
 * the thing that was ignored.
 */

import { TUNING } from "@/game/config/tuning";
import { createRng, forkSeed, RNG_STREAMS } from "@/game/sim/rng";
import { createLevelState, generateNext } from "@/game/sim/level";
import { entityDef } from "@/game/sim/level/entities";
import type { Sim } from "@/game/sim/sim";
import type { EntityColumns, SimState } from "@/game/sim/state";

const CHUNK_LENGTH = TUNING.spawn.chunkLength;
const MAX_OBSTACLES = TUNING.pools.maxObstacles;
const MAX_PICKUPS = TUNING.pools.maxPickups;

/** True when the dev harness is permitted to run at all. */
export function devSeedingEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Writes one entity into a column set. Returns false when the pool is full. */
function push(
  columns: EntityColumns,
  limit: number,
  kind: number,
  face: number,
  lane: number,
  z: number,
): boolean {
  const index = columns.count;
  if (index >= limit) {
    return false;
  }
  columns.active[index] = 1;
  columns.kind[index] = kind;
  columns.face[index] = face;
  columns.lane[index] = lane;
  columns.x[index] = 0;
  columns.y[index] = 0;
  columns.z[index] = z;
  columns.flags[index] = 0;
  columns.count = index + 1;
  return true;
}

export interface DevSeedOptions {
  /** How many chunks of authored track to lay down. */
  chunks?: number;
  /** Seed for chunk selection. Same seed, same layout. */
  seed?: number;
}

const DEFAULT_CHUNKS = 10;

/**
 * Fills a sim's entity columns from real generated chunks.
 *
 * Pure with respect to the sim's simulation state: it touches only the entity
 * columns, never the player, the clock, the RNG position or the score.
 */
export function seedWorldFromGenerator(state: SimState, options: DevSeedOptions = {}): void {
  const chunkCount = options.chunks ?? DEFAULT_CHUNKS;
  const seed = options.seed ?? 1;

  const level = createLevelState();
  const rng = createRng(forkSeed(seed, RNG_STREAMS.generator));

  for (let i = 0; i < chunkCount; i += 1) {
    const placed = generateNext(level, rng, 0);
    const base = i * CHUNK_LENGTH;

    for (const entity of placed.chunk.entities) {
      const def = entityDef(entity.type);
      const z = base + entity.z;
      const columns = def.pickup ? state.pickups : state.obstacles;
      const limit = def.pickup ? MAX_PICKUPS : MAX_OBSTACLES;
      if (!push(columns, limit, entity.type, entity.face, entity.lane, z)) {
        return;
      }
    }
  }
}

/** Convenience wrapper for the render layer's mount-time call. */
export function seedSim(sim: Sim, options?: DevSeedOptions): void {
  if (!devSeedingEnabled()) {
    return;
  }
  seedWorldFromGenerator(sim.getState(), options);
}
