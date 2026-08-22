/**
 * Identity. Item 4: "anonymous device identity by default with an upgrade path
 * to a real account. Do not gate the first run behind a signup."
 *
 * ## The first run is never gated, and that is enforced here rather than hoped
 *
 * `resolveSession` creates a player when it does not find one. There is no code
 * path where a request arrives without an identity and gets a 401 — the endpoint
 * that could do that does not exist. A player who has never seen a sign-up form
 * can start a run, submit it, and appear on the leaderboard, because the thing
 * gating a leaderboard place should be the run.
 *
 * ## The upgrade preserves the player id, which is the entire point
 *
 * `linkAccount` attaches an `accountId` to an existing `PlayerRecord`. It does
 * not create a new player and it does not migrate anything, because there is
 * nothing to migrate — the id the leaderboard rows point at is the id that was
 * already there. A player with a top-100 all-time run who signs up on Tuesday
 * still has it on Wednesday.
 *
 * The alternative design — a fresh account row, then copy the runs across — is
 * where "I signed up and lost my score" comes from, and it is unrecoverable
 * because the player cannot prove which anonymous device was theirs.
 *
 * ## What "account" means here, honestly
 *
 * `accountId` is an opaque string this module does not interpret. Wiring a real
 * provider — OAuth, email magic links, Sign in with Apple — means verifying a
 * credential and handing the resulting stable subject id to `upgradeToAccount`.
 * That verification is **not implemented**: it needs a provider, which needs a
 * dependency and secrets. The seam is real and tested; the provider behind it is
 * not there yet, and PROGRESS.md says so rather than leaving it to be discovered.
 */

import { SERVER_CONFIG } from "./config";
import { randomId, sign, verifySigned } from "./crypto";
import { ok, refuse, Reason, type Result } from "./errors";
import type { PlayerRecord, Store } from "./store/types";

/** The cookie the session token travels in. */
export const SESSION_COOKIE = "axis_session";

interface SessionPayload {
  readonly pid: string;
  readonly iat: number;
  readonly exp: number;
}

/** Mints a signed session token for a player. */
export function issueSession(playerId: string): { token: string; expiresAt: number } {
  const now = Date.now();
  const expiresAt = now + SERVER_CONFIG.sessionTtlMs;
  const payload: SessionPayload = { pid: playerId, iat: now, exp: expiresAt };
  return { token: sign(payload), expiresAt };
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["pid"] === "string" &&
    typeof candidate["iat"] === "number" &&
    typeof candidate["exp"] === "number"
  );
}

/** Reads a session token without touching the store. */
export function readSession(token: string | undefined): string | null {
  if (token === undefined || token === "") {
    return null;
  }
  const payload = verifySigned<unknown>(token);
  if (payload === null || !isSessionPayload(payload)) {
    return null;
  }
  if (Date.now() > payload.exp) {
    return null;
  }
  return payload.pid;
}

/** A resolved session, and whether it was created just now. */
export interface ResolvedSession {
  readonly player: PlayerRecord;
  /** True when this request minted the identity. The route sets a cookie. */
  readonly created: boolean;
  /** Present only when `created`, or when the old token was being rotated. */
  readonly token: string | null;
  readonly expiresAt: number | null;
}

/**
 * A default display name.
 *
 * Deliberately not a random human name from a list. A generated "Alex Chen" is a
 * name that belongs to real people, and a leaderboard full of them looks like a
 * leaderboard full of real players — which is a lie told to the person reading
 * it. "Runner 4F2A" is obviously provisional and invites the player to change it.
 */
function defaultDisplayName(): string {
  const SUFFIX_BYTES = 2;
  return `Runner ${randomId(SUFFIX_BYTES).replace(/[_-]/g, "").toUpperCase().slice(0, 4)}`;
}

/**
 * Finds the caller's player, creating one if there is none.
 *
 * Never refuses for lack of identity. See the header.
 */
export async function resolveSession(
  cookieToken: string | undefined,
  store: Store,
): Promise<ResolvedSession> {
  const playerId = readSession(cookieToken);

  if (playerId !== null) {
    const existing = await store.getPlayer(playerId);
    if (existing !== null) {
      return { player: existing, created: false, token: null, expiresAt: null };
    }
    // A validly-signed token for a player the store has never heard of. This is
    // normal rather than hostile — the memory store restarted, or the file store
    // was cleared — so a fresh identity is issued instead of a 401. Refusing
    // would strand every player behind a redeploy.
  }

  const player = await store.createPlayer(defaultDisplayName());
  const session = issueSession(player.playerId);
  return {
    player,
    created: true,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/** The longest a display name may be. Long enough to be a name, short enough to render. */
const MAX_DISPLAY_NAME = 24;

/**
 * Characters a display name may not contain.
 *
 * C0 and C1 control codes, plus the Unicode bidirectional overrides. The last
 * group matters more than it looks: U+202E and friends can make a name RENDER
 * as something completely different from what it contains, which is a spoofing
 * vector rather than a formatting nuisance.
 *
 * Built with `String.fromCharCode` rather than written as a regex literal
 * because a literal would contain actual control bytes — invisible in review,
 * and reliably destroyed by the first tool that reformats the file.
 */
const UNSAFE_NAME_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}` +
    `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}` +
    `${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}` +
    `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}]`,
  "g",
);

/**
 * Cleans a submitted display name.
 *
 * Control characters and newlines are stripped rather than rejected: a name
 * pasted from somewhere with a stray character should work, not error. What it
 * does NOT attempt is profanity filtering, which cannot be done well and fails
 * embarrassingly in both directions — that belongs behind a report button.
 */
export function sanitiseDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.replace(UNSAFE_NAME_CHARS, "").trim().slice(0, MAX_DISPLAY_NAME);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Attaches an account to an existing anonymous player.
 *
 * The `accountId` must already have been verified by a real credential check.
 * This function trusts its caller entirely, which is safe only because nothing
 * routes to it from an unauthenticated path — see `api/identity/upgrade`.
 */
export async function upgradeToAccount(
  playerId: string,
  accountId: string,
  store: Store,
): Promise<Result<PlayerRecord>> {
  const player = await store.getPlayer(playerId);
  if (player === null) {
    return refuse(Reason.Unauthorized, "No such session.");
  }

  // Already linked to this same account: idempotent success. A client retrying
  // an upgrade whose response was lost must not be told the account is taken by
  // itself.
  if (player.accountId === accountId) {
    return ok(player);
  }

  if (player.accountId !== null) {
    return refuse(Reason.BadRequest, "This session is already linked to an account.");
  }

  const linked = await store.linkAccount(playerId, accountId);
  if (!linked) {
    return refuse(Reason.BadRequest, "That account is already linked to another player.");
  }

  const updated = await store.getPlayer(playerId);
  return updated === null ? refuse(Reason.Internal, "Upgrade failed.") : ok(updated);
}

/** Adds a friend by their share code. Mutual — see `Store.addFriend`. */
export async function addFriendByCode(
  playerId: string,
  code: string,
  store: Store,
): Promise<Result<PlayerRecord>> {
  const friend = await store.getPlayerByFriendCode(code);
  if (friend === null) {
    return refuse(Reason.BadRequest, "No player has that code.");
  }
  if (friend.playerId === playerId) {
    return refuse(Reason.BadRequest, "That is your own code.");
  }
  await store.addFriend(playerId, friend.playerId);
  return ok(friend);
}
