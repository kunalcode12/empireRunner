/**
 * Track generator — **STUB. NOT IMPLEMENTED. Scheduled for P06.**
 *
 * This file deliberately does nothing. No obstacles or pickups are ever spawned
 * in P02, so entity arrays stay empty and the collision stub has nothing to test
 * against. That is expected, not a bug.
 *
 * What P06 will implement here, from docs/GAME_BIBLE.md §3.3 and docs/TUNING.md §10:
 *   - seeded chunk generation on the `generator` RNG stream, never a shared one
 *   - the five difficulty bands, with density capped at band 5
 *   - authoring across all four faces, including the Full-Face Wall whose only
 *     answer is a roll
 *   - the reachability solver, and the hard guarantee that every spawn leaves at
 *     least one of the 12 cells reachable
 *   - `minReactionTime` 0.55s never violated, at any speed
 *   - chunk recycling back into the pool
 *
 * The 10,000-seed fuzz test in tests/generator/ is the gate for that phase.
 */

import type { EventRing } from "./events";
import type { RngState } from "./rng";
import type { SimState } from "./state";

/**
 * Spawns whatever the current distance and band call for.
 *
 * @param state     mutated in place by P06
 * @param generator the generator RNG stream — never the cosmetic one
 * @param pickup    the pickup RNG stream
 * @param events    where BandChange and ThemeChange will be emitted
 */
export function stepGenerator(
  state: SimState,
  generator: RngState,
  pickup: RngState,
  events: EventRing,
): void {
  // P06. Intentionally empty — see the module header.
  void state;
  void generator;
  void pickup;
  void events;
}
