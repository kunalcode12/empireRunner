/**
 * `GET /api/leaderboard` — one page of a board.
 *
 * Item 3. `?scope=all-time|weekly|daily|friends`, `?cursor=`, `?limit=`.
 *
 * The response always carries the caller's own rank and entry alongside the
 * page, because "where am I" is the question a leaderboard exists to answer and
 * a client that had to search for itself would page through the whole board to
 * find out.
 *
 * `POST` is deliberately absent. A leaderboard that accepts a score is the exact
 * hole this phase closes — runs arrive through `/api/run/submit`, which
 * re-simulates them, and there is no other way onto a board.
 */

import {
  contextFor,
  guarded,
  jsonResponse,
  parseScope,
  readBoard,
  refuse,
  refusalResponse,
  Reason,
} from "@/server";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const url = new URL(request.url);
  const scope = parseScope(url.searchParams.get("scope"));
  if (scope === null) {
    return refusalResponse(refuse(Reason.BadRequest, "Unknown leaderboard scope."));
  }

  const rawLimit = url.searchParams.get("limit");
  const view = await readBoard(
    {
      scope,
      playerId: session.player.playerId,
      cursor: url.searchParams.get("cursor") ?? undefined,
      // Clamped inside `readBoard`, so `?limit=1000000` cannot turn one page
      // into a table scan.
      limit: rawLimit === null ? undefined : Number.parseInt(rawLimit, 10),
    },
    store,
  );

  if (!view.ok) {
    return refusalResponse(view);
  }

  return jsonResponse({ ok: true, board: view.value }, session);
});
