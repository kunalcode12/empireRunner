# `src/app/api/replay/` — server-side validation

Empty until **P12**. This is the only place gameplay logic ever runs on the server.

## What it does

The client submits a **seed and an input log**. The server imports `@/game/sim` directly — no
renderer, no DOM — re-runs the simulation, and compares the resulting score to the claim.
Mismatch means rejection.

This is the only leaderboard anti-cheat that actually works, and it is nearly free **if and
only if** law (a) holds: same seed + same input log = same result, byte for byte, on any
machine. That is why `src/game/sim/` is locked down as hard as it is, and why retrofitting
determinism later would be a rewrite rather than a refactor.

## Belongs here

- `route.ts` — re-simulation and verdict
- Replay-format version handling. `tickRate` is baked into every stored replay; changing it
  invalidates all of them, so replays carry a schema version.

## Does NOT belong here

- Any import from `@/game/render`, `three`, or `@react-three/*`. The sim runs headless under
  Node, and if this route needs a renderer, law (a) has already been broken.
- Partial validation, sampling, or heuristics. Re-run the whole thing; it is cheap.
