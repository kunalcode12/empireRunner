# `src/game/sim/` — the deterministic simulation

**The strictest folder in the repo.** Everything else can be rewritten; this cannot, because
replay validation, the generator fuzz test, and the leaderboard all depend on its guarantees.

> Law (a): same seed + same input log = same result. Byte for byte, on any machine.

## Belongs here

- `world.ts` — the tick function; owns all gameplay state
- `player.ts` — kinematic controller: face, lane, jump, slide, roll
- `collision.ts` — swept AABB, hand-rolled
- `generator.ts` — seeded track generation, difficulty bands
- `flow.ts` — Flow meter, Overdrive, Fracture resolution
- `rng.ts` — the seeded PRNG
- `pool.ts` — pre-warmed object pools
- `replay.ts` — input-log record / playback / hash
- `state.ts` — the `SimState` struct + snapshot buffer

## Does NOT belong here

Enforced by `eslint.config.mjs`. These fail `npm run lint`, and `tests/sim/layering.test.ts`
proves they do:

- `react`, `react-dom`, `three`, `@react-three/*`, `zustand`, `next`, `motion`, `leva`, `r3f-perf`
- Anything from `ui/`, `app/`, `render/`, `input/`, `audio/`, `meta/` — including types
- `import()` and `require()`, which would route around the static import ban
- `Math.random()` — use the seeded PRNG in `rng.ts`
- `Date.now()`, `performance.now()` — the sim counts ticks, not wall-clock time
- `window`, `document`, `requestAnimationFrame` — this code runs headless under Node

The only legal imports are `src/game/config/**` and other files inside `sim/`.

## Two more rules the linter cannot check

- **Zero heap allocation inside the tick** (law (d)). No `new`, no object/array literals, no
  closures, no `.map`/`.filter`/`.slice`, no string concatenation. Everything comes from a
  pre-warmed pool. A GC pause reads as input lag, not as a frame drop.
- **No iteration over hash maps** where float results depend on order. Dense arrays with
  stable indices only.

Full text: [docs/ARCHITECTURE.md §2](../../../docs/ARCHITECTURE.md).
