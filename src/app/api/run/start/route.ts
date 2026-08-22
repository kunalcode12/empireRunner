/**
 * `POST /api/run/start` — issue a signed, single-use, short-TTL run seed.
 *
 * Item 1 of the threat model. The client cannot choose its own seed, so nobody
 * can generate ten thousand layouts offline, find the one that is a free
 * 400,000 points, and submit a perfectly genuine replay of it.
 *
 * The response also carries `shards`, and that is not a convenience — it is the
 * number the server will re-simulate with. The client must start its sim with
 * exactly this value or the hashes will not match. See `server/token.ts` for why
 * this comes from the server rather than from the save file.
 *
 * `POST` rather than `GET` because it has an effect: it mints a token, it may
 * mint an identity, and it consumes rate-limit budget. A `GET` with side effects
 * is a `GET` something will prefetch.
 */

import { contextFor, guarded, issueRunToken, jsonResponse, refusalResponse } from "@/server";

export const dynamic = "force-dynamic";

export const POST = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }

  const { session } = context.value;
  const issued = issueRunToken(session.player);

  return jsonResponse(
    {
      ok: true,
      runToken: issued.token,
      seed: issued.seed,
      // The client MUST pass this into `createSim({ shards })`. It is part of
      // the simulated state and therefore part of the hash.
      shards: issued.shards,
      expiresAt: issued.expiresAt,
      player: {
        playerId: session.player.playerId,
        displayName: session.player.displayName,
        friendCode: session.player.friendCode,
      },
    },
    session,
  );
});
