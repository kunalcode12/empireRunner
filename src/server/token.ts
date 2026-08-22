/**
 * The run token. Item 1 of the threat model.
 *
 * ## What it is for
 *
 * "Any leaderboard that accepts a client-reported score will be topped by
 * someone typing `submitScore(999999999)` within a day." Re-simulation answers
 * that. But re-simulation alone leaves a quieter hole: if the client picks its
 * own seed, an attacker generates ten thousand seeds offline, simulates each one
 * with a bot, keeps the layout that happened to be a free 400,000 points, and
 * submits a *genuine* replay of it. Every check passes, because nothing was
 * forged. They simply chose the dice.
 *
 * So the seed is server-issued, signed, single-use and short-lived, and the
 * client cannot mint one. Farming still works in the sense that anyone can ask
 * for tokens — but each one expires in fifteen minutes, is bound to a session,
 * is rate-limited, and dies the moment it is spent.
 *
 * ## Starting Shards are in the token, and that is a real fix
 *
 * P14 gave `createSim` a `RunOptions { shards }`, and `hashState` mixes
 * `player.shards`. Shards buy Fracture saves (GAME_BIBLE §12 cause 6), so a run
 * that began with nine of them re-simulates to a completely different hash than
 * one that began with zero.
 *
 * `replay.ts:verify()` re-simulates with `createSim(header.seed)` — always zero.
 * Left alone, **every run by a player holding Shards would be rejected as a
 * forgery**, and the more a player invested the more certainly they would be
 * called a cheat.
 *
 * The fix is not to add a shards field to the replay header. That would let the
 * client assert "I started with nine", which is nine free deaths for the asking.
 * The server holds the balance, quotes it into the signed token at issue, and
 * feeds the signed value into re-simulation. The client is told the number so it
 * can run the same sim; it cannot change it.
 *
 * ## The payload is signed, not encrypted
 *
 * Anyone can read a token. There is nothing in it worth hiding — a seed the
 * player is about to see anyway, an expiry, a nonce. The guarantee is integrity:
 * it cannot be *altered*. See `crypto.ts`.
 */

import { SERVER_CONFIG } from "./config";
import { randomId, randomSeed, sign, verifySigned } from "./crypto";
import { ok, refuse, Reason, type Result } from "./errors";
import type { Store } from "./store/types";

/** What a run token asserts. All of it server-chosen. */
export interface RunTokenPayload {
  /** Which run this is. Becomes the `runId` if the submission validates. */
  readonly rid: string;
  /** The seed the client must run. */
  readonly seed: number;
  /** Starting Shards, quoted from the player record. See the header. */
  readonly shards: number;
  /** Who it was issued to. */
  readonly pid: string;
  /** ms epoch — issued at. */
  readonly iat: number;
  /** ms epoch — expires at. */
  readonly exp: number;
  /** Single-use marker. Spent through `Store.consumeNonce`. */
  readonly jti: string;
}

/** What `/api/run/start` hands back. */
export interface IssuedRunToken {
  readonly token: string;
  readonly seed: number;
  readonly shards: number;
  readonly expiresAt: number;
}

/**
 * Issues a token for a player.
 *
 * The seed comes from `randomBytes`, not `Math.random`: a predictable seed is a
 * layout an attacker can compute in advance, which is most of the way back to
 * choosing it.
 */
export function issueRunToken(player: { playerId: string; shards: number }): IssuedRunToken {
  const now = Date.now();
  const expiresAt = now + SERVER_CONFIG.runTokenTtlMs;

  const payload: RunTokenPayload = {
    rid: randomId(),
    seed: randomSeed(),
    shards: Math.max(0, Math.trunc(player.shards)),
    pid: player.playerId,
    iat: now,
    exp: expiresAt,
    jti: randomId(),
  };

  return {
    token: sign(payload),
    seed: payload.seed,
    shards: payload.shards,
    expiresAt,
  };
}

/** Shape check. A signed payload is still an unknown until this passes. */
function isRunTokenPayload(value: unknown): value is RunTokenPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["rid"] === "string" &&
    typeof candidate["seed"] === "number" &&
    typeof candidate["shards"] === "number" &&
    typeof candidate["pid"] === "string" &&
    typeof candidate["iat"] === "number" &&
    typeof candidate["exp"] === "number" &&
    typeof candidate["jti"] === "string"
  );
}

/**
 * Verifies a token and spends it.
 *
 * The order is deliberate and is the cheap-first rule this whole layer follows:
 *
 *   1. signature   — pure CPU, no I/O, rejects every random string instantly
 *   2. shape       — pure CPU
 *   3. expiry      — pure CPU
 *   4. ownership   — pure CPU
 *   5. **spend**   — the only step that touches the store
 *
 * Reversing 1 and 5 would let an unauthenticated flood of garbage hammer the
 * nonce table. It also matters that the spend is LAST: a token rejected for any
 * earlier reason must remain unspent, or an attacker could burn somebody else's
 * token by submitting it with a mangled expiry.
 *
 * @param sessionPlayerId the player the request is authenticated as
 */
export async function consumeRunToken(
  token: string,
  sessionPlayerId: string,
  store: Store,
): Promise<Result<RunTokenPayload>> {
  const payload = verifySigned<unknown>(token);
  if (payload === null || !isRunTokenPayload(payload)) {
    return refuse(Reason.InvalidToken, "Run token is not valid.");
  }

  if (Date.now() > payload.exp) {
    return refuse(Reason.InvalidToken, "Run token has expired. Start a new run.");
  }

  // A token is bound to the session it was issued to. Without this, one account
  // could farm tokens and hand them to others — or an attacker could submit
  // against a token they observed in someone else's traffic.
  if (payload.pid !== sessionPlayerId) {
    return refuse(Reason.InvalidToken, "Run token was issued to a different session.");
  }

  // Test-and-set. Must be atomic in the adapter — see `Store.consumeNonce`.
  // Retained past the token's own expiry so the memory of a spend outlives the
  // thing it was spent on.
  const fresh = await store.consumeNonce(payload.jti, payload.iat + SERVER_CONFIG.nonceRetentionMs);
  if (!fresh) {
    return refuse(Reason.TokenAlreadyUsed, "This run has already been submitted.");
  }

  return ok(payload);
}

/**
 * Verifies without spending. For diagnostics and tests.
 *
 * Deliberately NOT used by the submit path: a check-then-spend pair is a race
 * two simultaneous submissions of the same token can both win.
 */
export function peekRunToken(token: string): RunTokenPayload | null {
  const payload = verifySigned<unknown>(token);
  return payload !== null && isRunTokenPayload(payload) ? payload : null;
}
