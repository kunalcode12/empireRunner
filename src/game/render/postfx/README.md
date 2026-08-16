# `src/game/render/postfx/` — post-processing

Surgical, never atmospheric. Every effect here is off by default and switched on by a specific
game event.

## Belongs here

- **Bloom** — Overdrive **only**, at half resolution. The first frame of Overdrive is the first
  bloom the player has seen all run, and that contrast *is* the effect.
- **Vignette** — subtle, static
- **Chromatic aberration** — **transient only**: impact, Fracture entry/exit, Overdrive
  entry/exit. Measured in frames, not as a look.

## Does NOT belong here

- Bloom as ambient mood. This is the single most common way the art direction gets destroyed.
- Constant chromatic aberration
- Scanline overlays — those are diegetic, and only inside the Static theme
- Motion blur, depth of field, film grain (the halftone in `materials/` is the grain)

## Cost

Post-processing competes with the draw-call budget in
[docs/TUNING.md §14](../../../../docs/TUNING.md). Bloom renders at half resolution and that is
a hard requirement, asserted in the postprocessing config.
