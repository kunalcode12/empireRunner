/**
 * Collision — **STUB. NOT IMPLEMENTED. Scheduled for P07.**
 *
 * This file deliberately does nothing. Nothing collides in P02 because nothing
 * spawns.
 *
 * What P07 will implement here, from docs/ARCHITECTURE.md §2e:
 *   - **swept** AABB, not discrete. At 34 u/s the player advances 0.57u per tick,
 *     nearly the width of a Bit; a discrete check tunnels straight through thin
 *     geometry.
 *   - near-miss detection at `nearMissRadius` 0.45u, measured surface to surface
 *     between AABBs, awarded at most once per obstacle instance
 *   - pickup collection, shield absorption, and the fatal-contact path
 *
 * Hand-rolled and deterministic, always. Rapier is cosmetic-only and never
 * touches anything the sim reads — law (e). If a Rapier body position is ever
 * read back into this file, determinism is dead and so is the leaderboard.
 */

import type { EventRing } from "./events";
import type { SimState } from "./state";

/**
 * Resolves all collisions for this tick.
 *
 * @param state  mutated in place by P07
 * @param dt     fixed timestep, for the swept test
 * @param events where Coin, NearMiss, ShieldAbsorb and Crash will be emitted
 */
export function stepCollision(state: SimState, dt: number, events: EventRing): void {
  // P07. Intentionally empty — see the module header.
  void state;
  void dt;
  void events;
}
