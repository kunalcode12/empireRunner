# `src/game/render/` — all react-three-fiber

Reads sim snapshots. **Never writes them.** Snapshots are frozen in dev builds to catch it.

## Belongs here

- `GameCanvas.tsx` — the single client component, mounted via `dynamic(..., { ssr: false })`
- `Tunnel.tsx` — four-face prism geometry
- `Runner.tsx` — player mesh
- `Entities.tsx` — instanced obstacles and pickups, pooled
- `Debris.tsx` — Rapier, **cosmetic only** (law (e))
- `interpolate.ts` — blends the two most recent sim snapshots
- `materials/`, `postfx/` — see their own READMEs

## Does NOT belong here

- Gameplay decisions. If it changes what happens rather than what is drawn, it is `sim/`.
- Mutation of sim state, ever. The data flow is one-way: `sim → render → Rapier`.
- Reading a Rapier body position back into anything the sim consumes. That kills law (a),
  and with it the leaderboard.
- Per-frame writes into zustand. Push derived HUD values at **≤ 15Hz**, not 60Hz.

## The budget

Under **100 draw calls** desktop, **50** mobile ([docs/TUNING.md §14](../../../docs/TUNING.md)).
Instance aggressively. `pixelRatio = min(devicePixelRatio, 2)`. These are CI gates from P05,
not aspirations.

## Interpolation

Render never reads a partially-ticked state. It reads `previous` and `current` and lerps by
`alpha = accumulator / fixedDelta`. Rotations — which means the roll — use quaternion slerp,
never euler lerp.
