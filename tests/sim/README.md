# `tests/sim/` — the laws, asserted

Laws without tests decay. Every architectural law in
[docs/ARCHITECTURE.md §2](../../docs/ARCHITECTURE.md) has a test here or is scheduled to get
one — see the enforcement table in §5.

## Here now (P01)

- `layering.test.ts` — proves the import boundaries **fail the build**. Lints virtual files at
  `src/game/sim/…` paths through ESLint's Node API, so no illegal file exists on disk. Also
  asserts the legal imports still pass, because a blanket ban gets disabled the first time it
  gets in the way.
- `tuning-invariants.test.ts` — the relationships that must hold between tuning values, plus
  independent re-derivation of every DERIVED number.

## Scheduled

| Test | Law | Phase |
|---|---|---|
| Same seed + log twice → identical `SimState` hash | (a) | P02 |
| 30 / 60 / 144Hz render rates → identical result | (c) | P02 |
| Heap delta over 10,000 ticks === 0 | (d) | P02 |
| Tick cost < 2.0ms | budget | P02 |
| `abs(player.z) < 50` over a 20-minute run | (b) | P02 |
| Rapier never feeds the sim | (e) | P09 |

## Rules

- `environment: "node"`. If a sim test needs jsdom, the sim has a bug.
- No `Math.random()` in a test either — seed everything, or a flake is unreproducible.
- Assert on exact values, not ranges, wherever determinism makes that possible.
