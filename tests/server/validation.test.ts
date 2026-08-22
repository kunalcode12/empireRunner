/**
 * The anti-cheat, tested against the real sim.
 *
 * Every case the brief names is here: a forged replay is rejected, a valid
 * replay validates, a replay from a different seed is rejected, a token cannot
 * be reused, superhuman input density is rejected.
 *
 * Plus the one this phase discovered: a run recorded with starting Shards
 * verifies only when the server re-simulates with the same Shards. That test is
 * the reason `VerifyOptions` exists.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { verify } from "@/game/sim/replay";
import {
  consumeRunToken,
  issueRunToken,
  submitRun,
  validateSubmission,
  Verdict,
  type PlayerRecord,
  type Store,
} from "@/server";
import {
  alternating,
  freshStore,
  passive,
  recordRun,
  tamperHash,
  tamperInputs,
  tamperSeed,
  toBlob,
} from "./helpers";

const SEED = 0x5eed_1234;
const TICKS = 600;

let store: Store;
let player: PlayerRecord;

beforeEach(async () => {
  store = freshStore();
  player = await store.createPlayer("Tester");
});

describe("re-simulation", () => {
  it("validates a genuine replay and computes its own score", () => {
    const run = recordRun(SEED, TICKS, passive);

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.Valid);
    expect(result.tickCount).toBe(TICKS);
    // The score came out of the re-simulation. There is nowhere in the wire
    // format to put a client score, so there is nothing to have trusted.
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("rejects a replay whose INPUTS were altered", () => {
    // The interesting forgery. The header still claims the original hash and
    // parses perfectly; only re-simulation can tell that the inputs no longer
    // produce it.
    const run = recordRun(SEED, TICKS, passive);
    const forged = tamperInputs(run.bytes);

    const result = validateSubmission({
      bytes: forged,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.InvalidReplay);
    expect(result.score).toBe(0);
  });

  it("rejects a replay claiming a hash it does not produce", () => {
    // The naive cheat, stated in the brief: "submitScore(999999999)". Here it is
    // the closest the format allows — a forged final hash.
    const run = recordRun(SEED, TICKS, passive);
    const forged = tamperHash(run.bytes, 0xdead_beef);

    const result = validateSubmission({
      bytes: forged,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.InvalidReplay);
    expect(result.score).toBe(0);
  });

  it("rejects a replay recorded on a DIFFERENT seed", () => {
    // A genuine replay of a layout the player chose. Everything about it is
    // honest except which dice were rolled — which is the whole reason the seed
    // is server-issued.
    const run = recordRun(SEED, TICKS, passive);

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED + 1,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.SeedMismatch);
    expect(result.score).toBe(0);
  });

  it("rejects a header whose seed was edited to match the issued one", () => {
    // The obvious follow-up to the previous test: play a farmed seed, then
    // rewrite the header to claim the issued one. The header now matches and the
    // inputs are genuine — but they are genuine for a DIFFERENT track, so the
    // re-simulation diverges immediately.
    const run = recordRun(SEED, TICKS, passive);
    const relabelled = tamperSeed(run.bytes, SEED + 99);

    const result = validateSubmission({
      bytes: relabelled,
      expectedSeed: SEED + 99,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.InvalidReplay);
  });

  it("rejects a truncated payload", () => {
    const run = recordRun(SEED, TICKS, passive);
    const truncated = run.bytes.slice(0, run.bytes.length - 10);

    const result = validateSubmission({
      bytes: truncated,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: 0,
    });

    expect(result.verdict).toBe(Verdict.InvalidReplay);
  });

  it("rejects a replay from a different format version", () => {
    const run = recordRun(SEED, TICKS, passive);
    const stale = new Uint8Array(run.bytes);
    const OFFSET_VERSION = 4;
    stale[OFFSET_VERSION] = TUNING.replay.formatVersion - 1;

    const result = validateSubmission({
      bytes: stale,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: 0,
    });

    expect(result.verdict).toBe(Verdict.InvalidReplay);
  });
});

describe("starting Shards are part of the simulated state", () => {
  const SHARDS = 9;

  it("verifies a Shard run ONLY when re-simulated with the same Shards", () => {
    // The bug this phase found. P14 gave `createSim` a `shards` option and
    // `hashState` mixes `player.shards`, but `verify()` always passed zero — so
    // every run by a player holding Shards verified as a forgery, and the more
    // they had invested the more certainly they were called a cheat.
    const run = recordRun(SEED, TICKS, passive, SHARDS);

    const withoutShards = verify(run.bytes);
    expect(withoutShards.valid, "zero-Shard re-sim should NOT match").toBe(false);

    const withShards = verify(run.bytes, { shards: SHARDS });
    expect(withShards.valid, "matching-Shard re-sim should match").toBe(true);
  });

  it("takes the Shard count from the signed token, not from the client", async () => {
    await store.updatePlayer(player.playerId, { shards: SHARDS });
    const updated = await store.getPlayer(player.playerId);
    expect(updated?.shards).toBe(SHARDS);

    const issued = issueRunToken({ playerId: player.playerId, shards: updated?.shards ?? 0 });
    expect(issued.shards).toBe(SHARDS);

    const run = recordRun(issued.seed, TICKS, passive, SHARDS);
    const result = await submitRun(
      { runToken: issued.token, replayBlob: toBlob(run.bytes), elapsedMs: 10_000 },
      { ...player, shards: SHARDS },
      store,
    );

    expect(result.ok, result.ok ? "" : result.message).toBe(true);
  });
});

describe("input density", () => {
  it("rejects a direction change every single tick", () => {
    // 60 changes a second against a sustained human ceiling of 14. This replay
    // re-simulates perfectly — it really was played — but not by hands.
    const run = recordRun(SEED, TICKS, alternating(1));

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.Implausible);
    expect(result.detail).toContain("density");
  });

  it("accepts a fast but human rate", () => {
    // A change every 10 ticks is 6 a second — brisk, deliberate play, and well
    // inside the ceiling. The bias is deliberately toward letting cheats through
    // rather than calling a real player a cheat.
    const run = recordRun(SEED, TICKS, alternating(10));

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: (TICKS / TUNING.sim.tickRate) * 1000,
    });

    expect(result.verdict).toBe(Verdict.Valid);
  });

  it("rejects a run shorter than the minimum", () => {
    const run = recordRun(SEED, TUNING.input.plausibility.minTicks - 1, passive);

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: 500,
    });

    expect(result.verdict).toBe(Verdict.Implausible);
  });
});

describe("wall clock against tick count", () => {
  it("rejects a run fast-forwarded through its input log", () => {
    // 600 ticks is 10 seconds of game time at a fixed 60Hz. Claiming it took
    // 200ms means the sim ran 50x faster than 60Hz, which no machine does — the
    // accumulator is fixed-rate by construction.
    const run = recordRun(SEED, TICKS, passive);

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: 200,
    });

    expect(result.verdict).toBe(Verdict.Implausible);
    expect(result.detail).toContain("wall-clock");
  });

  it("accepts a run that took LONGER than its ticks", () => {
    // Backgrounded tabs, throttled timers and paused runs all stretch wall clock
    // without stretching ticks. Only the downward direction is impossible.
    const run = recordRun(SEED, TICKS, passive);

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: 60_000,
    });

    expect(result.verdict).toBe(Verdict.Valid);
  });

  it("accepts a submission with no duration at all", () => {
    // An absent figure is not evidence. Rejecting it would break real clients to
    // catch a cheat who would simply start sending a plausible number.
    const run = recordRun(SEED, TICKS, passive);

    const result = validateSubmission({
      bytes: run.bytes,
      expectedSeed: SEED,
      shards: 0,
      elapsedMs: 0,
    });

    expect(result.verdict).toBe(Verdict.Valid);
  });
});

describe("run tokens", () => {
  it("cannot be reused", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });

    const first = await consumeRunToken(issued.token, player.playerId, store);
    expect(first.ok).toBe(true);

    const second = await consumeRunToken(issued.token, player.playerId, store);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("token-already-used");
    }
  });

  it("cannot be spent by a different session", async () => {
    const other = await store.createPlayer("Somebody else");
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });

    const stolen = await consumeRunToken(issued.token, other.playerId, store);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) {
      expect(stolen.reason).toBe("invalid-token");
    }

    // And critically: a rejected attempt must NOT have spent it. Otherwise an
    // attacker can burn anybody's token just by submitting it.
    const rightful = await consumeRunToken(issued.token, player.playerId, store);
    expect(rightful.ok).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const [payload] = issued.token.split(".");
    const forged = `${payload}.notasignature`;

    const result = await consumeRunToken(forged, player.playerId, store);
    expect(result.ok).toBe(false);
  });

  it("rejects a token whose payload was edited", async () => {
    // Re-encode the payload with a seed the attacker likes, keeping the original
    // signature. The MAC covers the encoded payload, so this cannot survive.
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const [, signature] = issued.token.split(".");
    const edited = Buffer.from(
      JSON.stringify({
        rid: "x",
        seed: 1,
        shards: 999,
        pid: player.playerId,
        iat: Date.now(),
        exp: Date.now() + 60_000,
        jti: "x",
      }),
      "utf8",
    ).toString("base64url");

    const result = await consumeRunToken(`${edited}.${signature ?? ""}`, player.playerId, store);
    expect(result.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const ttl = 15 * 60 * 1000;

    const original = Date.now;
    try {
      Date.now = () => original() + ttl + 1000;
      const result = await consumeRunToken(issued.token, player.playerId, store);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-token");
      }
    } finally {
      Date.now = original;
    }
  });
});

describe("the full submit path", () => {
  it("accepts a genuine run and records the SERVER's score", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const run = recordRun(issued.seed, TICKS, passive);

    const result = await submitRun(
      { runToken: issued.token, replayBlob: toBlob(run.bytes), elapsedMs: 10_000 },
      player,
      store,
    );

    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (result.ok) {
      const best = await store.getPlayerBest("all-time", "all", player.playerId);
      expect(best?.score).toBe(result.value.score);
    }
  });

  it("refuses a second submission of the same token", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const run = recordRun(issued.seed, TICKS, passive);
    const body = { runToken: issued.token, replayBlob: toBlob(run.bytes), elapsedMs: 10_000 };

    const first = await submitRun(body, player, store);
    expect(first.ok).toBe(true);

    const second = await submitRun(body, player, store);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("token-already-used");
    }
  });

  it("does not record anything when validation fails", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const run = recordRun(issued.seed, TICKS, passive);

    const result = await submitRun(
      { runToken: issued.token, replayBlob: toBlob(tamperInputs(run.bytes)), elapsedMs: 10_000 },
      player,
      store,
    );

    expect(result.ok).toBe(false);
    const best = await store.getPlayerBest("all-time", "all", player.playerId);
    expect(best).toBeNull();
  });

  it("rejects a blob that is not base64", async () => {
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const result = await submitRun(
      { runToken: issued.token, replayBlob: "!!!! not base64 !!!!", elapsedMs: 1000 },
      player,
      store,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a body missing its fields", async () => {
    const result = await submitRun({ nonsense: true }, player, store);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("bad-request");
    }
  });
});
