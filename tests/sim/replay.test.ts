import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  createRecorder,
  packIntent,
  parseReplay,
  record,
  ReplayRejection,
  resetRecorder,
  serializeReplay,
  unpackIntent,
  verify,
} from "@/game/sim/replay";
import { createIntent, type Intent } from "@/game/sim/intent";
import { createSim } from "@/game/sim/sim";
import { createRng, nextInt } from "@/game/sim/rng";
import { F, getF } from "@/game/sim/state";
import { getScore } from "@/game/sim/scoring/score";

const HEADER_BYTES = TUNING.replay.headerBytes;
const TICK_RATE = TUNING.sim.tickRate;
const RUN_SEED = 0x5eed1234;

/** Every legal combination: 3 lateral x 3 roll x 2 jump x 2 slide x 2 overdrive = 72.
 *  Overdrive joined the byte at v3, in bit 6 that v2 required to be zero. */
function allIntents(): Intent[] {
  const out: Intent[] = [];
  for (const lateral of [-1, 0, 1]) {
    for (const roll of [-1, 0, 1]) {
      for (const jump of [false, true]) {
        for (const slide of [false, true]) {
          for (const overdrive of [false, true]) {
            out.push({ lateral, roll, jump, slide, overdrive });
          }
        }
      }
    }
  }
  return out;
}

describe("intent bit packing", () => {
  it("round-trips all 36 combinations", () => {
    const out = createIntent();
    for (const intent of allIntents()) {
      unpackIntent(packIntent(intent), out);
      expect(out).toEqual(intent);
    }
  });

  it("fits in one byte", () => {
    for (const intent of allIntents()) {
      const packed = packIntent(intent);
      expect(packed).toBeGreaterThanOrEqual(0);
      expect(packed).toBeLessThanOrEqual(0xff);
    }
  });

  it("uses only the low 7 bits, leaving one spare", () => {
    // Bit 6 became OVERDRIVE at v3. Bit 7 is the last one free — spend it
    // deliberately, because the next verb after that costs a second byte per
    // tick and doubles every stored replay.
    const RESERVED_MASK = 0b10000000;
    for (const intent of allIntents()) {
      expect(packIntent(intent) & RESERVED_MASK).toBe(0);
    }
  });

  it("gives every combination a distinct encoding", () => {
    const codes = new Set(allIntents().map(packIntent));
    expect(codes.size).toBe(72);
  });
});

describe("recording", () => {
  it("records one byte per tick", () => {
    const recorder = createRecorder(RUN_SEED);
    const intent = createIntent();
    for (let i = 0; i < 500; i += 1) {
      record(recorder, intent);
    }
    expect(recorder.tickCount).toBe(500);
    expect(recorder.overflowed).toBe(false);
  });

  it("preallocates and never grows", () => {
    const recorder = createRecorder(RUN_SEED);
    const before = recorder.intents.byteLength;
    const intent = createIntent();
    for (let i = 0; i < 10_000; i += 1) {
      record(recorder, intent);
    }
    expect(recorder.intents.byteLength).toBe(before);
    expect(before).toBe(TUNING.replay.maxTicks);
  });

  it("truncates rather than throwing past capacity", () => {
    // Killing an exceptional run at the 30-minute mark to protect a buffer is
    // the wrong trade. The run continues; only the replay is truncated.
    const recorder = createRecorder(RUN_SEED);
    const intent = createIntent();
    for (let i = 0; i < TUNING.replay.maxTicks + 100; i += 1) {
      record(recorder, intent);
    }
    expect(recorder.tickCount).toBe(TUNING.replay.maxTicks);
    expect(recorder.overflowed).toBe(true);
  });

  it("resets cleanly", () => {
    const recorder = createRecorder(RUN_SEED);
    record(recorder, { lateral: 1, roll: -1, jump: true, slide: true, overdrive: false });
    resetRecorder(recorder);
    expect(recorder.tickCount).toBe(0);
    expect(recorder.overflowed).toBe(false);
    expect(recorder.intents[0]).toBe(0);
  });
});

describe("60-second round trip", () => {
  const SIXTY_SECONDS_TICKS = TICK_RATE * 60;

  /** Records a full 60-second run with varied input. */
  function recordRun(seed: number) {
    const sim = createSim(seed);
    const recorder = createRecorder(seed);
    const rng = createRng(seed);
    const intent = createIntent();
    const AXIS_CHOICES = 3;
    const BOOL_CHOICES = 2;

    for (let i = 0; i < SIXTY_SECONDS_TICKS; i += 1) {
      intent.lateral = nextInt(rng, 0, AXIS_CHOICES) - 1;
      intent.roll = nextInt(rng, 0, AXIS_CHOICES) - 1;
      intent.jump = nextInt(rng, 0, BOOL_CHOICES) === 1;
      intent.slide = nextInt(rng, 0, BOOL_CHOICES) === 1;

      record(recorder, intent);
      sim.tick(intent);
    }

    return { sim, recorder, hash: sim.hash(), state: sim.getState() };
  }

  it("serializes, deserializes and verifies to the same score", () => {
    const run = recordRun(RUN_SEED);
    const expectedScore = getScore(run.state);
    const expectedDistance = getF(run.state, F.distance);

    const bytes = serializeReplay(run.recorder, run.hash);
    const result = verify(bytes);

    expect(result.valid).toBe(true);
    expect(result.rejection).toBe(ReplayRejection.None);
    expect(result.score).toBe(expectedScore);
    expect(result.distance).toBe(expectedDistance);

    // Guard against this assertion going vacuous. It did exactly that between
    // P08 landing and the audit: `verify()` read the dead `F.score` slot, so
    // both sides of the comparison were 0 and a broken server-side score — the
    // authoritative number for the entire leaderboard — passed its own test.
    expect(expectedScore).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0);
    expect(result.hash).toBe(run.hash);
    expect(result.ticksSimulated).toBe(SIXTY_SECONDS_TICKS);
  });

  it("is one byte per tick plus a 20-byte header", () => {
    const run = recordRun(RUN_SEED);
    const bytes = serializeReplay(run.recorder, run.hash);
    expect(bytes.length).toBe(HEADER_BYTES + SIXTY_SECONDS_TICKS);
    // 60 seconds of input in under 4KB.
    expect(bytes.length).toBeLessThan(4096);
  });

  it("verifies identically on repeated runs", () => {
    const run = recordRun(RUN_SEED);
    const bytes = serializeReplay(run.recorder, run.hash);
    const first = verify(bytes);
    for (let i = 0; i < 10; i += 1) {
      const again = verify(bytes);
      expect(again.hash).toBe(first.hash);
      expect(again.score).toBe(first.score);
    }
  });

  it("round-trips through a plain byte copy, as a network transfer would", () => {
    const run = recordRun(RUN_SEED);
    const bytes = serializeReplay(run.recorder, run.hash);
    const transferred = Uint8Array.from(bytes);
    expect(verify(transferred).valid).toBe(true);
  });
});

describe("header parsing", () => {
  function validBytes(): Uint8Array {
    const recorder = createRecorder(RUN_SEED);
    const sim = createSim(RUN_SEED);
    const intent = createIntent();
    for (let i = 0; i < 100; i += 1) {
      record(recorder, intent);
      sim.tick(intent);
    }
    return serializeReplay(recorder, sim.hash());
  }

  it("reads back what it wrote", () => {
    const parsed = parseReplay(validBytes());
    expect(parsed.ok).toBe(true);
    expect(parsed.header?.seed).toBe(RUN_SEED);
    expect(parsed.header?.tickCount).toBe(100);
    expect(parsed.header?.tickRate).toBe(TICK_RATE);
    expect(parsed.header?.version).toBe(TUNING.replay.formatVersion);
  });

  it("rejects a buffer too short to hold a header", () => {
    const result = parseReplay(new Uint8Array(HEADER_BYTES - 1));
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(ReplayRejection.TooShort);
  });

  it("rejects bad magic", () => {
    const bytes = validBytes();
    bytes[0] = 0x00;
    expect(parseReplay(bytes).rejection).toBe(ReplayRejection.BadMagic);
  });

  it("rejects a version mismatch instead of guessing", () => {
    const bytes = validBytes();
    bytes[4] = TUNING.replay.formatVersion + 1;
    expect(parseReplay(bytes).rejection).toBe(ReplayRejection.VersionMismatch);
  });

  it("rejects a tick-rate mismatch", () => {
    // Replaying a 60Hz log at another rate yields a plausible but wrong score,
    // which is worse than an error. This is why tickRate is in the header.
    const bytes = validBytes();
    const view = new DataView(bytes.buffer);
    view.setUint16(6, 30, true);
    expect(parseReplay(bytes).rejection).toBe(ReplayRejection.TickRateMismatch);
  });

  it("rejects a truncated payload", () => {
    const bytes = validBytes();
    expect(parseReplay(bytes.slice(0, bytes.length - 10)).rejection).toBe(
      ReplayRejection.TruncatedPayload,
    );
  });

  it("rejects a payload longer than the header claims", () => {
    const bytes = validBytes();
    const padded = new Uint8Array(bytes.length + 5);
    padded.set(bytes);
    expect(parseReplay(padded).rejection).toBe(ReplayRejection.TruncatedPayload);
  });
});

describe("the anti-cheat", () => {
  function runAndSerialize(seed: number, ticks: number) {
    const sim = createSim(seed);
    const recorder = createRecorder(seed);
    const intent = createIntent();
    for (let i = 0; i < ticks; i += 1) {
      record(recorder, intent);
      sim.tick(intent);
    }
    return { bytes: serializeReplay(recorder, sim.hash()), sim };
  }

  it("rejects a tampered final hash", () => {
    const { bytes } = runAndSerialize(RUN_SEED, 300);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 0xdeadbeef, true);

    const result = verify(bytes);
    expect(result.valid).toBe(false);
    expect(result.rejection).toBe(ReplayRejection.HashMismatch);
  });

  it("rejects a tampered input log", () => {
    // This was a canary through P02: with the player controller stubbed, input
    // changed nothing and a tampered log still verified. P04 landed the
    // controller, so a single flipped input now diverges the whole run and the
    // hash no longer matches. The anti-cheat is fully closed as of here.
    const { bytes } = runAndSerialize(RUN_SEED, 300);
    bytes[HEADER_BYTES + 150] = packIntent({
      lateral: 1,
      roll: 1,
      jump: true,
      slide: true,
      overdrive: false,
    });

    const result = verify(bytes);
    expect(result.valid).toBe(false);
    expect(result.rejection).toBe(ReplayRejection.HashMismatch);
  });

  it("a single flipped lateral bit, once, mid-run, is caught", () => {
    // Not just gross tampering. One input, changed once, 300 ticks from the end.
    const { bytes } = runAndSerialize(RUN_SEED, 600);
    const target = HEADER_BYTES + 300;
    const LATERAL_MASK = 0b11;
    const LATERAL_RIGHT = 2; // encoded as lateral + 1
    bytes[target] = ((bytes[target] ?? 0) & ~LATERAL_MASK) | LATERAL_RIGHT;

    expect(verify(bytes).valid).toBe(false);
  });

  it("a hash-neutral edit is also score-neutral, so it is not a cheat", () => {
    // Worth stating plainly, because it looks like a hole and is not. Inserting
    // a lone jump in open space heals completely — every timer returns to zero
    // and the player lands where they started — so the final hash still
    // matches. But the server RECOMPUTES the score from the log rather than
    // reading a claimed one, and an edit that changes nothing about the final
    // state changes nothing about the score either. There is nothing to gain.
    const { bytes, sim } = runAndSerialize(RUN_SEED, 600);
    const honestScore = getScore(sim.getState());

    const target = HEADER_BYTES + 300;
    const JUMP_BIT = 0b00010000;
    bytes[target] = (bytes[target] ?? 0) ^ JUMP_BIT;

    const result = verify(bytes);
    expect(result.valid).toBe(true);
    expect(result.score).toBe(honestScore);
  });

  it("rejects a tampered seed", () => {
    const { bytes } = runAndSerialize(RUN_SEED, 300);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 0x99999999, true);
    expect(verify(bytes).valid).toBe(false);
  });

  it("THE POINT: there is nowhere in the format to put a score", () => {
    // A client cannot claim a score because the wire format has no field for
    // one. The server computes it from seed + inputs, full stop.
    const { bytes, sim } = runAndSerialize(RUN_SEED, 600);
    const result = verify(bytes);

    expect(result.score).toBe(getScore(sim.getState()));
    expect(result.distance).toBeCloseTo(getF(sim.getState(), F.distance), 12);
    // Header is exactly the documented 20 bytes: no room for a score field.
    expect(HEADER_BYTES).toBe(20);
  });

  it("reports zeroes rather than throwing on garbage input", () => {
    const garbage = new Uint8Array(64);
    const result = verify(garbage);
    expect(result.valid).toBe(false);
    expect(result.score).toBe(0);
    expect(result.ticksSimulated).toBe(0);
  });

  it("handles an empty replay", () => {
    const recorder = createRecorder(RUN_SEED);
    const sim = createSim(RUN_SEED);
    const bytes = serializeReplay(recorder, sim.hash());
    const result = verify(bytes);
    expect(result.valid).toBe(true);
    expect(result.ticksSimulated).toBe(0);
  });
});
