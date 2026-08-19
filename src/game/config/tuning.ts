/**
 * AXIS — the single home for every gameplay number.
 *
 * A gameplay number that appears anywhere outside this file is a bug, and the
 * `no-magic-numbers` rule in eslint.config.mjs fails the lint step on it.
 *
 * Status tags mirror docs/TUNING.md:
 *   LOCKED   researched starting point from platformer game-feel literature.
 *            Do not change without a real playtest; name the playtest in the commit.
 *   DERIVED  computed from LOCKED inputs below. Never hand-edit one of these —
 *            change its inputs and it follows.
 *   OPEN     first-pass value chosen to make the system runnable. Expected to move.
 *
 * Units are in every doc comment. `u` = world unit, `u/s` = world units per second.
 * All times are seconds of SIM time unless the comment says otherwise.
 *
 * This module is leaf data: it imports nothing (enforced by eslint.config.mjs).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Derivation inputs.
//
// Hoisted only because DERIVED values below are computed from them. Everything
// else is written inline. Keeping the derivations as real arithmetic — rather
// than baked-in constants — is what stops a derived number silently drifting
// from its inputs.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_RATE_HZ = 60;
const MAX_TICKS_PER_FRAME = 5;

const LANE_WIDTH_U = 2.2;
const LANE_COUNT = 3;
const WALL_MARGIN_U = 1.4;

const JUMP_APEX_TIME_S = 0.34;
const JUMP_APEX_HEIGHT_U = 1.75;
const FALL_GRAVITY_MULTIPLIER = 1.8;

const ROLL_DURATION_S = 0.3;
const ROLL_COMMIT_LOCK_S = 0.25;

const FIXED_DELTA_S = 1 / TICK_RATE_HZ;
const GRAVITY_RISE_U_S2 = (2 * JUMP_APEX_HEIGHT_U) / (JUMP_APEX_TIME_S * JUMP_APEX_TIME_S);
const GRAVITY_FALL_U_S2 = GRAVITY_RISE_U_S2 * FALL_GRAVITY_MULTIPLIER;
const FALL_TIME_S = Math.sqrt((2 * JUMP_APEX_HEIGHT_U) / GRAVITY_FALL_U_S2);

/**
 * u — how much track is kept live around the player at once. Sized from the
 * longest fog distance (Static, 90u) plus a spawn lead and a recycle tail.
 * Every pool capacity below is derived from this.
 */
const LIVE_TRACK_LENGTH_U = 240;

export const TUNING = {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Simulation core — docs/TUNING.md §1
  // ───────────────────────────────────────────────────────────────────────────
  sim: {
    /** Hz — fixed simulation rate. LOCKED. Changing this invalidates every stored replay. */
    tickRate: TICK_RATE_HZ,
    /** s — 1 / tickRate. DERIVED. */
    fixedDelta: FIXED_DELTA_S,
    /** ticks — spiral-of-death guard. Surplus accumulated time is discarded, not simulated. OPEN. */
    maxTicksPerFrame: MAX_TICKS_PER_FRAME,
    /** s — maxTicksPerFrame * fixedDelta. DERIVED. */
    maxAccumulator: MAX_TICKS_PER_FRAME * FIXED_DELTA_S,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 1b. Determinism constants — docs/ARCHITECTURE.md §2a
  //
  // READ THIS BEFORE ADDING A NUMBER HERE.
  //
  // ECMA-262 specifies +, -, *, / and Math.sqrt as exactly reproducible
  // (IEEE-754). It specifies Math.exp, log, pow, sin, cos, tan and atan2 only as
  // "implementation-approximated" — engines are free to differ in the last ulp.
  //
  // That is fatal for P12, where a replay recorded in a browser is re-validated
  // on a Node server. Chrome, Safari and Firefox do not share a libm. A one-ulp
  // difference compounded over 36,000 ticks diverges, and the failure mode is
  // honest players being rejected as cheaters.
  //
  // So any transcendental the sim needs is evaluated ONCE, offline, and frozen
  // here as a decimal literal. Decimal-to-double conversion IS exactly specified,
  // so every engine reads the identical bit pattern.
  // ───────────────────────────────────────────────────────────────────────────
  determinism: {
    /** x — per-tick exponential approach factor for the world-speed curve.
     *
     *  Frozen value of `1 - e^(-fixedDelta / speedTau)` = `1 - e^(-1/5700)`.
     *
     *  Applied incrementally each tick as:
     *    timeSpeed += (speedCeiling - timeSpeed) * speedApproachPerTick
     *
     *  which reproduces the closed form in docs/TUNING.md §2 to 15 significant
     *  figures over a 20-minute run (27.99994772489087 vs 27.999947724890873)
     *  using nothing but multiply and add.
     *
     *  DERIVED-OFFLINE. Recompute with `1 - Math.exp(-1 / (tickRate * speedTau))`
     *  and paste the full-precision result if tickRate or speedTau ever change. */
    speedApproachPerTick: 0.00017542320804053713,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 1c. Pools and buffers — docs/ARCHITECTURE.md §2d
  //
  // Law (d) is zero heap allocation inside the tick, which means every capacity
  // here is a hard ceiling reserved up front. Sized from TUNING.md §10 band 5,
  // the worst case the generator can produce.
  // ───────────────────────────────────────────────────────────────────────────
  pools: {
    /** u — length of track kept live around the player. DERIVED input. */
    liveTrackLength: LIVE_TRACK_LENGTH_U,

    /** count — obstacle slots. Band 5 runs 18 obstacles per 100m, so 240u of live
     *  track holds ~43. 256 is the next power of two and leaves headroom for a
     *  Shear Ring, which occupies up to 12 cells in one spawn event. OPEN. */
    maxObstacles: 256,

    /** count — pickup slots. A Bit Cluster is 8 pickups from one slot; 240u of
     *  band-5 track is ~10 chunks x 4 slots x 0.55 pickup ratio, and if every one
     *  of those rolled a cluster that is 176. 512 doubles it. OPEN. */
    maxPickups: 512,

    /** count — live track chunks. liveTrackLength / chunkLength = 10, rounded up
     *  to 16 so recycling never has to stall on a full ring. DERIVED. */
    maxChunks: 16,

    /** count — sim events buffered between drains. The render and audio layers
     *  drain every frame, so this only has to survive one frame's worth of
     *  events plus a spiral-guard burst of 5 ticks. OPEN. */
    maxEvents: 256,

    /** count — payload floats carried by a single event. OPEN. */
    eventPayloadSlots: 4,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 1d. Replay format — docs/ARCHITECTURE.md §6, consumed by P12
  // ───────────────────────────────────────────────────────────────────────────
  replay: {
    /** Format version written into every replay header. Bump on ANY change to
     *  the header layout, the intent bit packing, the tick order in sim.ts, or
     *  the meaning of a recorded intent. A replay whose version does not match is
     *  rejected, never re-scored.
     *
     *  v2 (P04): the player controller landed. Intents that were inert under v1
     *  now move the player, and `jump`/`slide` changed meaning from "pressed" to
     *  "held" so variable jump height can read the release edge. Every v1 replay
     *  would re-simulate to a different result and is therefore rejected.
     *
     *  v3 (P08): Flow became non-zero. Under v2 `flow` was pinned at 0 by the
     *  scoring stub, so the Flow speed bonus contributed nothing and every run
     *  followed the time curve alone. It now feeds `worldSpeed`, which changes
     *  distance, which changes everything downstream. Three float slots were also
     *  appended (state hash changed) and intent bit 6 now carries OVERDRIVE, which
     *  was previously required to be zero. */
    formatVersion: 3,

    /** bytes — fixed header size. magic(4) version(1) flags(1) tickRate(2)
     *  seed(4) tickCount(4) finalHash(4). DERIVED from the layout in replay.ts. */
    headerBytes: 20,

    /** ticks — recorder capacity, preallocated. 30 minutes at 60Hz. One byte per
     *  tick, so this reserves ~105KB up front and never grows mid-run. OPEN. */
    maxTicks: 108_000,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 2. World speed — docs/TUNING.md §2
  //
  //   timeSpeed(t) = baseSpeed + (speedCeiling - baseSpeed) * (1 - e^(-t / speedTau))
  //   worldSpeed   = min(timeSpeed(t) + flowSpeedBonus * (flow / 100), maxSpeed)
  // ───────────────────────────────────────────────────────────────────────────
  speed: {
    /** u/s — speed at t=0. LOCKED. */
    baseSpeed: 12.0,
    /** u/s — hard clamp, reachable only with Flow. LOCKED. */
    maxSpeed: 34.0,
    /** u/s — asymptote of the time-only curve. OPEN. Must be <= maxSpeed - flowSpeedBonus. */
    speedCeiling: 28.0,
    /** s — time constant of the exponential approach. One tau ≈ 63% of the way up. LOCKED. */
    speedTau: 95.0,
    /** u/s — added on top of the time curve at 100 Flow. OPEN. Must be <= maxSpeed - speedCeiling. */
    flowSpeedBonus: 6.0,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Geometry — docs/TUNING.md §3
  // ───────────────────────────────────────────────────────────────────────────
  geometry: {
    /** u — spacing between lane centres. LOCKED. */
    laneWidth: LANE_WIDTH_U,
    /** count — lanes per face. Design constant. LOCKED. */
    laneCount: LANE_COUNT,
    /** count — faces of the prism. The prism is square; this is the game. LOCKED. */
    faceCount: 4,
    /** u — inner edge-to-edge size of the square cross-section. DERIVED. */
    prismInnerSize: LANE_WIDTH_U * (LANE_COUNT - 1) + 2 * WALL_MARGIN_U,
    /** u — distance from an outer lane centre to the wall. OPEN. */
    wallMargin: WALL_MARGIN_U,
    /** u — player AABB width. OPEN. Keep well under laneWidth. */
    playerWidth: 0.7,
    /** u — player AABB height, standing. OPEN. */
    playerHeightStand: 1.6,
    /** u — player AABB depth, standing. OPEN. */
    playerDepthStand: 0.6,
    /** u — player AABB height while sliding. OPEN. Must be < lowBarClearance - 0.25. */
    playerHeightSlide: 0.7,
    /** u — player AABB depth while sliding. OPEN. */
    playerDepthSlide: 1.1,
    /** u — depth below the floor plane at which a Void Gap fall becomes fatal. OPEN. */
    fallKillDepth: 4.0,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Vertical movement — docs/TUNING.md §4
  //
  // Gravity is asymmetric. fallGravityMultiplier is THE floatiness knob.
  // ───────────────────────────────────────────────────────────────────────────
  vertical: {
    /** s — time from launch to apex. LOCKED. */
    jumpApexTime: JUMP_APEX_TIME_S,
    /** u — apex height above the floor plane. OPEN. Clears highGateClearance by 0.35u. */
    jumpApexHeight: JUMP_APEX_HEIGHT_U,
    /** x — descent gravity relative to ascent gravity. LOCKED. */
    fallGravityMultiplier: FALL_GRAVITY_MULTIPLIER,
    /** u/s² — 2h / t². DERIVED. */
    gravityRise: GRAVITY_RISE_U_S2,
    /** u/s² — gravityRise * fallGravityMultiplier. DERIVED. */
    gravityFall: GRAVITY_FALL_U_S2,
    /** u/s — initial upward velocity, 2h / t. DERIVED. */
    jumpImpulse: (2 * JUMP_APEX_HEIGHT_U) / JUMP_APEX_TIME_S,
    /** s — apex to landing, sqrt(2h / gravityFall). DERIVED. */
    fallTime: FALL_TIME_S,
    /** s — total airborne time. DERIVED. */
    airTime: JUMP_APEX_TIME_S + FALL_TIME_S,

    /** x — upward velocity is multiplied by this when JUMP is released while still
     *  rising. Variable jump height: a tap is a short hop, a hold is a full arc.
     *  This is the single cheapest thing that makes a jump feel authored rather
     *  than scripted. OPEN. */
    jumpReleaseCut: 0.5,

    /** u/s — downward velocity forced by pressing SLIDE while airborne.
     *
     *  An intentionally undocumented advanced technique: a dive to the ground that
     *  cuts airtime short and lands straight into a slide. New players never find
     *  it; expert players use it to recover from a mistimed jump. It is deliberately
     *  absent from the tutorial and the verb list in GAME_BIBLE §6.
     *
     *  Must exceed maxSpeed so the dive reads as decisive rather than a soft drift.
     *  OPEN. */
    fastDropSpeed: 28.0,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Slide — docs/TUNING.md §5
  // ───────────────────────────────────────────────────────────────────────────
  slide: {
    /** s — how long the collapsed hitbox lasts. LOCKED. */
    slideDuration: 0.55,
    /** s — stand-up tail. Lane change is legal during a slide; jump is not until this ends. OPEN. */
    slideRecovery: 0.08,
    /** s — spare clearance at or under which a slide counts as "perfect" for Flow. OPEN. */
    perfectSlideMargin: 0.12,
    /** u — underside height of a Low Bar. OPEN. */
    lowBarClearance: 1.05,
    /** u — underside height of a High Gate. OPEN. */
    highGateClearance: 1.4,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Lane change — docs/TUNING.md §6
  // ───────────────────────────────────────────────────────────────────────────
  lane: {
    /** s — time to traverse one lane. LOCKED. */
    laneChangeDuration: 0.14,
    /** count — how many lane inputs may queue behind the current move. OPEN. */
    laneQueueDepth: 1,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Roll — the signature verb. docs/TUNING.md §7
  //
  // rollCommitLock is the risk that stops the roll being a free escape button.
  // It must stay strictly below rollDuration (asserted in tests/sim).
  // ───────────────────────────────────────────────────────────────────────────
  roll: {
    /** s — time for the 90° world rotation. LOCKED. */
    rollDuration: ROLL_DURATION_S,
    /** s — window from roll start during which lane input is DROPPED, not buffered. LOCKED. */
    rollCommitLock: ROLL_COMMIT_LOCK_S,
    /** s — tail where lane input is accepted again. DERIVED. */
    rollRecovery: ROLL_DURATION_S - ROLL_COMMIT_LOCK_S,
    /** s — minimum gap between consecutive rolls. OPEN. */
    rollCooldown: 0.1,
    /** x — how tightly the camera follows the roll. 0 = world rolls, camera does not
     *  (the reduced-motion path). OPEN — needs a device playtest, GAME_BIBLE §13 Q1. */
    rollCameraLerp: 0.85,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Input forgiveness — docs/TUNING.md §8
  //
  // These two are the difference between "hard" and "broken". They apply
  // identically to keyboard, touch and gamepad.
  // ───────────────────────────────────────────────────────────────────────────
  input: {
    /** s — JUMP stays legal this long after leaving a ledge. LOCKED. */
    coyoteTime: 0.1,
    /** s — a verb issued this early is held and fired when it becomes legal. LOCKED. */
    inputBuffer: 0.15,
    /** count — how many buffered intents may be held at once. OPEN. */
    bufferDepth: 1,

    touch: {
      /** px — minimum travel for a swipe to register. OPEN. */
      swipeMinDistance: 28,
      /** ms — maximum duration for a gesture to count as a swipe. Real time, not sim time. OPEN. */
      swipeMaxDuration: 260,
      /** ms — window in which two touches count as one two-finger gesture (the roll).
       *  Real time, not sim time. OPEN — riskiest number in the touch layer. */
      twoFingerTolerance: 80,
    },

    gamepad: {
      /** x — normalised stick deflection that emits a lane intent. OPEN. */
      stickThreshold: 0.5,
      /** x — stick must return inside this before it can fire again. The hysteresis
       *  band. OPEN. Must stay below stickThreshold. */
      stickReleaseThreshold: 0.25,
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Flow — docs/TUNING.md §9.1
  //
  // scoreMultiplier = 1.0 + (flowMultiplierMax - 1.0) * flow / 100
  // ───────────────────────────────────────────────────────────────────────────
  flow: {
    /** Flow — meter ceiling. Constant; tune the rates, not the ceiling. LOCKED. */
    flowMax: 100,
    /** u — surface-to-surface AABB distance that counts as a near-miss. LOCKED. */
    nearMissRadius: 0.45,
    /** Flow — per near-miss at zero gap. One award per obstacle instance, ever. LOCKED.
     *
     *  Scaled down toward `nearMissScaleMin` as the gap widens — see below. */
    flowPerNearMiss: 6,

    /** x — fraction of `flowPerNearMiss` awarded for a near-miss at exactly
     *  `nearMissRadius`, rising linearly to 1.0 at zero gap.
     *
     *      gain = flowPerNearMiss * (min + (1 - min) * (1 - gap / nearMissRadius))
     *
     *  P08 addition, NOT in GAME_BIBLE §4.1's flat +6. The flat award pays a graze
     *  at 0.44u exactly as much as one at 0.02u, which teaches the player that
     *  "near enough" is near enough. Scaling makes the last centimetre worth
     *  something and is the cheapest way to reward precision over adequacy.
     *
     *  Linear on purpose: a curve here would need `Math.pow`, which is banned in
     *  the sim for the P12 cross-engine reason. OPEN. */
    nearMissScaleMin: 0.5,
    /** Flow — per slide clearing a Low Bar within perfectSlideMargin. OPEN.
     *  Deliberately below flowPerNearMiss so slide-farming cannot out-earn risk. */
    flowPerPerfectSlide: 4,
    /** Flow — per completed Bit streak. OPEN. */
    flowPerBitStreak: 3,
    /** count — consecutive Bits per streak award. OPEN. */
    bitStreakInterval: 10,
    /** Flow — clearing a roll that was FORCED, i.e. a blocker the player could not
     *  have passed by any other verb.
     *
     *  P08 addition, NOT in GAME_BIBLE §4.1. The roll is the signature verb and
     *  was the only one of the six with no Flow source attached to it, which made
     *  the optimal Flow line "stay on one face and graze things" — the exact
     *  opposite of what the game is about. Set above `flowPerNearMiss` 6 so a
     *  forced roll is the single most valuable non-pickup event in the game.
     *
     *  Awarded once per blocking obstacle instance, on roll completion. OPEN. */
    flowPerForcedRoll: 10,

    /** Flow — Overdrive Cell pickup. LOCKED. */
    flowPerOverdriveCell: 35,
    /** Flow — Shard pickup. OPEN. */
    flowPerShard: 10,
    /** Flow/s — passive bleed once the grace window has elapsed. LOCKED. */
    flowDecayPerSecond: 1.5,
    /** s — time with no gain event before decay starts. OPEN. */
    flowDecayGrace: 2.0,
    /** x — score multiplier at 100 Flow. OPEN. */
    flowMultiplierMax: 3.0,
    /** x — product of the Flow Gain upgrade tier and the avatar passive.
     *  Applies to every gain above; never to decay. DERIVED at runtime from meta/. */
    flowGainMultiplier: 1.0,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Overdrive — docs/TUNING.md §9.2
  // ───────────────────────────────────────────────────────────────────────────
  overdrive: {
    /** s — duration of the invulnerable shatter window. LOCKED. */
    overdriveDuration: 6.0,
    /** x — flat score multiplier, overriding the Flow formula. LOCKED. */
    overdriveMultiplier: 4.0,
    /** Flow — spent to trigger. The full meter. This is the deal. LOCKED. */
    overdriveCost: 100,
    /** Flow — meter value on exit. OPEN. Non-zero so using the mechanic is not a punishment. */
    overdriveExitFlow: 25,
    /** pts — score per obstacle shattered. OPEN. */
    overdriveShatterScore: 25,
    /** x — bloom strength. The ONLY place bloom is permitted (GAME_BIBLE §11.1).
     *  Renders at half resolution. OPEN. */
    overdriveBloomIntensity: 0.85,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 11. Fracture — docs/TUNING.md §9.3
  // ───────────────────────────────────────────────────────────────────────────
  fracture: {
    /** s — input window. REAL time, not scaled time. LOCKED. */
    fractureWindow: 1.2,
    /** x — world time scale during the window. At 0.15, 1.2s real ≈ 8s perceived. OPEN. */
    fractureTimeScale: 0.15,
    /** s — how far back the solver replays to find the single clearing verb. OPEN. */
    fractureLookback: 0.4,
    /** s — invulnerability granted on resume. OPEN. */
    fractureInvulnerability: 1.5,
    /** x — fraction of pre-death Flow retained on a successful Fracture. LOCKED. */
    fractureFlowRetained: 0.5,
    /** count — Fractures allowed per run. OPEN. */
    maxFracturesPerRun: 2,
    /** Shards — cost indexed by fracture number within the run. OPEN. */
    fractureShardCost: [1, 2],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 12. Spawn density and difficulty bands — docs/TUNING.md §10
  //
  // Density is a budget spent in CLUSTERS, never a metronome. minReactionTime is
  // a hard floor the generator may never violate, at any density or speed.
  // ───────────────────────────────────────────────────────────────────────────
  spawn: {
    /** u — length of one track chunk. OPEN. */
    chunkLength: 24.0,
    /** count — authoring slots per chunk. OPEN. */
    slotsPerChunk: 4,
    /** s — HARD FLOOR. The generator rejects any spawn that gives the player less
     *  than this to react, at any speed. LOCKED. */
    minReactionTime: 0.55,
    /** x — fraction of unused slots that receive pickups. OPEN. */
    pickupSlotRatio: 0.55,

    // ── P07 — live spawning ───────────────────────────────────────────────────
    /** u — how far ahead of the player a chunk is spawned.
     *
     *  Must exceed the longest fog distance (Bazaar, 70u) so geometry is never
     *  seen popping into existence, and must exceed
     *  `minReactionTime * maxSpeed` = 18.7u by a wide margin so the player has
     *  time to read it. 96u is four chunks. OPEN. */
    spawnAhead: 96.0,

    /** u — how far behind the player an entity is recycled.
     *
     *  Far enough to be off camera at any FOV: the camera sits `cameraDistance`
     *  7.5u back, and at 82 degrees the near geometry is wide. 24u is a full
     *  chunk of slack. OPEN. */
    despawnBehind: 24.0,

    /** count — chunks that may be emitted in a single tick.
     *
     *  A bound on the catch-up loop, for the same reason the clock has
     *  `maxTicksPerFrame`: an unbounded loop turns one slow moment into a stall.
     *  In steady state the world advances at most 0.567u per tick against a 24u
     *  chunk, so this never binds — it exists for the pathological case. */
    maxChunksPerTick: 2,

    /** Difficulty bands, keyed by distance travelled. Density does NOT rise past
     *  the last band — beyond it, escalation comes from worldSpeed alone. */
    bands: [
      {
        /** m — inclusive lower bound. */
        fromMetres: 0,
        /** m — exclusive upper bound. */
        toMetres: 500,
        /** count/100m — obstacle event budget. */
        obstaclesPer100m: 6,
        /** count — how many faces may carry obstacles at the same z. */
        maxSimultaneousFaces: 1,
        /** /slot — Full-Face Wall spawn chance. Zero until band 3. */
        fullFaceWallChance: 0,
      },
      {
        fromMetres: 500,
        toMetres: 1500,
        obstaclesPer100m: 9,
        maxSimultaneousFaces: 2,
        fullFaceWallChance: 0,
      },
      {
        fromMetres: 1500,
        toMetres: 3000,
        obstaclesPer100m: 12,
        maxSimultaneousFaces: 3,
        fullFaceWallChance: 0.08,
      },
      {
        fromMetres: 3000,
        toMetres: 5000,
        obstaclesPer100m: 15,
        maxSimultaneousFaces: 4,
        fullFaceWallChance: 0.14,
      },
      {
        fromMetres: 5000,
        toMetres: Number.POSITIVE_INFINITY,
        obstaclesPer100m: 18,
        maxSimultaneousFaces: 4,
        fullFaceWallChance: 0.18,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 12b. Collision and forgiveness — P04
  //
  // NOTE: STUMBLE, corner forgiveness and the mid-air fast-drop are mechanics
  // introduced at P04. They are NOT yet described in docs/GAME_BIBLE.md §7 or
  // §12 — that doc update was proposed and not approved, so the bible and the
  // code currently disagree. See the P04 entry in PROGRESS.md.
  // ───────────────────────────────────────────────────────────────────────────
  collision: {
    /** u — penetration depth at or under which a clip into an obstacle EDGE nudges
     *  the player clear instead of killing them.
     *
     *  This is invisible to players and is the difference between "tight" and
     *  "this game cheats me". At maxSpeed the player advances 0.57u per tick, so
     *  0.12u is roughly a fifth of a tick of overlap — genuinely a graze, not a
     *  hit the player could have seen. Emitted as a distinct event so the rate can
     *  be measured; if it fires often, the generator is placing unfair geometry
     *  rather than the forgiveness being too generous. OPEN. */
    cornerForgiveness: 0.12,

    /** x — worldSpeed multiplier applied for the duration of a stumble. OPEN. */
    stumbleSpeedPenalty: 0.55,

    /** s — how long a stumble lasts before control returns. Must stay under the
     *  time it takes the next obstacle to arrive at band-5 density, or a stumble
     *  becomes an unavoidable death rather than a setback. OPEN. */
    stumbleRecovery: 0.7,

    /** s — invulnerability granted while recovering from a stumble, so a single
     *  bad cluster cannot chain-stumble the player into a wall. OPEN. */
    stumbleInvulnerability: 0.35,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 12c. Level generation — P06
  //
  // The architecture is a hybrid: a pool of hand-authored 24u chunks selected by
  // a difficulty-banded grammar and placed on a fixed grid. Pure procedural
  // generation produces track that is technically fair and completely
  // characterless; pure authoring runs out after ten minutes. The grammar is
  // what buys both.
  // ───────────────────────────────────────────────────────────────────────────
  level: {
    /** chunks — how many are kept live ahead of the player.
     *  liveTrackLength 240u / chunkLength 24u = 10. DERIVED. */
    windowChunks: LIVE_TRACK_LENGTH_U / 24,

    /** picks — a chunk cannot be selected again within this many selections.
     *
     *  The single cheapest defence against "I have seen this before". With ~6
     *  chunks per tier, a window of 5 means a tier's rotation is nearly a full
     *  shuffle before anything repeats. Raising it past the tier population
     *  makes selection fail and fall back, so it is clamped at runtime. OPEN. */
    recencyWindow: 5,

    /** difficulty — at or above this, a chunk counts as "hard" for the breather rule. */
    hardDifficulty: 4,

    /** count — never more than this many consecutive hard chunks before a
     *  breather is forced in.
     *
     *  Pacing is not decoration. An unbroken wall of difficulty reads as noise
     *  rather than as escalation, and the player never gets the beat of relief
     *  that makes the next hard section land. OPEN. */
    maxConsecutiveHard: 3,

    /** tiers — how much a full Flow meter shifts the difficulty band upward.
     *
     *  This is the self-escalation loop reaching the generator: a player at 100
     *  Flow is not just moving faster, they are being handed harder track.
     *
     *  NOTE: this is an ADDITION to the design in GAME_BIBLE §4.2, which couples
     *  Flow to speed and multiplier only. Introduced at P06. OPEN. */
    flowDifficultyBonus: 1,

    /** ticks — minimum solver slack before a chunk is flagged as inhuman.
     *
     *  Slack is how many ticks the player can be frozen on entry and still
     *  survive. A chunk that is survivable only with a frame-perfect input is
     *  technically fair and practically a cheat. 3 ticks is 50ms. OPEN. */
    minSolverSlackTicks: 3,

    /** m — distances at which the run crosses into a new theme. Each is followed
     *  by a `transitionLength` stretch of guaranteed-empty track.
     *  From GAME_BIBLE §10.1. */
    themeMilestones: [1200, 2800, 5000],

    /** m — length of the obstacle-free transition tunnel between themes. */
    transitionLength: 120,

    /** m — after the last theme, the cycle repeats every this many metres. */
    themeCycleLength: 2000,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 13. Pickups — docs/TUNING.md §11
  // ───────────────────────────────────────────────────────────────────────────
  pickups: {
    /** u — magnet attraction radius. OPEN. */
    magnetRadius: 4.0,
    /** s — magnet duration at upgrade tier 0. LOCKED. */
    magnetDuration: 6.0,
    /** u/s — lateral closing speed toward the player. Bits ride the world, so this
     *  only closes lateral distance; the floor is maxSpeed / 2 = 17.0 u/s.
     *  OPEN — 18.0 clears that by just 5.9%, so re-check it at P07. */
    magnetPullSpeed: 18.0,
    /** count — shields held at upgrade tier 0. OPEN. */
    maxShields: 1,
    /** count — shields by upgrade tier 0..5. Integer step table, not the continuous
     *  effect curve — you cannot hold 1.43 shields. OPEN. */
    shieldCountByTier: [1, 1, 2, 2, 2, 3],
    /** s — invulnerability after a Shield absorbs a hit. Flow is NOT reset. OPEN. */
    shieldInvulnerability: 1.0,
    /** s — Slowfield duration. OPEN. */
    slowfieldDuration: 4.0,
    /** x — world speed scale during Slowfield. Does NOT scale the score rate. OPEN. */
    slowfieldSpeedScale: 0.65,

    /** Per-slot spawn chances. Shards target roughly one per three runs. */
    spawnChance: {
      /** /slot — OPEN. */
      shard: 0.004,
      /** /slot — OPEN. */
      cluster: 0.06,
      /** /slot — OPEN. */
      magnet: 0.03,
      /** /slot — OPEN. */
      shield: 0.02,
      /** /slot — OPEN. */
      overdriveCell: 0.025,
      /** /slot — OPEN. */
      slowfield: 0.015,
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 14. Scoring and economy — docs/TUNING.md §12
  //
  //   cost(tier)   = round5(base * 2.15^(tier - 1)),          tier 1..5
  //   effect(tier) = Emax * (1 - k^tier) / (1 - k^5),  k=0.6, tier 0..5
  // ───────────────────────────────────────────────────────────────────────────
  scoring: {
    /** x — fixed-point denominator for the score accumulator.
     *
     *  Score is accumulated as an INTEGER count of thousandths of a point, never
     *  as a float. A 20-minute run at ~34 u/s under a 4x multiplier accrues about
     *  1.6e8 thousandths, which is exact in a double (integers are exact to 2^53,
     *  ~9.0e15) with eight orders of magnitude to spare.
     *
     *  Why it matters: `score += rate * dt * multiplier` in floating point drifts.
     *  Each add rounds, the error is a function of the running magnitude, and
     *  after 72,000 ticks two machines that agree on every input can disagree on
     *  the total. P12 re-simulates replays server-side and compares — a one-unit
     *  disagreement rejects an honest player. Integers cannot drift.
     *
     *  1000 gives milli-point resolution, so a single tick of distance score at
     *  the lowest rate still registers rather than truncating to zero. LOCKED —
     *  changing it changes every stored score. */
    scoreFixedPointScale: 1000,

    /** pts/m — base score rate before scoreMultiplier. OPEN. */
    pointsPerMetre: 1.0,
    /** pts — per Bit collected. OPEN. */
    pointsPerBit: 10,
    /** pts — per near-miss. Near-misses must pay in score as well as Flow. OPEN. */
    pointsPerNearMiss: 50,
    /** m/Bit — distance divisor for the end-of-run Bit award. OPEN. */
    bitsPerMetreDivisor: 50,
  },

  economy: {
    /** x — exponent of the upgrade cost curve. LOCKED. */
    upgradeCostExponent: 2.15,
    /** Bits — rounding granularity applied to every computed cost. OPEN. */
    upgradeCostRounding: 5,
    /** x — shape constant of the diminishing effect curve. Lower front-loads
     *  harder. At 0.6, tier 1 delivers 43.4% of Emax. OPEN. */
    upgradeEffectK: 0.6,
    /** count — upgrade tiers per track. OPEN. */
    upgradeMaxTier: 5,
    /** x — tier-5 effect, as a multiplier over tier 0. +65%, NOT +400%. Any upgrade
     *  whose tier 5 more than doubles tier 0 is a balance bug. LOCKED. */
    upgradeEmax: 0.65,

    /** Bits — tier-1 cost per upgrade track. OPEN. */
    upgradeBaseCost: {
      magnetDuration: 250,
      flowGain: 300,
      bitValue: 350,
      shieldCount: 400,
    },

    /** Bits — pre-run boost costs. OPEN. */
    boostCost: {
      headStart: 500,
      doubleBits: 600,
      flowPrimer: 450,
    },

    /** m — distance the Head Start boost skips. timeSpeed is advanced to match. OPEN. */
    headStartMetres: 300,
    /** Flow — starting Flow granted by the Flow Primer boost. OPEN. */
    flowPrimerFlow: 40,
    /** x — the 2x Bits boost. OPEN. */
    doubleBitsMultiplier: 2,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15. Camera and render — docs/TUNING.md §13
  //
  // Not gameplay, but they change how the game feels, so they live here too.
  // ───────────────────────────────────────────────────────────────────────────
  camera: {
    /** u — distance behind the runner. OPEN. */
    cameraDistance: 7.5,
    /** u — height above the current floor plane. OPEN. */
    cameraHeight: 2.6,
    /** deg — vertical field of view at baseSpeed. OPEN. */
    cameraFov: 62,

    /** deg — added to cameraFov, lerped from baseSpeed to maxSpeed. OPEN.
     *
     *  Raised from 8 to 20 at P05, taking the maximum FOV to 82. This is
     *  deliberately **outside** the 0–15 range TUNING.md §13 originally gave, and
     *  the range there has been widened to 0–20 to match rather than the value
     *  quietly exceeding its own documented bound.
     *
     *  The reasoning is that FOV widening is most of what makes speed read on a
     *  flat-shaded scene with no motion blur and no particles — there is very
     *  little else carrying the sensation at this art direction. The cost is the
     *  documented one: FOV pumping is a nausea risk, so this must be on the
     *  reduced-motion kill switch at P15, and it wants a real playtest before it
     *  is treated as settled. */
    cameraSpeedFovBoost: 20,

    // ── P05 — camera rig dynamics ─────────────────────────────────────────────
    //
    // All three stiffnesses are exponential-damping RATES in 1/s, applied as
    // `x += (target - x) * (1 - e^(-rate * dt))`. That form is frame-rate
    // independent, unlike a raw `lerp(x, target, k)` which converges faster at
    // higher frame rates and makes the camera feel different on a 144Hz monitor.
    //
    // `Math.exp` is fine here: the ban in eslint.config.mjs is scoped to
    // src/game/sim/** because the sim has to be bit-reproducible for P12. The
    // camera is presentation and never feeds back into the sim.
    /** 1/s — lateral follow rate. Stiffest axis: lane changes must read as
     *  decisive, and lateral lag is what makes a runner feel like it is on ice. */
    cameraFollowLateral: 14.0,
    /** 1/s — vertical follow rate. Deliberately softer than lateral so a jump
     *  arcs out of frame slightly rather than the camera glueing to the apex. */
    cameraFollowVertical: 7.0,
    /** 1/s — depth follow rate. Softest: the player barely moves in z (law b). */
    cameraFollowDepth: 5.0,

    /** u — how far the camera leads in the direction of lane input, at full
     *  deflection. Small on purpose; it is a hint, not a pan. OPEN. */
    cameraLookAhead: 1.1,
    /** 1/s — damping rate on the look-ahead offset. Low, so the lead drifts in
     *  rather than snapping and fighting the lane tween. OPEN. */
    cameraLookAheadDamping: 4.0,

    /** 1/s — rate at which the camera's own roll chases the world's.
     *
     *  `rollCameraLerp` 0.85 is expressed as a per-frame lerp weight, which is
     *  frame-rate dependent and therefore unusable directly. This is the same
     *  intent as an exponential rate: 17/s reaches ~85% of the way in a 60Hz
     *  frame, matching the original at the rate it was chosen on, while staying
     *  identical at 144Hz. DERIVED from `roll.rollCameraLerp`. */
    cameraRollRate: 17.0,

    /** deg — how far the camera leans INTO a roll, on top of the world rotation.
     *
     *  The camera does not rigidly track the 90 degree world turn — that reads as
     *  the screen flipping. It over-rotates slightly at the start and settles
     *  back, which is what sells the roll as the player's action rather than the
     *  world's. OPEN, needs a device playtest alongside GAME_BIBLE §13 Q1. */
    cameraRollLean: 9.0,
    /** 1/s — how fast the lean settles back out after the roll completes. OPEN. */
    cameraRollSettle: 6.0,
    /** u — positional shake amplitude on a near-miss. Respects reduced-motion. OPEN. */
    cameraShakeOnNearMiss: 0.06,
    /** x — min(devicePixelRatio, this). Above 2 the fragment cost on high-DPI
     *  phones destroys the frame budget for no visible gain at this art style. LOCKED. */
    pixelRatioCap: 2.0,
  },

  /** u — per-theme fog distances. fogFar must exceed maxSpeed * 0.9 ≈ 31u in every
   *  theme except Static, which is deliberately unfair and is an unlock.
   *  Full theme definitions (palettes, props, stems) land in config/themes.ts at P10. */
  fog: {
    kiln: { near: 12, far: 45 },
    undertow: { near: 8, far: 30 },
    bazaar: { near: 20, far: 70 },
    /** Static's fog is unstable and oscillates between these bounds. */
    staticTheme: { near: 6, far: 90, unstableMin: 20, unstableMax: 90 },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15b. Render layer — P05
  //
  // Presentation only. Nothing here is read by src/game/sim/**, and nothing here
  // may change a gameplay outcome — if a number in this section could alter where
  // the player ends up, it is in the wrong section.
  // ───────────────────────────────────────────────────────────────────────────
  render: {
    /** u — length of one tunnel segment along z.
     *
     *  Independent of `spawn.chunkLength` 24u on purpose: a segment is a unit of
     *  GEOMETRY and a chunk is a unit of GAMEPLAY. Tying them would mean any
     *  change to chunk length silently re-tessellates the tunnel. 12u gives two
     *  segments per chunk, which is enough to keep the recycle seam off-screen. */
    tunnelSegmentLength: 12.0,

    /** count — live tunnel segments in the recycling ring.
     *
     *  Must cover the longest fog distance (Bazaar, 70u) plus the camera's own
     *  setback, or the player sees the world end. 24 x 12u = 288u, comfortably
     *  past `pools.liveTrackLength` 240u. DERIVED-ish; re-check if fog moves. */
    tunnelSegmentCount: 24,

    /** u — how far behind the camera a segment must fall before it recycles to
     *  the front. Beyond the near plane and beyond any plausible camera lean. */
    tunnelRecycleBehind: 20.0,

    /** count — instance-buffer capacity per obstacle geometry type.
     *
     *  Sized from `pools.maxObstacles` 256: any single geometry could in
     *  principle account for every live obstacle, so each buffer is allocated for
     *  the worst case. Instances beyond the live count are collapsed to zero
     *  scale rather than removed, which keeps the draw count constant. */
    maxInstancesPerGeometry: 256,

    /** count — instance capacity for pickups. From `pools.maxPickups`. */
    maxPickupInstances: 512,

    /** px — directional shadow map edge length, by quality tier. 0 disables
     *  shadow casting entirely, which is the first thing to cut on a phone. */
    shadowMapHigh: 1024,
    shadowMapMedium: 512,
    shadowMapLow: 0,

    /** u — half-extent of the directional light's orthographic shadow frustum.
     *
     *  Tight on purpose. A shadow camera sized to the whole tunnel spreads 1024px
     *  over 288u and the shadows turn to mush; sized to the ~40u the player can
     *  actually see, the same map is sharp. */
    shadowFrustumHalfSize: 22.0,
    /** u — near/far span of the shadow camera. */
    shadowFrustumDepth: 80.0,

    /** x — hemisphere fill intensity.
     *
     *  Dominant on purpose, with the key light kept low. Two reasons:
     *
     *  1. GAME_BIBLE §11.3 bans anything darker than the theme palette. With a
     *     directional-dominant setup, gunmetal #2b2b2f on a VERTICAL surface
     *     lands near #111111 — measured from a captured frame — because a wall
     *     normal catches almost nothing from an overhead key. The tunnel walls
     *     crushed to black and broke the ban.
     *  2. §11.1 wants flat colour fields, not modelled form. A high fill and a
     *     weak key gets surfaces close to their actual albedo, which is what
     *     "every surface is one flat colour" asks for.
     *
     *  The key is kept non-zero only so the player still casts a contact shadow,
     *  which is the one depth cue the grey-box cannot do without. */
    hemisphereIntensity: 1.35,
    /** x — key directional intensity. Low: it is here for the shadow, not the
     *  shading. See the note above. */
    directionalIntensity: 0.55,

    /** u — the player's fixed z offset from the origin. Law (b): the player stays
     *  near origin and the world moves past. Non-zero only so the camera has
     *  something to sit behind. */
    playerZ: 0.0,

    /** s — minimum time the loading screen stays up once mounted.
     *
     *  Not a fake delay for polish: below this a fast load produces a single-frame
     *  flash of the loading screen, which reads as a rendering glitch rather than
     *  as loading. */
    minLoadingSeconds: 0.35,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15c. Character animation — P09-feel
  //
  // The runner is built from primitives and animated procedurally. There is no
  // rigged model in the repo and none is referenced — a blocky character that
  // moves well reads better than a detailed one that T-poses.
  // ───────────────────────────────────────────────────────────────────────────
  animation: {
    /** u — world distance per stride.
     *
     *  **This is why the feet never skate.** The run cycle's phase is driven by
     *  DISTANCE, not by elapsed time: `phase = distance / strideLength`. A
     *  time-driven cycle has to be rate-matched to speed by hand and drifts the
     *  moment speed changes, which at a `worldSpeed` that ranges 12–34 u/s is
     *  constantly. Driving from distance makes the match exact by construction —
     *  one stride always covers one stride's worth of ground. OPEN. */
    strideLength: 2.05,

    /** rad — hip/shoulder swing amplitude at the extremes of the run cycle. */
    runSwing: 0.85,
    /** u — vertical bob over one stride. Two bounces per stride, as in a real gait. */
    runBob: 0.075,
    /** rad — forward torso pitch while running. Leaning in reads as intent. */
    runLean: 0.16,

    /** rad — limb pose while airborne: legs tucked, arms up. */
    jumpTuck: 0.7,
    /** rad — falling reach. Distinct from the jump tuck so the apex is readable. */
    fallReach: 0.45,
    /** rad — torso pitch while sliding. Nearly flat. */
    slidePitch: 1.15,
    /** rad — stumble flail amplitude. */
    stumbleFlail: 1.0,
    /** Hz — how fast the stumble flails. Fast and ugly on purpose. */
    stumbleFrequency: 9.0,

    // ── Procedural layer, applied ON TOP of the pose ────────────────────────
    /** rad — how far the body banks into a lane change, at full deflection. */
    leanIntoLane: 0.34,
    /** 1/s — how fast that bank arrives and leaves. */
    leanRate: 9.0,

    /** rad — torso counter-rotation during a roll.
     *
     *  The world spins 90 degrees around the player. If the body spins with it
     *  the roll is invisible — the player is static relative to their own frame.
     *  Counter-rotating the torso AGAINST the world makes the runner look like
     *  they are driving the roll rather than being carried by it. */
    rollCounterRotation: 0.55,
    /** 1/s — how fast the counter-rotation unwinds after the roll completes. */
    rollCounterRate: 7.0,

    /** rad — maximum head yaw when tracking a hazard. */
    headTrackMax: 0.6,
    /** 1/s — head tracking responsiveness. Slower than the body: a head snap
     *  reads as a twitch rather than as attention. */
    headTrackRate: 5.5,
    /** u — only hazards within this distance are worth looking at. */
    headTrackRange: 22.0,

    // ── Cross-fade durations, PER PAIR ──────────────────────────────────────
    //
    // One global blend time is the single most common animation mistake. A
    // jump has to leave the ground instantly or the character feels heavy; a
    // landing has to settle rather than snap. Those want opposite values, and a
    // compromise is wrong for both.
    /** s — default when a pair is not listed below. */
    blendDefault: 0.09,
    /** s — run into jump. Fast: the launch must be instant. */
    blendRunToJump: 0.06,
    /** s — jump into fall. Slow: this is the apex hang, and it is the one moment
     *  the arc should feel floaty. */
    blendJumpToFall: 0.12,
    /** s — land into run. Medium: the settle. */
    blendLandToRun: 0.1,
    /** s — anything into slide. Fast; a slide is a commitment. */
    blendToSlide: 0.05,
    /** s — into a crash. Near-instant: the impact is the point. */
    blendToCrash: 0.03,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15d. Impact feel — P09-feel
  //
  // Everything here is PRESENTATION. Nothing in this section may change a
  // gameplay outcome, and nothing reads anything but sim events and interpolated
  // sim state.
  // ───────────────────────────────────────────────────────────────────────────
  feel: {
    /** s — frozen render time on a fatal crash.
     *
     *  **Hit-stop does more for impact than any particle system.** Freezing the
     *  presentation for a few frames lets the brain register that two things
     *  touched; without it a collision is just a state change. The sim keeps
     *  ticking underneath — only the picture holds.
     *
     *  60–90ms is the band where it reads as impact rather than as a dropped
     *  frame. Below ~50ms nobody perceives it; above ~120ms it reads as a hitch. */
    hitStopCrash: 0.09,
    /** s — frozen render time when an obstacle shatters during Overdrive.
     *  Shorter than a crash: it happens repeatedly and must not stack into a
     *  stutter. */
    hitStopShatter: 0.06,
    /** s — hard ceiling on accumulated hit-stop, so a burst of shatters in one
     *  frame cannot freeze the game. */
    hitStopMax: 0.12,

    // ── Trauma-based screen shake ───────────────────────────────────────────
    //
    // A single `trauma` value in [0,1] that decays linearly, with the actual
    // offset driven by `trauma^2`. The square is what makes it feel right: a
    // small trauma produces almost nothing, a large one produces a lot, and the
    // tail-off is fast rather than a long linear fade.
    //
    // The offset comes from noise, NEVER a sine. A fixed sine wobble is
    // instantly recognisable as fake — it is periodic, so the eye locks onto the
    // rhythm — whereas noise reads as a physical jolt.
    /** trauma — added on a fatal crash. Full. */
    traumaCrash: 1.0,
    /** trauma — added on a stumble. */
    traumaStumble: 0.42,
    /** trauma — added on a near-miss. Small; near-misses are frequent. */
    traumaNearMiss: 0.16,
    /** trauma — added on a shatter. */
    traumaShatter: 0.3,
    /** trauma — maximum added on a hard landing, scaled by impact velocity. */
    traumaLanding: 0.22,
    /** trauma/s — decay rate. */
    traumaDecay: 1.7,
    /** u — positional shake at trauma 1.0. */
    shakeMaxOffset: 0.34,
    /** rad — rotational shake at trauma 1.0. Roll only; yaw/pitch shake on a
     *  first-person-adjacent camera is nauseating. */
    shakeMaxRoll: 0.055,
    /** Hz — how fast the noise is sampled. High enough to read as a jolt rather
     *  than a sway. */
    shakeFrequency: 24.0,

    // ── Landing squash and stretch ──────────────────────────────────────────
    /** x — maximum vertical compression on a hard landing. 0.35 means the body
     *  squashes to 65% height at peak. */
    squashMax: 0.32,
    /** u/s — impact speed that produces the maximum squash. Below this the
     *  squash scales down linearly, so a small hop barely registers. */
    squashFullImpactSpeed: 11.0,
    /** 1/s — how fast the squash springs back out. */
    squashRecovery: 13.0,
    /** x — how much the body stretches while rising fast. Subtle. */
    stretchMax: 0.14,

    // ── Speed lines ─────────────────────────────────────────────────────────
    /** count — radial line instances. One draw call regardless. */
    speedLineCount: 110,
    /** u/s — world speed at which lines begin to appear at all. Below this they
     *  are fully invisible: at base speed the screen must be clean. */
    speedLineOnsetSpeed: 17.0,
    /** u — inner radius of the radial field, so lines never cross the runner. */
    speedLineInnerRadius: 2.6,
    /** u — outer radius. */
    speedLineOuterRadius: 9.0,
    /** u — line length at onset speed. */
    speedLineMinLength: 0.7,
    /** u — line length at maxSpeed. */
    speedLineMaxLength: 5.5,
    /** x — opacity at maxSpeed. Never fully opaque; these are a hint of motion,
     *  not a curtain. */
    speedLineMaxOpacity: 0.42,

    // ── Near-miss ───────────────────────────────────────────────────────────
    //
    // Near-misses must feel REWARDING. This is the feedback that teaches the
    // entire Flow system without a tutorial: the player learns that shaving an
    // obstacle pays, because the game visibly rewards it the first time it
    // happens by accident.
    /** s — how long the near-miss pulse lasts. */
    nearMissPulseDuration: 0.28,
    /** x — peak intensity of the aberration pulse. Consumed by the post-FX pass
     *  when it lands; GAME_BIBLE §11.3 permits chromatic aberration ONLY as a
     *  transient, which is exactly what this is. */
    nearMissPulseStrength: 0.65,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15e. Particles — P09-feel
  //
  // One pooled system, instanced quads, one draw call. Per-particle React
  // components would be thousands of reconciling elements per second.
  // ───────────────────────────────────────────────────────────────────────────
  particles: {
    /** count — hard cap on live particles, by quality tier. The pool is
     *  allocated at the HIGH size once and the cap merely limits how much of it
     *  is used, so changing tier never reallocates. */
    maxHigh: 1024,
    maxMedium: 512,
    maxLow: 0,

    /** s — how long a foot-dust puff lives. */
    dustLife: 0.45,
    /** u — dust puff size. */
    dustSize: 0.16,
    /** count — puffs per footfall. */
    dustPerStep: 3,
    /** u/s — initial upward drift on dust. */
    dustRise: 0.9,

    /** count — particles in a coin-collect burst. */
    coinBurst: 10,
    /** s — coin burst lifetime. Short and bright. */
    coinLife: 0.35,
    /** u — coin particle size. */
    coinSize: 0.11,
    /** u/s — coin burst outward speed. */
    coinSpeed: 3.4,

    /** count — debris pieces when an obstacle shatters. */
    shatterBurst: 22,
    /** s — shatter debris lifetime. */
    shatterLife: 0.8,
    /** u — shatter piece size. */
    shatterSize: 0.2,
    /** u/s — shatter outward speed. */
    shatterSpeed: 6.5,

    /** count — Overdrive trail particles emitted per second. */
    trailPerSecond: 55,
    /** s — trail particle lifetime. */
    trailLife: 0.55,
    /** u — trail particle size. */
    trailSize: 0.18,

    /** u/s² — downward acceleration on debris. Cosmetic gravity; nothing here
     *  touches the sim's own gravity, which is solved from jumpApexTime. */
    gravity: -14.0,
    /** x — per-second velocity damping, so bursts settle rather than fly off. */
    drag: 0.88,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15g. Meta — docs/TUNING.md §17
  //
  // Everything between runs. None of this may execute inside the tick —
  // docs/ARCHITECTURE.md §3. The one permitted exception is the run-summary
  // recorder, which counts events and decides nothing.
  // ───────────────────────────────────────────────────────────────────────────
  meta: {
    // ── Inventory — GAME_BIBLE §9.3 ─────────────────────────────────────────
    /** count — how high a consumable stacks. */
    consumableStackCap: 99,
    /** count — boosts equipped per run. NEVER sold as slots: that is how this
     *  genre turns a clean meta into a spreadsheet. */
    boostSlots: 2,
    /** count — avatars equipped per run. */
    avatarSlots: 1,

    // ── Progression — GAME_BIBLE §9.5 ───────────────────────────────────────
    //
    // DECISION (P13). The brief asked for "player level from lifetime distance"
    // and the design had no level system at all, so this curve is new. It is
    // deliberately cosmetic: level gates nothing that affects a run, because a
    // level that gates power turns a score chase into a grind check.
    /** m — lifetime distance required to reach level 2. */
    levelOneDistance: 1500,
    /** x — geometric growth per level. At 1.18, level 10 is ~7,700m lifetime and
     *  level 30 is ~250,000m — a few hundred runs, which is the intended shape
     *  for a number whose only job is to say "you have played a lot". */
    levelGrowth: 1.18,
    /** count — level ceiling. Past this the curve would outrun any real player. */
    maxLevel: 50,

    // ── Missions — GAME_BIBLE §9.4 ──────────────────────────────────────────
    /** count — dailies active at once. */
    dailyMissionCount: 3,
    /** Shards — awarded for completing all three dailies. */
    dailyAllCompleteShards: 1,
    /** Shards — per weekly contract tier. */
    weeklyTierShards: [2, 3, 5],
    /** count — tiers in the weekly contract. */
    weeklyTierCount: 3,

    // ── Avatars — GAME_BIBLE §9.1 ───────────────────────────────────────────
    /** x — hard ceiling on any passive that changes how a run PLAYS.
     *
     *  Kestrel's +8% Flow gain is the strongest such passive and this is what
     *  holds it there. Ochre's +10% Bit value is above this number and is
     *  deliberately exempt: it changes what a run PAYS, not how it is played, so
     *  it cannot define a build. `avatars.ts` asserts the distinction. */
    avatarGameplayPassiveCap: 0.08,

    // ── Save — the chain in save.ts ─────────────────────────────────────────
    /** The schema version this build writes. Bumping it requires a migration. */
    saveVersion: 3,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 15f. Audio — docs/TUNING.md §16
  //
  // Everything here is PRESENTATION. Audio reads the sim event ring and the
  // interpolated state; it never writes either. An audio hitch must never change
  // a run's outcome — docs/ARCHITECTURE.md §3.
  //
  // Times in this section are WALL-CLOCK seconds on the `AudioContext` clock,
  // not sim seconds. That distinction is the whole reason audio schedules
  // against `AudioContext.currentTime` rather than the tick counter: the sim
  // clock is a fiction the audio hardware has never heard of.
  // ───────────────────────────────────────────────────────────────────────────
  audio: {
    // ── Bus gains. Persisted; these are the defaults ────────────────────────
    /** x — master output gain. Below 1.0 so the sum of a full mix plus a burst
     *  of one-shots has headroom before the destination clips. */
    masterGain: 0.9,
    /** x — music bus default. Music sits UNDER gameplay: every sound that tells
     *  the player something has to win against it. */
    musicGain: 0.6,
    /** x — sfx bus default. */
    sfxGain: 0.85,
    /** x — ui bus default. */
    uiGain: 0.7,

    // ── Voice pool ──────────────────────────────────────────────────────────
    /** count — concurrent one-shot voices. Beyond roughly this many the ear
     *  cannot separate them anyway, so the cap costs nothing audible and bounds
     *  the graph size. Band-5 density plus a shatter burst peaks near 14. */
    maxVoices: 24,
    /** s — fade applied when a voice is STOLEN. A hard `stop()` on a sounding
     *  buffer is a step discontinuity, which is exactly what a click is. Six
     *  milliseconds is inaudible as a fade and completely removes the click. */
    voiceStealFade: 0.006,

    // ── The musical grid ────────────────────────────────────────────────────
    //
    // One tempo for the whole project. Every theme is written to it, so a theme
    // cross-fade at a distance milestone lands on a beat instead of smearing
    // across one — and so the Overdrive swap can be quantised against a single
    // shared grid rather than four of them.
    /** bpm — project tempo. Fast enough to carry a runner, slow enough that the
     *  percussion layer is not a wash at Overdrive speed. */
    musicBpm: 126,
    /** count — beats per bar. */
    beatsPerBar: 4,
    /** count — bars per stem loop. Every stem buffer is exactly this long, which
     *  is what makes them interchangeable and phase-locked. */
    barsPerLoop: 4,
    /** s — extra render time past the loop end, folded back onto the head so a
     *  decay that crosses the loop point wraps instead of clicking. */
    stemTailSeconds: 1.5,

    // ── Adaptive layering ───────────────────────────────────────────────────
    //
    // Intensity is a blend of the two things the player is actually feeling:
    // how fast the world is moving, and how close they are to Overdrive.
    /** x — weight of normalised world speed in the intensity blend. */
    musicSpeedWeight: 0.45,
    /** x — weight of normalised Flow in the intensity blend. Slightly higher:
     *  Flow is the thing the player is playing FOR. */
    musicFlowWeight: 0.55,
    /** x — intensity at which percussion starts to come in. */
    percussionOnset: 0.18,
    /** x — intensity at which percussion is fully up. */
    percussionFull: 0.45,
    /** x — intensity at which the tension layer starts. */
    tensionOnset: 0.5,
    /** x — intensity at which the tension layer is fully up. */
    tensionFull: 0.9,
    /** s — how long a layer takes to fade in or out. Long: a layer that snaps in
     *  reads as a bug, and the whole point of adaptive music is that the player
     *  never catches it changing. */
    layerFade: 0.9,
    /** x — minimum change in a layer's target before it is re-scheduled. Without
     *  this the frame loop would queue an automation event 60 times a second for
     *  changes of 0.001, which costs real CPU and produces zipper artifacts. */
    layerEpsilon: 0.02,
    /** s — cross-fade between two themes' stem sets at a milestone. Slow, and
     *  roughly the length of the 120m transition tunnel at mid-run speed. */
    themeFade: 2.0,
    /** s — cross-fade into and out of the Overdrive stem once the bar lands.
     *  Short: the swap is meant to be felt as a cut. */
    overdriveFade: 0.12,
    /** x — how far the normal layers drop while the Overdrive stem is up. Not to
     *  zero — the groove has to survive underneath or the exit feels like the
     *  music restarted. */
    overdriveLayerDuck: 0.75,

    // ── Side-chain ducking ──────────────────────────────────────────────────
    //
    // Impacts have to cut through the music. The alternative — mixing music low
    // enough that it never masks anything — makes the music pointless.
    /** s — duck attack. 8ms is fast enough to clear the transient it is ducking
     *  for and slow enough not to click. */
    duckAttack: 0.008,
    /** s — duck release, to 95% recovered. */
    duckRelease: 0.18,
    /** x — how far the music bus drops for a nominal one-shot. Scaled by the
     *  sound's own loudness, so a coin dips far less than a crash. */
    duckDepth: 0.3,
    /** x — hard ceiling on the dip. Without it a shatter burst drives the music
     *  bus to silence and the ducking becomes a mute button. */
    duckMaxDepth: 0.6,

    // ── One-shot humanisation ───────────────────────────────────────────────
    //
    // The single cheapest thing that stops repeated sounds sounding like a
    // sample player. Applied per shot, never per sound.
    /** x — +/- fractional pitch jitter, via playbackRate. */
    pitchJitter: 0.08,
    /** x — +/- fractional gain jitter. */
    gainJitter: 0.06,

    // ── The coin streak ladder ──────────────────────────────────────────────
    //
    // Pickups climb in pitch across a streak and drop back on a break. This
    // communicates the entire bit-streak system with no HUD element at all, and
    // it is the reason collecting feels good rather than merely scoring.
    /** semitones — how far each successive pickup climbs. */
    coinStreakSemitone: 1,
    /** semitones — ceiling on the climb, so a long streak stays musical instead
     *  of disappearing upward. One octave. */
    coinStreakMax: 12,
    /** s — a gap longer than this resets the ladder. The sim has no
     *  "streak broken" event, and a gap IS the break as the player hears it. */
    coinStreakResetSeconds: 2.5,

    // ── Latency ─────────────────────────────────────────────────────────────
    /** s — minimum lead on any scheduled cue. Scheduling at exactly
     *  `currentTime` races the render quantum and drops the head of the sound. */
    scheduleAhead: 0.02,
    /** s — lower bound on the user's manual offset. Negative values reduce the
     *  scheduling lead and clamp at zero: sound cannot be scheduled in the past. */
    latencyOffsetMin: -0.15,
    /** s — upper bound on the user's manual offset. */
    latencyOffsetMax: 0.25,

    // ── Lifecycle ───────────────────────────────────────────────────────────
    /** s — master fade-in after the first gesture unlocks the context. Starting
     *  at full gain on the first sample is a click and a jump-scare. */
    masterFadeIn: 0.4,
    /** s — fade before suspending on tab hide, and back after resuming. */
    suspendFade: 0.06,
    /** count — output channels for every rendered buffer. */
    channels: 2,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 16. UI — docs/TUNING.md §18, P14
  //
  // Presentation only. Nothing here may change a run's outcome.
  //
  // ## Every duration is a whole number of sim ticks
  //
  // The brief asked for screen transitions "on the same clock as the game", and
  // the game's clock is the 60Hz fixed tick. So the motion scale is expressed in
  // ticks and converted to milliseconds by one derived expression, which means a
  // UI animation can never land on a fractional frame boundary.
  //
  // Two of them are borrowed rather than invented: `screenTicks` is 18, which is
  // `rollDuration` exactly, and `slowTicks` is 33, which is `slideDuration`. A
  // screen change therefore takes precisely as long as the roll the player
  // already has in their hands, on the same easing curve. Asserted in
  // `tests/ui/tokens.test.ts` so it stays true if either verb is retuned.
  // ───────────────────────────────────────────────────────────────────────────
  ui: {
    // ── Motion scale, in ticks ──────────────────────────────────────────────
    /** ticks — the shortest perceptible change. Hover, press, focus. */
    instantTicks: 3,
    /** ticks — small state changes. Matches `coyoteTime`. */
    fastTicks: 6,
    /** ticks — the default for anything that moves more than a few pixels. */
    baseTicks: 12,
    /** ticks — the screen wipe. Equals `rollDuration` 0.30s, deliberately. */
    screenTicks: 18,
    /** ticks — long reveals. Equals `slideDuration` 0.55s. */
    slowTicks: 33,

    /** ticks — how far ahead of the colour layer the incoming screen's key-line
     *  arrives during a wipe. A two-colour screen print is never in perfect
     *  register; this is that tell, and it is the whole reason the transition
     *  does not read as a generic slide. */
    registerLeadTicks: 2,
    /** px — how far the key-line layer is offset while out of register. */
    registerOffsetPx: 3,

    // ── HUD ─────────────────────────────────────────────────────────────────
    /** Hz — rate the frame loop pushes values into the HUD.
     *
     *  docs/ARCHITECTURE.md §3.1: the eye cannot read a number changing at 60Hz,
     *  and writing one 60 times a second is layout work nobody sees. This is a
     *  ceiling on DOM writes, not on the sim — the sim still runs at 60. */
    hudPushHz: 15,
    /** px — the AXIS ring's outer edge on desktop. */
    ringSizeDesktop: 112,
    /** px — and on mobile. Above the 56px hit-target floor in GAME_BIBLE §6.2
     *  because the ring is also the Overdrive button. */
    ringSizeMobile: 88,
    /** px — the ring's stroke at rest. Matches the 2-3px key-line in §11.1. */
    ringStroke: 6,
    /** px — the ring's stroke once Flow is full. Weight, not glow: §11.3 bans
     *  emissive anywhere outside Overdrive, so "this is ready" has to be carried
     *  by ink. */
    ringStrokeFull: 10,
    /** x — peak scale of the near-miss kick. Attack is instant, decay eases. */
    ringKickScale: 1.12,
    /** ticks — how long the near-miss kick takes to decay. */
    ringKickTicks: 6,
    /** x — peak scale of the at-100 idle pulse. Much smaller than the kick, so a
     *  near-miss still reads as an event while the ring is already breathing. */
    ringPulseScale: 1.04,
    /** count — pooled floating "+6" nodes. A 60-near-miss run must allocate
     *  nothing, so these are recycled rather than created. */
    flowPopupPool: 8,
    /** ticks — how long a floating Flow award stays on screen. */
    flowPopupTicks: 45,
    /** px — how far it drifts before it is recycled. */
    flowPopupDriftPx: 56,

    /** ticks — time for one digit to roll one place on the odometer. Digits
     *  translate; they never fade — GAME_BIBLE §11.2. */
    odometerRollTicks: 8,
    /** count — maximum digits any counter renders. Six covers 999,999m, which no
     *  run reaches, and fixes the width so the layout cannot reflow. */
    odometerMaxDigits: 7,

    // ── Death screen ────────────────────────────────────────────────────────
    /** ticks — gap between the five beats of the death sequence. */
    deathBeatTicks: 12,
    /** ticks — how long the score counts up. */
    deathCountTicks: 33,

    // ── Layout ──────────────────────────────────────────────────────────────
    /** px — minimum interactive target. WCAG 2.2 AA target size is 24; 44 is the
     *  platform convention and the honest floor for a thumb at speed. */
    minTargetPx: 44,
    /** px — the viewport width the mobile layout is designed and tested at. */
    mobileBreakpointPx: 720,
    /** count — discrete cells in a settings slider. A continuous track needs a
     *  gradient or a soft thumb; 20 flat plates reads as printed. */
    sliderSteps: 20,
    /** px — halftone dot pitch. Fixed to the viewport so it does not swim when
     *  the camera moves, per §11.1. */
    halftonePitchPx: 4,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 17. Enforced budgets — docs/TUNING.md §14
  //
  // These are tests, not aspirations. They fail CI.
  // ───────────────────────────────────────────────────────────────────────────
  budgets: {
    /** count — maximum draw calls, desktop. */
    drawCallsDesktop: 100,
    /** count — maximum draw calls, mobile. */
    drawCallsMobile: 50,
    /** ms — maximum cost of a single sim tick. */
    simTickMs: 2.0,
    /** ms — maximum wall time for the full benchmarkTicks run. */
    benchmarkBudgetMs: 200,
    /** bytes — RETAINED heap growth permitted across benchmarkTicks. Law (d).
     *
     *  Retained, not transient: measured after a forced collection, so it counts
     *  only memory the tick kept. Measured actual is **-40 bytes over 100,000
     *  ticks** — i.e. zero. 50KB is a generous ceiling that would still catch a
     *  real leak long before it mattered.
     *
     *  Requires `--expose-gc`; without it the retained figure is unmeasurable and
     *  the suite falls back to `transientBytesPerTick` below. */
    heapDeltaBytes: 50 * 1024,

    /** bytes/tick — TRANSIENT garbage ceiling, for when a forced GC is not
     *  available.
     *
     *  This is deliberately looser than the retained budget because the figure is
     *  JIT-tier dependent: the same code measures 0 bytes/tick once V8 has fully
     *  optimised the tick, and a steady 16 bytes/tick before that. Both were
     *  observed on the same machine, same build.
     *
     *  16 bytes/tick is 960 B/s at 60Hz — a young-generation scavenge every few
     *  hours, of objects that are all dead. It does not cause the GC pause law (d)
     *  exists to prevent. 32 leaves room for tier variance while still catching a
     *  gross regression: one object literal per tick is ~40 bytes and fails. */
    transientBytesPerTick: 32,
    /** ticks — sample size for the allocation and tick-cost benchmarks. */
    benchmarkTicks: 10_000,
    /** KB — first-load JS, gzipped. */
    firstLoadJsKb: 250,

    /** % — ceiling on the audio graph's CPU cost, measured as offline render
     *  time over rendered duration. A proxy for a profiler reading, and named as
     *  one: it measures the graph, not the main thread's share of a frame. */
    audioCpuPercent: 3,
    /** samples — permitted drift between two music stems over a full session.
     *  One sample at 48kHz is 21 microseconds. The real target is zero, and the
     *  design achieves zero structurally by never restarting a stem; this is a
     *  tolerance for the transient-detection window, not for the audio. */
    audioDriftSamples: 1,
    /** x — sample-to-sample amplitude step that counts as a click. Real audio at
     *  these frequencies moves far less than this between adjacent samples;
     *  a discontinuity from a hard gain change moves much more. */
    audioClickThreshold: 0.25,

    /** count — React commits permitted in the UI tree during a run, after the
     *  first paint. Zero, and it is a hard zero rather than a small number:
     *  one `setState` in the frame path re-renders the HUD subtree 60 times a
     *  second and there is no such thing as a little bit of that.
     *  Measured by `<Profiler>` in `tests/e2e/ui.spec.ts`. */
    uiCommitsDuringRun: 0,
    /** x — WCAG AA contrast floor for every text role against its real ground.
     *  Recomputed from the theme hex values in `tests/ui/contrast.test.ts`. */
    uiContrastMin: 4.5,
  },
} as const;

/**
 * The shape of the tuning table.
 *
 * `as const` above already makes every property deeply readonly and narrows each
 * literal to its exact value, so this type carries the real numbers — not `number`.
 * DERIVED fields widen to `number`, which is correct: they are computed, so there
 * is no literal to preserve.
 */
export type TuningSchema = typeof TUNING;

/** One entry of the difficulty band table. */
export type DifficultyBand = TuningSchema["spawn"]["bands"][number];
