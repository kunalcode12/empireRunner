/**
 * `POST /api/run/submit` — the anti-cheat.
 *
 * Item 2. Takes `{ runToken, replayBlob }`, verifies the token, re-runs the sim
 * headlessly, and stores the score **the server computed**. The client never
 * sends a score; there is nowhere in the replay format to put one.
 *
 * This route is deliberately almost empty. Everything that decides anything
 * lives in `server/submit.ts`, which is testable without a listening port — the
 * whole P12 suite exercises the real pipeline in milliseconds. A route that
 * contained the logic would force every one of those tests to stand up a server.
 */

import {
  contextFor,
  guarded,
  jsonResponse,
  readJson,
  readRanks,
  refusalResponse,
  submitRun,
} from "@/server";

export const dynamic = "force-dynamic";

export const POST = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const body = await readJson<unknown>(request);
  if (!body.ok) {
    return refusalResponse(body);
  }

  const outcome = await submitRun(body.value, session.player, store);
  if (!outcome.ok) {
    return refusalResponse(outcome);
  }

  // Returned with the result because it is the one thing a player wants to know
  // the instant a run ends, and making them poll a second endpoint for it would
  // double the requests on the busiest path in the game.
  const ranks = await readRanks(session.player.playerId, store);

  return jsonResponse({ ok: true, run: outcome.value, ranks }, session);
});
