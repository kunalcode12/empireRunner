/**
 * The simulation.
 *
 * Headless, deterministic, and dependency-free: this module and everything it
 * imports run under plain Node with no DOM and no renderer. That is what lets
 * P12 re-simulate a submitted replay server-side and reject a tampered score
 * (docs/ARCHITECTURE.md §2a, §6).
 *
 * ## The tick order is a contract
 *
 *   1. input      sanitise and latch this tick's intent
 *   2. player     verb state machine, gravity, lane/roll motion        [P04 stub]
 *   3. world      advance the speed curve, accumulate distance, band
 *   4. spawn      generate obstacles and pickups ahead                 [P06 stub]
 *   5. collision  swept AABB, pickups, near-miss, fatal contact        [P07 stub]
 *   6. scoring    Flow, multiplier, Overdrive                          [P08 stub]
 *   7. events     finalise the tick and emit
 *
 * Reordering these changes results. Player before world means the player acts on
 * last tick's speed; spawn before collision means an entity can be created and
 * hit on the same tick. Both are defensible, but only one can be true, and the
 * choice is baked into every stored replay. **Changing this order requires
 * bumping `TUNING.replay.formatVersion`.**
 *
 * Steps 2, 4, 5 and 6 are no-op stubs in P02. See each module's header for the
 * phase that implements it.
 */

import { TUNING } from "../config/tuning";
import { stepCollision } from "./collision";
import { createEventRing, emit, resetEventRing, SimEvent, type EventRing } from "./events";
import { stepGenerator } from "./generator";
import { hashState } from "./hash";
import { createIntent, sanitizeIntent, type Intent } from "./intent";
import { stepPlayer } from "./player";
import {
  createRng,
  deserializeRng,
  forkSeed,
  RNG_STREAMS,
  serializeRng,
  type RngState,
} from "./rng";
import { stepScoring } from "./scoring";
import {
  copyState,
  createState,
  F,
  Phase,
  resetState,
  RunStatus,
  type RngSeeds,
  type SimState,
} from "./state";

const FIXED_DELTA = TUNING.sim.fixedDelta;
const SPEED_APPROACH = TUNING.determinism.speedApproachPerTick;
const BASE_SPEED = TUNING.speed.baseSpeed;
const SPEED_CEILING = TUNING.speed.speedCeiling;
const MAX_SPEED = TUNING.speed.maxSpeed;
const FLOW_SPEED_BONUS = TUNING.speed.flowSpeedBonus;
const FLOW_MAX = TUNING.flow.flowMax;
const BANDS = TUNING.spawn.bands;
const STUMBLE_SPEED_PENALTY = TUNING.collision.stumbleSpeedPenalty;

export interface Sim {
  /** Advances exactly one fixed timestep. */
  tick(intent: Readonly<Intent>): void;
  /** The state as of the most recent tick. Do not mutate. */
  getState(): SimState;
  /** The state as of the tick before that. Do not mutate. Render interpolates between them. */
  getPrevious(): SimState;
  /** Restores everything to run-start for `seed`. Allocates nothing. */
  reset(seed: number): void;
  /** The event ring. The only channel out of the sim. */
  readonly events: EventRing;
  /** The seed this sim is currently running. */
  getSeed(): number;
  /** FNV-1a hash of the current state. The determinism instrument. */
  hash(): number;
}

/**
 * Creates a simulation.
 *
 * This is the only function in the sim that allocates. Everything it builds —
 * two state buffers, the event ring, the RNG streams, the scratch intent — is
 * reused for the lifetime of the sim, including across `reset`.
 */
export function createSim(seed: number): Sim {
  const normalizedSeed = seed >>> 0;
  let currentSeed = normalizedSeed;

  const current = createState();
  const previous = createState();
  const events = createEventRing();

  // Named streams, derived from the run seed. Separate streams mean a cosmetic
  // particle can never shift the track layout — see rng.ts.
  const generatorRng = createRng(0);
  const pickupRng = createRng(0);
  const cosmeticRng = createRng(0);

  // One reusable intent. The caller's intent is copied in and sanitised here so
  // the sim never holds a reference to caller-owned mutable data.
  const scratchIntent = createIntent();

  const seeds: RngSeeds = { generator: 0, pickup: 0, cosmetic: 0 };

  function deriveSeeds(runSeed: number): void {
    seeds.generator = forkSeed(runSeed, RNG_STREAMS.generator);
    seeds.pickup = forkSeed(runSeed, RNG_STREAMS.pickup);
    seeds.cosmetic = forkSeed(runSeed, RNG_STREAMS.cosmetic);
  }

  function loadRngFromState(state: SimState): void {
    deserializeRng(generatorRng, state.rngGenerator);
    deserializeRng(pickupRng, state.rngPickup);
    deserializeRng(cosmeticRng, state.rngCosmetic);
  }

  // Stored signed so the value stays a Smi and does not box — see state.ts.
  function storeRngToState(state: SimState, gen: RngState, pick: RngState, cos: RngState): void {
    state.rngGenerator = serializeRng(gen) | 0;
    state.rngPickup = serializeRng(pick) | 0;
    state.rngCosmetic = serializeRng(cos) | 0;
  }

  function reset(nextSeed: number): void {
    currentSeed = nextSeed >>> 0;
    deriveSeeds(currentSeed);

    resetState(current, seeds);
    resetState(previous, seeds);
    resetEventRing(events);
    loadRngFromState(current);

    current.runStatus = RunStatus.Running;
    previous.runStatus = RunStatus.Running;
    emit(events, SimEvent.RunStart, 0, currentSeed);
  }

  /**
   * Step 3 — world scroll.
   *
   * The speed curve is integrated incrementally rather than evaluated in closed
   * form, because `Math.exp` is only "implementation-approximated" by ECMA-262
   * and browsers do not agree on its last ulp. See TUNING.determinism for the
   * full reasoning and the frozen constant. This form uses nothing but multiply
   * and add, which IEEE-754 specifies exactly.
   *
   * Law (b): distance is an accumulated scalar. The player's z does not move.
   */
  function stepWorld(state: SimState): void {
    // Indexed directly rather than through the getF/setF helpers. Those are
    // fine at the edges, but passing a double across a call boundary that V8
    // declines to inline boxes it into a HeapNumber — 16 bytes, every tick.
    // Measured: the helper form cost ~16 bytes/tick, this form costs nothing.
    const f = state.f;

    const timeSpeed = f[F.timeSpeed] ?? 0;
    const nextTimeSpeed = timeSpeed + (SPEED_CEILING - timeSpeed) * SPEED_APPROACH;
    f[F.timeSpeed] = nextTimeSpeed;

    const flowBonus = FLOW_SPEED_BONUS * ((f[F.flow] ?? 0) / FLOW_MAX);
    const target = nextTimeSpeed + flowBonus;
    const capped = target > MAX_SPEED ? MAX_SPEED : target;

    // A stumble is a setback, not a death: the world slows while the player
    // recovers. Applied after the clamp so the penalty is always felt, even at
    // maxSpeed where the clamp would otherwise absorb it.
    const worldSpeed =
      state.player.phase === Phase.Stumbling ? capped * STUMBLE_SPEED_PENALTY : capped;
    f[F.worldSpeed] = worldSpeed;

    f[F.distance] = (f[F.distance] ?? 0) + worldSpeed * FIXED_DELTA;
  }

  /** Step 3b — difficulty band, derived from distance. Emits on transition. */
  function stepBand(state: SimState): void {
    const previousBand = state.band;
    const distance = state.f[F.distance] ?? 0;
    let band = previousBand;
    // Bands are contiguous and ascending (asserted in tuning-invariants), so a
    // forward scan from the current band is correct and never walks backwards.
    while (band + 1 < BANDS.length && distance >= (BANDS[band]?.toMetres ?? Infinity)) {
      band += 1;
    }
    if (band !== previousBand) {
      state.band = band;
      emit(events, SimEvent.BandChange, state.tick, band);
    }
  }

  function tick(intent: Readonly<Intent>): void {
    if (current.runStatus === RunStatus.Ended) {
      return;
    }

    // Snapshot before mutating, so the renderer always has two consecutive
    // states to interpolate between (law (c)).
    copyState(previous, current);

    // 1. input
    scratchIntent.lateral = intent.lateral;
    scratchIntent.roll = intent.roll;
    scratchIntent.jump = intent.jump;
    scratchIntent.slide = intent.slide;
    sanitizeIntent(scratchIntent);

    // 2. player                                                      [P04 stub]
    stepPlayer(current, scratchIntent, FIXED_DELTA, events);

    // 3. world
    stepWorld(current);
    stepBand(current);

    // 4. spawn                                                       [P06 stub]
    stepGenerator(current, generatorRng, pickupRng, events);

    // 5. collision                                                   [P07 stub]
    stepCollision(current, FIXED_DELTA, events);

    // 6. scoring                                                     [P08 stub]
    stepScoring(current, FIXED_DELTA, events);

    // 7. events — advance time and persist RNG positions into the state, so a
    //    snapshot or a hash captures the generator's exact position.
    current.tick += 1;
    current.f[F.elapsed] = current.tick * FIXED_DELTA;
    storeRngToState(current, generatorRng, pickupRng, cosmeticRng);
  }

  reset(normalizedSeed);

  return {
    tick,
    getState: () => current,
    getPrevious: () => previous,
    reset,
    events,
    getSeed: () => currentSeed,
    hash: () => hashState(current),
  };
}

/** The speed the world starts at, before any ramp. Exported for tests and the HUD. */
export const INITIAL_WORLD_SPEED = BASE_SPEED;
