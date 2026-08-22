# `src/app/api/leaderboard/` — submit and read

**Landed at P12.**

## What shipped

- `GET /api/leaderboard?scope=all-time|weekly|daily|friends` — cursor-paginated, and the
  cursor is **signed**, because an unsigned offset is a query parameter and a query parameter is
  a thing a client edits into a table scan.
- `GET /api/leaderboard/rank` — the caller's standing on all three stored boards, by indexed
  lookup rather than by scanning. The death screen wants a rank, not a leaderboard.
- Period rollover shares `utcDayKey`/`utcWeekKey` with `game/meta/missions`, so a player's
  daily mission and the daily board roll over at ONE instant. A second copy would drift, and
  the symptom — a run counting toward a mission but landing on yesterday's board — is the kind
  nobody reports and everybody quietly stops trusting.
- Rate limiting per session AND per IP, both required to pass.

There is deliberately **no `POST`**. Runs reach a board only through
[`../run/submit`](../run/submit/route.ts), which re-simulates them.

## Does NOT belong here

- **Trusting a submitted score.** A `POST` carries a seed and an input log, not a number. The
  score is whatever [`../replay/`](../replay/README.md) computes when it re-runs them.
- Gameplay logic. Import `@/game/sim` and run it; do not reimplement any part of it here.

## The open question, settled

Scope was undecided (GAME_BIBLE §13 Q4). **Resolved at P12: all-time, weekly, daily and
friends.** Friends is assembled per request from a mutual friend list keyed by a short share
code — no contact-list access, and a player is always on their own friends board, because a
board you are absent from cannot answer the only question anyone asks it.
