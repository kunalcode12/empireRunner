# AXIS — Architecture

> **Status:** authoritative for code layout, layering and dependencies.
> Design lives in [GAME_BIBLE.md](./GAME_BIBLE.md). Numbers live in [TUNING.md](./TUNING.md).
>
> The five laws in §2 are not style preferences. Each one is load-bearing for a feature that is
> painful or impossible to add later — determinism for replay validation, pooling for frame
> stability, hand-rolled collision for game feel. **Breaking one of them is a design change, not a
> refactor**, and requires a conversation before the code is written.

---

## 1. Folder structure

```
axis/
├── docs/
│   ├── GAME_BIBLE.md           design source of truth
│   ├── TUNING.md               every tunable number
│   └── ARCHITECTURE.md         this file
├── public/                     stays at repo root (Next requirement)
├── src/
│   ├── app/                    Next.js App Router: routes, layouts, API handlers
│   │   ├── layout.tsx
│   │   ├── page.tsx            marketing / landing shell
│   │   ├── play/page.tsx       mounts the game via dynamic(..., { ssr: false })
│   │   └── api/
│   │       ├── leaderboard/    submit + read
│   │       └── replay/         server-side replay validation (P12)
│   │
│   ├── game/
│   │   ├── sim/                PURE DETERMINISTIC SIMULATION
│   │   │   ├── world.ts        the tick function; owns all gameplay state
│   │   │   ├── player.ts       kinematic controller: face, lane, jump, slide, roll
│   │   │   ├── collision.ts    swept AABB, hand-rolled
│   │   │   ├── generator.ts    seeded track generation, difficulty bands
│   │   │   ├── flow.ts         Flow meter, Overdrive, Fracture resolution
│   │   │   ├── rng.ts          seeded PRNG. Math.random() is BANNED in this folder
│   │   │   ├── pool.ts         pre-warmed object pools
│   │   │   ├── replay.ts       input-log record / playback / hash
│   │   │   └── state.ts        the SimState struct + snapshot buffer
│   │   │
│   │   ├── config/
│   │   │   ├── tuning.ts       THE ONLY HOME FOR GAMEPLAY NUMBERS
│   │   │   ├── entities.ts     obstacle / pickup / hazard tables
│   │   │   └── themes/         theme registry — one file per theme, P10
│   │   │       ├── types.ts    the Theme contract. No values, only the shape.
│   │   │       ├── index.ts    THEMES, ordinal cycling, unlock resolution
│   │   │       └── kiln.ts · undertow.ts · bazaar.ts · static.ts
│   │   │
│   │   ├── render/             ALL react-three-fiber. Reads sim state, never writes it.
│   │   │   ├── GameCanvas.tsx  the single client component
│   │   │   ├── Tunnel.tsx      four-face prism geometry
│   │   │   ├── Runner.tsx      player mesh
│   │   │   ├── Entities.tsx    instanced obstacles + pickups, pooled
│   │   │   ├── Debris.tsx      Rapier, cosmetic only
│   │   │   ├── materials/      screen-print, key-line, halftone
│   │   │   ├── postfx/         bloom (Overdrive only), vignette, transient CA
│   │   │   ├── theme/          P10 — the theme runtime
│   │   │   │   ├── ThemeDirector.ts  owns which place the run is in
│   │   │   │   ├── crossfade.ts      the 4s fade, as pure arithmetic
│   │   │   │   ├── loader.ts         GLB streaming with byte-accurate progress
│   │   │   │   └── tints.ts          live particle / entity colours
│   │   │   ├── props/          P10 — decorative instanced geometry, LOD + culling
│   │   │   ├── hud-sink.ts     output port -> src/ui/hud/
│   │   │   ├── theme-sink.ts   output port -> src/ui/ThemeStage.tsx
│   │   │   └── interpolate.ts  blends the two most recent sim snapshots
│   │   │
│   │   ├── audio/              raw Web Audio. No library. Framework-free, like input/.
│   │   │   ├── engine.ts       AudioContext, bus graph, gesture unlock, interruption recovery
│   │   │   ├── voices.ts       pooled one-shot voices, cap + oldest-voice stealing
│   │   │   ├── synth.ts        offline render of every sound; seamless-loop machinery
│   │   │   ├── recipes.ts      sound-design data: 26 one-shots + 4 stems x 4 themes
│   │   │   ├── music.ts        adaptive layered stems, bar-quantised Overdrive swap
│   │   │   ├── sfx.ts          sim event -> sound, pitch/gain jitter, coin streak ladder
│   │   │   ├── ducking.ts      side-chain: music steps aside for gameplay sounds
│   │   │   ├── latency.ts      outputLatency probe, scheduling lead, user offset
│   │   │   ├── settings.ts     persisted volumes / mute / offset, clamped on every read
│   │   │   └── director.ts     the seam: handleEvent, setTelemetry, dispose
│   │   │
│   │   ├── meta/              runs between runs. Pure functions over frozen data.
│   │   │   ├── runSummary.ts   the sim -> meta boundary object + its event recorder
│   │   │   ├── economy.ts      Bits and Shards as an append-only transaction ledger
│   │   │   ├── backend.ts      EconomyBackend — the ONE door every balance goes through
│   │   │   ├── upgrades.ts     4 tracks x 5 tiers, cost + diminishing effect curves
│   │   │   ├── avatars.ts      8 runners: passives, unlocks, visual descriptors
│   │   │   ├── inventory.ts    consumables, cosmetics, the 1 avatar + 2 boost loadout
│   │   │   ├── missionPool.ts  the mission catalogue (data)
│   │   │   ├── missions.ts     UTC-seeded dailies, weekly contract, the near-miss line
│   │   │   ├── progression.ts  player level, unlock gating, onboarding flags
│   │   │   ├── settle.ts       applies a finished run: the one entry point P14 calls
│   │   │   └── save.ts         versioned schema, migration chain, repairing validator
│   │   │
│   │   └── input/
│   │       ├── keyboard.ts
│   │       ├── touch.ts
│   │       ├── gamepad.ts
│   │       └── intent.ts       normalises all three -> { verb, tickIssued }
│   │
│   └── ui/                     DOM only. No three.js imports, ever.
│       ├── tokens.css          design tokens: colour roles, type, spacing, motion
│       ├── styles.css          every component's rules. No hex values.
│       ├── theme.ts            writes the active theme's roles onto <html>
│       ├── fonts.ts + fonts/   Anton, Martian Mono, Archivo — self-hosted woff2
│       ├── motion.ts           the motion scale, in whole 60Hz sim ticks
│       ├── hud/                THE AXIS RING, odometers, Fracture ring — all
│       │                       imperative DOM; zero React renders during a run
│       ├── screens/            title, death, shop, loadout, runners, missions,
│       │                       settings, leaderboard, pause
│       ├── transition/         the screen-print shutter and the screen stack
│       ├── components/         Plate, Button, Meter, TierPips, StepSlider, Glyph
│       ├── a11y/               focus trap, roving tabindex, gamepad nav
│       └── state/              zustand: meta (run boundaries) and UI (screens)
│
├── tests/
│   ├── sim/                    determinism, replay hashing, tuning invariants
│   ├── generator/              10k-run fuzz: no unwinnable spawns
│   └── e2e/                    Playwright: boot, perf budgets, draw calls
│
├── AGENTS.md
├── CLAUDE.md
├── PROGRESS.md
└── package.json
```

### 1.1 The src/ migration — DONE at P01

The scaffold shipped `app/` at the **repo root**, with `tsconfig.json` mapping `@/*` → `./*`.

The installed Next 16 docs (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/src-folder.md`) state plainly:

> `src/app` or `src/pages` will be ignored if `app` or `pages` are present in the root directory.

So it had to be a **move**, not a copy. P01 ran `git mv app src/app` (history preserved) and set `paths` to `"@/*": ["./src/*"]`. `public/`, `next.config.ts`, `postcss.config.mjs` and `package.json` stay at the root — the same doc requires it. Tailwind v4 resolves content automatically and needed no change.

**Do not recreate a root-level `app/`.** If one appears, Next will silently serve it and ignore everything under `src/app/` — which presents as "my route edits do nothing."

---

## 2. The five laws

### (a) The sim is headless and deterministic

> Same seed + same input log = same result. Byte for byte, on any machine.

- `src/game/sim/**` imports **nothing** from `react`, `react-dom`, `three`, `@react-three/*`, `zustand`, or the DOM. Its only permitted imports are `src/game/config/**` and other files inside `sim/`.
- **`Math.random()` is banned** in `sim/`. All randomness comes from the seeded PRNG in `rng.ts`, advanced only inside the tick.
- **`Date.now()`, `performance.now()` and `requestAnimationFrame` are banned** in `sim/`. The sim knows tick counts, not wall-clock time.
- No floating-point operation may depend on iteration order over a hash map. Entity iteration is over dense arrays with stable indices.
- Enforced by an ESLint `no-restricted-imports` boundary rule plus a Vitest test that runs the same seed and input log twice and compares a hash of the final `SimState`.

**What this buys:** unit-testable gameplay with no renderer; a 10,000-run fuzz test over the generator that proves no spawn is unwinnable; and **server-side replay validation** — the client submits its seed and input log, the server re-runs the sim headlessly and checks the score. That is the only leaderboard anti-cheat that actually works, and it is free if and only if this law holds from day one. Retrofitting determinism into a live sim is a rewrite.

### (b) The world translates toward a near-stationary player

> Never move the player far from origin.

- Track chunks move along `-Z` toward a player who stays within a few units of the origin.
- `distanceTravelled` is an accumulated scalar in the sim, **not** a player transform.
- Chunks are recycled to the pool once behind the camera; the tunnel is a treadmill.

**What this buys:** `float32` precision does not decay over a 20-minute run (a player at `z = 20000` has visible vertex jitter — this is the classic endless-runner bug); culling is a trivial `z` range check; and the camera rig never needs a floating-origin rebase.

### (c) Fixed 60Hz sim tick with an accumulator; render interpolates

```
frame(now):
  accumulator += min(now - last, maxAccumulator)     // 0.0833s clamp
  while accumulator >= fixedDelta:                   // 0.016667s
      previous = current                             // keep the last two snapshots
      current  = simTick(current, intents)
      accumulator -= fixedDelta
  alpha = accumulator / fixedDelta                   // 0..1
  render( interpolate(previous, current, alpha) )
```

- **Gameplay is never tied to `requestAnimationFrame` delta.** A 144Hz monitor and a 60Hz monitor produce identical runs.
- The render layer reads `previous` and `current` and lerps. It **never** reads a partially-ticked state.
- Rotations (the roll) interpolate as quaternion slerp, not euler lerp.
- `maxTicksPerFrame` 5 is the spiral-of-death guard: after a long tab stall, surplus time is discarded rather than simulated.

### (d) Zero heap allocation inside the tick

> Everything pooled and pre-warmed.

- No `new`, no object literals, no array literals, no closures, no `.map` / `.filter` / `.slice`, and no string concatenation inside `simTick` or anything it calls.
- Obstacles, pickups, particles, debris and audio voices come from pre-warmed pools sized to the worst case in [TUNING.md](./TUNING.md) §10 band 5.
- Vector maths is done on scratch objects owned by the pool, or on flat `Float64Array` fields on `SimState`. **This is not a style note.** Every real-valued field in `SimState` lives in the flat `f` array indexed by `F.*` for exactly this reason.
- Enforced by `tests/sim/allocation.test.ts`, which separates two things that need different treatment:
  - **Retained** — memory the tick keeps. This is a leak and is fatal. Budget: `TUNING.budgets.heapDeltaBytes`. **Measured at P02: −40 bytes across 100,000 ticks. Zero.** Requires `--expose-gc`, so this check skips (loudly) when the flag is absent.
  - **Transient** — short-lived garbage a scavenge reclaims completely. Budget: `TUNING.budgets.transientBytesPerTick`. This figure is **JIT-tier dependent**: the same code measures 0 B/tick once V8 fully optimises the tick and a steady 16 B/tick before that. 16 B/tick is 960 B/s at 60Hz — a scavenge every few hours, of objects that are already dead. It does not cause the pause this law exists to prevent.

  A literal `=== 0` assertion is not achievable in-process and would be a test that passes by JIT accident. The tier-independent check is the third one: two measurement windows an hour of gameplay apart, compared against each other.

**Why this is a law and not an optimisation:** a GC pause during a run does not read as a frame drop. It reads as **input lag** — the player pressed jump and the character jumped late — and it always happens during the dense, high-Flow sections where it hurts most.

### (e) A physics engine is used ONLY for cosmetic debris and ragdolls

> The player controller and all gameplay collision are hand-rolled and deterministic.

**Rapier may touch:** crash debris, death ragdoll, Overdrive shatter fragments, hanging banners and cloth, and nothing else. It runs in the render layer, on its own timestep, and it may drop frames without consequence.

**Rapier may never touch:** the player, obstacles, pickups, the tunnel, Flow, score, or any value the sim reads.

There is a one-way data flow and it is one-way: `sim → render → Rapier`. If a Rapier body's position is ever read back into the sim, law (a) is dead and so is the leaderboard.

**Player collision is swept AABB, computed in `sim/collision.ts`.** Swept, not discrete — at 34 u/s a player moves 0.57u per tick, which is nearly the width of a Bit, and discrete checks tunnel straight through thin geometry.

**Why:** every shipped endless runner hand-rolls its character controller. A rigid-body player gives you floaty, non-deterministic, unreplayable movement and the game feel dies. You get real physics where the player *sees* physics, and hand-tuned physics where the player *feels* control.

---

## 3. Layering law

Dependencies point **downward only**. An arrow is an allowed import direction.

```
  ┌────────────┐     ┌────────────┐
  │  src/ui    │     │  src/app   │        DOM + Next.js
  └─────┬──────┘     └─────┬──────┘
        │                  │
        └────────┬─────────┘
                 v
        ┌──────────────────┐
        │  game/render     │  r3f, three, drei, postprocessing, rapier
        └────────┬─────────┘
                 │  reads snapshots, writes nothing
     ┌───────────┼───────────┬──────────────┐
     v           v           v              v
┌─────────┐ ┌─────────┐ ┌─────────┐   ┌──────────┐
│game/    │ │game/    │ │game/    │   │game/meta │
│input    │ │audio    │ │  sim    │   │          │
└────┬────┘ └────┬────┘ └────┬────┘   └────┬─────┘
     │           │           │             │
     └───────────┴─────┬─────┴─────────────┘
                       v
              ┌──────────────────┐
              │   game/config    │   tuning, entities, themes
              └──────────────────┘   imports nothing
```

Hard rules, all enforced by ESLint import boundaries in P01:

| Rule | |
|---|---|
| `sim/` imports only `config/` and `sim/` | Nothing else. Not even a type from `render/`. |
| `render/` reads sim snapshots and **never mutates them** | Snapshots are frozen in dev builds to catch violations. |
| `ui/` never imports `three` or `@react-three/*` | The HUD is DOM. A canvas-rendered HUD costs draw calls the budget does not have. |
| `config/` imports nothing | It is leaf data. |
| `input/` produces intents; it does not call into the sim | The sim pulls the intent queue at tick boundaries. |
| `meta/` runs no economy or mission logic during a run | Economy and missions settle at run end, off the hot path. **One exception, added at P13:** the run-summary recorder in `meta/runSummary.ts` counts events inside the frame loop. It allocates nothing, decides nothing, and cannot reach a balance — there is no economy import in that file. It exists because `bitsCollected`, `nearMisses` and `peakFlow` are not fields in `SimState`, and the event ring holds only 256 entries, so by run end the data is gone rather than merely awkward to reach. |
| `ui/` and `render/` never name each other. **`app/` is the seam.** | Added at P14. `ui/` may not import `render/` (lint), and `render/` may not import `ui/` (the arrow points down). So the run HUD is driven through an **output port**: `render/hud-sink.ts` declares a `HudSink` interface of setters, `src/ui/hud/Hud.tsx` returns a structurally identical object, and `src/app/play/page.tsx` — which sits above both — performs the one assignment where TypeScript checks the halves agree. No shared enum, so nothing can drift; duplicated sim constants have already caused two real bugs here (`ThemeChange` at P11, pickup kinds at P13). Every method is a setter returning `void`: a read would be a layout flush inside `useFrame`. |
| The `AudioContext` is a **session** resource, not a per-mount one | Added at P14, after a real bug. `acquireAudioDirector()` hands out reference-counted handles onto one shared director, and teardown is deferred a tick so a React handover — which unmounts the outgoing tree *before* mounting the incoming one — does not pass through zero and destroy the graph. Building one per component meant the music died on every RUN press, because the new context's gesture listeners were armed after the click that would have unlocked them, and Chrome caps a page at roughly six contexts. The same reasoning applies to the WebGL context, which is now mounted once for the session. |
| The theme is resolved in `render/`, never in `sim/` | Added at P10. `SimEvent.ThemeChange` carries the **ordinal the run reached** and nothing else. Which theme that ordinal *means* — and whether this player has unlocked Static — is a presentation question, answered by `render/theme/ThemeDirector` against the registry. That is what keeps the unlock out of the deterministic sim: two players crossing 5,120m on the same seed run identically, and only one of them sees Static. It is also a correctness rule rather than a tidiness one. The audio layer used to key its stem swap off the raw event, so a player *without* Static heard its detuned FM lead over Kiln's foundry walls; `AudioDirector.setTheme` is now driven by the visual director, and `handleEvent` only tracks the ordinal so an unmute mid-run starts on the right stems. |
| A second output port, on the same seam | Added at P10. `render/theme-sink.ts` declares `ThemeSink` and `src/ui/ThemeStage.tsx` implements it, assigned in `app/play/page.tsx` exactly as `HudSink` is. Two ports rather than more methods on one, because the clocks are completely different: `HudSink` is called at `ui.hudPushHz` during a run and must never allocate; `ThemeSink` fires a handful of times a session and is allowed to do real work. The port carries **slugs**, not a token bundle — `src/ui/theme.ts` already imports `config/themes` and is entitled to, since only `render/` is off-limits to `ui/`, so a parallel `ThemeTokens` type would have been a second name for `ThemeUiRoles` and one more thing to drift. |
| `audio/` and `meta/` may import sim **constants only** | `audio/` at P11, `meta/` at P13. The ring buffer is the sanctioned one-way channel from sim to presentation, and mapping an event to a sound — or to a mission counter — requires knowing the event and pickup kinds. The alternative is duplicate enums whose numeric values are part of the replay format, and that duplication is precisely what caused the `ThemeChange` bug found at P11. Read-only, downward, and neither layer can write to the sim. |

### 3.1 Where state lives

| State | Home | Why |
|---|---|---|
| Per-frame gameplay (position, face, lane, Flow, score) | `SimState`, plain objects in `sim/` | React re-renders are ~100× too slow for 60Hz. **Never** put this in zustand. |
| UI state (screen, menu selection, modal) | zustand | Changes rarely, needs React. |
| Meta state (Bits, Shards, upgrades, inventory) | zustand, persisted via `meta/save.ts` | Changes at run boundaries. |
| Derived HUD values (displayed score, Flow %) | zustand, pushed from the render loop at **≤ 15Hz** | The eye cannot read a number changing at 60Hz, and pushing at 60Hz re-renders the HUD tree 60 times a second for nothing. |

---

## 4. Dependencies — one allowed use each

All rows marked ✅ are installed as of **P01**. The "one allowed use" column is the binding part
of this table — a package being present is not permission to use it anywhere. Per `CLAUDE.md`,
no dependency is added, removed or upgraded without approval.

| Package | Installed version | Installed? | The ONE thing it is allowed to be used for |
|---|---|---|---|
| `next` | 16.2.12 | ✅ | Routing, the marketing shell, and API handlers. **Not** the game loop. |
| `react` / `react-dom` | 19.2.4 | ✅ | Component tree and DOM UI. Never per-frame state. |
| `typescript` | ^5 | ✅ | `strict: true` + `noUncheckedIndexedAccess`. No `any`, no `@ts-ignore`. |
| `eslint` + `eslint-config-next` | 9.39.5 / 16.2.12 | ✅ | Lint, plus the **import-boundary rules** that enforce §3. Next 16 does **not** run ESLint during `next build`, so `npm run lint` is a required gate in its own right. |
| `prettier` | 3.9.6 | ✅ | Formatting only. No lint rules; it and ESLint do not overlap. |
| `tailwindcss` + `@tailwindcss/postcss` | ^4 | ✅ | DOM UI layout and spacing in `src/ui/` only. Colours come from `tokens.css`, never from Tailwind's default palette — that palette is not the theme palette. |
| `three` | 0.185.1 | ✅ P01 | The renderer. Imported only under `game/render/`. In `transpilePackages`. |
| `@react-three/fiber` | 9.7.0 | ✅ P01 | Declarative scene graph. **v9 is the React 19 line — v8 will not work.** |
| `@react-three/drei` | 10.7.8 | ✅ P01 | Loaders and perf helpers only. Its `KeyboardControls` is **not** used — input goes through `game/input/`, which owns the buffer and coyote windows. |
| `@react-three/postprocessing` | 3.0.5 | ✅ P01 | Bloom (Overdrive only, half resolution), vignette, transient chromatic aberration. Never an ambient look. Pulls `postprocessing@^6.36` as a transitive peer. |
| `@react-three/rapier` | 2.2.0 | ✅ P01 | Cosmetic debris and ragdolls. Law (e). **v2 is the React 19 line — v1 is React 18.** |
| `zustand` | 5.0.15 | ✅ P01 | UI and meta state. **Never per-frame sim state.** |
| `motion` (Framer Motion) | 13.1.0 | ✅ P01 | DOM screen transitions and HUD animation. Never 3D. |
| `vitest` | 4.1.10 | ✅ P01 | Headless sim tests: determinism, generator fuzz, allocation and tick-cost budgets. |
| `@playwright/test` | 1.62.1 | ✅ P01 | E2E boot test and the draw-call / bundle budget gates. |
| `r3f-perf` | 7.2.3 | ✅ P01 | Dev-only perf HUD. Must be absent from the production bundle. |
| `leva` | 0.10.1 | ✅ P01 | Dev-only tuning panel bound to `tuning.ts`, clamped to the ranges in [TUNING.md](./TUNING.md). Tree-shaken from prod. |
| `@gltf-transform/core` | ^4.4.2 | ✅ P10 | **Build time only.** Writing and reading the theme GLB bundles in `scripts/build-themes.mjs`. Never imported by `src/`. |
| `@gltf-transform/extensions` | ^4.4.2 | ✅ P10 | **Build time only.** `EXT_meshopt_compression` and `KHR_mesh_quantization` registration. Registering only the former silently dropped the latter and the writer warned about it. |
| `@gltf-transform/functions` | ^4.4.2 | ✅ P10 | **Build time only.** `prune`, `dedup` and the meshopt transform. |
| `meshoptimizer` | ^1.2.0 | ✅ P10 | **Build time only.** The encoder. The matching *decoder* ships inside `three` (`examples/jsm/libs/meshopt_decoder`), which is most of why meshopt was chosen over Draco — Draco needs a `.wasm` copied into `public/` and fetched before the first prop can draw. |
| `maath` | — | ❌ P05 | Easing and interpolation helpers for 3D. Not yet installed. |
| `howler` | — | ❌ **never** | **Not installed, and no longer needed.** P11 shipped the whole audio layer on raw Web Audio — buses, ducking, a voice pool, adaptive stems and offline-rendered procedural sounds — in ~1,400 lines with no dependency. Howler's value is cross-browser `<audio>` fallback and sprite management, and this project bans `<audio>` outright (no sample-accurate clock; music stems drift). **`<audio>` elements remain banned** and `tests/e2e/audio.spec.ts` asserts the page contains none. |

Bundle analysis needs **no** dependency: `next experimental-analyze` is built into Next 16.1+
and is wired as `npm run analyze`.

**If a version resolves differently from this table, stop and ask.** Do not improvise a compatible-looking alternative — the R3F v9 / Rapier v2 pairing with React 19 is the fragile part of this stack.

---

## 5. Enforcement

Every law above has a test. Laws without tests decay.

| Law / rule | Test | Phase |
|---|---|---|
| (a) determinism | Same seed + log run 100x → identical `SimState` hash | ✅ P02 |
| (a) no react/three in `sim/` | ESLint `no-restricted-imports` boundary | ✅ P01 |
| (a) no `Math.random` in `sim/` | ESLint `no-restricted-properties` | ✅ P01 |
| (a) **no transcendentals in `sim/`** | ESLint `no-restricted-properties` bans 19 `Math.*` functions under `src/game/sim/**`. They are only "implementation-approximated" by ECMA-262, so engines differ in the last ulp and client-vs-server replay validation breaks. Where the sim needs one, it is evaluated offline and frozen as a decimal literal — see `TUNING.determinism.speedApproachPerTick`. **This row read "NOT ENFORCED" until P09-feel; the rule had in fact shipped at P01 and the table was simply wrong.** | ✅ P01 |
| (b) player stays near origin | Assert `abs(player.z) < 50` across a 20-minute headless run | ✅ P02 |
| (c) frame-rate independence | Same log at 30 / 60 / 144 Hz and batched → identical result | ✅ P02 |
| (d) zero allocation | Retained ≈ 0 (needs `--expose-gc`); transient under ceiling; no growth over an hour | ✅ P02 |
| (a) replay round-trip | Record 60s → serialise → verify; tamper rejection | ✅ P02 |
| (e) Rapier never feeds the sim | ESLint boundary + no `@react-three/rapier` import under `sim/` | P09 |
| No magic numbers | Lint rule: numeric literals outside `config/` fail, allowlist `0`, `1`, `-1`, `2` | P01 |
| Generator never unwinnable | 10,000-seed fuzz; every spawn leaves ≥ 1 reachable cell | P06 |
| Tuning invariants | `rollCommitLock < rollDuration`, `speedCeiling + flowSpeedBonus <= maxSpeed`, `playerHeightSlide < lowBarClearance`, `stickReleaseThreshold < stickThreshold` | P01 |
| Perf budgets | [TUNING.md](./TUNING.md) §14 | P01 scaffold, P05 onward real |

---

## 6. Next.js is a shell, not the engine

- The entire game is **one client component** behind `dynamic(() => import('@/game/render/GameCanvas'), { ssr: false })`. There is no server rendering of anything on a canvas.
- App Router owns: the marketing page, `/play`, leaderboard API routes, and auth.
- **The only gameplay logic that ever runs on the server is replay validation** (P12) — which is possible precisely because of law (a): the server imports `game/sim/` directly, with no renderer, and re-runs the submitted seed and input log.
- No gameplay state is server state. A run is fully client-authoritative until it is submitted, and then it is fully re-verified.
- `public/` stays at the repo root. No placeholder asset paths that 404 at runtime — **generate procedural geometry instead.**
</content>
