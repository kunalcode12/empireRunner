/**
 * Scoring and Flow — **STUB. NOT IMPLEMENTED. Scheduled for P08.**
 *
 * This file deliberately does nothing. `score` and `flow` stay at 0 for the whole
 * of P02, which is why the world-speed curve in sim.ts currently only ever sees
 * `flow === 0` and the Flow speed bonus contributes nothing yet. That is by
 * design; the coupling is wired and the input is simply always zero.
 *
 * What P08 will implement here, from docs/GAME_BIBLE.md §4 and docs/TUNING.md §9:
 *   - Flow gains: near-miss +6, perfect slide +4, bit streak +3/10, Cell +35, Shard +10
 *   - decay at 1.5/s after a 2.0s grace window with no gain
 *   - `scoreMultiplier = 1.0 + 2.0 * (flow / 100)`
 *   - Overdrive: 6.0s, flat 4.0x, exits at 25 Flow, freezes Flow while active
 *   - crash zeroes Flow — not reduces it, zeroes it
 *
 * The Flow-to-speed coupling itself already lives in sim.ts, because world scroll
 * has to read Flow whether or not anything sets it yet.
 */

import type { EventRing } from "./events";
import type { SimState } from "./state";

/**
 * Applies scoring and Flow for this tick.
 *
 * @param state  mutated in place by P08
 * @param dt     fixed timestep
 * @param events read for Coin/NearMiss this tick; writes FlowFull and Overdrive events
 */
export function stepScoring(state: SimState, dt: number, events: EventRing): void {
  // P08. Intentionally empty — see the module header.
  void state;
  void dt;
  void events;
}
