/**
 * Rate limiting, on an injected clock.
 *
 * Every test here advances a number instead of sleeping. A rate-limit suite that
 * waits for real seconds is a suite that takes half a minute and goes flaky on a
 * loaded CI box — and the thing it would be testing is `setTimeout`, not the
 * bucket.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeRunToken,
  createRateLimiter,
  issueRunToken,
  submitRun,
  type PlayerRecord,
  type Store,
} from "@/server";
import { SERVER_CONFIG } from "@/server";
import { freshStore, passive, recordRun, toBlob } from "./helpers";

describe("token bucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const limiter = createRateLimiter({ capacity: 3, refillMs: 1000 });
    const t = 0;

    expect(limiter.take("a", t).allowed).toBe(true);
    expect(limiter.take("a", t).allowed).toBe(true);
    expect(limiter.take("a", t).allowed).toBe(true);

    const refused = limiter.take("a", t);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    // Actionable, and the only detail a refusal volunteers.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refills continuously rather than in windows", () => {
    // The reason this is a bucket and not a fixed window: a window has a seam
    // where 2x the intended burst gets through, and a bucket has none.
    const limiter = createRateLimiter({ capacity: 2, refillMs: 1000 });

    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(false);

    // Half a token later: still nothing.
    expect(limiter.take("a", 500).allowed).toBe(false);
    // One token later: exactly one.
    expect(limiter.take("a", 1000).allowed).toBe(true);
    expect(limiter.take("a", 1000).allowed).toBe(false);
  });

  it("never exceeds capacity however long it idles", () => {
    const limiter = createRateLimiter({ capacity: 2, refillMs: 100 });
    limiter.take("a", 0);
    limiter.take("a", 0);

    // An hour of idling must not bank an hour of tokens.
    const HOUR = 3_600_000;
    expect(limiter.take("a", HOUR).allowed).toBe(true);
    expect(limiter.take("a", HOUR).allowed).toBe(true);
    expect(limiter.take("a", HOUR).allowed).toBe(false);
  });

  it("keys are independent", () => {
    const limiter = createRateLimiter({ capacity: 1, refillMs: 1000 });
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(false);
    // A different player is not punished for the first one's traffic.
    expect(limiter.take("b", 0).allowed).toBe(true);
  });

  it("peek does not consume", () => {
    const limiter = createRateLimiter({ capacity: 1, refillMs: 1000 });
    expect(limiter.peek("a", 0).allowed).toBe(true);
    expect(limiter.peek("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.peek("a", 0).allowed).toBe(false);
  });

  it("forgets idle buckets so the map stays bounded", () => {
    const limiter = createRateLimiter({ capacity: 1, refillMs: 10 });
    const SWEEP_TRIGGER = 600;

    // A bucket that has refilled to full carries no information, so it can be
    // dropped. Without this the map grows by one entry per unique client, ever.
    for (let i = 0; i < SWEEP_TRIGGER; i += 1) {
      limiter.take(`client-${i}`, i * 1000);
    }
    expect(limiter.size).toBeLessThan(SWEEP_TRIGGER);
  });
});

describe("submission limits engage on the real path", () => {
  let store: Store;
  let player: PlayerRecord;

  beforeEach(async () => {
    store = freshStore();
    player = await store.createPlayer("Tester");
  });

  it("refuses once a session exceeds its burst", async () => {
    const burst = SERVER_CONFIG.submitRateLimit.capacity;
    const TICKS = 200;

    // Each submission needs its own token — they are single-use — so this really
    // does exercise the rate limiter rather than the nonce check.
    let refusals = 0;
    for (let i = 0; i <= burst; i += 1) {
      const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
      const run = recordRun(issued.seed, TICKS, passive);
      const result = await submitRun(
        { runToken: issued.token, replayBlob: toBlob(run.bytes), elapsedMs: 5000 },
        player,
        store,
      );
      if (!result.ok && result.reason === "rate-limited") {
        refusals += 1;
      }
    }

    expect(refusals).toBeGreaterThan(0);
  });

  it("does not spend a token when the rate limit refuses", async () => {
    const burst = SERVER_CONFIG.submitRateLimit.capacity;
    const TICKS = 200;

    // Exhaust the bucket.
    for (let i = 0; i < burst; i += 1) {
      const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
      const run = recordRun(issued.seed, TICKS, passive);
      await submitRun(
        { runToken: issued.token, replayBlob: toBlob(run.bytes), elapsedMs: 5000 },
        player,
        store,
      );
    }

    // This one is refused for rate. Its token must survive — otherwise a burst
    // of traffic silently destroys runs the player legitimately earned, which is
    // the worst possible interaction between two safety mechanisms.
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    const run = recordRun(issued.seed, TICKS, passive);
    const refused = await submitRun(
      { runToken: issued.token, replayBlob: toBlob(run.bytes), elapsedMs: 5000 },
      player,
      store,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("rate-limited");
    }

    // Proof the nonce is still unspent: consuming it now succeeds. If the
    // refused submission had burned it, this would come back
    // `token-already-used`. That is the assertion the ordering in `submitRun`
    // exists to make true — rate limit BEFORE the token spend.
    const spend = await consumeRunToken(issued.token, player.playerId, store);
    expect(spend.ok, spend.ok ? "" : spend.reason).toBe(true);
  });
});
