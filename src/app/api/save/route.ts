/**
 * `GET /api/save` — read the cloud save. `PUT` — sync one up.
 *
 * Item 5. The reconciliation rule lives in `server/save.ts`; this route is the
 * transport. `PUT` returns the MERGED save rather than an acknowledgement,
 * because the client has to adopt the merge — a client that syncs up and keeps
 * its own copy has not reconciled anything, it has just told the server it
 * disagrees.
 *
 * The response says which currencies the server protected. That is not
 * decoration: a player who spent Bits on one device and sees them return after a
 * sync deserves an explanation available to support, and a silent protection is
 * indistinguishable from a bug.
 */

import {
  contextFor,
  guarded,
  isCloudSave,
  jsonResponse,
  readJson,
  reconcile,
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

  const save = await store.getSave(session.player.playerId);
  return jsonResponse({ ok: true, save }, session);
});

export const PUT = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const body = await readJson<unknown>(request);
  if (!body.ok) {
    return refusalResponse(body);
  }

  // Validated before it can reach `reconcile`. A NaN currency would propagate
  // through `Math.max` and permanently poison a balance — there is no recovery
  // from a stored NaN, because every future comparison against it is false.
  if (!isCloudSave(body.value)) {
    return refusalResponse(refuse(Reason.BadRequest, "That is not a valid save."));
  }

  const stored = await store.getSave(session.player.playerId);
  const report = reconcile(stored, body.value);
  await store.putSave(session.player.playerId, report.merged);

  return jsonResponse(
    {
      ok: true,
      save: report.merged,
      tookRemotePayload: report.tookRemotePayload,
      protectedCurrencies: report.protectedCurrencies,
    },
    session,
  );
});
