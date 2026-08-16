/**
 * Seeded PRNG — mulberry32.
 *
 * `Math.random()` is banned everywhere in this repo (enforced by eslint.config.mjs
 * for src/game/sim/). All randomness comes from here.
 *
 * Why mulberry32: 32-bit integer state, one `Math.imul` chain per draw, no float
 * accumulator. Every operation is exact integer arithmetic, so the sequence is
 * bit-identical on every engine — which is the whole point (docs/ARCHITECTURE.md
 * §2a). A PRNG with float state would drift between engines and take the
 * leaderboard down with it.
 *
 * State is one uint32 held in a plain mutable object, so advancing it allocates
 * nothing and serialising it is a single number.
 */

/** mulberry32's Weyl increment. */
const WEYL_INCREMENT = 0x6d2b79f5;
const SHIFT_A = 15;
const SHIFT_B = 7;
const SHIFT_C = 14;
const ODD_MASK_A = 1;
const ODD_MASK_B = 61;

/** 2^32, for mapping a uint32 into [0, 1). */
const U32_RANGE = 4294967296;
const U32_MAX = 0xffffffff;

/** FNV-1a 32-bit, used to derive child stream seeds from a stream name. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * A PRNG stream. Mutable by design: `nextU32` advances `s` in place so drawing a
 * number inside the tick allocates nothing.
 */
export interface RngState {
  /** uint32 — the entire state of the generator. */
  s: number;
}

/** Creates a stream from a seed. Any 32-bit value is a valid seed, including 0. */
export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

/** Advances the stream and returns the next uint32. */
export function nextU32(rng: RngState): number {
  rng.s = (rng.s + WEYL_INCREMENT) | 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> SHIFT_A), t | ODD_MASK_A);
  t = (t + Math.imul(t ^ (t >>> SHIFT_B), t | ODD_MASK_B)) ^ t;
  return (t ^ (t >>> SHIFT_C)) >>> 0;
}

/** Next float in [0, 1). Exact: a uint32 divided by 2^32 is representable. */
export function nextFloat(rng: RngState): number {
  return nextU32(rng) / U32_RANGE;
}

/** Next float in [min, max). */
export function nextRange(rng: RngState, min: number, max: number): number {
  return min + nextFloat(rng) * (max - min);
}

/**
 * Next integer in [min, max) — uniform, via modulo on the uint32.
 *
 * Modulo bias is present but bounded: for any range the generator ever uses here
 * (lane counts, face counts, entity kinds — all under 100) the bias is under
 * 1 part in 42 million. Rejection sampling would remove it at the cost of a
 * variable number of draws per call, which would make the stream position depend
 * on rejected values. A fixed one-draw-per-call cost is worth more to
 * determinism than removing a bias this small.
 */
export function nextInt(rng: RngState, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) {
    return min;
  }
  return min + (nextU32(rng) % span);
}

/** Next boolean, using the high bit (the best-mixed one). */
export function nextBool(rng: RngState): boolean {
  return nextU32(rng) >= U32_RANGE / 2;
}

/**
 * Derives a named child stream from a parent seed.
 *
 * **This is why the level generator and the cosmetic layer never share a stream.**
 * If they did, spawning one extra particle would advance the generator and change
 * the entire track layout downstream — a replay recorded with particles enabled
 * would not validate against a server run with them disabled.
 *
 * Pure: does not advance the parent. The same (seed, name) always yields the
 * same child, so streams can be re-derived rather than serialised individually.
 */
export function forkSeed(parentSeed: number, streamName: string): number {
  let h = FNV_OFFSET_BASIS ^ (parentSeed >>> 0);
  for (let i = 0; i < streamName.length; i += 1) {
    h ^= streamName.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Creates a named child stream from a parent seed. */
export function forkRng(parentSeed: number, streamName: string): RngState {
  return createRng(forkSeed(parentSeed, streamName));
}

/** Serialises a stream to a single uint32. */
export function serializeRng(rng: RngState): number {
  return rng.s >>> 0;
}

/** Restores a stream in place from a serialised uint32. Allocates nothing. */
export function deserializeRng(rng: RngState, serialized: number): void {
  rng.s = serialized >>> 0;
}

/** Largest value `nextU32` can return. Exported for tests and range maths. */
export const RNG_U32_MAX = U32_MAX;

/**
 * The named streams the sim owns.
 *
 * Add a stream here rather than reusing an existing one. Sharing is the failure
 * mode this whole mechanism exists to prevent.
 */
export const RNG_STREAMS = {
  /** Track layout: chunks, obstacle placement, difficulty rolls. */
  generator: "generator",
  /** Pickup contents and rarity rolls. Separate so a Shard roll cannot shift geometry. */
  pickup: "pickup",
  /** Purely visual: debris, particles, prop dressing. Never affects gameplay. */
  cosmetic: "cosmetic",
} as const;

export type RngStreamName = (typeof RNG_STREAMS)[keyof typeof RNG_STREAMS];
