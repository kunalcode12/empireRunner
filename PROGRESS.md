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
| **P03** | Input layer | keyboard / touch / gamepad → normalised intent stream; input buffer, coyote time, stick hysteresis, two-finger roll gesture | Unit tests for buffer + coyote windows; a real device playtest of the two-finger roll (GAME_BIBLE §13 Q2 answered) | **Complete (code) · gate PARTIAL** |
| **P04** | Player controller | 12-position face/lane state machine, jump/slide/lane/roll, asymmetric gravity, swept AABB collision, roll commit lock | Headless: all 6 verbs produce the exact durations in TUNING.md; `newLane === 2 - oldLane` across rolls; no tunnelling at `maxSpeed` | **Complete** |
| **P05** | Render bridge & camera | r3f canvas, `dynamic(ssr:false)` mount, four-face prism geometry, runner mesh, snapshot interpolation, camera rig, r3f-perf, leva | Game boots and runs at 60fps; `< 100` draw calls desktop, `< 50` mobile; roll reads correctly and the reduced-motion path works | Not started |
| **P06** | Track generator | Seeded chunk generation, difficulty bands, 4-face authoring, reachability solver, chunk recycling | **10,000-seed fuzz: zero unwinnable spawns**; `minReactionTime` 0.55s never violated at any speed; band density matches TUNING.md §10 | **Complete (not wired live)** |
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

**P03 note.** The input layer was delivered as part of the P04 prompt, which scoped
`src/game/input/**` alongside the player controller. All of P03's code shipped and its unit
tests pass (31 tests). Its gate is marked **PARTIAL** because the other half —
*"a real device playtest of the two-finger roll"* — has not been run and cannot be run
headlessly. **GAME_BIBLE §13 Q2 (portrait vs landscape) is still unanswered.** Do not treat
the touch layer as validated until someone puts a thumb on it.

---

## Build log

### 2026-08-16 — P06 · Level generator — **Complete (not wired live)**

**Verify gate — all green**

```
npm run typecheck && npm run test

> tsc --noEmit         (clean)
> eslint .             (clean, 0 errors 0 warnings — run alongside)
> vitest run           Test Files 20 passed | Tests 472 passed (was 394)
                       Duration 22.01s
```

**Shipped — `src/game/sim/level/`**

- `chunk.ts` — chunk and seam types, 12-bit cell masks, verb and archetype enums.
- `entities.ts` — the entity catalogue with a **blocking model keyed on the player's three
  vertical states** rather than on world-space AABBs, because per-entity collider extents are
  P07's job and a solver built on `collision.ts`'s placeholder 0.5u cube would prove chunks
  safe against geometry that is not the shipping geometry.
- `chunks/` — **32 hand-authored chunks** across five tier files. ≥5 per tier, all ten
  required archetypes present, every one asserted by test.
- `generator.ts` — rolling window, banded grammar, weighted selection, recency penalty, seam
  validation, forced breathers, theme transitions. Fully pooled.
- `validator.ts` — BFS solver over `(tick, face, lane, vertical, vertTimer, rollLock)`,
  ~990k states worst case, with a reusable `Uint8Array` visited set.

**A doc bug that would have poisoned the whole solver**

GAME_BIBLE §7.1 listed the **Low Bar as occupying 0.0–1.05u** (a floor kerb) and the **High
Gate as 1.4u–top** (a ceiling lintel) — while its own "defeated by" column said SLIDE and JUMP
respectively. Those are inverted: you cannot slide under something on the floor, and you cannot
jump over something that reaches the ceiling. TUNING §5 compounded it by calling both
"underside height".

The gate's own note — *"clearance 1.4u vs jump apex 1.75u = 0.35u margin"* — only works if
1.4u is its **top**. Corrected in both docs before writing a line of solver.

**The solver found 7 chunks I authored that are impossible**

This is the finding of the phase. At maxSpeed one tick is 0.567u:

| verb | ticks | distance |
|---|---|---|
| lane change | 8 | 4.5u |
| roll | 18 | **10.2u** |
| slide | 33 | 18.7u |
| jump | 36 | **20.4u** |
| **whole chunk** | 43 | **24u** |

Two consequences I had not accounted for while authoring:

1. **A Full-Face Wall must sit at z ≥ ~11u.** A roll takes 10.2u to complete and the player is
   still on the old face throughout, so a wall at z=8 kills them mid-roll. Four chunks had
   walls too early.
2. **No 24u chunk can demand two vertical verbs.** Jump (36t) + slide (33t) = 69 ticks against
   a 43-tick chunk. `t5-roll-jump-slide` asked for roll + jump + slide and was never possible.
   Reframed as `t5-braced-roll-jump`. `t5-double-roll` likewise: two rolls are 20.4u plus
   cooldown, so it became `t5-wrong-way-wall` — one roll where the *direction* is the decision,
   which is a better chunk than the one I set out to write.

Three more failed on lane-shuffle timing: two lane changes are 16 ticks, so a pillar pair at
z=7 is unreachable from the outer lane. All seven fixed; all 32 now pass from **all 12 entry
cells**.

**Slack table** — ticks the player can be frozen on entry and still survive:

```
tier 1   17-43     generous, as the teaching band should be
tier 2    6-43
tier 3    6-43
tier 4    3-43     t4-roll-then-jump / -slide / -multiface-weave sit at 3
tier 5    3-43     t5-braced-roll-jump and t5-gauntlet-terminal sit at 3
```

Nothing is below `minSolverSlackTicks` (3), so nothing is flagged TIGHT — but the tier-4/5
floor sitting exactly *on* the threshold is worth knowing. Those six are the first place to
look if playtesters report the late game feeling unfair.

**Fuzz — 10,000 seeds x 250 chunks = 2,500,000 chunk selections**

```
  distance      mean tier  distribution (tier 1..5 share)
      0-  500m     1.00     1111111111111111111111111111111111111111
    500- 1000m     2.00     2222222222222222222222222222222222222222
   1000- 1500m     2.00     2222222222222222222222222222222222222222
   1500- 2000m     3.00     3333333333333333333333333333333333333333
   2000- 2500m     3.00     3333333333333333333333333333333333333333
   2500- 3000m     3.00     3333333333333333333333333333333333333333
   3000- 3500m     3.76     3333333333444444444444444444444444444444
   3500- 4000m     3.76     3333333333444444444444444444444444444444
   4000- 4500m     3.76     3333333333444444444444444444444444444444
   4500- 5000m     3.75     3333333333444444444444444444444444444444
   5000- 5500m     4.53     3333333335555555555555555555555555555555
   5500- 6000m     4.50     3333333333555555555555555555555555555555

  chunks generated : 2,500,000
  transitions      :   150,000
  seam violations  :         0
  breather breaches:         0
```

The tier-3 floor visible from 3,000m on is the **breather rule working** — it forces a
non-hard chunk after three consecutive hard ones, and tier 3 is where those come from.

**Deliberately NOT done**

- **The generator is not wired into the live tick.** `src/game/sim/generator.ts` is still the
  P02 no-op stub. Connecting it would spawn entities that `collision.ts`'s placeholder
  classifier mishandles — it currently splits fatal/stumble on odd-vs-even kind id — and
  per-entity collider extents do not exist. Both are P07. **The game still generates no
  track.**
- The solver does not model the fast-drop, so it is *stricter* than the real controller. That
  is the safe direction: a chunk it passes is survivable in the real game, and no chunk
  depends on an undocumented technique.
- `minReactionTime` is not separately asserted. The solver subsumes it — a chunk that violates
  reaction time has zero slack and fails outright.

**Known issues**

- Six tier-4/5 chunks sit exactly at the slack threshold of 3 ticks (50ms).
- The layering lint rule needed a **third** fix. v1 assumed sim files sat at the root, v2
  allowlisted sibling module names by hand and broke on `../chunk`. It is now a **denylist**
  of the six sibling layers, which cannot go stale when a module is added. Verified against a
  probe that escapes to `render/` and `ui/`.
- `no-magic-numbers` is now exempt for `src/game/sim/level/chunks/**`, on the same grounds as
  `config/`: those files are pure data, every number *is* the content, and hoisting each z
  offset to a named constant would make them unreadable to whoever authors chunk 33.

**What P07 needs**

- Wire `stepGenerator` to `fillWindow`, and replace `classifyContact`'s odd/even placeholder
  with the real `ENTITY_DEFS` table.
- Add per-entity collider extents, then add the cross-check test asserting the solver's
  logical blocking model and the real AABBs agree. **Until that test exists, the two models
  can drift and nothing will notice.**

---

### 2026-08-16 — P04b · Hardening pass — **Complete**

Ran between P04 and P05 to clear every issue flagged as open across P02-P04, plus three
real bugs found by auditing rather than by a failing test.

**Verify gate**

```
npm run typecheck && npm run lint && npm run test

> tsc --noEmit         (clean)
> eslint .             (clean, 0 errors 0 warnings)
> vitest run           Test Files 17 passed | Tests 394 passed (was 377)
```

**Three real bugs, all of which passed every existing test**

1. **Coyote time was completely dead.** `beginCoyote` existed, was exported, and had six
   passing unit tests — and **nothing in the controller ever called it**. Worse, fixing that
   was only half the job: the transition table had no `FALLING --JumpStart--> JUMPING` edge,
   so even once armed, a coyote jump was rejected and buffered. Coyote time is a LOCKED
   tuning value that did nothing whatsoever. Both halves fixed; the edge is now in the table
   with its guard documented.
2. **`Edge.LeaveGround` was unreachable.** The transition table advertised walking off a
   ledge; no code path produced it. Now exported as `leaveGround()` — armed automatically
   when support is lost, and the entry point P07's Void Gap logic will call.
3. **A fatal hit never ended the run.** Only `player.phase` became `Crashed`; `runStatus`
   stayed `Running`, so `sim.tick` kept going — the world scrolled, `distance` accumulated,
   and **a dead player went on scoring forever**. `endRun()` now sets `RunStatus.Ended` and
   emits `RunEnd`. Tests pin that distance, tick count and state hash all freeze at death.

**Previously-flagged issues, now closed**

- **Transcendental lint ban is in.** `Math.exp/log/pow/sin/cos/tan/atan2/cbrt/hypot` and
  friends are rejected inside `src/game/sim/`; `Math.sqrt` stays legal because IEEE-754
  specifies it exactly. Verified by planting a violation: 3 errors, `sqrt` untouched. This
  was raised at P02 and P04 and is the oldest risk in the repo — now enforced rather than
  hoped for.
- **Layering rule fixed for subdirectories.** The old regex `^\.\./(?!config/)` assumed
  every sim file sat directly in `src/game/sim/` and rejected a subdirectory's legitimate
  `../state`. The new pattern allows a sim sibling or `../../config/`, still catching
  `../render/` and `../../ui/`. Verified against a probe file.
- **`--expose-gc` wired into vitest** (`test.execArgv`, a top-level option in Vitest 4, not
  `poolOptions`). The retained-memory test **no longer skips**: it now measures
  **−104,280 bytes across 10,000 ticks**. Law (d) is verified rather than aspirational.
- **GAME_BIBLE updated** so the bible and the code agree: STUMBLE is documented as §12.1 with
  its numbers and its rationale, corner forgiveness is in §6.4, and the fast-drop has its own
  §6.5 explaining why it is undocumented *in-game* but documented *here*. Variable jump
  height added to the verb table.
- **P03's phase-table status corrected.** Its code shipped inside the P04 prompt; the row now
  reads `Complete (code) · gate PARTIAL` with a note that the device playtest is outstanding.

**Also**

- The roll now sets `Verb.RollLeft` / `Verb.RollRight` so the HUD can read it.
- `fellOutOfWorld` is checked before `Apex`, and routes through `Apex` first when the player
  is still in `JUMPING`, so it can never attempt an illegal edge.

**Still open — deliberately**

- **The two-finger roll has still not been playtested on hardware**, and GAME_BIBLE §13 Q2
  (portrait vs landscape) is still unanswered. Not fixable from here.
- **Coyote time cannot be exercised end to end** until Void Gaps exist: `stepVertical` treats
  the floor as unconditionally present at `y = 0`, so a player who loses support re-lands the
  same tick. The wiring and the decision path are tested; the *trigger* arrives at P06/P07.
  This is called out in a comment block in `ground-and-death.test.ts` rather than papered over.
- Per-entity collider extents and the real STUMBLE/FATAL classification are still P07.

---

### 2026-08-16 — P04 · Player controller & collision — **Complete**

**Verify gate — all green**

```
npm run typecheck && npm run test

> tsc --noEmit                    (clean)
> eslint .                        (clean, 0 errors 0 warnings — run alongside)
> vitest run
  Test Files  16 passed (16)
       Tests  377 passed (377)
    Duration  4.19s
```

**State hash and tick timing** (Node v24.13.0, Windows 11):

```
30s scripted-log state hash : 0x29ae5fa5   (identical across 100 runs)
  final phase/face/lane     : 3 (SLIDING) / face 0 / lane 1
  distance                  : 428.44 m
10,000 ticks (idle)         : 7.09ms | 0.709us/tick
10,000 ticks (full input)   : 8.04ms | 0.804us/tick
realtime multiple           : 20,737x
```

Driving all six verbs costs **0.095us/tick** more than idling — the controller is
essentially free next to the per-tick snapshot copy.

**Shipped**

- **`player/phase.ts`** — the 8-phase machine as a frozen data table, with the full
  transition table in the header. Illegal transitions throw in dev, no-op in prod.
  `phase.test.ts` walks all 8 x 16 = 128 pairs and asserts exactly 32 are legal.
- **`player/facing.ts`** — the `(face, lane, direction)` transform, pure and isolated.
  All 24 cases written out by hand rather than generated, so a wrong expectation shows in
  the diff instead of being computed by the same rule the code uses.
- **`player/locomotion.ts`** — lane tween (ease-out cubic, interruptible by reverse, not by
  a roll), jump solved from `jumpApexTime`/`jumpApexHeight` with asymmetric gravity,
  variable height via release-edge cut, slide, and the concurrent roll.
- **`player/forgiveness.ts`** — coyote time, one-slot input buffer, both aged at the END of
  the step so a window gets its full stated duration.
- **`player/collider.ts`** — phase-dependent AABB. Airborne deliberately reuses the standing
  box; inventing a smaller one would be a gameplay change smuggled in as an implementation detail.
- **`player/timer.ts`** — epsilon-snapped countdowns. See finding 3.
- **`collision.ts`** — swept AABB with a slab solve, FATAL/STUMBLE/PASS classification,
  corner forgiveness, and near-miss at 0.45u surface-to-surface awarded once per instance.
- **`src/game/input/`** — keyboard, touch and gamepad normalising to one intent stream.
  Touch fires **on threshold crossing, not touchend**, with a diagonal dead zone that
  discards ambiguous swipes rather than guessing. Gamepad uses a real hysteresis band.
- **377 tests**, up from 181.

**Four real findings**

1. **The dev-mode guard caught a hole in my own transition table.** The fast-drop slams
   `vy` to -28 u/s, so the player can reach the floor on the very next tick **while still in
   JUMPING** — the `Apex` edge never fires. `JUMPING --Land-->` and `JUMPING --LandIntoSlide-->`
   were missing. Added, with the reachability explained in the table. This is exactly what an
   exhaustive machine is for, and it paid for itself within an hour.
2. **A sign error in the swept-AABB slab solve.** I had `t = (centreDelta ± extentSum) / motion`;
   solving `|centreDelta + motion·t| < extentSum` actually gives `t = (−centreDelta ± extentSum) / motion`.
   It returned the right answer for already-overlapping boxes, so several tests passed —
   the thin-obstacle test at `maxSpeed` is what exposed it. **Every obstacle thinner than
   0.567u would have been tunnelled through.**
3. **Every timer ran one tick long.** `fixedDelta` is `1/60`, which is not exactly
   representable: `6 × (1/60) = 0.09999999999999999`, leaving `1.4e-17` on a 0.10s window and
   a naive `> 0` check keeping it open for a seventh tick. That is a **16% error on
   `coyoteTime`** and the kind of drift that makes playtest tuning impossible. Fixed centrally
   in `player/timer.ts` with an epsilon snap; `coyoteTime` is now exactly 6 ticks, the slide
   exactly 33, the roll exactly 18.
4. **The P01 layering lint rule has a false positive.** Its regex `^\.\./(?!config/)` assumed
   sim files sit directly in `src/game/sim/`, so a subdirectory's legitimate `../state` and
   `../../config/tuning` are rejected. `player/**` uses the `@/` alias instead, which the
   rule's group patterns explicitly permit for those two targets — legal, not an evasion,
   and `@/game/render` is still caught. **The rule itself is still wrong** and will bite the
   next subdirectory; see below.

**Both P02 canaries flipped, as designed**

- `replay.test.ts` "rejects a tampered input log" now asserts **rejection**. With input live,
  one flipped lateral bit 300 ticks from the end diverges the run. **The anti-cheat is fully
  closed as of this phase.**
- `determinism.test.ts` "different input logs give different hashes" now asserts they
  **differ**. Added a companion test pinning the honest corollary: a *completed* jump leaves
  no residue, so runs differing only by a finished jump legitimately reconverge — and since
  the server recomputes the score rather than reading one, a hash-neutral edit is also
  score-neutral and gains an attacker nothing.

**Deliberately deferred / not done**

- **The two-finger roll gesture has NOT been playtested on hardware.** PROGRESS.md sets that
  as half of P04's gate and I cannot run it. The recognizer is unit-tested headless
  (31 tests) but `twoFingerTolerance` at 80ms is still an untested guess on real thumbs.
  **GAME_BIBLE §13 Q2 (portrait vs landscape) remains unanswered.**
- **GAME_BIBLE was not updated** (doc scope not approved). STUMBLE, corner forgiveness and
  the fast-drop are implemented and tuned but appear in **neither** §7 nor §12. The bible and
  the code disagree today. TUNING.md §6 was corrected to `easeOutCubic` since that was
  explicitly approved.
- **Per-entity collider extents do not exist.** `collision.ts` uses a single 0.5u half-extent
  for every obstacle; the real dimensions arrive with `config/entities.ts` at P07. The
  thin-obstacle tunnelling test therefore drives `sweptOverlap` directly.
- `classifyContact` is a placeholder (odd kinds stumble, even kinds kill) so both branches are
  reachable. **Not a design** — P07 replaces it.
- Nothing spawns obstacles yet (generator is a P06 stub), so collision runs against an empty
  array in real play and the tests construct entities by hand.

**Known issues**

- **The transcendental lint ban is still not in place** (proposed at P02 and P04, not
  approved). P04 added easing and gravity maths and I kept everything to exact IEEE-754 ops
  by hand. Nothing enforces that for P05-P08. This is now the oldest open risk in the repo.
- The layering rule's relative-path regex is wrong for subdirectories (finding 4). Fix:
  allow `^\.\./` when the resolved path stays inside `src/game/sim/` or `src/game/config/`.
- `--expose-gc` still unwired, so the retained-memory test still skips.
- Dev-throw / prod-ignore means a replay hitting an illegal edge would crash a dev-mode
  server while a prod client sails past. Deliberate — a determinism bug should be loud where
  it can be fixed — but the guard must never become load-bearing gameplay logic.

**What P05 needs**

- Approval for the two lint fixes above.
- The render bridge reads `previous`/`current` and lerps by `alpha`; rotations use the roll
  angle in `F.playerRoll`, which is folded back to zero on completion so it never accumulates.
- `rollCameraLerp` (0.85) and GAME_BIBLE §13 Q1 (camera rolls vs world rolls) need the device
  playtest that P04 could not run.

---

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
