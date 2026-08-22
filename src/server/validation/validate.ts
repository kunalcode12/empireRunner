/**
 * One submission, start to verdict. Item 2 of the threat model.
 *
 * ## The order of the checks is the design
 *
 * Cheapest first, and every step that can reject does so before the expensive
 * one runs. This is an unauthenticated-adjacent public endpoint that accepts up
 * to 108,000 ticks of CPU work per call, so the sequencing is a denial-of-service
 * property, not a style preference:
 *
 * ```
 *   1. header parse        bytes, no simulation      — kills garbage instantly
 *   2. seed binding        one integer comparison    — kills seed farming
 *   3. wall clock          one division              — kills fast-forwarding
 *   4. input density       one pass over the bytes   — kills bots
 *   5. RE-SIMULATION       up to 108,000 ticks       — the actual check
 * ```
 *
 * Step 2 is the one that is easy to leave out and fatal to omit. Everything else
 * could pass — a genuine replay, honestly recorded, correctly hashed — and still
 * be a run of a seed the player chose rather than the seed they were issued.
 * Without this comparison the entire run-token mechanism is decoration.
 *
 * ## The score is computed, never read
 *
 * There is nowhere in the wire format to put a score. That is not an oversight
 * in `replay.ts`; it is the whole design. `authoritativeScore` below comes out of
 * the re-simulation, and the client's opinion is never consulted because it was
 * never transmitted.
 */

import { TUNING } from "@/game/config/tuning";
import { parseReplay, verify, ReplayRejection } from "@/game/sim/replay";
import { SERVER_CONFIG } from "../config";
import {
  analyseDensity,
  checkWallClock,
  ImplausibleReason,
  type ImplausibleReasonValue,
} from "./density";

/** Everything a submission is judged against. */
export interface ValidationRequest {
  readonly bytes: Uint8Array;
  /** The seed the SERVER issued. Must match the replay header. */
  readonly expectedSeed: number;
  /** Starting Shards from the signed token. Never from the client. */
  readonly shards: number;
  /** The client's claimed wall-clock duration. Untrusted; used only to reject. */
  readonly elapsedMs: number;
}

export const Verdict = {
  Valid: "valid",
  /** Header malformed, hash mismatch, wrong version, truncated. */
  InvalidReplay: "invalid-replay",
  /** The replay was for a seed the server did not issue. */
  SeedMismatch: "seed-mismatch",
  /** Input log is denser or faster than a human could produce. */
  Implausible: "implausible",
  /** Re-simulation exceeded its CPU budget. */
  Timeout: "timeout",
} as const;
export type VerdictValue = (typeof Verdict)[keyof typeof Verdict];

export interface ValidationResult {
  readonly verdict: VerdictValue;
  /** The server's own score. Zero unless the verdict is `Valid`. */
  readonly score: number;
  readonly distance: number;
  readonly tickCount: number;
  readonly seed: number;
  /**
   * Why it failed, in detail.
   *
   * For operator logs and tests only. The HTTP response deliberately collapses
   * every failure into a coarse reason — see `errors.ts` — because a precise
   * "your forgery failed at step 4" is a debugging aid for the forger.
   */
  readonly detail: string;
  /** ms spent in re-simulation. Feeds the p50/p99 the verify gate reports. */
  readonly validationMs: number;
}

function failure(
  verdict: VerdictValue,
  detail: string,
  seed: number,
  tickCount: number,
  validationMs: number,
): ValidationResult {
  return { verdict, score: 0, distance: 0, tickCount, seed, detail, validationMs };
}

/**
 * Judges one submission.
 *
 * Synchronous and pure apart from the clock. It is called from the queue, which
 * owns concurrency and admission; this function owns correctness and nothing
 * else.
 */
export function validateSubmission(request: ValidationRequest): ValidationResult {
  const startedAt = Date.now();

  // ── 1. Parse the header. Bytes only, no simulation. ───────────────────────
  const parsed = parseReplay(request.bytes);
  if (!parsed.ok || parsed.header === null) {
    return failure(
      Verdict.InvalidReplay,
      `header: ${parsed.rejection}`,
      0,
      0,
      Date.now() - startedAt,
    );
  }

  const header = parsed.header;

  // ── 2. Seed binding. THE check that makes run tokens mean anything. ───────
  //
  // A replay of a seed the player picked themselves is a genuine replay of a
  // farmed layout. Everything downstream would pass it happily.
  if (header.seed !== request.expectedSeed) {
    return failure(
      Verdict.SeedMismatch,
      `seed ${header.seed} does not match issued ${request.expectedSeed}`,
      header.seed,
      header.tickCount,
      Date.now() - startedAt,
    );
  }

  // ── 3. Wall clock against tick count. One division. ───────────────────────
  const wall = checkWallClock(header.tickCount, request.elapsedMs);
  if (!wall.plausible) {
    return failure(
      Verdict.Implausible,
      `wall-clock ${wall.reason} (ratio ${wall.ratio.toFixed(3)})`,
      header.seed,
      header.tickCount,
      Date.now() - startedAt,
    );
  }

  // ── 4. Input density. One pass over the bytes, no simulation. ─────────────
  const density = analyseDensity(request.bytes, header.tickCount);
  if (!density.plausible) {
    return failure(
      Verdict.Implausible,
      `density ${density.reason} (sustained ${density.sustainedRate.toFixed(2)}/s, peak ${density.peakRate}/s)`,
      header.seed,
      header.tickCount,
      Date.now() - startedAt,
    );
  }

  // ── 5. Re-simulation. The expensive one, and the one that actually decides. ─
  //
  // `shards` comes from the signed token. Without it every run by a player who
  // holds Shards re-simulates to a different hash and is rejected as forged —
  // see the note on `VerifyOptions` in `game/sim/replay.ts`.
  // The clock lives HERE, not in the sim. `src/game/sim/` may not read
  // wall-clock time — see the note on `VerifyOptions.shouldAbort`.
  const deadline = startedAt + SERVER_CONFIG.validation.cpuBudgetMs;
  const result = verify(request.bytes, {
    shards: request.shards,
    shouldAbort: () => Date.now() > deadline,
  });

  const validationMs = Date.now() - startedAt;

  if (result.rejection === ReplayRejection.Timeout) {
    return failure(
      Verdict.Timeout,
      "re-simulation exceeded its budget",
      header.seed,
      header.tickCount,
      validationMs,
    );
  }

  if (!result.valid) {
    return failure(
      Verdict.InvalidReplay,
      `resim ${result.rejection}: computed ${result.hash} vs claimed ${result.claimedHash}`,
      header.seed,
      header.tickCount,
      validationMs,
    );
  }

  return {
    verdict: Verdict.Valid,
    // The server's number. There is no client number to compare it to.
    score: result.score,
    distance: result.distance,
    tickCount: result.ticksSimulated,
    seed: header.seed,
    detail: "ok",
    validationMs,
  };
}

/** Re-exported so callers can name a density reason without a second import. */
export { ImplausibleReason, type ImplausibleReasonValue };

/** The longest replay the format permits, for admission control. */
export const MAX_REPLAY_BYTES = TUNING.replay.headerBytes + TUNING.replay.maxTicks;
