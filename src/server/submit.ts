/**
 * The submit pipeline: token → rate limit → queue → validate → record.
 *
 * Separated from the route handler so the whole path is testable without an HTTP
 * server. Everything the verify gate asserts — a forged replay is rejected, a
 * token cannot be reused, a wrong seed is rejected — is exercised against this
 * function directly, which is why those tests run in milliseconds instead of
 * needing a listening port.
 *
 * ## The order, and why each step is where it is
 *
 * ```
 *   1. decode the blob      cheap, and a malformed body should not spend a token
 *   2. size check           before anything touches the queue
 *   3. per-session limit    before the token, so a flood cannot burn tokens
 *   4. SPEND the token      atomic test-and-set; single-use is enforced here
 *   5. enqueue              admission control; may shed load
 *   6. validate             the expensive re-simulation
 *   7. record               only on a valid verdict
 * ```
 *
 * Step 4 sits after the rate limit and before the queue on purpose. Before the
 * rate limit, a rejected flood would still consume every token it carried;
 * after the queue, two concurrent submissions of the same token could both be
 * admitted and both re-simulate before either had spent it.
 *
 * ## A spent token is not refunded on a failed validation
 *
 * If the re-simulation rejects the replay, the token stays spent and the run is
 * gone. That is deliberate: refunding on failure hands an attacker unlimited
 * attempts against one seed, which is exactly the retry loop a forger needs.
 * The cost to an honest player is that a genuine submission lost to a crash
 * cannot be re-sent — so the client submits before it does anything else with
 * the result, and a lost response is a lost run rather than a lost session.
 */

import { randomId } from "./crypto";
import { ok, refuse, Reason, type Result } from "./errors";
import { periodKeysFor } from "./period";
import { submitLimiter } from "./ratelimit";
import type { PlayerRecord, RunRecord, Store } from "./store/types";
import { consumeRunToken } from "./token";
import { validationQueue } from "./validation/queue";
import { MAX_REPLAY_BYTES, Verdict, type ValidationResult } from "./validation/validate";

/** What the client posts. */
export interface SubmitRequest {
  readonly runToken: string;
  /** base64 of the replay bytes. */
  readonly replayBlob: string;
  /** The client's claimed wall-clock duration. Untrusted; only ever rejects. */
  readonly elapsedMs?: number;
}

/** What it gets back on success. */
export interface SubmitOutcome {
  readonly runId: string;
  /** The SERVER's score. The client never sent one to compare it to. */
  readonly score: number;
  readonly distance: number;
  readonly tickCount: number;
  /** ms spent re-simulating. Surfaced so the load test can read it per request. */
  readonly validationMs: number;
}

function isSubmitRequest(value: unknown): value is SubmitRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["runToken"] === "string" && typeof candidate["replayBlob"] === "string";
}

/**
 * Decodes the base64 blob.
 *
 * `Buffer.from(..., "base64")` ignores invalid characters rather than failing,
 * so a shape check comes first — otherwise garbage decodes to a short buffer and
 * is rejected later as "too short", which is a confusing way to say "that was
 * not base64".
 */
function decodeBlob(blob: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(blob)) {
    return null;
  }
  try {
    const buffer = Buffer.from(blob, "base64");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  }
}

/**
 * Runs one submission end to end.
 *
 * @param body    the parsed request body, still untrusted
 * @param player  the authenticated player
 */
export async function submitRun(
  body: unknown,
  player: PlayerRecord,
  store: Store,
): Promise<Result<SubmitOutcome>> {
  // ── 1. Shape and decode. ──────────────────────────────────────────────────
  if (!isSubmitRequest(body)) {
    return refuse(Reason.BadRequest, "Expected a runToken and a replayBlob.");
  }

  const bytes = decodeBlob(body.replayBlob);
  if (bytes === null) {
    return refuse(Reason.BadRequest, "Replay blob is not valid base64.");
  }

  // ── 2. Size, before the queue is involved at all. ─────────────────────────
  if (bytes.length > MAX_REPLAY_BYTES) {
    return refuse(Reason.BadRequest, "Replay is longer than the format allows.");
  }

  // ── 3. Per-session rate limit. The per-IP one ran in `contextFor`. ────────
  const verdict = submitLimiter.take(player.playerId);
  if (!verdict.allowed) {
    return refuse(
      Reason.RateLimited,
      "You are submitting runs faster than they can be played.",
      verdict.retryAfterSeconds,
    );
  }

  // ── 4. Spend the token. Atomic; single-use is enforced inside. ────────────
  const token = await consumeRunToken(body.runToken, player.playerId, store);
  if (!token.ok) {
    return token;
  }

  // ── 5. Admission control. A full queue sheds rather than starves. ─────────
  const result: ValidationResult | null = await validationQueue.submit({
    bytes,
    expectedSeed: token.value.seed,
    // From the SIGNED token, never from the client. See `token.ts`.
    shards: token.value.shards,
    elapsedMs: body.elapsedMs ?? 0,
  });

  if (result === null) {
    const RETRY_SECONDS = 5;
    return refuse(Reason.Overloaded, "The server is busy. Try again shortly.", RETRY_SECONDS);
  }

  // ── 6. The verdict. ───────────────────────────────────────────────────────
  if (result.verdict === Verdict.Timeout) {
    return refuse(Reason.Overloaded, "That run took too long to verify.");
  }
  if (result.verdict === Verdict.Implausible) {
    return refuse(Reason.ImplausibleInput, "That run could not be verified.");
  }
  if (result.verdict !== Verdict.Valid) {
    // Seed mismatch and hash mismatch collapse into one public reason. The
    // server knows which; the submitter does not need to. See `errors.ts`.
    return refuse(Reason.InvalidReplay, "That run could not be verified.");
  }

  // ── 7. Record. The token's `rid` becomes the run id, so a retried submission
  //       of the same token maps to the same run rather than a second one. ───
  const submittedAt = Date.now();
  const periods = periodKeysFor(submittedAt);

  const run: RunRecord = {
    runId: token.value.rid,
    playerId: player.playerId,
    score: result.score,
    distance: result.distance,
    seed: result.seed,
    tickCount: result.tickCount,
    submittedAt,
    dayKey: periods.dayKey,
    weekKey: periods.weekKey,
  };

  await store.recordRun(run);

  return ok({
    runId: run.runId,
    score: run.score,
    distance: run.distance,
    tickCount: run.tickCount,
    validationMs: result.validationMs,
  });
}

/** Exported for the load test, which needs a run id without a token. */
export function newRunId(): string {
  return randomId();
}
