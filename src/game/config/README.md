# `src/game/config/` — leaf data

The bottom of the dependency graph. **This folder imports nothing** (enforced by
`eslint.config.mjs`: only relative sibling imports are permitted).

## Belongs here

- `tuning.ts` — **the only home for gameplay numbers.** Every value from
  [docs/TUNING.md](../../../docs/TUNING.md), grouped by system, each with a unit comment and
  a LOCKED / DERIVED / OPEN status tag.
- `entities.ts` — obstacle, pickup and hazard tables (P07)
- `themes/` — the theme registry (P10). One file per theme plus `types.ts` (the contract,
  no values) and `index.ts` (ordinal cycling and unlock resolution).

## Adding a fifth theme

It is a **data change only**. Write `themes/<slug>.ts`, add it to the array in
`themes/index.ts`, run `npm run build:themes`. Nothing else in the codebase should need
touching — no switch gains an arm, no list of four grows to five.

That claim is not a hope; `tests/theme/extensibility.test.ts` builds a synthetic fifth theme
out of data alone and pushes it through the crossfade, the tint layer, the prop-geometry
builders and the loader's naming contract. **If that test fails, the abstraction is wrong and
the fix is in the consumer, not in the test.**

The registry's own invariants — palette size, contrast, fog floors, no prop wearing the
obstacle accent — are asserted in `tests/theme/registry.test.ts` by iterating `THEMES` rather
than by restating them, which is what makes them apply to a theme nobody has written yet.

## Does NOT belong here

- Logic of any kind. This is data. If it has a branch in it, it belongs in `sim/`.
- Imports from anywhere — including `sim/`, including type-only imports.
- Values that are not gameplay-facing. Build config belongs in the root config files.

## Changing a number

1. Change it in `tuning.ts` — nowhere else.
2. Change it in [docs/TUNING.md](../../../docs/TUNING.md) in the **same commit**, including
   the Too low / Too high column if the feel changed.
3. If it is 🔒 LOCKED, the commit message must name the playtest that justified it.
4. If it is 🔧 DERIVED, do not touch it — change its inputs. The derived values are computed
   from hoisted constants at the top of `tuning.ts` precisely so they cannot drift.
5. Run `npm run test`. `tests/sim/tuning-invariants.test.ts` asserts the relationships that
   have to hold, so a bad edit fails loudly instead of quietly breaking game feel.
