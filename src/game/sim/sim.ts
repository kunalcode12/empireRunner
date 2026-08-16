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
 *   2. player     verb state machine, gravity, lane/roll motion
 *   3. world      advance the speed curve, accumulate distance, band
 *   4. spawn      generate obstacles and pickups ahead                 [P06 stub]
 *   5. collision  swept AABB, pickups, near-miss, fatal contact        [P07 partial]
 *   6. scoring    Flow, multiplier, Overdrive, Fracture
 *   7. events     finalise the tick and emit
 *
 * Reordering these changes results. Player before world means the player acts on
 * last tick's speed; spawn before collision means an entity can be created and
 * hit on the same tick. Both are defensible, but only one can be true, and the
 * choice is baked into every stored replay. **Changing this order requires
 * bumping `TUNING.replay.formatVersion`.**
 *
 * Step 4 is still a no-op stub: P06 built and proved the level generator but
 * deliberately did not wire it into the live tick, so **nothing spawns yet** and
 * step 5 runs against an empty array in normal play.
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
import { stepDifficulty, stepScoring } from "./scoring";
import {
  copyState,
  createState,
  F,
  resetState,
  RunStatus,
  type RngSeeds,
  type SimState,
} from "./state";

const FIXED_DELTA = TUNING.sim.fixedDelta;
const BASE_SPEED = TUNING.speed.baseSpeed;

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

  function tick(intent: Readonly<Intent>): void {
    if (current.runStatus === RunStatus.Ended) {
      return;
    }

    // Snapshot before mutating, so the renderer always has two consecutive
    // states to interpolate between (law (c)).
    copyState(previous, current);

    // Where this tick's events begin. The scoring pass drains from here, so it
    // sees exactly what this tick produced and nothing from any earlier one.
    const eventCursor = events.head;

    // 1. input
    scratchIntent.lateral = intent.lateral;
    scratchIntent.roll = intent.roll;
    scratchIntent.jump = intent.jump;
    scratchIntent.slide = intent.slide;
    scratchIntent.overdrive = intent.overdrive;
    sanitizeIntent(scratchIntent);

    // A Fracture window suspends the run: the player is not moving, the world is
    // crawling, and collision must not fire again on the obstacle that already
    // killed them. Only the speed curve and the scoring pass run.
    const inFracture = current.runStatus === RunStatus.Fracturing;

    // 2. player
    if (!inFracture) {
      stepPlayer(current, scratchIntent, FIXED_DELTA, events);
    }

    // 3. world — owned by scoring/difficulty.ts, called here so the tick order
    //    is unchanged from P02. Returns the metres the odometer advanced.
    const metres = stepDifficulty(current, events);

    if (!inFracture) {
      // 4. spawn                                                     [P06 stub]
      stepGenerator(current, generatorRng, pickupRng, events);

      // 5. collision
      stepCollision(current, FIXED_DELTA, events);
    }

    // 6. scoring
    stepScoring(current, scratchIntent, FIXED_DELTA, events, eventCursor, metres);

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
