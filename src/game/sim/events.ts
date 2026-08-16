/**
 * Sim events — a fixed-size ring buffer.
 *
 * **This is the only channel from the sim to presentation.** No callbacks, no
 * emitters, no observers. The render and audio layers drain it once per frame.
 *
 * Why it has to be this way: a callback fired from inside the tick would let
 * presentation code run at an arbitrary point in the sim's execution, mutate
 * something, and allocate — killing determinism (law (a)) and the allocation
 * budget (law (d)) in one move. A ring buffer of plain numbers cannot do any of
 * that. The sim writes; consumers read; the coupling is one-way and inspectable.
 *
 * Storage is struct-of-arrays, so emitting an event writes a few numbers into
 * pre-allocated typed arrays and allocates nothing.
 */

import { TUNING } from "../config/tuning";

const CAPACITY = TUNING.pools.maxEvents;
const PAYLOAD_SLOTS = TUNING.pools.eventPayloadSlots;

/** Offsets within one event's payload block. Unrolled rather than looped: emit is hot. */
const SLOT_0 = 0;
const SLOT_1 = 1;
const SLOT_2 = 2;
const SLOT_3 = 3;

/**
 * Event kinds.
 *
 * Adding one is cheap; removing one breaks replay-adjacent tooling, so treat the
 * numeric values as stable once a replay format version has shipped.
 */
export const SimEvent = {
  None: 0,
  RunStart: 1,
  RunEnd: 2,
  /** A Bit, cluster member, or Shard was collected. payload0 = kind. */
  Coin: 3,
  /** Passed within nearMissRadius of a hazard. payload0 = obstacle index. */
  NearMiss: 4,
  /** Left the floor plane. */
  Jump: 5,
  /** Touched down. payload0 = impact vy. */
  Land: 6,
  SlideStart: 7,
  SlideEnd: 8,
  /** payload0 = direction (-1 left, +1 right), payload1 = destination face. */
  RollStart: 9,
  RollEnd: 10,
  LaneChange: 11,
  /** Fatal contact. payload0 = cause (see GAME_BIBLE §12). */
  Crash: 12,
  /** A shield absorbed a hit. Flow is NOT reset. */
  ShieldAbsorb: 13,
  OverdriveStart: 14,
  OverdriveEnd: 15,
  /** An obstacle was shattered during Overdrive. payload0 = obstacle index. */
  Shatter: 16,
  /** The Fracture window opened. payload0 = the single clearing verb. */
  FractureArm: 17,
  /** payload0 = 1 on success, 0 on failure. */
  FractureResolve: 18,
  /** Crossed a theme milestone. payload0 = theme id. */
  ThemeChange: 19,
  /** Crossed into a new difficulty band. payload0 = band index. */
  BandChange: 20,
  /** Flow crossed 100 and Overdrive armed. */
  FlowFull: 21,

  // ── P04 — player controller ────────────────────────────────────────────────
  /** Non-fatal contact. Speed penalty + recovery window. payload0 = stumble count. */
  Stumble: 22,
  /** Recovered from a stumble; control returned. */
  StumbleEnd: 23,
  /**
   * A clip of under `cornerForgiveness` was nudged clear instead of killing.
   *
   * Emitted so the rate can be MEASURED. This is a deliberately invisible
   * mechanic, and an invisible mechanic with no telemetry is one nobody can tune.
   * payload0 = penetration depth, payload1 = obstacle index.
   */
  CornerForgive: 24,
} as const;
export type SimEventValue = (typeof SimEvent)[keyof typeof SimEvent];

export interface EventRing {
  readonly capacity: number;
  readonly payloadSlots: number;
  /** Monotonic count of events ever emitted. Also the write cursor, pre-modulo. */
  head: number;
  /** Events dropped because a consumer did not drain in time. Diagnostic. */
  dropped: number;
  /** Event kind per slot. */
  readonly type: Int32Array;
  /** Sim tick the event was emitted on. */
  readonly tick: Int32Array;
  /** `payloadSlots` floats per slot, laid out contiguously. */
  readonly payload: Float64Array;
}

export function createEventRing(): EventRing {
  return {
    capacity: CAPACITY,
    payloadSlots: PAYLOAD_SLOTS,
    head: 0,
    dropped: 0,
    type: new Int32Array(CAPACITY),
    tick: new Int32Array(CAPACITY),
    payload: new Float64Array(CAPACITY * PAYLOAD_SLOTS),
  };
}

/**
 * Writes an event. Allocates nothing.
 *
 * All four payload slots are always written, so a slot never carries a stale
 * value from a previous event that happened to occupy the same ring position.
 */
export function emit(
  ring: EventRing,
  type: number,
  tick: number,
  payload0 = 0,
  payload1 = 0,
  payload2 = 0,
  payload3 = 0,
): void {
  const slot = ring.head % ring.capacity;
  const base = slot * ring.payloadSlots;

  ring.type[slot] = type;
  ring.tick[slot] = tick;
  ring.payload[base + SLOT_0] = payload0;
  ring.payload[base + SLOT_1] = payload1;
  ring.payload[base + SLOT_2] = payload2;
  ring.payload[base + SLOT_3] = payload3;

  ring.head += 1;
}

/**
 * The oldest event index still readable.
 *
 * Once `head` passes `capacity`, older events have been overwritten. A consumer
 * whose cursor has fallen behind that point has missed events; `drainFrom`
 * reports how many.
 */
export function oldestReadable(ring: EventRing): number {
  return ring.head <= ring.capacity ? 0 : ring.head - ring.capacity;
}

/**
 * Reads one event's kind by absolute index. Returns `SimEvent.None` if that
 * index has already been overwritten.
 */
export function eventTypeAt(ring: EventRing, index: number): number {
  if (index < oldestReadable(ring) || index >= ring.head) {
    return SimEvent.None;
  }
  return ring.type[index % ring.capacity] ?? SimEvent.None;
}

/** Reads the sim tick of an event by absolute index. */
export function eventTickAt(ring: EventRing, index: number): number {
  if (index < oldestReadable(ring) || index >= ring.head) {
    return 0;
  }
  return ring.tick[index % ring.capacity] ?? 0;
}

/** Reads one payload slot of an event by absolute index. */
export function eventPayloadAt(ring: EventRing, index: number, slot: number): number {
  if (index < oldestReadable(ring) || index >= ring.head || slot < 0 || slot >= ring.payloadSlots) {
    return 0;
  }
  const base = (index % ring.capacity) * ring.payloadSlots;
  return ring.payload[base + slot] ?? 0;
}

/**
 * Where a consumer should start reading, given where it left off.
 *
 * Consumers hold their own cursor — the ring holds no per-consumer state, so
 * render and audio can drain independently at different rates. If a cursor has
 * fallen off the back of the ring, this returns the oldest readable index and
 * the caller can compare against its own cursor to detect the gap.
 */
export function clampCursor(ring: EventRing, cursor: number): number {
  const oldest = oldestReadable(ring);
  return cursor < oldest ? oldest : cursor;
}

/**
 * Records that events were lost between `cursor` and the oldest readable index.
 * Returns the number missed, and is the only thing that increments `dropped`.
 */
export function accountForDropped(ring: EventRing, cursor: number): number {
  const oldest = oldestReadable(ring);
  if (cursor >= oldest) {
    return 0;
  }
  const missed = oldest - cursor;
  ring.dropped += missed;
  return missed;
}

/** Clears the ring. Called on reset, never inside the tick. */
export function resetEventRing(ring: EventRing): void {
  ring.head = 0;
  ring.dropped = 0;
  ring.type.fill(0);
  ring.tick.fill(0);
  ring.payload.fill(0);
}
