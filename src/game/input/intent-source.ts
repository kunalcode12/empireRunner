/**
 * The shared shape every input device collapses into.
 *
 * ## What this layer does, and what it deliberately does not
 *
 * It produces intent. That is all. It never reads sim state, never calls into
 * the sim, and never decides whether a verb is *legal* — only that it was
 * *requested*. docs/ARCHITECTURE.md §3.
 *
 * In particular, the input buffer and coyote time are **not** here, even though
 * docs/TUNING.md §8 files them under "input forgiveness". Both depend on sim
 * state, and more decisively, a buffered input is a decision: the replay log
 * records the raw per-tick intent stream, so a buffer living outside the sim
 * would not be reproduced by a server re-simulating from that log, and every
 * replay would desync. They live in `src/game/sim/player/forgiveness.ts`.
 *
 * ## Held, not pressed
 *
 * `jump` and `slide` are **held** states. The controller derives press and
 * release edges itself, which is what makes variable jump height possible — the
 * release edge is what cuts the arc short. `lateral` and `roll` are edge-like:
 * a source sets them for exactly one poll and they clear on read.
 */

import type { Intent } from "../sim/intent";

/**
 * A device adapter.
 *
 * `poll` writes the current frame's intent into `out` and clears any one-shot
 * edges it holds. Writing into a caller-owned object rather than returning a new
 * one keeps the per-frame path allocation-free, matching the sim's discipline.
 */
export interface IntentSource {
  readonly name: string;
  /** True when this device has produced input recently enough to be "active". */
  isActive(): boolean;
  /** Writes this frame's intent into `out`. */
  poll(out: Intent): void;
  /** Releases listeners and resets internal state. */
  dispose(): void;
}

/**
 * Accumulates one-shot directional intents between polls.
 *
 * Both keyboard and touch need the same thing: a lateral or roll request can
 * arrive at any moment between frames and must survive until the next poll, but
 * must not repeat afterwards. A held key produces one lane change, not sixty.
 */
export interface EdgeLatch {
  lateral: number;
  roll: number;
  jump: boolean;
  slide: boolean;
}

export function createEdgeLatch(): EdgeLatch {
  return { lateral: 0, roll: 0, jump: false, slide: false };
}

/** Records a one-shot lateral request. Newest wins. */
export function latchLateral(latch: EdgeLatch, direction: number): void {
  latch.lateral = direction;
}

/** Records a one-shot roll request. Newest wins. */
export function latchRoll(latch: EdgeLatch, direction: number): void {
  latch.roll = direction;
}

/** Drains the one-shot fields into `out` and clears them. Held fields persist. */
export function drainLatch(latch: EdgeLatch, out: Intent): void {
  out.lateral = latch.lateral;
  out.roll = latch.roll;
  out.jump = latch.jump;
  out.slide = latch.slide;
  latch.lateral = 0;
  latch.roll = 0;
}

/** Clears everything, including held state. */
export function resetLatch(latch: EdgeLatch): void {
  latch.lateral = 0;
  latch.roll = 0;
  latch.jump = false;
  latch.slide = false;
}

/**
 * Merges several sources into one intent.
 *
 * Players switch mid-session — keyboard to gamepad, or thumb to controller — and
 * the game should not care. Later sources win on conflict only where they have
 * something to say: a held jump on any device holds the jump.
 */
export function mergeInto(out: Intent, next: Readonly<Intent>): void {
  if (next.lateral !== 0) {
    out.lateral = next.lateral;
  }
  if (next.roll !== 0) {
    out.roll = next.roll;
  }
  out.jump = out.jump || next.jump;
  out.slide = out.slide || next.slide;
}
