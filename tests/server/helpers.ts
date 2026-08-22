/**
 * Shared fixtures for the P12 suite.
 *
 * ## Replays here are REAL
 *
 * Every replay in these tests is produced by running the actual sim and
 * serialising the actual recorder. Nothing is hand-assembled except where a test
 * is specifically about a malformed header.
 *
 * That matters more than it sounds. A hand-built "valid" replay tests that the
 * verifier agrees with the test author's idea of the format; a recorded one
 * tests that the verifier agrees with the game. Only the second catches the case
 * that actually happens — the sim changing under a format that did not.
 */

import { createIntent, type Intent } from "@/game/sim/intent";
import { createSim } from "@/game/sim/sim";
import { createRecorder, record, serializeReplay } from "@/game/sim/replay";
import { createMemoryStore, resetAllLimiters, setStore, type Store } from "@/server";

/** How a scripted player behaves on a given tick. */
export type Script = (tick: number, intent: Intent) => void;

/** Does nothing. A passive run — the player stands still and eventually dies. */
export const passive: Script = () => {
  /* no input */
};

/**
 * Changes lane every `period` ticks.
 *
 * At `period = 1` this is a direction change every tick — 60 a second, four
 * times the human ceiling — which is the bot signature the density check exists
 * to catch.
 */
export function alternating(period: number): Script {
  return (tick, intent) => {
    if (tick % period === 0) {
      intent.lateral = intent.lateral === 1 ? -1 : 1;
    }
  };
}

/** A recorded run: the bytes, plus what the sim actually produced. */
export interface RecordedRun {
  readonly bytes: Uint8Array;
  readonly seed: number;
  readonly shards: number;
  readonly tickCount: number;
  readonly hash: number;
}

/**
 * Plays a run and serialises it, exactly as the client does.
 *
 * `shards` is threaded through to `createSim` because it is part of the
 * simulated state and therefore part of the hash — a run recorded with nine
 * Shards and verified with zero produces a mismatch, which is the bug this phase
 * found and fixed.
 */
export function recordRun(
  seed: number,
  ticks: number,
  script: Script = passive,
  shards = 0,
): RecordedRun {
  const sim = createSim(seed, { shards });
  const recorder = createRecorder(seed);
  const intent = createIntent();

  for (let tick = 0; tick < ticks; tick += 1) {
    script(tick, intent);
    record(recorder, intent);
    sim.tick(intent);
  }

  const hash = sim.hash();
  return {
    bytes: serializeReplay(recorder, hash),
    seed,
    shards,
    tickCount: recorder.tickCount,
    hash,
  };
}

/** base64, as the wire format carries it. */
export function toBlob(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Flips one byte of the intent log.
 *
 * The forgery this suite cares most about: the header still claims the original
 * hash, but the inputs no longer produce it. Re-simulation is the only check
 * that catches this — the header parses perfectly.
 */
export function tamperInputs(bytes: Uint8Array, at = 40): Uint8Array {
  const copy = new Uint8Array(bytes);
  const index = Math.min(at, copy.length - 1);
  copy[index] = (copy[index] ?? 0) ^ 0b11;
  return copy;
}

/** Rewrites the claimed final hash. The "I scored a billion" forgery. */
export function tamperHash(bytes: Uint8Array, claimed: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const OFFSET_FINAL_HASH = 16;
  view.setUint32(OFFSET_FINAL_HASH, claimed >>> 0, true);
  return copy;
}

/** Rewrites the seed in the header, leaving everything else alone. */
export function tamperSeed(bytes: Uint8Array, seed: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const OFFSET_SEED = 8;
  view.setUint32(OFFSET_SEED, seed >>> 0, true);
  return copy;
}

/**
 * A clean store and clean limiters for one test.
 *
 * Both are module-level singletons in production — they have to be, since a
 * store rebuilt per request remembers no nonces and a limiter rebuilt per
 * request limits nothing. So each test installs its own rather than inheriting
 * the previous test's state, which is the difference between an independent
 * suite and one whose results depend on file order.
 */
export function freshStore(): Store {
  const store = createMemoryStore();
  setStore(store);
  resetAllLimiters();
  return store;
}
