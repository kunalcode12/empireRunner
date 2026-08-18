# `src/game/audio/` — the Web Audio graph

Raw Web Audio. No library, no dependency. Shipped at **P11**.

## Files

| File | What lives there |
|---|---|
| `engine.ts` | The `AudioContext`, the bus graph, gesture unlock, suspend/resume, interruption recovery |
| `voices.ts` | Pooled one-shot voices — fixed cap, oldest-voice stealing with a fade |
| `synth.ts` | Offline rendering of every sound into an `AudioBuffer`, seamless-loop machinery |
| `recipes.ts` | The sound-design data table: 26 one-shots + 4 stems × 4 themes |
| `music.ts` | Adaptive layered stems, bar-quantised Overdrive swap, theme cross-fade |
| `sfx.ts` | Sim event → sound, per-shot pitch/gain jitter, the coin streak ladder |
| `ducking.ts` | Side-chain: music steps out of the way of gameplay sounds |
| `latency.ts` | `outputLatency` probe, scheduling lead, the player's manual offset |
| `settings.ts` | Persisted bus volumes, mute, offset — clamped on every read |
| `director.ts` | The seam. Three methods: `handleEvent`, `setTelemetry`, `dispose` |

> Earlier drafts of `docs/ARCHITECTURE.md` §3 named these `graph.ts` / `stems.ts` /
> `sfx.ts`. The tree above is what shipped, and §3 has been updated to match.

## Does NOT belong here

- **`<audio>` elements. Banned.** They have no sample-accurate clock, so music stems drift
  audibly over a ten-minute run.
- Unbounded allocation during a run. Voices come from a fixed pool.
  `AudioBufferSourceNode` is single-use *by specification*, so one node per shot is
  unavoidable — what is pooled is the gain/panner chain and the slot, and the cap is what
  bounds concurrency. `voices.ts` says this out loud rather than pretending otherwise.
- Gameplay state. Audio reads the sim; it never influences it. An audio hitch must never
  change a run's outcome.
- Scheduling against `requestAnimationFrame` or `setTimeout`. Schedule against
  `AudioContext.currentTime`. There is exactly one `setTimeout` in this directory — waiting
  out a fade before `suspend()` stops the clock — and it is commented as the exception.
- React. This layer is framework-free, like `input/`, so it is drivable and testable
  without a component tree.

## Theme stems

Kiln (kick + industrial clank + low brass drone) · Undertow (dub bass + plate reverb rim +
submerged pad) · Bazaar (oud + hand percussion + tape-saturated synth) · Static (detuned FM
lead + tape hiss + broken clock pulse). Details:
[docs/GAME_BIBLE.md §10](../../../../docs/GAME_BIBLE.md).

All four themes are written to **one** tempo (`TUNING.audio.musicBpm`) and one bar length, so
a cross-fade at a distance milestone lands on a beat rather than smearing across one — and so
the Overdrive swap has a single grid to quantise against.

## The sounds are placeholders and are marked as such

There are no audio assets in this repository. Every sound is synthesised at warm-up from
oscillators and noise buffers, described by `recipes.ts`. They occupy the right frequency
ranges with the right envelopes and the right relative loudness, so **the mix is real** even
though the timbres are synthetic. Replacing them with recorded audio means replacing the
render step, not the architecture.

No `.mp3` or `.ogg` path is referenced anywhere, because none exists.
