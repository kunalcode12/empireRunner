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
     *  the header layout, the intent bit packing, or the tick order in sim.ts.
     *  A replay whose version does not match is rejected, never re-scored. */
    formatVersion: 1,

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
    /** Flow — per near-miss. One award per obstacle instance, ever. LOCKED. */
    flowPerNearMiss: 6,
    /** Flow — per slide clearing a Low Bar within perfectSlideMargin. OPEN.
     *  Deliberately below flowPerNearMiss so slide-farming cannot out-earn risk. */
    flowPerPerfectSlide: 4,
    /** Flow — per completed Bit streak. OPEN. */
    flowPerBitStreak: 3,
    /** count — consecutive Bits per streak award. OPEN. */
    bitStreakInterval: 10,
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
    /** deg — added to cameraFov, lerped from baseSpeed to maxSpeed. OPEN. */
    cameraSpeedFovBoost: 8,
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
  // 16. Enforced budgets — docs/TUNING.md §14
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
