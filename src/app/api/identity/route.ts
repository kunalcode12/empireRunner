/**
 * `GET /api/identity` — who the caller is. `PATCH` — change the display name.
 *
 * Item 4: anonymous by default, no signup gate. A `GET` here MINTS an identity
 * when there is not one, which is why the first run needs no account — the act
 * of asking who you are is enough to become somebody.
 *
 * The identity rate limiter applies to creation, not to reads: without it an
 * attacker mints unlimited sessions to defeat the per-session submit limit, and
 * the per-IP limit is the only thing left holding the line.
 */

import {
  contextFor,
  guarded,
  identityLimiter,
  jsonResponse,
  readJson,
  refuse,
  refusalResponse,
  Reason,
  sanitiseDisplayName,
} from "@/server";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, address } = context.value;

  // Only a NEW identity costs budget. Reading an existing one is free, so a
  // returning player behind a busy NAT is never turned away.
  if (session.created) {
    const verdict = identityLimiter.take(address);
    if (!verdict.allowed) {
      return refusalResponse(
        refuse(
          Reason.RateLimited,
          "Too many new sessions from this address.",
          verdict.retryAfterSeconds,
        ),
      );
    }
  }

  const { player } = session;
  return jsonResponse(
    {
      ok: true,
      player: {
        playerId: player.playerId,
        displayName: player.displayName,
        friendCode: player.friendCode,
        shards: player.shards,
        hasAccount: player.accountId !== null,
        telemetryConsent: player.telemetryConsent,
      },
    },
    session,
  );
});

interface PatchBody {
  readonly displayName?: unknown;
  readonly telemetryConsent?: unknown;
}

export const PATCH = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const body = await readJson<PatchBody>(request);
  if (!body.ok) {
    return refusalResponse(body);
  }

  const patch: { displayName?: string; telemetryConsent?: boolean } = {};

  if (body.value.displayName !== undefined) {
    const name = sanitiseDisplayName(body.value.displayName);
    if (name === null) {
      return refusalResponse(refuse(Reason.BadRequest, "That name cannot be used."));
    }
    patch.displayName = name;
  }

  // Consent is a boolean and only a boolean. Accepting a truthy value would let
  // a non-empty string turn telemetry on, which is not consent.
  if (body.value.telemetryConsent !== undefined) {
    if (typeof body.value.telemetryConsent !== "boolean") {
      return refusalResponse(refuse(Reason.BadRequest, "Consent must be true or false."));
    }
    patch.telemetryConsent = body.value.telemetryConsent;
  }

  await store.updatePlayer(session.player.playerId, patch);
  const updated = await store.getPlayer(session.player.playerId);

  return jsonResponse(
    {
      ok: true,
      player: {
        playerId: updated?.playerId ?? session.player.playerId,
        displayName: updated?.displayName ?? session.player.displayName,
        friendCode: updated?.friendCode ?? session.player.friendCode,
        telemetryConsent: updated?.telemetryConsent ?? false,
      },
    },
    session,
  );
});
