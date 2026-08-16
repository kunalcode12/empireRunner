# AXIS — Build Progress

> **Read this file before starting any phase. Append to it after finishing one.**
>
> One prompt = one session = one commit. Never run two phases at once.
> If a phase's verify gate fails, **stop** and run P15 Repair in a fresh session. Never build
> phase N+1 on a broken phase N.

Design: [docs/GAME_BIBLE.md](docs/GAME_BIBLE.md) · Numbers: [docs/TUNING.md](docs/TUNING.md) · Layout: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Rules: [CLAUDE.md](CLAUDE.md)

---

## Phase table

Status values: `Not started` · `In progress` · `Gate failed` · `Complete`

| # | Phase | Primary scope | Verify gate | Status |
|---|---|---|---|---|
| **P01** | Foundation & toolchain | Move `app/` → `src/app/`, update `tsconfig` paths, create the `src/game/**` + `src/ui/**` tree, `config/tuning.ts` from TUNING.md, ESLint import boundaries, vitest + playwright, npm scripts | `npm run typecheck && npm run lint && npm run test && npm run build` all pass; tuning-invariant tests green; boundary rule rejects a deliberate `three` import in `sim/` | **Complete** |
| **P02** | Deterministic sim core | Fixed-timestep loop, accumulator, snapshot buffer, seeded PRNG, `SimState`, object pools, replay record/playback + hash | Same seed + log run twice → identical hash; 30/60/144Hz render rates → identical result; 0-byte heap delta over 10k ticks; tick < 2.0ms | **Complete** |
| **P03** | Input layer | keyboard / touch / gamepad → normalised intent stream; input buffer, coyote time, stick hysteresis, two-finger roll gesture | Unit tests for buffer + coyote windows; a real device playtest of the two-finger roll (GAME_BIBLE §13 Q2 answered) | Not started |
| **P04** | Player controller | 12-position face/lane state machine, jump/slide/lane/roll, asymmetric gravity, swept AABB collision, roll commit lock | Headless: all 6 verbs produce the exact durations in TUNING.md; `newLane === 2 - oldLane` across rolls; no tunnelling at `maxSpeed` | Not started |
| **P05** | Render bridge & camera | r3f canvas, `dynamic(ssr:false)` mount, four-face prism geometry, runner mesh, snapshot interpolation, camera rig, r3f-perf, leva | Game boots and runs at 60fps; `< 100` draw calls desktop, `< 50` mobile; roll reads correctly and the reduced-motion path works | Not started |
| **P06** | Track generator | Seeded chunk generation, difficulty bands, 4-face authoring, reachability solver, chunk recycling | **10,000-seed fuzz: zero unwinnable spawns**; `minReactionTime` 0.55s never violated at any speed; band density matches TUNING.md §10 | Not started |
| **P07** | Entity catalogue | All 12 obstacles, 4 hazards, 7 pickups; instanced + pooled rendering; collision resolution; near-miss detection | Every entity in GAME_BIBLE §7 spawns, renders, and is defeated by exactly its listed verbs; near-miss fires at 0.45u surface-to-surface | Not started |
| **P08** | Flow & Overdrive | Flow meter, all gain/decay sources, multiplier, flow→speed coupling, Overdrive mode + palette inversion + shatter | Flow math matches TUNING.md §9.1 in headless tests; Overdrive lasts exactly 6.0s, exits at 25 Flow; crash zeroes Flow | Not started |
| **P09** | Fracture & cosmetic physics | Death freeze, correct-verb solver, 1.2s slow-mo window, resume; Rapier v2 debris and ragdolls | Solver picks the single clearing verb from a 0.40s lookback; arms only on single-answer deaths; **Rapier never writes to sim** (boundary test) | Not started |
| **P10** | Themes & art direction | Screen-print materials, key-lines, halftone, the four themes, transition tunnels, posterised fog | All four themes render at ≤ 6 colours; zero bloom outside Overdrive; the §11.3 ban holds under review; draw calls still in budget | Not started |
| **P11** | Audio | Web Audio graph, buses, ducking, per-theme stems with cross-fade, pooled SFX voices | Stems stay sample-locked across a 10-minute run; no `<audio>` elements; voice pool never allocates mid-run | Not started |
| **P12** | Leaderboards & replay validation | API routes, submit/read, **server-side replay re-simulation**, weekly reset | A tampered score is rejected; a legitimate replay validates; server re-sim result === client result | Not started |
| **P13** | Meta systems | Economy, upgrade cost + effect curves, avatars, boosts, inventory, dailies, weekly contract, save + migrations | Cost/effect tables match GAME_BIBLE §8 exactly; save survives a schema migration; missions roll over at 00:00 UTC | Not started |
| **P14** | UI, HUD & juice | Menu, loadout, store, missions, HUD, death screen with the "you were 40m short" line, rolling numerals, auto-pause on blur | Full loop playable start→death→spend→restart; HUD pushes at ≤ 15Hz; death screen always shows the nearest unmet objective | Not started |
| **P15** | Repair & ship hardening | Out-of-band. Fix a failed gate, or the final pass: perf sweep, budget enforcement, reduced-motion, a11y, error boundaries | Every budget in TUNING.md §14 green in CI; all five laws' tests green | Not started |

**P15 is dual-purpose:** it is both the Repair prompt (run in a fresh session whenever any earlier
gate fails, then return to the phase that failed) and the final hardening pass. It is the only
phase that may legitimately run more than once.

---

## Build log

### 2026-08-16 — P02 · Deterministic sim core — **Complete**

**Verify gate — all green**

```
npm run typecheck && npm run test

> tsc --noEmit                    (clean)
> eslint .                        (clean, 0 errors 0 warnings — run alongside)
> vitest run
  Test Files  10 passed (10)
       Tests  181 passed (181)
    Duration  3.58s
```

Measured, on this machine (Node v24.13.0, Windows 11):

```
[performance] 10000 ticks in 8.40ms (runs: 9.1, 9.4, 8.4)
              0.840us/tick | 1,190,391 ticks/sec | budget 200ms
[performance] 166.7s of gameplay simulated in 8.13ms = 20,504x realtime
[performance] early 20000 ticks 17.68ms | late 20000 ticks 17.69ms | ratio 1.00x
[performance] re-simulating a 60s run took 5.23ms (3600 ticks)
[allocation]  RETAINED -40 bytes per 100,000 ticks  (out-of-band, --expose-gc)
[allocation]  early 1.30 B/tick | late 0.00 B/tick | after 516,000 ticks
[allocation]  transient 16.00 B/tick = 960 B/s of play | ceiling 32 B/tick
```

**10,000 ticks in 8.40ms — 24x inside the 200ms budget, 0.84 microseconds per tick.**

**Shipped — `src/game/sim/`**

- `rng.ts` — mulberry32. 32-bit integer state, no float accumulator, so the sequence is
  bit-identical on every engine. Serialises to one uint32. `forkSeed(runSeed, name)` derives
  named streams (`generator`, `pickup`, `cosmetic`) by FNV-1a over the name, and is pure — it
  does not advance the parent. A test hammers the cosmetic stream 50x between every generator
  draw and asserts the generator sequence is untouched; that isolation is what stops a particle
  effect from silently reshaping the track.
- `clock.ts` — fixed 60Hz accumulator. `advance()` clamps delta to `maxAccumulator` **before**
  accumulating, so a 4-second stall yields exactly 5 ticks. `resync()` is a separate entry point
  that **drops** pending time for the tab-regains-focus case, because clamping minutes of wall
  time to 5 ticks would still lurch the world through obstacles the player never saw. NaN,
  negative and Infinity deltas are all neutralised.
- `state.ts` — plain data, no classes with methods. Every real-valued field lives in a flat
  `Float64Array` indexed by `F.*`; integers stay as object properties because Smis are free.
  See the allocation finding below for why that split is load-bearing rather than stylistic.
- `pool.ts` — `IndexPool` (free list over `Int32Array`) and `Pool<T>` (pre-warmed instances).
  `acquire` past capacity **throws** instead of growing, because growing is the allocation law (d)
  forbids. Double-release and out-of-range release both throw.
- `events.ts` — fixed-size ring, struct-of-arrays. The only channel from sim to presentation:
  no callbacks, no emitters. Consumers hold their own cursor so render and audio drain
  independently. Overwritten entries read as `None` rather than stale data.
- `hash.ts` — FNV-1a over the exact IEEE-754 bit patterns, via a module-level scratch view.
- `sim.ts` — `createSim(seed)` → `{ tick, getState, getPrevious, reset, events, getSeed, hash }`.
  Tick order is documented as a contract in the module header and changing it requires bumping
  the replay format version.
- `replay.ts` — 20-byte header (`magic·version·tickRate·seed·tickCount·finalHash`) plus one
  packed byte per tick. 60 seconds of input is 3,620 bytes. `verify()` re-simulates headlessly.
- `intent.ts` — the normalised discrete input, with `sanitizeIntent` clamping hostile values
  because a submitted replay's intents are untrusted at the P12 trust boundary.

**Stubs — NOT IMPLEMENTED, do not mistake these for finished**

All four are exported functions with the real signature, an empty body, and a header naming the
phase that fills them in. They are called from the tick in the correct order so the wiring is
proven, but they do nothing:

| File | Function | Phase |
|---|---|---|
| `player.ts` | `stepPlayer` | P04 |
| `generator.ts` | `stepGenerator` | P06 |
| `collision.ts` | `stepCollision` | P07 |
| `scoring.ts` | `stepScoring` | P08 |

Consequences today, all expected: nothing spawns, nothing collides, `score` and `flow` stay 0,
and **input has no effect on state**. Two tests assert that last fact explicitly and are marked
as canaries that must flip when P04 lands.

**Two real findings**

1. **`Math.exp` is a cross-engine determinism hazard.** ECMA-262 specifies `+ - * / sqrt` as
   exactly reproducible but `exp/log/pow/sin/cos` only as "implementation-approximated". The
   world-speed curve used `e^(-t/tau)`. P12 validates a **browser**-recorded replay on a **Node**
   server, and Chrome, Safari and Firefox do not share a libm — a one-ulp difference compounded
   over 36,000 ticks diverges, and the failure mode is honest players rejected as cheaters.
   Fixed by freezing `1 - e^(-1/5700)` as a decimal literal in `TUNING.determinism` (decimal→double
   conversion *is* exactly specified) and integrating incrementally with multiply/add only. A test
   asserts the result still matches the closed form to 9 decimal places at t=300s.
2. **Allocation is JIT-tier dependent, and I chased a phantom leak for a while.** Initial
   measurement showed a dead-consistent 16 bytes/tick. Bisecting every component showed 0 B/op
   for each in isolation. The resolution: the same code measures **0 B/tick after ~200,000
   warmup iterations and a steady 16.00 B/tick after ~20,000** — V8 tiering, not a defect.
   Settled it by measuring *retained* memory under `node --expose-gc`: **−40 bytes across
   100,000 ticks, reproduced twice.** The tick leaks nothing. The test now measures retained
   (skipped loudly without the flag), a transient ceiling, and a tier-independent
   early-vs-late-window comparison.

   En route I did move every double out of plain object properties into a `Float64Array`, on the
   theory that V8's removal of double-field unboxing was boxing them. That turned out not to be
   the cause — but it is what ARCHITECTURE.md §2d specifies, it makes `copyState` a single
   `.set()`, and it is much cheaper to do now than at P08. Kept.

**Deliberately deferred / not done**

- **`--expose-gc` is not wired into vitest** (the config change was not approved), so the
  retained-memory test **skips by default**. It logs a clear SKIPPED line rather than passing
  silently. This is the single weakest point in the P02 test suite.
- **No ESLint rule bans transcendentals in `sim/`** (also not approved). The `Math.exp` hazard is
  currently held by convention and one frozen constant. **Nothing stops P04 from typing
  `Math.pow` into an easing curve and quietly breaking cross-engine replay validation.**
  Recommend adding before P04 — it is four lines in the existing `no-restricted-properties` block.
- `copyState` copies full pool capacity (~31KB/tick) rather than up to `count`. Measured cost is
  inside budget and `subarray` would allocate, so left alone; revisit at P07 when entities exist.
- `hashState` costs ~68 bytes/call. It runs once per replay verification, never in the tick.

**Known issues**

- The determinism suite's "different input logs give different hashes" test currently asserts
  they are the SAME, because input is a no-op until P04. Deliberate and commented, but it means
  the anti-cheat is only half-proven today: the server computes the score rather than reading it
  (there is nowhere in the format to put one), but a tampered *input log* is not yet detectable.
  Both tests flip when P04 lands.
- Ring-buffer overflow drops oldest events and counts them; nothing yet consumes `dropped`.

**What P03 needs**

- No new dependencies.
- A decision on the two unapproved items above, especially the transcendental lint rule.
- `src/game/input/` produces `Intent` objects matching `sim/intent.ts`. That module already
  exports `createIntent`, `clearIntent`, `copyIntent` and `sanitizeIntent`; P03 should reuse a
  single instance per frame rather than allocating one.

---

### 2026-08-16 — P01 · Foundation & toolchain — **Complete**

**Verify gate — all green**

```
npm run typecheck && npm run lint && npm run test && npm run build

> tsc --noEmit                          (clean)
> eslint .                              (clean, 0 errors 0 warnings)
> vitest run                            Test Files 2 passed (2) | Tests 56 passed (56)
> next build                            ✓ Compiled successfully in 1320ms
                                        Route (app):  ○ /   ○ /_not-found
```

Also verified beyond the required gate: `npm run test:e2e` → **6 passed** (3 specs ×
desktop-chromium + mobile-chromium), `npm run analyze` → writes to `.next/diagnostics/analyze`,
`npm run format:check` → clean.

**Shipped**

- **`app/` → `src/app/` via `git mv`** (history preserved). `tsconfig` `paths` now `"@/*": ["./src/*"]`.
- **`tsconfig.json`** — `strict`, `noUncheckedIndexedAccess`, plus `noImplicitOverride` and
  `noFallthroughCasesInSwitch`. Target raised to ES2022. `exactOptionalPropertyTypes` was
  considered and **left off** — it fights third-party R3F prop types for little gain here.
- **`eslint.config.mjs` — the layering law, enforced.** `src/game/sim/**` cannot import
  react / react-dom / three / `@react-three/*` / zustand / next / motion / leva / r3f-perf, nor
  anything from `ui/`, `app/`, `render/`, `input/`, `audio/`, `meta/`. Static imports are caught
  by `no-restricted-imports`; `require()` and dynamic `import()` are caught separately by
  `no-restricted-syntax`, because the former only sees static imports. Relative escapes are
  caught by a regex (`^\.\./(?!config/)`) so `../config/x` stays legal and `../render/x` does not.
  Also banned in `sim/`: `Math.random`, `Date.now`, `performance.now`, `window`, `document`,
  `requestAnimationFrame`. Two more boundaries added while there: `src/ui/**` cannot import
  three, and `src/game/config/**` cannot import anything non-relative.
- **`no-magic-numbers`** on `src/game/**` except `config/`, allowlist `0,1,-1,2` — the
  ARCHITECTURE.md §5 rule. Zero noise today because there is no game code yet, and it will
  hold the line from P02 onward.
- **`src/game/config/tuning.ts`** — every value from TUNING.md, 16 sections, `as const`, each
  field carrying its unit and a LOCKED / DERIVED / OPEN tag. Exports `TUNING`, `TuningSchema`,
  `DifficultyBand`. **All nine DERIVED values are computed from hoisted constants**, not typed
  in, so they cannot drift from their inputs.
- **56 tests.** `tests/sim/layering.test.ts` lints virtual files through ESLint's Node API to
  prove each boundary actually errors — *and* proves the legal imports still pass, so the rule
  is targeted rather than a blanket ban that gets disabled the first time it is inconvenient.
  `tests/sim/tuning-invariants.test.ts` covers the four required invariants plus independent
  re-derivation of every DERIVED number and ~20 cross-system coherence checks.
- **18 folder READMEs**, each naming what belongs, what does not, and the governing law.
- **CI** (`.github/workflows/ci.yml`) — Node 24, npm cache, typecheck → lint → test → build as
  four named steps.
- **9 scripts**: `dev build start typecheck lint test test:e2e analyze` + `lint:fix format
  format:check test:watch`.
- Landing page: AXIS wordmark on `#0b0b0c`.

**Two documentation bugs found and fixed**

Both were errors in my own P00 docs, surfaced by writing the invariant tests:

1. **TUNING.md §13 said `fogFar` must exceed `maxSpeed * 0.9 ≈ 31u`** — but Undertow is
   specified at 30u and GAME_BIBLE §10 deliberately calls it "the tightest." The `0.9`
   heuristic was invented; the real floor is `minReactionTime × maxSpeed` = **18.7u**, which
   all four themes clear. Doc corrected, invariant now asserted for all four themes.
2. **TUNING.md §11 said `magnetPullSpeed` "must exceed `maxSpeed`"** — wrong. Bits ride the
   world (law (b)), so they already approach at `worldSpeed`; the pull only closes *lateral*
   distance. Real floor is `magnetRadius / (2 × magnetRadius / maxSpeed)` = **`maxSpeed / 2`
   = 17.0 u/s**. The shipped 18.0 clears it, but by only **5.9%** — flagged in both the doc and
   `tuning.ts` as something to re-check at P07.

**Deliberately deferred**

- **Playwright is not in CI.** Browser downloads would dominate the run for a scaffold with no
  canvas. Revisit at P05 when the draw-call budgets land and actually protect something.
  `playwright.config.ts` already defines both desktop and mobile projects so P05 does not have
  to retrofit the mobile gate.
- **`next/font/google` (Geist) removed** in favour of a system stack in `tokens.css`. It fetches
  at build time, which would make the `build` gate fail on a sandboxed CI runner for reasons
  unrelated to our code. Real typefaces are P10/P14.
- Only the **Kiln** palette exists in `tokens.css`. The other three themes land with
  `config/themes.ts` at P10.
- `config/entities.ts` and `config/themes.ts` not created — P07 and P10.
- `maath` and `howler` not installed — P05 and P11, and raw Web Audio may make `howler`
  unnecessary.

**Known issues**

- **5 high-severity npm advisories, all pre-existing and all transitive** from the
  `create-next-app` scaffold: `next` → `postcss` / `sharp`, plus `brace-expansion` and
  `js-yaml` from tooling. **None come from the r3f packages.** `npm audit fix --force` wants to
  change `next` itself, which needs approval — left untouched.
- `@react-three/postprocessing@3.0.5` peers `@react-three/fiber >=9.7.0`, and 9.7.0 is current
  latest. There is **zero slack**: a fiber patch release could break the peer graph. Watch it.
- `@types/node` is `^20` against Node 24 locally. Nothing fails today; bumping is a dependency
  change and needs approval.
- Vitest config had to be renamed `vitest.config.mts` — Vite's native config loader warns on
  ESM syntax in a `.ts` file with no `"type": "module"`. Setting `"type": "module"` in
  `package.json` would have been the alternative but risks the PostCSS/Next config loaders.

**What P02 needs**

- Nothing installed. Everything for the deterministic sim core is already present.
- A decision on the replay format's schema version field before `sim/replay.ts` is written —
  `tickRate` is baked into every stored replay, so replays must carry a version from the first
  one recorded, not from the first one that breaks.
- Confirmation that `no-magic-numbers` at `enforceConst: true` is acceptable in sim code, since
  it will require `const` for every extracted local. It has had zero opportunity to be annoying
  so far.

---

### 2026-08-16 — P00 · Specification — **Complete**

**Shipped**

- `docs/GAME_BIBLE.md` — pitch, core loop, four-face prism (with the `newLane = 2 - oldLane` derivation), Flow/Overdrive, Fracture, verb table with keyboard/touch/gamepad mappings, 12 obstacles + 4 hazards + 7 pickups, economy with worked examples, avatars/boosts/inventory/missions, four themes with milestones, art direction including the explicit cyberpunk-grid ban, and the complete failure-state list.
- `docs/TUNING.md` — ~90 tunables across 15 sections, each with unit, default, valid range, and too-high/too-low feel notes. Every locked value from the brief carried through unchanged and tagged 🔒.
- `docs/ARCHITECTURE.md` — folder tree, the five laws with rationale and per-law tests, the layering diagram, and a dependency table with one permitted use each.
- `CLAUDE.md` — RULES block, repo orientation, command list, verify-gate policy. The existing `@AGENTS.md` include was preserved.
- `PROGRESS.md` — this file.

**Deliberately deferred**

- No `.ts`, `.tsx`, `package.json` or asset files were created. `tuning.ts` is P01's job.
- No dependencies installed. Everything past the bare `create-next-app` scaffold needs approval first.

**Known issues / findings**

- **The scaffold has `app/` at the repo root, not `src/app/`.** The installed Next 16 docs confirm `src/app` is *ignored* when a root `app/` exists, so P01 must **move** it and update `tsconfig.json` `paths` to `"@/*": ["./src/*"]`. Recorded in ARCHITECTURE.md §1.1.
- Tailwind v4 is installed but was not in the locked stack. Scoped to `src/ui/` layout only; theme colours come from `tokens.css`, never from Tailwind's default palette.
- Four open design questions are parked in GAME_BIBLE.md §13 — camera-rolls-vs-world-rolls (P05), portrait vs landscape (P03), Overdrive extension on Cell pickup, leaderboard scope (P12).

**What P01 needs**

- Approval to install: `three`, `@react-three/fiber@^9`, `zustand`, `vitest`, `@playwright/test`.
- A "go" on the `src/` migration, since it moves files created by the scaffold.
- A decision on whether `npm run budgets` is its own script or folded into `test:e2e`.
</content>
