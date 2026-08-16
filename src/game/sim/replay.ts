/**
 * Replay record, serialise and verify.
 *
 * This is the anti-cheat. A client submits a **seed and an input log**, never a
 * score. The server re-runs the identical simulation headlessly and computes the
 * score itself. A tampered score is rejected because the server never trusted
 * one in the first place (docs/ARCHITECTURE.md §6).
 *
 * That only works if the sim is deterministic, which is why this lands in P02
 * rather than P12 — building it now means every later phase is developed against
 * a working replay check, instead of discovering in month four that some system
 * quietly broke reproducibility.
 *
 * ## Wire format
 *
 * Little-endian. 20-byte header, then one byte per tick.
 *
 * ```
 *   offset  size  field
 *   0       4     magic        "AXIS"
 *   4       1     version      TUNING.replay.formatVersion
 *   5       1     flags        reserved, must be 0
 *   6       2     tickRate     Hz, uint16
 *   8       4     seed         uint32
 *   12      4     tickCount    uint32
 *   16      4     finalHash    uint32, FNV-1a of the final SimState
 *   20+     N     intents      one packed byte per tick
 * ```
 *
 * Intent packing, one byte:
 * ```
 *   bits 0-1  lateral + 1   (0 = left, 1 = none, 2 = right)
 *   bits 2-3  roll + 1
 *   bit  4    jump
 *   bit  5    slide
 *   bits 6-7  reserved, zero
 * ```
 *
 * A 30-minute run is 108,000 ticks = ~105KB, small enough to POST inline.
 *
 * ## Why the header carries tickRate
 *
 * `tickRate` is baked into every recorded run: the intents are indexed by tick,
 * so replaying a 60Hz log at any other rate silently produces a different score
 * rather than an error. Storing it means a mismatch is **rejected**, not
 * mis-scored. Same reasoning for `version` — bump it on any change to this
 * layout, the packing, or the tick order in sim.ts.
 */

import { TUNING } from "../config/tuning";
import { createIntent, type Intent } from "./intent";
import { createSim } from "./sim";
import { F, getF } from "./state";

const FORMAT_VERSION = TUNING.replay.formatVersion;
const HEADER_BYTES = TUNING.replay.headerBytes;
const MAX_TICKS = TUNING.replay.maxTicks;
const TICK_RATE = TUNING.sim.tickRate;

/** "AXIS" as four ASCII bytes. */
const MAGIC_0 = 0x41;
const MAGIC_1 = 0x58;
const MAGIC_2 = 0x49;
const MAGIC_3 = 0x53;

const OFFSET_VERSION = 4;
const OFFSET_FLAGS = 5;
const OFFSET_TICK_RATE = 6;
const OFFSET_SEED = 8;
const OFFSET_TICK_COUNT = 12;
const OFFSET_FINAL_HASH = 16;

const AXIS_MASK = 0b11;
const ROLL_SHIFT = 2;
const JUMP_SHIFT = 4;
const SLIDE_SHIFT = 5;
const BIT_SET = 1;
const LITTLE_ENDIAN = true;

/** Packs one intent into a single byte. */
export function packIntent(intent: Intent): number {
  const lateral = (intent.lateral + 1) & AXIS_MASK;
  const roll = (intent.roll + 1) & AXIS_MASK;
  const jump = intent.jump ? BIT_SET << JUMP_SHIFT : 0;
  const slide = intent.slide ? BIT_SET << SLIDE_SHIFT : 0;
  return lateral | (roll << ROLL_SHIFT) | jump | slide;
}

/** Unpacks a byte into an existing intent. Allocates nothing. */
export function unpackIntent(byte: number, out: Intent): void {
  out.lateral = (byte & AXIS_MASK) - 1;
  out.roll = ((byte >> ROLL_SHIFT) & AXIS_MASK) - 1;
  out.jump = ((byte >> JUMP_SHIFT) & BIT_SET) === BIT_SET;
  out.slide = ((byte >> SLIDE_SHIFT) & BIT_SET) === BIT_SET;
}

/**
 * An in-progress recording.
 *
 * The intent buffer is preallocated to `TUNING.replay.maxTicks` at construction,
 * so `record` never grows it mid-run. Recording is called from inside the tick
 * loop and must respect law (d).
 */
export interface Recorder {
  readonly seed: number;
  tickCount: number;
  readonly intents: Uint8Array;
  /** Set true once capacity is hit; further records are dropped rather than throwing. */
  overflowed: boolean;
}

export function createRecorder(seed: number): Recorder {
  return {
    seed: seed >>> 0,
    tickCount: 0,
    intents: new Uint8Array(MAX_TICKS),
    overflowed: false,
  };
}

/**
 * Records one tick's intent. Allocates nothing.
 *
 * Past capacity this sets `overflowed` and stops recording rather than throwing.
 * A 30-minute run is already far beyond any realistic session, and killing an
 * exceptional run at the 30-minute mark to protect a buffer would be the wrong
 * trade — the run continues, only the replay is truncated, and `overflowed`
 * makes that explicit to the submit path.
 */
export function record(recorder: Recorder, intent: Intent): void {
  if (recorder.tickCount >= MAX_TICKS) {
    recorder.overflowed = true;
    return;
  }
  recorder.intents[recorder.tickCount] = packIntent(intent);
  recorder.tickCount += 1;
}

export function resetRecorder(recorder: Recorder): void {
  recorder.tickCount = 0;
  recorder.overflowed = false;
  recorder.intents.fill(0);
}

/** A parsed replay header. */
export interface ReplayHeader {
  version: number;
  tickRate: number;
  seed: number;
  tickCount: number;
  finalHash: number;
}

/**
 * Serialises a recording into the wire format.
 *
 * `finalHash` is the caller's observed final state hash. The verifier recomputes
 * it independently and compares; that comparison is the whole cheat check.
 */
export function serializeReplay(recorder: Recorder, finalHash: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + recorder.tickCount);
  const view = new DataView(bytes.buffer);

  bytes[0] = MAGIC_0;
  bytes[1] = MAGIC_1;
  bytes[2] = MAGIC_2;
  bytes[3] = MAGIC_3;
  view.setUint8(OFFSET_VERSION, FORMAT_VERSION);
  view.setUint8(OFFSET_FLAGS, 0);
  view.setUint16(OFFSET_TICK_RATE, TICK_RATE, LITTLE_ENDIAN);
  view.setUint32(OFFSET_SEED, recorder.seed, LITTLE_ENDIAN);
  view.setUint32(OFFSET_TICK_COUNT, recorder.tickCount, LITTLE_ENDIAN);
  view.setUint32(OFFSET_FINAL_HASH, finalHash >>> 0, LITTLE_ENDIAN);

  bytes.set(recorder.intents.subarray(0, recorder.tickCount), HEADER_BYTES);
  return bytes;
}

/** Why a replay was rejected. */
export const ReplayRejection = {
  None: "none",
  TooShort: "too-short",
  BadMagic: "bad-magic",
  VersionMismatch: "version-mismatch",
  TickRateMismatch: "tick-rate-mismatch",
  TruncatedPayload: "truncated-payload",
  HashMismatch: "hash-mismatch",
} as const;
export type ReplayRejectionValue = (typeof ReplayRejection)[keyof typeof ReplayRejection];

export interface ParseResult {
  ok: boolean;
  rejection: ReplayRejectionValue;
  header: ReplayHeader | null;
}

/**
 * Parses and validates a replay header without simulating anything.
 *
 * Every rejection here is a cheap check that runs before the expensive
 * re-simulation, which matters when this is an unauthenticated public endpoint.
 */
export function parseReplay(bytes: Uint8Array): ParseResult {
  if (bytes.length < HEADER_BYTES) {
    return { ok: false, rejection: ReplayRejection.TooShort, header: null };
  }
  if (
    bytes[0] !== MAGIC_0 ||
    bytes[1] !== MAGIC_1 ||
    bytes[2] !== MAGIC_2 ||
    bytes[3] !== MAGIC_3
  ) {
    return { ok: false, rejection: ReplayRejection.BadMagic, header: null };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: ReplayHeader = {
    version: view.getUint8(OFFSET_VERSION),
    tickRate: view.getUint16(OFFSET_TICK_RATE, LITTLE_ENDIAN),
    seed: view.getUint32(OFFSET_SEED, LITTLE_ENDIAN),
    tickCount: view.getUint32(OFFSET_TICK_COUNT, LITTLE_ENDIAN),
    finalHash: view.getUint32(OFFSET_FINAL_HASH, LITTLE_ENDIAN),
  };

  if (header.version !== FORMAT_VERSION) {
    return { ok: false, rejection: ReplayRejection.VersionMismatch, header };
  }
  // Not a warning. Replaying a 60Hz log at another rate produces a plausible but
  // wrong score, which is worse than an error.
  if (header.tickRate !== TICK_RATE) {
    return { ok: false, rejection: ReplayRejection.TickRateMismatch, header };
  }
  if (bytes.length !== HEADER_BYTES + header.tickCount) {
    return { ok: false, rejection: ReplayRejection.TruncatedPayload, header };
  }

  return { ok: true, rejection: ReplayRejection.None, header };
}

export interface VerifyResult {
  /** True only if the replay parsed AND the re-simulated hash matched the claim. */
  valid: boolean;
  rejection: ReplayRejectionValue;
  /** Score the server computed. This is the authoritative one. */
  score: number;
  /** Distance the server computed, in metres. */
  distance: number;
  /** Hash the server computed. */
  hash: number;
  /** Hash the replay claimed. */
  claimedHash: number;
  ticksSimulated: number;
}

/**
 * Re-runs a replay headlessly and reports what actually happened.
 *
 * The returned `score` is computed here, from the seed and the inputs. It is
 * never read from the payload — there is nowhere in the format to put one.
 */
export function verify(bytes: Uint8Array): VerifyResult {
  const parsed = parseReplay(bytes);
  if (!parsed.ok || parsed.header === null) {
    return {
      valid: false,
      rejection: parsed.rejection,
      score: 0,
      distance: 0,
      hash: 0,
      claimedHash: parsed.header?.finalHash ?? 0,
      ticksSimulated: 0,
    };
  }

  const header = parsed.header;
  const sim = createSim(header.seed);
  const intent = createIntent();

  for (let i = 0; i < header.tickCount; i += 1) {
    unpackIntent(bytes[HEADER_BYTES + i] ?? 0, intent);
    sim.tick(intent);
  }

  const state = sim.getState();
  const hash = sim.hash();

  return {
    valid: hash === header.finalHash,
    rejection: hash === header.finalHash ? ReplayRejection.None : ReplayRejection.HashMismatch,
    score: getF(state, F.score),
    distance: getF(state, F.distance),
    hash,
    claimedHash: header.finalHash,
    ticksSimulated: header.tickCount,
  };
}
