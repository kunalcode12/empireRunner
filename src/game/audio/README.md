# `src/game/audio/` — the Web Audio graph

## Belongs here

- `graph.ts` — `AudioContext`, buses, ducking
- `stems.ts` — per-theme music stems, cross-faded through the transition tunnel
- `sfx.ts` — pooled one-shot voices

## Does NOT belong here

- **`<audio>` elements. Banned.** They have no sample-accurate clock, so music stems drift
  audibly over a ten-minute run.
- Allocation during a run. Voices come from a pre-warmed pool, like everything else.
- Gameplay state. Audio reads the sim; it never influences it. An audio hitch must never
  change a run's outcome.
- Scheduling against `requestAnimationFrame` or `setTimeout`. Schedule against
  `AudioContext.currentTime`.

## Theme stems

Kiln (kick + industrial clank + low brass drone) · Undertow (dub bass + plate reverb rim +
submerged pad) · Bazaar (oud + hand percussion + tape-saturated synth) · Static (detuned FM
lead + tape hiss + broken clock pulse). Details:
[docs/GAME_BIBLE.md §10](../../../../docs/GAME_BIBLE.md).

Stems for a theme are written to a common tempo and bar length so a cross-fade at a distance
milestone lands on a beat rather than smearing across one.
