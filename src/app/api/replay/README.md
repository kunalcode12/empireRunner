# `src/app/api/replay/` — server-side validation

**Landed at P12.** This is the only place gameplay logic ever runs on the server.

The route itself is [`../run/submit/`](../run/submit/route.ts); the logic is in
[`src/server/`](../../../server/), which is testable without a listening port.

## What it does

The client submits a **seed and an input log**. The server imports `@/game/sim` directly — no
renderer, no DOM — re-runs the simulation, and compares the resulting score to the claim.
Mismatch means rejection.

This is the only leaderboard anti-cheat that actually works, and it is nearly free **if and
only if** law (a) holds: same seed + same input log = same result, byte for byte, on any
machine. That is why `src/game/sim/` is locked down as hard as it is, and why retrofitting
determinism later would be a rewrite rather than a refactor.

## What shipped

- `POST /api/run/start` — a **server-issued**, signed, single-use, 15-minute seed. The client
  cannot choose its own, so nobody can farm favourable generations offline and submit a
  perfectly genuine replay of the best one.
- `POST /api/run/submit` — verify the token, re-simulate, store the score the SERVER computed.
- Replay-format version handling. `tickRate` is baked into every stored replay; changing it
  invalidates all of them, so replays carry a schema version.

## Two things P12 discovered

1. **The recorder was never wired in.** P02 built `createRecorder`/`record` and, until P12,
   nothing in the frame loop called them. A recorder nobody records into is a leaderboard
   nobody can submit to.
2. **`verify()` could not validate a run by a player holding Shards.** P14 added
   `createSim(seed, { shards })` and `hashState` mixes `player.shards`, but `verify()` always
   passed zero — so the more a player had invested, the more certainly they were called a
   cheat. Starting Shards now travel in the **signed token**, never in the replay header,
   because a header field is a claim the client makes and "I started with nine" is nine free
   deaths for the asking.

## Does NOT belong here

- Any import from `@/game/render`, `three`, or `@react-three/*`. The sim runs headless under
  Node, and if this route needs a renderer, law (a) has already been broken.
- Partial validation, sampling, or heuristics. Re-run the whole thing; it is cheap.
