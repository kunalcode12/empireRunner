/**
 * Deterministic hashing of SimState — FNV-1a, 32-bit.
 *
 * This is the instrument the determinism law is measured with. Two runs of the
 * same seed and input log must produce the same hash, byte for byte
 * (docs/ARCHITECTURE.md §2a), and P12 puts this hash in the replay header so a
 * server re-simulation can be checked against the client's claim in one compare.
 *
 * Doubles are hashed by their IEEE-754 bit pattern rather than their decimal
 * form, so `0.1 + 0.2` and `0.30000000000000004` hash differently — which is
 * exactly what a determinism check needs. Reading the bits through a shared
 * Float64Array/Uint32Array view is exact and allocates nothing after module load.
 *
 * One portability note: the view reads bytes in the host's native order. Every
 * platform this ships to (x86-64, ARM64, WASM) is little-endian, so this is safe
 * in practice. A big-endian host would need a byte swap; no browser or Node
 * target currently is one.
 */

import type { EntityColumns, SimState } from "./state";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HEX_RADIX = 16;
const HEX_WIDTH = 8;

/** Shared scratch for reading the bits of a double. Allocated once, at module load. */
const scratchFloat = new Float64Array(1);
const scratchWords = new Uint32Array(scratchFloat.buffer);

/** Mixes one 32-bit word into the running hash. */
function mixWord(hash: number, word: number): number {
  let h = hash ^ (word >>> 0);
  h = Math.imul(h, FNV_PRIME);
  return h >>> 0;
}

/** Mixes a double in by its exact bit pattern, low word first. */
function mixFloat(hash: number, value: number): number {
  scratchFloat[0] = value;
  let h = mixWord(hash, scratchWords[0] ?? 0);
  h = mixWord(h, scratchWords[1] ?? 0);
  return h;
}

function mixInt32Array(hash: number, array: Int32Array, upTo: number): number {
  let h = hash;
  for (let i = 0; i < upTo; i += 1) {
    h = mixWord(h, array[i] ?? 0);
  }
  return h;
}

function mixUint8Array(hash: number, array: Uint8Array, upTo: number): number {
  let h = hash;
  for (let i = 0; i < upTo; i += 1) {
    h = mixWord(h, array[i] ?? 0);
  }
  return h;
}

function mixFloat64Array(hash: number, array: Float64Array, upTo: number): number {
  let h = hash;
  for (let i = 0; i < upTo; i += 1) {
    h = mixFloat(h, array[i] ?? 0);
  }
  return h;
}

/**
 * Hashes entity columns up to `count`, not up to `capacity`.
 *
 * Slots past `count` are unused, and their residue from earlier entities is not
 * part of the simulation's meaning. Hashing them would make the hash depend on
 * recycling history rather than on observable state, and two runs that agree on
 * everything the player can see would disagree on the hash.
 */
function mixEntityColumns(hash: number, columns: EntityColumns): number {
  const upTo = columns.count;
  let h = mixWord(hash, upTo);
  h = mixUint8Array(h, columns.active, upTo);
  h = mixInt32Array(h, columns.kind, upTo);
  h = mixInt32Array(h, columns.face, upTo);
  h = mixInt32Array(h, columns.lane, upTo);
  h = mixFloat64Array(h, columns.z, upTo);
  h = mixFloat64Array(h, columns.x, upTo);
  h = mixFloat64Array(h, columns.y, upTo);
  h = mixInt32Array(h, columns.flags, upTo);
  return h;
}

/**
 * Hashes the complete simulation state.
 *
 * Field order is part of the contract: changing it changes every hash, which
 * invalidates stored replays. Add new state at the END of `F` in state.ts and
 * bump `TUNING.replay.formatVersion`.
 */
export function hashState(state: SimState): number {
  let h = FNV_OFFSET_BASIS;

  h = mixFloat64Array(h, state.f, state.f.length);

  h = mixWord(h, state.tick);
  h = mixWord(h, state.runStatus);
  h = mixWord(h, state.band);
  h = mixWord(h, state.fracturesUsed);
  h = mixWord(h, state.rngGenerator);
  h = mixWord(h, state.rngPickup);
  h = mixWord(h, state.rngCosmetic);

  const p = state.player;
  h = mixWord(h, p.face);
  h = mixWord(h, p.lane);
  h = mixWord(h, p.phase);
  h = mixWord(h, p.verb);
  h = mixWord(h, p.bufferedVerb);
  h = mixWord(h, p.grounded);
  h = mixWord(h, p.shields);
  h = mixWord(h, p.rollDirection);
  h = mixWord(h, p.jumpHeld);
  h = mixWord(h, p.slideHeld);
  h = mixWord(h, p.targetLane);
  h = mixWord(h, p.cornerForgiveCount);
  h = mixWord(h, p.stumbleCount);

  h = mixEntityColumns(h, state.obstacles);
  h = mixEntityColumns(h, state.pickups);

  return h >>> 0;
}

/** Renders a hash as a stable 8-character hex string, for test output and logs. */
export function formatHash(hash: number): string {
  return (hash >>> 0).toString(HEX_RADIX).padStart(HEX_WIDTH, "0");
}
