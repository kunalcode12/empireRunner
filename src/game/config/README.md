# `src/game/config/` — leaf data

The bottom of the dependency graph. **This folder imports nothing** (enforced by
`eslint.config.mjs`: only relative sibling imports are permitted).

## Belongs here

- `tuning.ts` — **the only home for gameplay numbers.** Every value from
  [docs/TUNING.md](../../../docs/TUNING.md), grouped by system, each with a unit comment and
  a LOCKED / DERIVED / OPEN status tag.
- `entities.ts` — obstacle, pickup and hazard tables (P07)
- `themes.ts` — theme registry: palettes, fog, prop sets, music stems (P10)

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
