/**
 * Token-bucket rate limiting. Item 3's "rate limit per session and per IP".
 *
 * ## Why a token bucket rather than a fixed window
 *
 * A fixed window ("100 per minute") has a seam: an attacker sends 100 at
 * 00:00:59 and 100 more at 00:01:00, so the real burst is 200 in a second. A
 * token bucket has no seam — it refills continuously, so the long-run rate and
 * the instantaneous burst are two separate, independently chosen numbers. That
 * matters here because the honest traffic shape is bursty (a player finishes
 * three runs in a row) while the abusive shape is sustained.
 *
 * ## Both buckets must pass
 *
 * Per-session alone is worthless: identities are free and anonymous by design
 * (item 4 — "do not gate the first run behind a signup"), so an attacker takes a
 * new one per submission. Per-IP alone punishes a shared NAT. Requiring both
 * means the session bucket stops one player hammering, and the IP bucket bounds
 * the total regardless of how many identities are behind it.
 *
 * ## The clock is injected
 *
 * Every function takes `now`. Tests advance a number instead of sleeping, which
 * is the difference between a rate-limit suite that runs in 3ms and one that
 * runs in 30 seconds and is flaky on CI.
 */

/** One bucket's configuration. */
export interface BucketConfig {
  /** Maximum tokens held. The burst. */
  readonly capacity: number;
  /** ms to earn one token. The sustained rate. */
  readonly refillMs: number;
}

interface BucketState {
  /** Fractional, so a partial refill is not lost to rounding on every call. */
  tokens: number;
  lastRefillAt: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds until one token is available. Zero when allowed. */
  readonly retryAfterSeconds: number;
  /** Whole tokens left after this call. Diagnostics and headers. */
  readonly remaining: number;
}

const MS_PER_SECOND = 1000;

/**
 * A keyed collection of buckets.
 *
 * Entries are swept lazily rather than on a timer: a bucket that has been full
 * for longer than its own refill window carries no information — it is
 * indistinguishable from a fresh one — so it can be dropped. That keeps the map
 * bounded by *active* clients rather than by every client ever seen, without a
 * background interval to leak.
 */
export interface RateLimiter {
  /** Takes one token if available. */
  take(key: string, now?: number): RateLimitVerdict;
  /** Inspects without taking. */
  peek(key: string, now?: number): RateLimitVerdict;
  /** Live bucket count. Diagnostics. */
  readonly size: number;
  reset(): void;
}

export function createRateLimiter(config: BucketConfig): RateLimiter {
  const buckets = new Map<string, BucketState>();
  /** How many `take` calls between sweeps. Amortised, so a sweep is never hot. */
  const SWEEP_INTERVAL = 512;
  let sinceSweep = 0;

  /** Drops buckets that have refilled to full and so hold no state. */
  function sweep(now: number): void {
    const idleFor = config.capacity * config.refillMs;
    for (const [key, state] of buckets) {
      if (now - state.lastRefillAt > idleFor) {
        buckets.delete(key);
      }
    }
  }

  function refill(state: BucketState, now: number): void {
    const elapsed = now - state.lastRefillAt;
    if (elapsed <= 0) {
      return;
    }
    const earned = elapsed / config.refillMs;
    state.tokens = Math.min(config.capacity, state.tokens + earned);
    state.lastRefillAt = now;
  }

  function bucketFor(key: string, now: number): BucketState {
    let state = buckets.get(key);
    if (state === undefined) {
      state = { tokens: config.capacity, lastRefillAt: now };
      buckets.set(key, state);
    } else {
      refill(state, now);
    }
    return state;
  }

  function verdict(state: BucketState, allowed: boolean): RateLimitVerdict {
    if (allowed) {
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(state.tokens) };
    }
    const deficit = 1 - state.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((deficit * config.refillMs) / MS_PER_SECOND)),
      remaining: 0,
    };
  }

  return {
    take(key: string, now: number = Date.now()): RateLimitVerdict {
      sinceSweep += 1;
      if (sinceSweep >= SWEEP_INTERVAL) {
        sinceSweep = 0;
        sweep(now);
      }

      const state = bucketFor(key, now);
      if (state.tokens < 1) {
        return verdict(state, false);
      }
      state.tokens -= 1;
      return verdict(state, true);
    },

    peek(key: string, now: number = Date.now()): RateLimitVerdict {
      const state = bucketFor(key, now);
      return verdict(state, state.tokens >= 1);
    },

    get size(): number {
      return buckets.size;
    },

    reset(): void {
      buckets.clear();
      sinceSweep = 0;
    },
  };
}

/**
 * The two limiters every submission passes, plus the identity one.
 *
 * Module-level, because a limiter rebuilt per request remembers nothing and
 * limits nothing. Same reasoning as the store singleton.
 */
import { SERVER_CONFIG } from "./config";

export const submitLimiter = createRateLimiter(SERVER_CONFIG.submitRateLimit);
export const ipLimiter = createRateLimiter(SERVER_CONFIG.ipRateLimit);
export const identityLimiter = createRateLimiter(SERVER_CONFIG.identityRateLimit);

/** Clears every shared limiter. Tests only. */
export function resetAllLimiters(): void {
  submitLimiter.reset();
  ipLimiter.reset();
  identityLimiter.reset();
}
