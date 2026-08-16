# `tests/generator/` — the fuzz test

Empty until **P06**.

## The one test that matters

**10,000 seeds. Zero unwinnable spawns.**

Every spawn event must leave at least one of the 12 cells reachable, given the player's
current cell, the current world speed, and the verb timings in
[docs/TUNING.md](../../docs/TUNING.md). A spawn that fills every reachable cell is a
**generator bug**, not a difficulty setting.

This test is only possible because the sim is deterministic and headless (law (a)). It runs
the real generator and the real reachability solver, with no renderer.

## Also here

- `minReactionTime` (0.55s) is never violated, at any speed or density
- Band density matches [docs/TUNING.md §10](../../docs/TUNING.md)
- Full-Face Walls always have a clear cell on an adjacent face
- Corner Braces never make *every* roll wrong at the same time
- Pickup lines never lead into geometry — a Bit trail into a wall is a bug, not a trap

## Why this is load-bearing beyond the generator

Fracture's solver replays the last 0.40s against each verb to find the single move that would
have cleared the obstacle. If zero verbs would have worked, that is an unwinnable spawn, and
Fracture cannot arm honestly. This fuzz test is what keeps that path from ever firing.
