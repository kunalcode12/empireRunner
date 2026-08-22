/**
 * Every way a request can be refused, and the status each one maps to.
 *
 * One table, in one file, for a specific reason: status codes invented at the
 * call site drift. Somebody returns 400 for a rate limit here and 429 there, a
 * client retries the wrong one, and the bug is invisible until a player is stuck
 * in a loop. A route in this codebase cannot pick a status — it returns a reason
 * and this file decides.
 *
 * ## Rejection reasons are deliberately coarse
 *
 * `invalid-replay` covers a forged hash, a truncated payload and a bad magic
 * number alike. The server knows the difference — `validate.ts` records it for
 * operators — but the RESPONSE does not say, because the only party who benefits
 * from a precise "your forgery failed at step 3" is the person forging. A
 * legitimate client has nothing to do differently in any of those cases.
 *
 * The one exception is `rate-limited`, which carries a retry-after: that is
 * actionable, and withholding it just produces clients that hammer.
 */

export const Reason = {
  /** The body was missing, too large, or not the shape the route expects. */
  BadRequest: "bad-request",
  /** No identity, or a session that does not verify. */
  Unauthorized: "unauthorized",
  /** The run token failed signature, TTL, or single-use. */
  InvalidToken: "invalid-token",
  /** The token was already spent. Kept separate from `InvalidToken`: a client
   *  double-submitting after a network retry is a legitimate case, and it
   *  should learn that the first one landed rather than that it was forged. */
  TokenAlreadyUsed: "token-already-used",
  /** The replay did not re-simulate to what it claimed, or did not parse. */
  InvalidReplay: "invalid-replay",
  /** Input density beyond a human hand, or a duration inconsistent with ticks. */
  ImplausibleInput: "implausible-input",
  /** Too many requests from this session or this address. */
  RateLimited: "rate-limited",
  /** The validation queue is full. Distinct from rate limiting: this is the
   *  SERVER being busy rather than the client being greedy, so it is a 503 and
   *  the client should retry rather than back off permanently. */
  Overloaded: "overloaded",
  /** Consent was not given for an operation that requires it. */
  ConsentRequired: "consent-required",
  /** Something the server got wrong. */
  Internal: "internal",
} as const;

export type ReasonValue = (typeof Reason)[keyof typeof Reason];

const STATUS: Readonly<Record<ReasonValue, number>> = Object.freeze({
  [Reason.BadRequest]: 400,
  [Reason.Unauthorized]: 401,
  [Reason.InvalidToken]: 403,
  // 409, not 403. The request was well-formed and authorised; it conflicts with
  // something that already happened. A client can act on that.
  [Reason.TokenAlreadyUsed]: 409,
  [Reason.InvalidReplay]: 422,
  [Reason.ImplausibleInput]: 422,
  [Reason.RateLimited]: 429,
  [Reason.Overloaded]: 503,
  [Reason.ConsentRequired]: 403,
  [Reason.Internal]: 500,
});

/** The HTTP status a reason maps to. Exhaustive by construction. */
export function statusFor(reason: ReasonValue): number {
  return STATUS[reason];
}

/**
 * A refusal, as a value rather than an exception.
 *
 * Thrown errors lose their type at every `await` boundary and tempt a catch-all
 * that turns a 429 into a 500. Every server function in this layer returns a
 * result union instead, so the compiler checks that the failure was handled.
 */
export interface Refusal {
  readonly ok: false;
  readonly reason: ReasonValue;
  /** Safe to show a user. Never contains internal detail. */
  readonly message: string;
  /** Seconds. Only ever set on `RateLimited` and `Overloaded`. */
  readonly retryAfterSeconds?: number;
}

export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

export type Result<T> = Success<T> | Refusal;

export function ok<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function refuse(reason: ReasonValue, message: string, retryAfterSeconds?: number): Refusal {
  return retryAfterSeconds === undefined
    ? { ok: false, reason, message }
    : { ok: false, reason, message, retryAfterSeconds };
}
