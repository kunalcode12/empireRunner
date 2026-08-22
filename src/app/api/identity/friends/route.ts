/**
 * `POST /api/identity/friends` — add a friend by their share code.
 *
 * The friends board (item 3) needs a friend relation, and anonymous identities
 * have no address book to read. A short share code is the honest minimum: the
 * player sends it to someone by whatever means they already use, and nobody has
 * to hand over a contact list to compare scores.
 *
 * Friendship is mutual — see `Store.addFriend`. A one-way list means two players
 * comparing boards see different boards, which reads as a bug every single time.
 */

import {
  addFriendByCode,
  contextFor,
  guarded,
  jsonResponse,
  readJson,
  refuse,
  refusalResponse,
  Reason,
} from "@/server";

export const dynamic = "force-dynamic";

interface FriendBody {
  readonly friendCode?: unknown;
}

export const POST = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const body = await readJson<FriendBody>(request);
  if (!body.ok) {
    return refusalResponse(body);
  }

  const code = body.value.friendCode;
  if (typeof code !== "string" || code.length === 0) {
    return refusalResponse(refuse(Reason.BadRequest, "A friendCode is required."));
  }

  const added = await addFriendByCode(session.player.playerId, code, store);
  if (!added.ok) {
    return refusalResponse(added);
  }

  return jsonResponse(
    { ok: true, friend: { playerId: added.value.playerId, displayName: added.value.displayName } },
    session,
  );
});

export const GET = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const ids = await store.listFriends(session.player.playerId);
  const friends = await Promise.all(ids.map((id) => store.getPlayer(id)));

  return jsonResponse(
    {
      ok: true,
      friendCode: session.player.friendCode,
      friends: friends
        .filter((friend): friend is NonNullable<typeof friend> => friend !== null)
        .map((friend) => ({ playerId: friend.playerId, displayName: friend.displayName })),
    },
    session,
  );
});
