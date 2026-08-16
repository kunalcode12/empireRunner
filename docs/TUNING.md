# AXIS — Tuning Reference

> **Status:** authoritative for numbers. Design rationale lives in [GAME_BIBLE.md](./GAME_BIBLE.md).
>
> **Every number in this file has exactly one home in code: `src/game/config/tuning.ts`.**
> A gameplay number that appears anywhere else — a component, a system, a shader, a test — is a
> bug, and CI fails on it (see [ARCHITECTURE.md](./ARCHITECTURE.md) §5).
>
> Units are explicit everywhere. `u` = world unit. `u/s` = world units per second. All times are
> **seconds of sim time** unless the row says otherwise.

## How to read this file

| Column | Meaning |
|---|---|
| **Default** | Ship value. What `tuning.ts` initialises to. |
| **Range** | The band inside which the value is *sane*. Outside it, expect broken feel or broken collision. `leva` sliders in dev clamp to this. |
| **Too low / Too high** | What it feels like at the edges. This is the column you actually use when playtesting. |

### Status tags

- 🔒 **LOCKED** — a researched starting point from platformer game-feel literature. **Do not change these without a real playtest.** Not guesses, not placeholders.
- 🔧 **DERIVED** — computed from locked values. Changing a locked value changes these automatically. Never hand-edit a derived number; fix its inputs.
- ⚙️ **OPEN** — a first-pass value chosen to make the system runnable. Expected to move. Marked `DECISION` in the notes where it was my call.

---

## 1. Simulation core

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `tickRate` | Hz | **60** | 60 fixed | 🔒 | Below 60 the input buffer and coyote windows stop resolving at the granularity players can feel; 30Hz makes a 0.10s coyote window 3 ticks and jitter becomes visible. | Above 60 burns CPU on mobile for zero perceptual gain and desyncs every recorded replay. **This value is effectively constant** — replays and leaderboard validation (P12) depend on it. Changing it invalidates every stored replay. |
| `fixedDelta` | s | **0.016667** | — | 🔧 | `1 / tickRate`. | |
| `maxTicksPerFrame` | ticks | **5** | 3 – 8 | ⚙️ | Below 3, a hitching tab drifts behind real time and the world visibly slows. | Above 8, recovering from a long stall runs a burst of catch-up ticks and the world lurches forward through obstacles. This is the spiral-of-death guard. |
| `maxAccumulator` | s | **0.0833** | — | 🔧 | `maxTicksPerFrame * fixedDelta`. Excess accumulated time is discarded, not simulated. |

---

## 2. World speed

The world translates toward the player. See [ARCHITECTURE.md](./ARCHITECTURE.md) law (b).

```
timeSpeed(t) = baseSpeed + (speedCeiling - baseSpeed) * (1 - e^(-t / speedTau))
worldSpeed   = min( timeSpeed(t) + flowSpeedBonus * (flow / 100), maxSpeed )
```

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `baseSpeed` | u/s | **12.0** | 8 – 16 | 🔒 | The first 20 seconds feel like walking; players quit before the game starts. | New players are overwhelmed in the tutorial band and never learn the roll. |
| `maxSpeed` | u/s | **34.0** | 28 – 40 | 🔒 | Hard clamp. Below 28 the late run stops escalating and expert play plateaus into boredom. | Above 40, reaction distance falls under the human floor: at 40 u/s a 0.55s reaction needs 22u of clear sightline, which the fog cannot deliver. |
| `speedCeiling` | u/s | **28.0** | 22 – 31 | ⚙️ | Time alone stops mattering; only Flow drives speed and low-Flow runs stagnate. | Approaches `maxSpeed` and squeezes out Flow's contribution, making the self-escalation loop cosmetic. Must stay ≤ `maxSpeed - flowSpeedBonus`. |
| `speedTau` | s | **95.0** | 60 – 140 | 🔒 | The ramp arrives too fast; the difficulty bands (§10) get out of sync with the speed and band 2 arrives at band-4 speeds. | The run feels flat for minutes. Note 1 tau ≈ 63% of the way from `baseSpeed` to `speedCeiling`. |
| `flowSpeedBonus` | u/s | **6.0** | 3 – 9 | ⚙️ | Flow stops feeling dangerous; it becomes a pure score stat and the "skill makes it harder" hook dies. | A 100-Flow run outpaces the fog draw distance and obstacles become unreadable. Must stay ≤ `maxSpeed - speedCeiling`. |

**Worked example — reaction distance.** At `worldSpeed` 28 u/s, an obstacle 20u ahead arrives in `20 / 28 = 0.714s`. Subtract `inputBuffer` 0.15s of tolerance and the player has ~0.56s to read and answer it. That is why `minReactionTime` (§10) is 0.55s and why fog distance must exceed `maxSpeed * 0.9 ≈ 31u` in every theme except Static (which is deliberately unfair, and unlocked).

---

## 3. Geometry

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `laneWidth` | u | **2.2** | 1.6 – 3.0 | 🔒 | Lanes read as one wide strip; the player cannot tell which lane a distant obstacle occupies. | Lane changes travel too far in `laneChangeDuration` and read as teleports; also widens the tunnel until the far faces are invisible. |
| `laneCount` | count | **3** | 3 fixed | 🔒 | — | 4+ lanes per face × 4 faces = 16 positions, which is past the readable limit at speed. This is a design constant. |
| `faceCount` | count | **4** | 4 fixed | 🔒 | — | The prism is square. This is the game. |
| `prismInnerSize` | u | **7.2** | 6.6 – 8.4 | 🔧 | `laneWidth * (laneCount - 1) + 2 * wallMargin` = `4.4 + 2.8`. Below 6.6 an outer-lane player clips the wall; above 8.4 the opposite faces are too far to read. |
| `wallMargin` | u | **1.4** | 1.0 – 2.0 | ⚙️ | Outer lanes feel pinched and the player's shoulder visually intersects the wall. | The tunnel bloats and the four-face conceit gets lost in empty space. |
| `playerWidth` | u | **0.70** | 0.5 – 0.9 | ⚙️ | Slipping through gaps that visually should not fit; near-misses stop registering. | Clipping obstacle corners the player believes they cleared. Keep well under `laneWidth`. |
| `playerHeightStand` | u | **1.60** | 1.4 – 1.8 | ⚙️ | High Gates become trivially clearable without jumping. | Must stay above this for High Gate clearance to mean anything. |
| `playerDepthStand` | u | **0.60** | 0.5 – 0.8 | ⚙️ | Obstacles pass through the player before registering. | Deaths register "too early," in front of the visible model. |
| `playerHeightSlide` | u | **0.70** | 0.55 – 0.9 | ⚙️ | Slide clears everything and becomes the universal answer. | Cannot clear the Low Bar at 1.05u with margin. Must be < `lowBarClearance - 0.25`. |
| `playerDepthSlide` | u | **1.10** | 0.9 – 1.4 | ⚙️ | Sliding has no cost. | The extended hitbox catches obstacles behind the player and deaths read as unfair. |
| `fallKillDepth` | u | **4.0** | 2.5 – 6.0 | ⚙️ | A Void Gap kills before the fall reads as a fall. | The player floats visibly below the tunnel for a beat before dying, which looks broken. |

---

## 4. Vertical movement

Gravity is **asymmetric** — this is the single biggest lever on jump feel and the reason it is split into two numbers.

```
gravityRise = 2 * jumpApexHeight / jumpApexTime^2
jumpImpulse = 2 * jumpApexHeight / jumpApexTime
gravityFall = gravityRise * fallGravityMultiplier
fallTime    = sqrt( 2 * jumpApexHeight / gravityFall )
airTime     = jumpApexTime + fallTime
```

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `jumpApexTime` | s | **0.34** | 0.25 – 0.45 | 🔒 | The jump is a twitch; players cannot see the arc and cannot time a landing. | Floaty. The player hangs, loses the sense of weight, and jump becomes a dodge-everything button because the airtime covers too much ground. |
| `jumpApexHeight` | u | **1.75** | 1.5 – 2.2 | ⚙️ | Cannot clear the High Gate at 1.4u. Below 1.5u the jump verb stops answering anything. | Clears the Stack (2.4u) and collapses the "height is not always the answer" lesson. Margin over High Gate is currently **0.35u**. |
| `fallGravityMultiplier` | ×  | **1.8** | 1.4 – 2.4 | 🔒 | The descent matches the rise and the jump feels like the moon. This is *the* floatiness knob. | The player is slammed down; the arc reads as a spike and landings feel like being dropped rather than landing. |
| `gravityRise` | u/s² | **30.28** | — | 🔧 | `2 * 1.75 / 0.34²` |
| `gravityFall` | u/s² | **54.50** | — | 🔧 | `30.28 * 1.8` |
| `jumpImpulse` | u/s | **10.29** | — | 🔧 | `2 * 1.75 / 0.34` |
| `fallTime` | s | **0.2534** | — | 🔧 | `sqrt(2 * 1.75 / 54.50)` |
| `airTime` | s | **0.5934** | — | 🔧 | `0.34 + 0.2534` |

**Worked example — jump footprint.** The distance the world travels during one jump:

| worldSpeed | ground covered (`airTime × speed`) |
|---|---|
| 12 u/s (run start) | 7.1u |
| 22 u/s (mid run) | 13.1u |
| 28 u/s (`speedCeiling`) | 16.6u |
| 34 u/s (`maxSpeed`) | 20.2u |

This is why obstacle spacing (§10) is expressed in **seconds of separation, not units.** A 12u gap is comfortable at run start and does not exist at max speed.

---

## 5. Slide

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `slideDuration` | s | **0.55** | 0.40 – 0.80 | 🔒 | The slide ends under the bar and the player stands up into it. Reads as a broken hitbox even though it is a timing failure. | Slide becomes a free crouch-walk; the player spams it, and low bars stop being a distinct threat. |
| `slideRecovery` | s | **0.08** | 0.0 – 0.2 | ⚙️ | No commitment; slide-cancel spam. | Standing up feels sticky and chains into the next obstacle badly. Lane change **is** permitted during a slide; jump is not until recovery ends. |
| `perfectSlideMargin` | s | **0.12** | 0.05 – 0.25 | ⚙️ | "Perfect" is unhittable and the Flow source dries up. | Every slide is perfect, the bonus stops meaning anything, and Flow inflates. |
| `lowBarClearance` | u | **1.05** | 0.9 – 1.3 | ⚙️ | **UNDERSIDE height** of a Low Bar, which hangs from the ceiling. Below 0.95 nothing clears it — `playerHeightSlide` is 0.70u and needs margin. | Above 1.3 a standing player nearly fits and the slide stops being required. |
| `highGateClearance` | u | **1.40** | 1.2 – 1.6 | ⚙️ | **TOP height** of a High Gate, which stands on the floor. (Corrected at P06: this was mislabelled "underside", which inverted the entity and would have made the level solver validate against the wrong geometry.) Below 1.2u the jump becomes trivial and the gate stops being a real gate. | Approaches `jumpApexHeight` 1.75u and the jump margin (0.35u) vanishes. |

---

## 6. Lane change

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `laneChangeDuration` | s | **0.14** | 0.08 – 0.25 | 🔒 | Teleporting. The player arrives before the eye tracks the move, and near-misses stop being legible. | Sluggish. At 28 u/s a 0.25s lane change travels 7u forward, so the player is committed for a third of a jump's footprint and dodging late becomes impossible. |
| `laneChangeEasing` | — | **`easeOutCubic`** | — | ⚙️ | Linear reads mechanical and cheap. | Heavy ease-in-out makes the move feel like it has weight it should not have. The runner is agile, not heavy. **Changed from `easeOutQuad` at P04:** cubic decelerates harder into the settle, which reads as decisive rather than drifting over a 0.14s move. Implemented as an explicit polynomial (`1 - u*u*u`), never `Math.pow` — see the determinism note in §1b. |
| `laneQueueDepth` | count | **1** | 0 – 2 | ⚙️ | 0 means a double-tap to cross two lanes drops the second input, which players read as a missed press. | 2+ lets a panic mash carry the player across the whole face uncontrollably. |

---

## 7. Roll — the signature verb

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `rollDuration` | s | **0.30** | 0.20 – 0.45 | 🔒 | Below 0.20s the 90° world rotation becomes a hard cut; the player loses spatial orientation and cannot tell which face they are on. | Above 0.45s the rotation induces motion sickness and the player is blind through too much track. |
| `rollCommitLock` | s | **0.25** | 0.15 – 0.30 | 🔒 | **This is the risk that stops roll being a free escape button.** Below 0.15s the player can roll and immediately correct their lane, so a roll costs nothing and the Full-Face Wall stops being a threat. | Above 0.30s (i.e. ≥ `rollDuration`) the player lands with no ability to adjust and every roll into a partially-blocked face is an unavoidable death. Must stay **< `rollDuration`**. |
| `rollRecovery` | s | **0.05** | — | 🔧 | `rollDuration - rollCommitLock`. The tail where lane input is accepted again. |
| `rollCooldown` | s | **0.10** | 0.0 – 0.30 | ⚙️ | Chain-rolling 360° through the tunnel; the player spins constantly and the four-face read collapses. | Two consecutive rolls (a 180°) become impossible, removing a legitimate advanced answer. |
| `rollEasing` | — | `easeInOutCubic` | — | ⚙️ | Linear rotation is the most nauseating possible curve. | Extreme ease makes the middle of the roll a blur-fast snap. |
| `rollCameraLerp` | — | **0.85** | 0.6 – 1.0 | ⚙️ | The camera lags the world and the horizon swims. | 1.0 = camera locked rigidly to the roll. See [GAME_BIBLE.md](./GAME_BIBLE.md) §13 open question 1 — needs a device playtest. A reduced-motion setting forces 0.0 (world rolls, camera does not). |

**Rejected input during the lock is dropped, not buffered.** This is the one place `inputBuffer` does not apply, and it is deliberate.

---

## 8. Input forgiveness

These two numbers are the difference between "the game is hard" and "the game is broken." They apply identically to keyboard, touch and gamepad.

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `coyoteTime` | s | **0.10** | 0.05 – 0.18 | 🔒 | Players who press jump one frame after leaving a Void Gap edge die, and blame the game — correctly. | Above 0.18s the player visibly jumps from mid-air, which looks like a bug and lets them cheat gap timing. |
| `inputBuffer` | s | **0.15** | 0.08 – 0.25 | 🔒 | Inputs pressed slightly early during a landing or a slide are eaten. The most common source of "it didn't register." | Above 0.25s stale intent fires long after the player changed their mind, and the character acts on decisions the player has abandoned. |
| `bufferDepth` | count | **1** | 1 – 2 | ⚙️ | — | Above 1, a mash queues a sequence the player cannot cancel. |

**Touch-specific:**

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `swipeMinDistance` | px | **28** | 16 – 48 | ⚙️ | Taps and thumb drift register as swipes. | Deliberate flicks get ignored; the game feels unresponsive on small screens. |
| `swipeMaxDuration` | ms | **260** | 150 – 400 | ⚙️ | Fast, short flicks are rejected. | Slow drags register as swipes long after the player meant them. |
| `twoFingerTolerance` | ms | **80** | 40 – 150 | ⚙️ | Two fingers landing a few ms apart read as two separate one-finger swipes — i.e. a roll becomes a lane change. | A one-finger swipe followed quickly by a second touch reads as a roll. **This is the riskiest number in the touch layer.** |

**Gamepad-specific:**

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `stickThreshold` | — | **0.50** | 0.35 – 0.7 | ⚙️ | Stick drift emits phantom lane changes. | The player has to slam the stick to the gate for anything to happen. |
| `stickReleaseThreshold` | — | **0.25** | 0.1 – 0.4 | ⚙️ | Chatter around the threshold re-triggers. Must stay well below `stickThreshold` — this is the hysteresis band. | A held stick will not re-trigger even after a genuine return to centre. |

---

## 9. Flow, Overdrive, Fracture

### 9.1 Flow

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `flowMax` | — | **100** | 100 fixed | 🔒 | The meter is the UI. This is a constant; tune the rates, not the ceiling. | |
| `nearMissRadius` | u | **0.45** | 0.25 – 0.70 | 🔒 | Near-misses require frame-perfect grazing; the primary Flow source dries up and Overdrive becomes unreachable. | Merely being in the same lane counts as a near-miss. Flow fills passively, Overdrive triggers constantly, and the whole escalation loop trivialises. Measured **surface to surface** between AABBs, not centre to centre. |
| `flowPerNearMiss` | Flow | **6** | 3 – 12 | 🔒 | ~17 near-misses to fill the meter is already a lot; below 3 it is 30+ and nobody sees Overdrive. | Below 8 near-misses to full. Overdrive stops being an event. |
| `flowPerPerfectSlide` | Flow | **4** | 2 – 8 | ⚙️ | Perfect slides stop being worth the risk over a lazy early slide. | Slide-heavy sections become the optimal Flow farm and the roll gets ignored. Kept under `flowPerNearMiss` on purpose. |
| `flowPerBitStreak` | Flow | **3** | 1 – 6 | ⚙️ | The streak is invisible and Bit lines become pure economy. | Coin-vacuuming outperforms risky play, which inverts the entire design thesis. |
| `bitStreakInterval` | count | **10** | 5 – 25 | ⚙️ | Streak fires constantly and reads as noise. | The player never sees one and does not learn the system exists. |
| `flowPerOverdriveCell` | Flow | **35** | 20 – 50 | 🔒 | The Cell is not worth diverting for. | Two Cells nearly fill the meter and Overdrive becomes a pickup-luck outcome rather than an earned one. |
| `flowPerShard` | Flow | **10** | 0 – 20 | ⚙️ | — | Shards start being chased for Flow rather than for Fracture. |
| `flowDecayPerSecond` | Flow/s | **1.5** | 0.5 – 4.0 | 🔒 | Flow ratchets upward and never falls; a mediocre player reaches 100 by attrition and Overdrive stops being an achievement. | ~67s from full to empty at 1.5/s. Above 4.0/s a clean, safe stretch of track actively punishes the player for surviving it. |
| `flowDecayGrace` | s | **2.0** | 0.5 – 4.0 | ⚙️ | Decay bites between two near-misses in the same obstacle cluster, so tight play still bleeds. | The player can coast indefinitely by grazing one thing every few seconds. |
| `flowMultiplierMax` | × | **3.0** | 2.0 – 5.0 | ⚙️ | Flow's score contribution is invisible next to distance score. | Flow score dwarfs everything and low-Flow runs stop being worth banking. `scoreMultiplier = 1.0 + (flowMultiplierMax - 1.0) * flow / 100`. |
| `flowGainMultiplier` | × | **1.0** | 1.0 – 1.65 | 🔧 | Product of the Flow Gain upgrade tier and the avatar passive. Applies to every gain row above; never to decay. |

### 9.2 Overdrive

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `overdriveDuration` | s | **6.0** | 4.0 – 10.0 | 🔒 | The palette inversion barely lands before it ends; the spend feels wasted. | Long stretches of invulnerability are boring — there is no tension, and the player is just watching. 6s is roughly 170u at `speedCeiling`. |
| `overdriveMultiplier` | × | **4.0** | 3.0 – 6.0 | 🔒 | Not worth 100 Flow versus simply holding a 3.0× multiplier. | Score becomes an Overdrive-uptime optimisation problem and nothing else matters. |
| `overdriveExitFlow` | Flow | **25** | 0 – 40 | ⚙️ | 0 makes using the mechanic feel like a punishment; the player exits into a dead meter. | Above 40 the player chains Overdrives with barely any play between them. |
| `overdriveCost` | Flow | **100** | 100 fixed | 🔒 | The full meter. This is the deal. | |
| `overdriveShatterScore` | pts | **25** | 10 – 60 | ⚙️ | Shattering feels weightless. | Ramming obstacles beats dodging them, which is the wrong lesson to teach mid-power-fantasy. |
| `overdriveBloomIntensity` | — | **0.85** | 0.4 – 1.4 | ⚙️ | The one moment bloom is allowed does not read. | Blows out the flat colour fields and destroys the print look at the worst possible moment. Renders at **half resolution** — see [ARCHITECTURE.md](./ARCHITECTURE.md) §6. |

### 9.3 Fracture

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `fractureWindow` | s | **1.2** | 0.8 – 2.0 | 🔒 | Below 0.8s of real time there is no room to read the frozen geometry; it becomes a coin flip and the skill framing is a lie. | Above 2.0s the player has time to deliberate, and Fracture degrades into the pay-to-continue button it exists to replace. **Real time, not scaled time.** |
| `fractureTimeScale` | × | **0.15** | 0.05 – 0.35 | ⚙️ | Near-freeze looks like a bug rather than bullet time. | Not slow enough to read; the 1.2s window flies past. At 0.15, 1.2s real ≈ 8s of perceived world motion. |
| `fractureLookback` | s | **0.40** | 0.2 – 0.8 | ⚙️ | Too short to find a clearing verb — the sim concludes nothing would have worked and Fracture never arms. | The "correct" verb is one the player could not plausibly still have been thinking about. |
| `fractureInvulnerability` | s | **1.5** | 0.8 – 3.0 | ⚙️ | The player resumes directly into the next obstacle and dies instantly, which reads as theft of a Shard. | Free passage through a whole cluster. |
| `fractureFlowRetained` | × | **0.50** | 0.25 – 0.75 | 🔒 | Fracture stops being worth a Shard. | The crash costs almost nothing and Flow loses its teeth. |
| `maxFracturesPerRun` | count | **2** | 1 – 3 | ⚙️ | 1 makes a great run end to a single unlucky spawn. | 3+ turns a rare-currency skill test into a Shard-denominated score ladder. |
| `fractureShardCost` | Shards | **[1, 2]** | — | ⚙️ | Indexed by fracture number within the run. |

---

## 10. Spawn density and difficulty bands

Density is authored as **obstacle events per 100m** and constrained by a hard reaction-time floor. The generator is seeded and deterministic; the same seed produces the same track on every machine (law (a)).

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `chunkLength` | u | **24.0** | 16 – 48 | ⚙️ | Chunk seams recur too often and the track reads as repeating tiles. | Coarse difficulty stepping, and the pool has to hold more live entities than the draw-call budget allows. |
| `slotsPerChunk` | count | **4** | 3 – 8 | ⚙️ | Not enough resolution to author a rhythm inside a chunk. | Slots land closer than `minReactionTime` allows and the generator spends its time rejecting spawns. |
| `minReactionTime` | s | **0.55** | 0.40 – 0.90 | 🔒 | **Hard floor.** Below 0.40s no human clears it and every death reads as unfair. The generator rejects any spawn violating this, at any density. | Above 0.90s the track is empty at speed and the late game has no pressure. |
| `minSpawnGap` | u | — | — | 🔧 | `minReactionTime * worldSpeed`. At 12 u/s = 6.6u; at 34 u/s = 18.7u. **Recomputed every spawn**, never a constant. |
| `pickupSlotRatio` | — | **0.55** | 0.3 – 0.8 | ⚙️ | The track is barren and the economy starves. | Bits everywhere; collection stops being a choice. |

### Bands

| Band | Distance | Obstacles / 100m | Max faces used at once | New entities unlocked | Notes |
|---|---|---|---|---|---|
| **1** | 0 – 500m | **6** | 1 | Block, Low Bar, High Gate, Bit, Bit Cluster | The teaching band. Single face only. The player learns jump/slide/lane before the tunnel ever rotates. |
| **2** | 500 – 1,500m | **9** | 2 | Stack, Pillar Pair, Magnet, Shield, Overdrive Cell | **The roll is introduced here**, via a Pillar Pair whose free lane is on an adjacent face. |
| **3** | 1,500 – 3,000m | **12** | 3 | **Full-Face Wall** (0.08/slot), Void Gap, Piston, Slowfield | Roll becomes mandatory rather than optional. |
| **4** | 3,000 – 5,000m | **15** | 4 | **Corner Brace**, **Shear Ring**, Rotor, Kicker (walls 0.14/slot) | Full 12-cell authoring. Rolls can now be wrong. |
| **5** | 5,000m+ | **18** | 4 | All, plus theme hazards at full rate (walls 0.18/slot) | Terminal density. Does not increase further — past here, escalation comes from `worldSpeed` alone. |

**Density does not rise past band 5.** Beyond 5,000m the game gets harder because it gets *faster*, not because it gets more crowded. Stacking both is how endless runners become unwinnable noise at minute six.

**Worked example — band 4 at 26 u/s.** 15 obstacles per 100m = one every 6.67u = one every `6.67 / 26 = 0.256s`. That is far below `minReactionTime` 0.55s, so obstacles are **clustered, not evenly spaced**: the generator emits bursts of 2–4 obstacles that resolve to a single verb each, separated by clear runs of ≥ 14.3u (`0.55 × 26`). Density is a budget spent in clusters, never a metronome.

---

## 11. Pickups

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `magnetRadius` | u | **4.0** | 2.0 – 8.0 | ⚙️ | The Magnet is indistinguishable from not having one. | Vacuums the whole tunnel; lane choice stops mattering while it is up. |
| `magnetDuration` | s | **6.0** | 3.0 – 12.0 | 🔒 | Expires before the next Bit line. | Base for the upgrade track; tier 5 takes it to 9.9s. |
| `magnetPullSpeed` | u/s | **18.0** | 8 – 40 | ⚙️ | Bits at the edge of the radius are never reached before they leave it. Bits ride the world, so this only has to close **lateral** distance: the floor is `magnetRadius / (2 × magnetRadius / maxSpeed)` = **`maxSpeed / 2` = 17.0 u/s**. ⚠️ 18.0 clears that by only **5.9%** — re-check whenever `maxSpeed` or `magnetRadius` moves. Asserted in `tests/sim/tuning-invariants.test.ts`. | Bits snap instantly and the satisfying arc of the pull is lost. |
| `maxShields` | count | **1** | 1 – 3 | ⚙️ | Base value; the Shield Count upgrade step table `[1,1,2,2,2,3]` raises it. | Above 3 the player is functionally immortal through a whole band. |
| `shieldInvulnerability` | s | **1.0** | 0.5 – 2.5 | ⚙️ | The player is hit again inside the same cluster before regaining control. | Free passage through the rest of the cluster. |
| `slowfieldDuration` | s | **4.0** | 2.0 – 8.0 | ⚙️ | Not enough relief to matter at 100 Flow. | Long stretches at reduced speed break the escalation. |
| `slowfieldSpeedScale` | × | **0.65** | 0.4 – 0.85 | ⚙️ | Near-stop; jarring, and it desyncs the player's timing. | Barely noticeable. Does **not** scale the score rate — see [GAME_BIBLE.md](./GAME_BIBLE.md) §7.3. |
| `shardSpawnChance` | /slot | **0.004** | 0.001 – 0.02 | ⚙️ | Shards never appear and Fracture is dead content. | Fracture becomes free and stops being a decision. Target ≈ 1 Shard per 3 runs. |
| `clusterSpawnChance` | /slot | **0.06** | 0.02 – 0.15 | ⚙️ | | |
| `magnetSpawnChance` | /slot | **0.03** | 0.01 – 0.08 | ⚙️ | | |
| `shieldSpawnChance` | /slot | **0.02** | 0.005 – 0.06 | ⚙️ | | |
| `cellSpawnChance` | /slot | **0.025** | 0.01 – 0.06 | ⚙️ | Overdrive is unreachable without a near-perfect run. | Overdrive uptime becomes luck-driven. |
| `slowfieldSpawnChance` | /slot | **0.015** | 0.005 – 0.04 | ⚙️ | | |

---

## 12. Scoring and economy

| Key | Unit | Default | Range | Status | Notes |
|---|---|---|---|---|---|
| `pointsPerMetre` | pts | **1.0** | 0.5 – 2.0 | ⚙️ | Base score rate before `scoreMultiplier`. |
| `pointsPerBit` | pts | **10** | 5 – 25 | ⚙️ | Too low and Bits are pure economy with no score identity; too high and the game becomes coin-vacuuming. |
| `pointsPerNearMiss` | pts | **50** | 20 – 150 | ⚙️ | Near-misses must pay in score as well as Flow, or they read as a Flow chore. |
| `bitsPerMetreDivisor` | m/Bit | **50** | 25 – 100 | ⚙️ | `floor(distance / 50)`. Lower makes distance the only economy that matters. |
| `upgradeCostBase` | Bits | **2.15** exponent | 2.15 fixed | 🔒 | `cost(tier) = round5(base * 2.15^(tier-1))`. |
| `upgradeEffectK` | — | **0.6** | 0.45 – 0.75 | ⚙️ | `effect(t) = Emax * (1 - k^t) / (1 - k^5)`. Lower `k` front-loads harder (tier 1 gives more); higher flattens toward linear. At 0.6, tier 1 = 43.4% of Emax. |
| `upgradeEmax` | % | **+65** | +40 – +80 | 🔒 | Tier 5 is +65%, **not +400%.** Any upgrade whose tier 5 more than doubles tier 0 is a balance bug. |

**Base costs:** Magnet Duration 250 · Flow Gain 300 · Bit Value 350 · Shield Count 400 Bits.
**Boost costs:** Head Start 500 · 2× Bits 600 · Flow Primer 450 Bits.
**Head Start** starts the run at 300m with `timeSpeed` advanced to the equivalent elapsed time, not at `baseSpeed`.

---

## 13. Camera and render

Not gameplay, but they change how the game *feels*, so they live here.

| Key | Unit | Default | Range | Status | Too low | Too high |
|---|---|---|---|---|---|---|
| `cameraDistance` | u | **7.5** | 5 – 12 | ⚙️ | Too close: the player's own model blocks the near lane and there is no reaction distance. | Too far: the runner is a speck and the four faces stop reading as a tunnel around *you*. |
| `cameraHeight` | u | **2.6** | 1.5 – 4.0 | ⚙️ | Flat angle hides the floor lanes. | Top-down; the vertical verbs (jump/slide) become unreadable. |
| `cameraFov` | deg | **62** | 50 – 80 | ⚙️ | Telephoto; approach speed is hard to judge. | Fisheye distortion at the tunnel edges wrecks the flat-colour print look. |
| `cameraSpeedFovBoost` | deg | **+8** | 0 – 15 | ⚙️ | Speed does not read on screen. | Constant FOV pumping induces nausea. Applied as a lerp from `baseSpeed` to `maxSpeed`. |
| `cameraShakeOnNearMiss` | u | **0.06** | 0 – 0.2 | ⚙️ | Near-misses have no physical punch. | At 60 near-misses a run, the screen never stops shaking. Must respect the reduced-motion setting. |
| `pixelRatioCap` | × | **2.0** | 1 – 2 | 🔒 | `min(devicePixelRatio, 2)`. Above 2 the fragment cost on high-DPI phones destroys the frame budget for no visible gain at this art style. |
| `fogNear` / `fogFar` | u | per theme | — | ⚙️ | `fogFar` must exceed `minReactionTime * maxSpeed` = **18.7u** in every theme, Static included (its `unstableMin` is the binding value). Kiln 45u · Undertow 30u · Bazaar 70u · Static 20–90u unstable. Undertow is the tightest by design and is the case to re-check whenever `maxSpeed` or `minReactionTime` moves. Asserted in `tests/sim/tuning-invariants.test.ts`. |

---

## 14. Enforced budgets

These are **tests, not aspirations.** They live in CI from P01 and fail the build.

| Budget | Limit | Enforced by |
|---|---|---|
| Draw calls, desktop | **< 100** | Playwright + `renderer.info.render.calls`, P05 onward |
| Draw calls, mobile | **< 50** | Same, mobile viewport profile |
| Sim tick cost | **< 2.0ms** | Vitest benchmark, 10k-tick headless run |
| Heap allocation per tick | **0 bytes** | Vitest, allocation counter across 10k ticks |
| Bundle, first load JS | **< 250KB gzip** | `next build` output assertion |
| Bloom resolution | **half** | Code review + postprocessing config assertion |
| Pixel ratio | **≤ 2** | Runtime assertion in dev |

---

## 15. Changing a number

1. Change it in `src/game/config/tuning.ts` — **nowhere else.**
2. Change it here, in the same commit, including the Too low / Too high column if the feel changed.
3. If it is 🔒 **LOCKED**, the commit message must name the playtest that justified it.
4. If it is 🔧 **DERIVED**, do not change it. Change its inputs.
5. Run `npm run test` — several tuning invariants are asserted (`rollCommitLock < rollDuration`, `speedCeiling + flowSpeedBonus <= maxSpeed`, `playerHeightSlide < lowBarClearance`, `stickReleaseThreshold < stickThreshold`). These exist so a bad edit fails loudly instead of quietly breaking feel.
</content>
