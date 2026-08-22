/**
 * `POST /api/identity/upgrade` — anonymous player becomes an account.
 *
 * Item 4's upgrade path. The `playerId` does not change, so every leaderboard
 * row already pointing at this player keeps pointing at them. A player with a
 * top-100 run who signs up on Tuesday still has it on Wednesday.
 *
 * ## What is NOT implemented here, stated plainly
 *
 * There is no credential verification. `accountId` arrives as an opaque string
 * and is trusted, which is safe only because nothing real is behind it yet.
 * Wiring an actual provider — OAuth, an email magic link, Sign in with Apple —
 * means verifying a credential HERE and passing the resulting stable subject id
 * to `upgradeToAccount`. That needs a provider, a dependency and secrets, none
 * of which were approved for this phase.
 *
 * The route therefore refuses in production rather than pretending: an
 * unauthenticated account link is an account takeover primitive, and shipping
 * one behind a comment saying "TODO verify" is how that happens. In development
 * it works, so the seam is exercised and tested.
 */

import {
  contextFor,
  guarded,
  jsonResponse,
  readJson,
  refuse,
  refusalResponse,
  Reason,
  upgradeToAccount,
} from "@/server";

export const dynamic = "force-dynamic";

interface UpgradeBody {
  readonly accountId?: unknown;
  readonly displayName?: unknown;
}

export const POST = guarded(async (request: Request): Promise<Response> => {
  // The hard stop. See the header — this is a deliberate refusal, not an
  // oversight, and it fails closed rather than open.
  if (
    process.env.NODE_ENV === "production" &&
    process.env["AXIS_ALLOW_UNVERIFIED_UPGRADE"] !== "1"
  ) {
    return refusalResponse(refuse(Reason.BadRequest, "Account upgrade is not available yet."));
  }

  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const body = await readJson<UpgradeBody>(request);
  if (!body.ok) {
    return refusalResponse(body);
  }

  const accountId = body.value.accountId;
  if (typeof accountId !== "string" || accountId.length === 0) {
    return refusalResponse(refuse(Reason.BadRequest, "An accountId is required."));
  }

  const upgraded = await upgradeToAccount(session.player.playerId, accountId, store);
  if (!upgraded.ok) {
    return refusalResponse(upgraded);
  }

  return jsonResponse(
    {
      ok: true,
      player: {
        playerId: upgraded.value.playerId,
        displayName: upgraded.value.displayName,
        friendCode: upgraded.value.friendCode,
        hasAccount: true,
      },
    },
    session,
  );
});
