# `src/game/render/materials/` — screen-print materials

The look is 1980s cabinet side-art and riso posters: physical ink on physical paper, not light
on glass. Full art direction in [docs/GAME_BIBLE.md §11](../../../../docs/GAME_BIBLE.md).

## Belongs here

- **Flat colour fill** — one flat colour per surface, sampled from the active theme palette
- **Key-line outlines** — inverted-hull or normal-based, 2–3px at 1080p, scaling with distance
  so far geometry does not turn into a wire ball
- **Halftone grain** — screen-space dot pattern, dot size varying by surface luminance. It must
  read as a print artifact and **must not swim** when the camera moves.
- **Posterised fog and caustics** — 3–4 hard steps, never a smooth ramp

## Does NOT belong here

- Gradient ramps, soft shadows, ambient occlusion smudges
- Emissive as an ambient property. Emission exists only inside Overdrive.
- Any colour not in the active theme's 4–6 entry palette
- **The banned look**: near-black + neon cyan/magenta + glowing perspective grid. See
  GAME_BIBLE §11.3 — it is banned as a placeholder too, and a PR reintroducing it is rejected
  on sight regardless of how good it looks.

## Shadow

A single flat darker colour from the palette, with a hard edge. Not a blur.
