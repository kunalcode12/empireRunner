# `src/app/api/leaderboard/` — submit and read

Empty until **P12**.

## Belongs here

- `route.ts` — `GET` the board, `POST` a run
- Weekly reset handling
- Rate limiting on submit

## Does NOT belong here

- **Trusting a submitted score.** A `POST` carries a seed and an input log, not a number. The
  score is whatever [`../replay/`](../replay/README.md) computes when it re-runs them.
- Gameplay logic. Import `@/game/sim` and run it; do not reimplement any part of it here.

## Open question

Scope is undecided — global only, or friends/regional? It affects the schema, so settle it
before writing the table. Default assumption: global + weekly reset.
[GAME_BIBLE §13 Q4](../../../../docs/GAME_BIBLE.md).
