/**
 * `GET /api/leaderboard/rank` — the caller's standing, and nothing else.
 *
 * Item 3's "rank lookup for the current player without scanning". Three indexed
 * lookups, no page of anybody else's rows fetched.
 *
 * It is a separate endpoint from the board for a reason worth stating: the death
 * screen wants a rank, not a leaderboard. Making it read a page to find one
 * number would put the most-hit path in the game on the most expensive query,
 * and it would get slower as the board grew — which is precisely when it must
 * not.
 */

import { contextFor, guarded, jsonResponse, readRanks, refusalResponse } from "@/server";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const ranks = await readRanks(session.player.playerId, store);
  return jsonResponse({ ok: true, ranks }, session);
});
