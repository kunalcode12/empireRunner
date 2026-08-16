# AXIS — Game Bible

> **Status:** authoritative. This file is the single source of truth for design.
> If a prompt, a comment, or a chat message contradicts this document, **stop and ask which wins.**
> Numbers live in [TUNING.md](./TUNING.md). Code layout lives in [ARCHITECTURE.md](./ARCHITECTURE.md).
>
> `AXIS` is a working title held in exactly one constant (`GAME_TITLE`). Renaming the game is a one-line change.

---

## 1. Elevator pitch

You run inside a square tunnel. Three lanes on the face beneath your feet — but there are four faces, and you can roll the world 90° to make any wall your floor. Twelve positions, not three. Obstacles are authored across **all four faces at once**, so a wall with no gap in front of you may have a wide-open gap on the face to your left. Running well fills a **Flow** meter that raises your multiplier *and* the world's speed, so skill compounds into danger, and danger compounds into score. Cash 100 Flow for six seconds of **Overdrive** and you stop dodging obstacles and start shattering them.

**The one sentence:**

> Subway Surfers and Temple Run are three-lane games where every threat has one of four answers; AXIS is a twelve-position game where the *same* wall means a different thing depending on which face you are standing on.

That is the whole differentiator. Every feature below either serves it or gets cut.

---

## 2. Core loop

```
                  ┌──────────────────────────────────────────────┐
                  │                                              │
                  v                                              │
        ╔═════════════════╗                                      │
        ║   PRE-RUN       ║   equip 1 avatar + 2 boosts          │
        ║   LOADOUT       ║   spend Bits on Head Start /         │
        ╚════════╤════════╝   2x Bits / Flow Primer              │
                 │                                               │
                 v                                               │
        ╔═════════════════╗                                      │
        ║      RUN        ║<──────────┐                          │
        ║  roll · jump    ║           │ Fracture succeeds        │
        ║  slide · lane   ║           │ (costs 1 Shard,          │
        ╚════════╤════════╝           │  resume at 50% Flow)     │
                 │                    │                          │
        near-miss│perfect slide       │                          │
        bit streak│                   │                          │
                 v                    │                          │
        ╔═════════════════╗           │                          │
        ║   FLOW 0-100    ║           │                          │
        ║  ↑ multiplier   ║           │                          │
        ║  ↑ world speed  ║  ── self-escalating ──┐              │
        ╚════════╤════════╝                       │              │
                 │ at 100, spend                  │ harder       │
                 v                                │ = more       │
        ╔═════════════════╗                       │ lucrative    │
        ║   OVERDRIVE 6s  ║                       │ = harder     │
        ║  shatter · 4x   ║<──────────────────────┘              │
        ╚════════╤════════╝                                      │
                 │                                               │
              CRASH (Flow -> 0)                                  │
                 │                                               │
                 v                                               │
        ╔═════════════════╗                                      │
        ║  DEATH SCREEN   ║   "you were 40m short"               │
        ║  distance·score ║   mission progress                   │
        ║  Bits earned    ║                                      │
        ╚════════╤════════╝                                      │
                 │                                               │
                 v                                               │
        ╔═════════════════╗                                      │
        ║     SPEND       ║   upgrades (5 tiers)                 │
        ║  Bits / Shards  ║   avatars · cosmetics · consumables  │
        ╚════════╤════════╝                                      │
                 │                                               │
                 └───────────────────────────────────────────────┘
                            longer runs -> more Bits
```

The economic loop is the outer ring. **The inner ring — Flow escalating into Overdrive and collapsing on a crash — is the one that makes people press Retry.** Losing a 90-Flow run hurts in a way losing 400 Bits never will, because Flow is a *state you built*, not a number you banked. Protect that asymmetry in every design decision.

---

## 3. The Four-Face Prism

### 3.1 Geometry

The player runs inside a square prism (a hollow square tunnel) extending along `+Z`. The cross-section is `prismInnerSize` = **7.2u** edge to edge.

Each of the four inner faces carries **3 lanes**, spaced `laneWidth` = **2.2u** apart, centred on the face:

```
                        FACE 2  (the ceiling, when face 0 is the floor)
                     L2       L1       L0
                      ·        ·        ·
              ┌───────────────────────────────┐  y = +3.6
              │                               │
         L0 · │                               │ · L2
   FACE 3     │                               │      FACE 1
   (left      │              +               │      (right
    wall) L1 ·│         tunnel axis           │· L1   wall)
              │                               │
         L2 · │                               │ · L0
              │                               │
              └───────────────────────────────┘  y = -3.6
            x=-3.6   ·        ·        ·      x=+3.6
                     L0       L1       L2
                        FACE 0  (the floor)

              lane centres on face 0:  x = -2.2, 0.0, +2.2
              wall clearance from an outer lane centre: 1.4u
```

- **Faces** are indexed `0..3`. Face `0` is whichever face gravity currently points into — i.e. the floor. Rolling **right** advances the face index `+1 (mod 4)`; rolling **left** advances `-1 (mod 4)`.
- **Lanes** are indexed `0..2`, always ordered **left → right from the player's current point of view**. Lane 1 is always centre.
- The player is a kinematic AABB, never a rigid body. See [ARCHITECTURE.md](./ARCHITECTURE.md) law (e).

**12 positions total** = 4 faces × 3 lanes. This is the state space the level generator authors into.

### 3.2 The roll

A roll re-anchors gravity to the adjacent face. Mechanically:

1. Player inputs `ROLL_LEFT` or `ROLL_RIGHT`.
2. `rollDuration` = **0.30s**. Over that window the entire tunnel — geometry, obstacles, pickups, and camera — rotates 90° about the tunnel axis. The player stays visually near the bottom-centre of frame. **The world rotates; the player does not.**
3. For the first `rollCommitLock` = **0.25s** of the roll, `LANE_LEFT` / `LANE_RIGHT` are **rejected** (not buffered, not queued — dropped). Jump and slide remain available throughout.
4. The last 0.05s is the recovery tail, during which lane input is accepted again and will begin immediately on roll completion.

The commitment lock is what stops the roll from being a free "get out of everything" button. You commit to the destination face before you can see how it plays out.

**DECISION — lane mapping across a roll:** `newLane = 2 - oldLane`.

Derivation: lane 2 on face 0 sits nearest the face0/face1 corner. After a right roll, face 1 is the floor and that shared corner lies at the *left* edge of the new floor — so the player lands in lane 0. The rule is symmetric and holds for both roll directions. The alternative (preserve lane index) was rejected: it teleports the player laterally across the tunnel and breaks the reading of "I was near that corner, I am still near that corner."

Worked example:

```
Player on FACE 0, LANE 2, rolls RIGHT.
  -> face: 0 -> 1
  -> lane: 2 -> 0        (2 - 2)
  -> during t=0.00..0.25s, LANE_LEFT / LANE_RIGHT are dropped
  -> at t=0.30s the player is standing on face 1, lane 0, gravity points +x
```

### 3.3 Why obstacles must be authored across all four faces

The generator does not place obstacles "in front of the player." It places them **into the tunnel**, occupying a set of `(face, lane)` cells at a given `z`. A single spawn event fills anywhere from 1 to 12 cells.

This is what creates the signature moment: a **Full-Face Wall** occupies all 3 lanes of face 0 and cannot be jumped or slid. There is no answer on your face. But face 3 has a clear lane. **The only valid input is a roll.** Not a jump, not a slide, not a dodge — a roll.

**Authoring guarantee (enforced by the generator's fuzz test, P06):** every spawn event must leave **at least one** of the 12 cells reachable by the player given their current cell, the current world speed, and the verb timings in [TUNING.md](./TUNING.md). A spawn that fills all 12 reachable cells is an unwinnable state and is a **generator bug**, not a difficulty setting.

---

## 4. The Flow system

### 4.1 The meter

`Flow` is a single float, `0..100`, owned by the sim. It is the game's whole tension curve.

**Gains** (all values in [TUNING.md](./TUNING.md), all scaled by the avatar/upgrade `flowGainMultiplier`):

| Event | Flow | Condition |
|---|---|---|
| Near-miss | **+6** | Player AABB passes within `nearMissRadius` 0.45u of a hazard AABB (surface to surface) without contacting it. One award per obstacle instance, ever. |
| Perfect slide | **+4** | A slide clears a low bar with ≤ `perfectSlideMargin` 0.12s of spare clearance at either end. Sliding early and lying there does not count. |
| Bit streak | **+3** | Every 10th consecutive Bit collected without missing a Bit that entered the magnet-eligible cone. Streak resets on a miss or a crash. |
| Overdrive Cell | **+35** | Pickup. |
| Shard pickup | **+10** | Pickup. |

**Losses:**

| Event | Effect |
|---|---|
| Passive decay | **-1.5 Flow/s**, but only after `flowDecayGrace` 2.0s with no gain event. Standing still in a clean stretch bleeds you; playing sharply never does. |
| Crash | **Flow -> 0.** Not reduced. Zeroed. |
| Fracture success | **Flow -> 50%** of its value at the moment of death. |

### 4.2 Flow drives two things at once

This is the mechanism. Do not decouple them.

**Score multiplier** — continuous, displayed to one decimal on a mechanical roll counter:

```
scoreMultiplier = 1.0 + 2.0 * (flow / 100)      ->  1.0x at 0 Flow, 3.0x at 100 Flow
```

**World speed** — Flow adds on top of the time-based ramp:

```
timeSpeed(t)  = baseSpeed + (speedCeiling - baseSpeed) * (1 - e^(-t / speedTau))
worldSpeed    = min( timeSpeed(t) + flowSpeedBonus * (flow / 100), maxSpeed )
```

With the locked values (`baseSpeed` 12, `speedCeiling` 28, `speedTau` 95s, `flowSpeedBonus` 6, `maxSpeed` 34 u/s):

| Elapsed | timeSpeed | at 0 Flow | at 100 Flow |
|---|---|---|---|
| 0s | 12.0 u/s | 12.0 | 18.0 |
| 95s | 22.1 u/s | 22.1 | 28.1 |
| 190s | 25.8 u/s | 25.8 | 31.8 |
| 285s | 27.2 u/s | 27.2 | 33.2 |
| ∞ | 28.0 u/s | 28.0 | **34.0 (hard clamp)** |

**DECISION — `speedCeiling` 28 u/s is introduced as a new constant.** The brief gave `baseSpeed` 12 and `maxSpeed` 34 with a tau-95s exponential approach. If the time curve alone approached 34, Flow would have no headroom to contribute and the self-escalation would be cosmetic. Splitting them — time curve approaches 28, Flow adds up to +6, hard clamp at 34 — preserves both given numbers and makes `maxSpeed` reachable *only* by playing well. Override by changing `speedCeiling`, not `maxSpeed`.

The feedback loop, stated plainly:

```
play well -> Flow up -> speed up -> obstacles arrive faster
          -> near-misses become unavoidable rather than optional
          -> Flow climbs faster -> multiplier climbs -> score explodes
          -> until you crash, and lose all of it at once
```

### 4.3 Overdrive

At **exactly 100 Flow** the Overdrive prompt arms. The player spends the full meter to trigger it.

Duration `overdriveDuration` = **6.0s**. During Overdrive:

- **Invulnerable.** Obstacles shatter on contact into Rapier debris (cosmetic only — see law (e)) and are removed from the sim.
- **Full magnet.** Every Bit, Cell and Shard in the visible tunnel is drawn to the player regardless of magnet radius.
- **Score multiplier is a flat 4.0x**, overriding the Flow formula.
- **Flow is frozen at 0** and accrues nothing.
- **Palette inverts** to flat wireframe: the theme's key-line black becomes the fill, the fill becomes the line. This is the only place in the game bloom is permitted (see §11).
- Shattering an obstacle awards its full near-miss value as **score**, not Flow.

On exit: `overdriveExitFlow` = **25**.

**DECISION — Overdrive exits at 25 Flow rather than 0.** Exiting a triumphant 6-second power fantasy into a dead meter reads as a punishment for using the mechanic, and playtest-standard practice in escalation games is to leave the player mid-ramp. 25 is a quarter-meter: meaningful, not free. If Overdrive turns out to be spammable, lower this before touching duration.

Overdrive **cannot** be triggered during a roll, during Fracture, or in the last 0.5s of a theme transition tunnel.

---

## 5. Fracture

The revive. It is a **skill test**, not a purchase. That is the entire point: surviving one feels earned, and it produces the best clip in the game.

### 5.1 Sequence

```
t = 0.000   Fatal contact. Sim state frozen. worldSpeed -> 0.
            The obstacle that killed you shatters into fragments and hangs in the air.
            Everything desaturates to the theme's two darkest colours; the one
            correct escape route is left in full colour.
t = 0.000   Time resumes at fractureTimeScale 0.15. Input window opens.
            HUD shows the Shard cost and a draining 1.2s ring.
t <= 1.200  Player inputs a verb.
            CORRECT -> §5.2 Resume.   WRONG or TIMEOUT -> run over.
```

`fractureWindow` = **1.2s of real time**. At `fractureTimeScale` 0.15 the player perceives roughly 8 seconds of in-world motion — enough to *read* the geometry, not enough to *deliberate*.

### 5.2 The correct move

There is exactly one. The sim computes it at the moment of death by replaying the last `fractureLookback` 0.40s of state against each of the six movement verbs and selecting the single verb that would have produced a clear cell. Because the sim is deterministic (law (a)), this is exact, not heuristic.

- If **two or more** verbs would have cleared it, Fracture does not arm — the death was avoidable by multiple routes and the player simply misplayed. The run ends. (This also means Fracture *teaches*: it only ever fires on deaths that had a single answer.)
- If **zero** verbs would have cleared it, that is an unwinnable spawn and a **generator bug**. Ship behaviour: arm Fracture with any verb accepted, and log a `GENERATOR_UNWINNABLE` telemetry event. The fuzz test in P06 exists to make this never fire.

### 5.3 Resume

| | |
|---|---|
| Cost | **1 Shard** for the first Fracture in a run, **2 Shards** for the second |
| Max per run | `maxFracturesPerRun` = **2** |
| Flow on resume | 50% of its value at death |
| Grace | `fractureInvulnerability` 1.5s of invulnerability, telegraphed by a flashing key-line |
| Position | Player is placed in the cell the correct verb would have reached |
| Speed | Resumes at the pre-death `worldSpeed`, not reset |

**DECISION — `maxFracturesPerRun` = 2, second costs 2 Shards.** Unbounded Fractures turn a rare-currency skill test into a Shard-denominated score ladder, which is exactly the pay-to-continue model this mechanic exists to avoid. Two is enough to save a great run and too few to buy one.

---

## 6. Verbs and input mappings

Six movement verbs, plus two meta verbs. There are no others. If a future feature needs a seventh verb, it needs a design review, not a keybind.

| Verb | Effect | Duration |
|---|---|---|
| `LANE_LEFT` | Move one lane left on the current face. No-op at lane 0. | 0.14s |
| `LANE_RIGHT` | Move one lane right on the current face. No-op at lane 2. | 0.14s |
| `JUMP` | Ballistic arc, apex 1.75u at 0.34s, faster fall. Airborne ≈ 0.59s. | 0.59s |
| `SLIDE` | Collapse hitbox to 0.70u tall, extend to 1.10u deep. | 0.55s |
| `ROLL_LEFT` | Re-anchor gravity to face `-1`. Lane input locked 0.25s. | 0.30s |
| `ROLL_RIGHT` | Re-anchor gravity to face `+1`. Lane input locked 0.25s. | 0.30s |
| `OVERDRIVE` | Spend 100 Flow. Ignored below 100. | — |
| `PAUSE` | Pause. Disabled during Fracture. | — |

### 6.1 Keyboard

| Verb | Primary | Alternate |
|---|---|---|
| `LANE_LEFT` | `A` | `←` |
| `LANE_RIGHT` | `D` | `→` |
| `JUMP` | `Space` | `W` / `↑` |
| `SLIDE` | `S` | `↓` |
| `ROLL_LEFT` | `Q` | `,` |
| `ROLL_RIGHT` | `E` | `.` |
| `OVERDRIVE` | `Shift` | `F` |
| `PAUSE` | `Esc` | `P` |

All bindings are remappable and persisted in `meta/save`. `W`/`↑` doubling as jump is deliberate: the reflex from three-lane runners is "up = jump," and fighting it costs first-run retention.

### 6.2 Touch

| Verb | Gesture |
|---|---|
| `LANE_LEFT` / `LANE_RIGHT` | One-finger horizontal swipe, ≥ `swipeMinDistance` 28px, within `swipeMaxDuration` 260ms |
| `JUMP` | One-finger swipe up |
| `SLIDE` | One-finger swipe down |
| `ROLL_LEFT` / `ROLL_RIGHT` | **Two-finger horizontal swipe** |
| `OVERDRIVE` | Tap the Flow meter (a real HUD hit target, ≥ 56px, bottom-right, thumb-reachable) |
| `PAUSE` | Tap the pause chip, top-left |

**DECISION — roll is a two-finger swipe on touch, with a double-tap-and-hold-drag fallback.** Roll needed a gesture distinct from lane change while remaining directional, and one-handed portrait play is the common grip. Rejected: swiping from screen edges (collides with OS back-gestures on both iOS and Android), and on-screen buttons (they consume the corners the HUD needs and read as a cheaper game). This is the single highest-risk input decision in the game and should be the **first thing playtested in P03.** If two-finger swipes miss too often, the fallback is a device-tilt roll on mobile only.

Touch is also the reason `rollCommitLock` matters: an accidental roll must feel like a mistake with consequences, not noise.

### 6.3 Gamepad (Standard Gamepad mapping via the Gamepad API)

| Verb | Button | Index |
|---|---|---|
| `LANE_LEFT` | D-pad Left / Left stick X < -0.5 | 14 / axis 0 |
| `LANE_RIGHT` | D-pad Right / Left stick X > +0.5 | 15 / axis 0 |
| `JUMP` | A / Cross | 0 |
| `SLIDE` | B / Circle | 1 |
| `ROLL_LEFT` | LB / L1 | 4 |
| `ROLL_RIGHT` | RB / R1 | 5 |
| `OVERDRIVE` | RT / R2 | 7 |
| `PAUSE` | Start / Options | 9 |

Stick axes are **edge-triggered**, never continuous: crossing ±0.5 emits one intent, and the stick must return inside ±0.25 before it can fire again. A held stick does not repeat.

### 6.4 The intent stream

All three devices normalise to the same thing — a stream of `{ verb, tickIssued }`. The sim never sees a key, a touch, or a button. This is what makes replays device-agnostic and P12's server-side validation possible.

Two forgiveness systems apply to every device equally:

- **`inputBuffer` 0.15s** — a verb issued up to 0.15s before it becomes legal is held and fired the instant it is. Pressing jump slightly early while landing still jumps.
- **`coyoteTime` 0.10s** — `JUMP` remains legal for 0.10s after walking off a ledge or gap edge.

Buffered input is **dropped, not queued**, during `rollCommitLock`. That is the exception that makes the roll a commitment.

---

## 7. Entity catalogue

Notation for **Faces**: `any` = the generator may place it on any face; `floor-relative` = only on the face that is currently the floor at authoring time; `all-4` = one instance spans all four faces simultaneously; `edge` = occupies the seam between two adjacent faces.

### 7.1 Obstacles

| # | Entity | Cells occupied | Defeated by | Faces | Notes |
|---|---|---|---|---|---|
| 1 | **Block** | 1 lane | `LANE_*`, `ROLL_*`, `JUMP` (if ≤ 1.2u) | any | The primer. Introduced in band 1. |
| 2 | **Stack** | 1 lane, 2.4u tall | `LANE_*`, `ROLL_*` | any | Too tall to jump. Teaches that height is not always the answer. |
| 3 | **Low Bar** | 3 lanes, 0.0–1.05u | `SLIDE`, `ROLL_*` | any | The perfect-slide source. |
| 4 | **High Gate** | 3 lanes, 1.4u–top | `JUMP`, `ROLL_*` | any | Clearance 1.4u vs jump apex 1.75u = 0.35u margin. |
| 5 | **Pillar Pair** | 2 lanes | `LANE_*` to the free lane, `ROLL_*` | any | One lane always clear on its own face. |
| 6 | **Full-Face Wall** | **3 lanes, full height, one face** | **`ROLL_*` only** | any | The signature entity. No jump, no slide, no lane. Generator must guarantee a clear cell on an adjacent face. Unlocked band 3. |
| 7 | **Void Gap** | 3 lanes, a `gapLength` hole in the floor | `JUMP`, `ROLL_*` | floor-relative | Coyote time applies at the leading edge. Rolling mid-gap lands you on a face that still has floor. |
| 8 | **Piston** | 1–2 lanes, oscillating in/out on `pistonPeriod` 1.4s | timing + `LANE_*`, `SLIDE` at extension, `ROLL_*` | any | Phase is derived from `z` position, so it is deterministic and identical every replay. |
| 9 | **Rotor** | sweeps 3 lanes on a 2.0s cycle | timing + `LANE_*` or `JUMP` | any | Reads as a rotating bar; the safe lane moves. |
| 10 | **Corner Brace** | the seam between two faces | `LANE_*` away from the seam | edge | **Blocks the roll in one direction.** Placed to make a roll answer wrong. Unlocked band 4. |
| 11 | **Shear Ring** | 1–2 lanes on **all four faces** at the same `z` | `LANE_*` + correct face; often `ROLL_*` mid-approach | all-4 | The full 12-cell puzzle. Unlocked band 4. |
| 12 | **Kicker** | 3 lanes, a ramp | none — it launches you | floor-relative | Not a threat. Forces a long airborne beat with pickups in it; landing is on a generator-guaranteed clear cell. |

### 7.2 Hazards (environmental, theme-skinned, non-discrete)

| Entity | Effect | Defeated by | Faces | Theme |
|---|---|---|---|---|
| **Ember Vent** | Column of heat, fatal, fires on a 1.8s cycle | timing + `LANE_*` / `ROLL_*` | any | Kiln |
| **Surge** | Rising water fills the bottom face for 3.0s; the floor becomes fatal | `ROLL_*` to a dry face and stay there | floor-relative | Undertow |
| **Sand Curtain** | Non-fatal. Occludes 60% of view for 2.0s | ride it out, or `ROLL_*` out of it | all-4 | Bazaar |
| **Dropout** | Non-fatal. The tunnel renders as key-lines only for 1.5s; obstacles remain solid | memory | all-4 | Static |

Non-fatal hazards still **suppress Flow gain** while active. They are pressure, not damage.

### 7.3 Pickups

| Pickup | Effect | Value | Spawn weight |
|---|---|---|---|
| **Bit** | +1 Bit, feeds the streak counter | 1 × `bitValueMult` | Baseline; laid in readable arcs and lines, never scattered |
| **Bit Cluster** | 8 Bits in a tight ring, usually on a jump arc or in a Full-Face Wall's escape lane | 8 × `bitValueMult` | 0.06 per slot |
| **Shard** | +1 Shard, **+10 Flow** | 1 | 0.004 per slot — roughly one per three runs |
| **Magnet** | Pulls Bits within `magnetRadius` 4.0u for `magnetDuration` 6.0s | — | 0.03 per slot |
| **Shield** | Absorbs one fatal hit and is consumed. Does **not** reset Flow. Stacks to `maxShields`. | — | 0.02 per slot |
| **Overdrive Cell** | **+35 Flow** | — | 0.025 per slot |
| **Slowfield** | World speed × **0.65** for 4.0s. Score rate is **not** reduced. | — | 0.015 per slot |

**DECISION — Slowfield does not reduce the score rate.** A pickup that slows your scoring is a punishment the player has to learn to dodge, which is a bad pickup. Keeping the rate while dropping the speed makes it a pure relief valve at high Flow.

Pickups are always placed on cells the generator has proven reachable. A Bit line that leads into a wall is a **bug**, not a trap.

---

## 8. Economy

### 8.1 Currencies

**Bits** — soft currency, earned every run, spent constantly.

```
bitsEarned = floor( bitsCollected * bitValueMult * boostMultiplier )
           + floor( distanceMetres / 50 )
```

Worked example: a 2,400m run collecting 310 Bits, with `bitValueMult` at upgrade tier 3 (+55.3%) and the 2× Bits boost active:

```
310 * 1.553 * 2 = 962.86 -> 962
2400 / 50       = 48
                  ------
                  1,010 Bits
```

**Shards** — rare currency. Never sold in bulk, never dropped in a way that feels routine.

| Sources | Rate |
|---|---|
| In-run pickup | ~0.004 per pickup slot ≈ 1 per 3 runs |
| Daily mission completion (all 3) | 1 |
| Weekly contract | 2 / 3 / 5 by tier |
| First-time avatar challenge | 1 each |
| Purchase | Available, never required |

| Sinks | Cost |
|---|---|
| Fracture (1st in run) | 1 |
| Fracture (2nd in run) | 2 |
| Premium avatar unlock | 12–20 |
| Premium cosmetic | 8–15 |

**Shards are never spendable on upgrades.** Upgrades are the Bits treadmill; Shards are the second-chance and identity currency. Mixing them collapses both.

### 8.2 Upgrade cost curve

```
cost(tier) = round5( base * 2.15^(tier - 1) )        tier ∈ 1..5
```

| Upgrade | base | T1 | T2 | T3 | T4 | T5 | Total |
|---|---|---|---|---|---|---|---|
| Magnet Duration | 250 | 250 | 540 | 1,155 | 2,485 | 5,340 | **9,770** |
| Flow Gain Rate | 300 | 300 | 645 | 1,385 | 2,980 | 6,410 | **11,720** |
| Bit Value | 350 | 350 | 755 | 1,620 | 3,480 | 7,485 | **13,690** |
| Shield Count | 400 | 400 | 860 | 1,850 | 3,975 | 8,550 | **15,635** |

Full clear ≈ **50,815 Bits** ≈ 50 competent runs at ~1,000 Bits each.

### 8.3 Diminishing effect curve

```
effect(tier) = Emax * (1 - k^tier) / (1 - k^5),    k = 0.6,   tier ∈ 0..5
```

| Tier | Fraction of Emax |
|---|---|
| 0 | 0% |
| 1 | **43.4%** |
| 2 | 69.4% |
| 3 | 85.0% |
| 4 | 94.4% |
| 5 | **100%** |

Tier 1 costs 250 and delivers 43% of the total benefit. Tier 5 costs 5,340 and delivers the last 5.6%. That is the intended shape: early upgrades feel transformative, the last tier is a completionist flex, and **nobody is ever locked out of content by not owning tier 5.**

| Upgrade | Emax | T1 | T3 | T5 |
|---|---|---|---|---|
| Magnet Duration | +65% (6.0s → 9.9s) | 6.0 → 7.6s | 6.0 → 9.1s | 6.0 → 9.9s |
| Flow Gain Rate | +65% (near-miss 6 → 9.9) | 6 → 7.6 | 6 → 9.1 | 6 → 9.9 |
| Bit Value | +65% (1.0× → 1.65×) | 1.28× | 1.55× | 1.65× |
| Shield Count | +2 (step table, see below) | +0 | +1 | +2 |

**DECISION — Shield Count uses a step table `[1, 1, 2, 2, 2, 3]`, not the continuous curve.** Shield count is an integer; a continuous diminishing curve would produce 1.43 shields. The table preserves the curve's *shape* (front-loaded, flattening) in integer space. Tier 5 caps at 3 shields.

Tier 5 of every upgrade is **+65%, not +400%.** Any upgrade whose tier-5 value more than doubles its tier-0 value is a balance bug.

---

## 9. Meta systems

### 9.1 Avatars

Eight runners. Passives are **flavour-tier**: a good player on the worst avatar beats a bad player on the best. If any passive changes how a run is *played* rather than how it *feels*, it is over-tuned.

| # | Avatar | Passive | Unlock |
|---|---|---|---|
| 1 | **Ferro** | — (baseline) | Default |
| 2 | **Kestrel** | +8% Flow gain | 5,000 Bits |
| 3 | **Ballast** | +1 starting Shield | Challenge: finish a run with 3 Shields unused |
| 4 | **Vane** | Roll commit lock 0.25s → 0.21s | Challenge: 40 rolls in one run |
| 5 | **Ochre** | +10% Bit value | 8,000 Bits |
| 6 | **Sable** | Overdrive lasts 6.0s → 6.7s | Challenge: trigger Overdrive twice in one run |
| 7 | **Quill** | Near-miss radius 0.45u → 0.52u | Challenge: 60 near-misses in one run |
| 8 | **Null** | Fracture window 1.2s → 1.45s | 16 Shards |

Five of eight are unlocked by **challenges, not price.** Money-only rosters make the meta feel like a store shelf.

### 9.2 Pre-run boosts

Two equipped per run. Consumable, bought with Bits.

| Boost | Effect | Cost |
|---|---|---|
| **Head Start** | Begin at 300m, with the world speed already ramped to that point | 500 Bits |
| **2× Bits** | Doubles `bitsEarned` for the run | 600 Bits |
| **Flow Primer** | Start at 40 Flow | 450 Bits |

### 9.3 Inventory

- **Consumables** (boosts) stack to 99.
- **Cosmetics** (avatar skins, trail colourways, tunnel decals) equip, never stack.
- **One loadout:** 1 avatar + 2 boosts. Swapping is free and instant from the main menu.
- No loadout slots are sold. Selling loadout slots is the most common way this genre turns a clean meta into a spreadsheet.

### 9.4 Missions

**Dailies** — 3 active, rotating at 00:00 UTC. Completing all 3 awards 1 Shard.

Examples: *travel 4,000m total* · *trigger Overdrive twice* · *bank 45 near-misses* · *clear 20 Full-Face Walls* · *collect 500 Bits in a single run*.

**Weekly contract** — one 3-tier objective, resets Monday 00:00 UTC. Tiers award 2 / 3 / 5 Shards. Tier 3 should require roughly 5–6 strong runs, not grinding.

**The death screen is the retention hook.** Every death screen shows the closest unmet objective as a near-miss:

```
    WEEKLY  ·  REACH 3,000m IN ONE RUN
    ████████████████████████░░░  2,960m

    YOU WERE 40m SHORT
```

That line does more for D2 retention than any reward in the game. It is not decoration — it is a **required** element of the death screen (P14).

---

## 10. Themes

Four themes. A run **transitions between them at distance milestones**, passing through a 120m transition tunnel that cross-fades palette, fog and music stems. The transition tunnel is guaranteed obstacle-free — it is the run's only place to breathe.

| Theme | Palette (4–6 flat colours) | Fog | Tunnel material | Prop set | Hazard skin | Music stems |
|---|---|---|---|---|---|---|
| **Kiln** | Gunmetal `#2B2B2F`, ember `#E4572E`, ash `#8C8C90`, bone `#EDE6DB`, key-line black `#0B0B0C` | Warm, dense, 45u | Cast iron plate, riveted seams, heavy halftone on the rivets | Ladles, chain hoists, slag chutes, cooling racks | Ember Vent | Kick + industrial clank + low brass drone |
| **Undertow** | Deep teal `#0E3B43`, caustic cyan-green `#3FB8A0`, silt `#5C6B63`, tile bone `#DCD8C7`, key-line black `#0B0B0C` | Cool, layered, 30u — the tightest | Flooded transit tile, grout key-lines, animated caustic bands as **flat stepped bands, not gradients** | Turnstiles, hanging signage, drowned benches, conduit | Surge | Dub bass + plate reverb rim + submerged pad |
| **Bazaar** | Indigo `#2B3A67`, ochre `#D89216`, sun-bleached plaster `#E8DCC0`, terracotta `#A8452B`, key-line black `#0B0B0C` | Bright, thin, 70u — the longest sightlines | Sun-bleached patterned tile, geometric repeat, heaviest halftone | Awnings, hanging rugs, crates, lanterns, spice sacks | Sand Curtain | Oud + hand percussion + tape-saturated synth |
| **Static** *(unlock)* | Broadcast grey `#3A3A3A`, phosphor amber `#F0A202`, bleed magenta `#9B2247`, signal white `#F2F2F0`, key-line black `#0B0B0C` | Flickering, 20–90u, unstable | Decayed CRT scanline plate; the halftone itself glitches | Test cards, dead monitors, cable spools, aerials | Dropout | Detuned FM lead + tape hiss + broken clock pulse |

### 10.1 Milestones

| Distance | Segment |
|---|---|
| 0 – 1,200m | **Kiln** |
| 1,200 – 1,320m | Transition tunnel |
| 1,320 – 2,800m | **Undertow** |
| 2,800 – 2,920m | Transition tunnel |
| 2,920 – 5,000m | **Bazaar** |
| 5,000 – 5,120m | Transition tunnel |
| 5,120m+ | **Static** if unlocked; otherwise cycle to Kiln |
| every +2,000m after | Cycle Kiln → Undertow → Bazaar → Static at band-5 density |

**DECISION — 120m transition tunnels and the ~2,000m cycle length.** The brief specified themed swaps at milestones but not their spacing. 1,200m is roughly 60–75 seconds at mid-run speed, which is long enough to establish a place and short enough that a strong run sees three of them. 120m at 25 u/s ≈ 4.8s of enforced calm — a real breath, and a natural place to hang the "theme name" title card.

**Static is the unlock**, awarded for reaching 5,000m in a single run. It is the only theme with unstable fog, and the only one whose halftone animates.

---

## 11. Art direction

### 11.1 The look: screen-printed arcade

1980s cabinet side-art and riso posters. Physical ink on physical paper, not light on glass.

- **Thick flat colour fields.** Every surface is one flat colour. No gradient ramps, no ambient occlusion baked as a soft smudge.
- **Heavy black key-lines around everything.** Inverted-hull or normal-based outlines, 2–3px at 1080p, scaling with distance so far geometry does not turn into a wire ball.
- **Visible halftone grain.** A screen-space dot pattern over the fill, dot size varying by surface luminance. It should read as a print artifact, not a post filter — it does **not** swim when the camera moves.
- **4–6 colours per theme, hard cap.** Including the key-line black. Every colour in a theme's row in §10 is the *complete* list. Materials sample the theme palette; they do not tint freely.
- **Deep shadow.** Shadow is a single flat darker colour from the palette, with a hard edge. Not a blur.
- **No soft gradients.** Anywhere. If a gradient is unavoidable (fog, caustics), it is **posterised into 3–4 hard steps.**
- **Bloom is reserved for Overdrive.** Not ambient mood. Not "just a little on the pickups." The first frame of Overdrive is the first bloom the player has seen, and that contrast is the effect.

### 11.2 Typography

| Role | Face | Rule |
|---|---|---|
| Display | Heavy condensed grotesque | Titles, theme cards, verb prompts |
| **All numerals** | Wide monospace | Score, distance, Bits, Shards, multiplier, timers — **every digit in the game** |
| Body | Clean sans | Menus, mission text, settings |

Numbers **roll like a mechanical counter** — digits translate vertically, the way a fuel pump or an odometer moves. They never fade, never scale-pop, never count up with an easing tween. A score that ticks over should sound and look like a machine.

### 11.3 EXPLICITLY FORBIDDEN

> **The near-black background with neon cyan and magenta on a glowing perspective grid is banned from this project.**
>
> It is banned in the tunnel, the menus, the HUD, the death screen, the store, the marketing page, the favicon, and the loading state. It is banned as a placeholder. It is banned "just for now until we get real art."

Specifically prohibited:

- Backgrounds darker than the darkest colour in the active theme's palette.
- Cyan (`#00FFFF` and neighbours) or magenta (`#FF00FF` and neighbours) as a **primary or accent** colour anywhere. Undertow's `#3FB8A0` is a desaturated caustic teal and is fine; `#00FFFF` is not.
- Emissive glow as an ambient property of any material. Emission exists only inside Overdrive.
- Perspective grid floors with glowing lines receding to a horizon.
- Chromatic aberration as a constant. It is permitted only as a **transient** on impact, Fracture, and Overdrive entry/exit.
- Scanline overlays outside the Static theme, where they are the diegetic subject.

This ban exists because it is the default output for "arcade game," it is a template rather than a choice, and everyone has seen it. **Any PR that reintroduces it is rejected on sight, regardless of how good it looks.**

---

## 12. Failure states

A run can end for exactly these reasons. There are no others.

| # | Cause | Fracture eligible? | Notes |
|---|---|---|---|
| 1 | **Obstacle contact** — player AABB overlaps a fatal obstacle AABB | Yes, if exactly one verb would have cleared it | The common case |
| 2 | **Hazard contact** — Ember Vent, Surge | Yes, same rule | Non-fatal hazards (Sand Curtain, Dropout) can never kill |
| 3 | **Void Gap fall** — player descends below `fallKillDepth` 4.0u under the current floor plane | Yes — the clearing verb is `JUMP` or a `ROLL_*` | Coyote time already applied |
| 4 | **Corner Brace roll into geometry** — a roll resolves into an occupied cell | **No** | The player rolled into a visible, telegraphed blocker. Fracture would undermine the entity's whole purpose. |
| 5 | **Fracture failure** — wrong verb or 1.2s timeout | — | Terminal by definition |
| 6 | **Out of Fractures** — a fatal hit with `maxFracturesPerRun` spent or 0 Shards held | — | The death screen names which, so the player knows whether to buy or to improve |

Not failure states, for the avoidance of doubt:

- Reaching `maxSpeed`. There is no speed at which the game kills you.
- Flow hitting 0. Costly, never fatal.
- Missing every Bit in a run. Poverty is not death.
- Non-fatal hazards. They suppress Flow, they do not end runs.
- Tab blur / window unfocus — the run **auto-pauses** (P14).

A **Shield** intercepts causes 1, 2 and 3: the shield is consumed, the obstacle shatters, the player gets `shieldInvulnerability` 1.0s, and **Flow is not reset.** That last clause is what makes Shields worth an upgrade track.

---

## 13. Open questions

Tracked here so they do not get silently decided by whoever writes the code.

1. **Does the camera roll with the world, or does the world roll under a fixed camera?** Design intent is world-rolls-under-fixed-camera (the player stays bottom-centre of frame), but this is a motion-sickness risk and needs a real device playtest in P05. A reduced-motion setting is mandatory either way.
2. **Portrait or landscape on mobile?** Portrait suits the one-thumb grip and the vertical tunnel; landscape shows more of the four faces. Decide in P03 with the two-finger-swipe test.
3. **Does Overdrive extend on Cell pickup?** Currently no — Cells give +35 Flow and are wasted during Overdrive. Revisit if Overdrive feels too short.
4. **Leaderboard scope** — global only, or friends/regional? Affects the P12 schema. Defaults to global + weekly reset.
</content>
