/**
 * The level generator.
 *
 * Maintains a rolling window of chunks ahead of the player, selected from the
 * authored pool by a difficulty-banded grammar. Deterministic: same seed, same
 * sequence, always.
 *
 * ## The five rules, and why each exists
 *
 * 1. **Band from distance AND Flow.** A player at 100 Flow is not just moving
 *    faster, they are handed harder track. That is the self-escalation loop
 *    reaching the generator — playing well makes the game harder, which makes
 *    it more lucrative, which makes it harder.
 *
 * 2. **Weighted selection with a recency penalty.** A chunk cannot reappear
 *    within `recencyWindow` picks. The cheapest possible defence against "I
 *    have seen this before", which is the failure mode that kills runners at
 *    the ten-minute mark.
 *
 * 3. **Seam validation.** Two individually survivable chunks can bolt together
 *    into a wall. Any candidate whose entry mask does not overlap the previous
 *    chunk's exit mask is rejected and re-rolled. This is the rule that makes
 *    the whole thing provable rather than merely likely.
 *
 * 4. **Forced breathers.** Never more than `maxConsecutiveHard` chunks at
 *    difficulty >= `hardDifficulty`. Pacing is not decoration: an unbroken wall
 *    of difficulty reads as noise, and the player never gets the beat of relief
 *    that makes the next hard section land.
 *
 * 5. **Theme transitions at the milestones.** An obstacle-free stretch at each
 *    distance boundary in GAME_BIBLE §10.1 — the run's only guaranteed rest.
 *
 * ## Allocation
 *
 * Everything comes from pools. The window is a fixed-size ring of pre-allocated
 * slots; the recency list is a fixed Int32Array; candidate filtering writes into
 * a reused scratch array. Generating 1,000 chunks allocates nothing beyond the
 * initial construction — asserted in the tests, per law (d).
 */

import { TUNING } from "@/game/config/tuning";
import { nextU32, type RngState } from "@/game/sim/rng";
import { CHUNK_LENGTH, seamsCompatible, type Chunk } from "./chunk";
import { ALL_CHUNKS, CHUNKS_BY_TIER, MAX_TIER, MIN_TIER, TRANSITION_CHUNK } from "./chunks";

const WINDOW_CHUNKS = TUNING.level.windowChunks;
const RECENCY_WINDOW = TUNING.level.recencyWindow;
const HARD_DIFFICULTY = TUNING.level.hardDifficulty;
const MAX_CONSECUTIVE_HARD = TUNING.level.maxConsecutiveHard;
const FLOW_DIFFICULTY_BONUS = TUNING.level.flowDifficultyBonus;
const FLOW_MAX = TUNING.flow.flowMax;
const BANDS = TUNING.spawn.bands;
const THEME_MILESTONES = TUNING.level.themeMilestones;
const TRANSITION_LENGTH = TUNING.level.transitionLength;

/** How many transition chunks a theme boundary inserts. */
const TRANSITION_CHUNK_COUNT = Math.round(TRANSITION_LENGTH / CHUNK_LENGTH);

/** One placed chunk in the live window. */
export interface PlacedChunk {
  /** Index into `ALL_CHUNKS`, or -1 for the transition chunk. */
  chunkIndex: number;
  chunk: Chunk;
  /** m — distance at which this chunk's leading edge sits. */
  startDistance: number;
  /** Sequence number since the run started. Never reused. */
  ordinal: number;
}

export interface LevelState {
  /** Ring of placed chunks. Length is always `windowChunks`. */
  readonly window: PlacedChunk[];
  /** Index of the oldest live slot in the ring. */
  head: number;
  /** How many chunks are currently live. */
  count: number;
  /** m — where the next chunk will be placed. */
  nextDistance: number;
  /** Total chunks emitted this run. */
  ordinal: number;
  /** Recent chunk indices, newest last. -1 means empty. */
  readonly recent: Int32Array;
  /** How many entries of `recent` are valid. */
  recentCount: number;
  /** Consecutive hard chunks immediately behind `nextDistance`. */
  consecutiveHard: number;
  /** Index into `THEME_MILESTONES` of the next boundary to cross. */
  nextMilestone: number;
  /** Transition chunks still to emit before normal selection resumes. */
  transitionRemaining: number;
  /** Exit constraint of the last placed chunk, for the seam check. */
  lastExitCells: number;
  lastExitGrounded: boolean;
  /** Diagnostics. */
  seamRejections: number;
  recencyRejections: number;
  breathersForced: number;
}

/** Scratch for candidate filtering. Reused; never reallocated. */
const candidateIndices = new Int32Array(ALL_CHUNKS.length);
const candidateWeights = new Int32Array(ALL_CHUNKS.length);

/** Maps a chunk back to its index in `ALL_CHUNKS`, built once. */
const CHUNK_INDEX = new Map<string, number>();
for (let i = 0; i < ALL_CHUNKS.length; i += 1) {
  CHUNK_INDEX.set(ALL_CHUNKS[i]?.id ?? "", i);
}

const TRANSITION_INDEX = -1;

export function createLevelState(): LevelState {
  const window: PlacedChunk[] = [];
  for (let i = 0; i < WINDOW_CHUNKS; i += 1) {
    window.push({
      chunkIndex: 0,
      chunk: TRANSITION_CHUNK,
      startDistance: 0,
      ordinal: 0,
    });
  }
  return {
    window,
    head: 0,
    count: 0,
    nextDistance: 0,
    ordinal: 0,
    recent: new Int32Array(RECENCY_WINDOW).fill(-1),
    recentCount: 0,
    consecutiveHard: 0,
    nextMilestone: 0,
    transitionRemaining: 0,
    lastExitCells: TRANSITION_CHUNK.exitConstraint.safeCells,
    lastExitGrounded: true,
    seamRejections: 0,
    recencyRejections: 0,
    breathersForced: 0,
  };
}

/** Resets in place. Allocates nothing. */
export function resetLevelState(state: LevelState): void {
  state.head = 0;
  state.count = 0;
  state.nextDistance = 0;
  state.ordinal = 0;
  state.recent.fill(-1);
  state.recentCount = 0;
  state.consecutiveHard = 0;
  state.nextMilestone = 0;
  state.transitionRemaining = 0;
  state.lastExitCells = TRANSITION_CHUNK.exitConstraint.safeCells;
  state.lastExitGrounded = true;
  state.seamRejections = 0;
  state.recencyRejections = 0;
  state.breathersForced = 0;
}

/**
 * The difficulty tier to draw from.
 *
 * Distance sets the floor via the band table; Flow lifts it. Clamped to the
 * authored tiers so a 100-Flow player at 6,000m cannot ask for a tier 6 that
 * does not exist.
 */
export function difficultyFor(distance: number, flow: number): number {
  let band = 0;
  while (band + 1 < BANDS.length && distance >= (BANDS[band]?.toMetres ?? Infinity)) {
    band += 1;
  }
  const fromDistance = band + 1;
  const fromFlow = Math.floor((flow / FLOW_MAX) * FLOW_DIFFICULTY_BONUS);
  const tier = fromDistance + fromFlow;
  if (tier < MIN_TIER) {
    return MIN_TIER;
  }
  return tier > MAX_TIER ? MAX_TIER : tier;
}

/** True when this chunk index appears in the recency list. */
function isRecent(state: LevelState, chunkIndex: number): boolean {
  for (let i = 0; i < state.recentCount; i += 1) {
    if (state.recent[i] === chunkIndex) {
      return true;
    }
  }
  return false;
}

/** Pushes onto the recency ring, dropping the oldest. */
function pushRecent(state: LevelState, chunkIndex: number): void {
  if (state.recentCount < RECENCY_WINDOW) {
    state.recent[state.recentCount] = chunkIndex;
    state.recentCount += 1;
    return;
  }
  for (let i = 1; i < RECENCY_WINDOW; i += 1) {
    state.recent[i - 1] = state.recent[i] ?? -1;
  }
  state.recent[RECENCY_WINDOW - 1] = chunkIndex;
}

/**
 * Collects legal candidates from a tier into the scratch arrays.
 *
 * @param allowHard when false, chunks at or above `hardDifficulty` are excluded —
 *        this is how the breather rule is enforced.
 * @returns the number of candidates written.
 */
function collectCandidates(
  state: LevelState,
  tier: number,
  allowHard: boolean,
  allowRecent: boolean,
): number {
  const pool = CHUNKS_BY_TIER[tier] ?? [];
  let n = 0;

  for (const chunk of pool) {
    if (!allowHard && chunk.difficulty >= HARD_DIFFICULTY) {
      continue;
    }
    const index = CHUNK_INDEX.get(chunk.id) ?? -1;
    if (index < 0) {
      continue;
    }
    if (!allowRecent && isRecent(state, index)) {
      state.recencyRejections += 1;
      continue;
    }
    if (
      !seamsCompatible(
        { safeCells: state.lastExitCells, requiresGrounded: state.lastExitGrounded },
        chunk.entryConstraint,
      )
    ) {
      state.seamRejections += 1;
      continue;
    }
    candidateIndices[n] = index;
    candidateWeights[n] = chunk.weight;
    n += 1;
  }
  return n;
}

/** Weighted pick from the scratch arrays. */
function pickWeighted(rng: RngState, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += candidateWeights[i] ?? 0;
  }
  if (total <= 0) {
    return candidateIndices[0] ?? 0;
  }
  let roll = nextU32(rng) % total;
  for (let i = 0; i < count; i += 1) {
    roll -= candidateWeights[i] ?? 0;
    if (roll < 0) {
      return candidateIndices[i] ?? 0;
    }
  }
  return candidateIndices[count - 1] ?? 0;
}

/**
 * Selects the next chunk.
 *
 * Relaxes constraints in a fixed order when a tier has nothing legal, so
 * selection can never fail outright and can never become non-deterministic:
 *
 *   1. tier, no hard (if breather forced), no recent
 *   2. tier, allow recent          — small tier, or recency window too wide
 *   3. neighbouring tiers          — tier genuinely exhausted by the seam
 *   4. the transition chunk        — always seam-compatible, never a dead end
 *
 * Step 4 is the guarantee that matters: there is always *something* legal, so
 * the generator cannot stall mid-run.
 */
function selectChunk(state: LevelState, rng: RngState, tier: number): number {
  const forceBreather = state.consecutiveHard >= MAX_CONSECUTIVE_HARD;
  const allowHard = !forceBreather;

  let count = collectCandidates(state, tier, allowHard, false);
  if (count === 0) {
    count = collectCandidates(state, tier, allowHard, true);
  }

  if (count === 0) {
    for (let delta = 1; delta < MAX_TIER && count === 0; delta += 1) {
      const lower = tier - delta;
      if (lower >= MIN_TIER) {
        count = collectCandidates(state, lower, allowHard, true);
      }
      if (count === 0) {
        const higher = tier + delta;
        if (higher <= MAX_TIER) {
          count = collectCandidates(state, higher, allowHard, true);
        }
      }
    }
  }

  if (count === 0) {
    return TRANSITION_INDEX;
  }

  if (forceBreather) {
    state.breathersForced += 1;
  }
  return pickWeighted(rng, count);
}

/** Writes a chunk into the ring, recycling the oldest slot when full. */
function place(state: LevelState, chunkIndex: number, chunk: Chunk): PlacedChunk {
  const slotIndex =
    state.count < WINDOW_CHUNKS
      ? (state.head + state.count) % WINDOW_CHUNKS
      : state.head;

  const slot = state.window[slotIndex];
  if (slot === undefined) {
    throw new Error(`Level window slot ${slotIndex} missing — the ring was resized.`);
  }

  slot.chunkIndex = chunkIndex;
  slot.chunk = chunk;
  slot.startDistance = state.nextDistance;
  slot.ordinal = state.ordinal;

  if (state.count < WINDOW_CHUNKS) {
    state.count += 1;
  } else {
    // Full: the oldest slot has just been overwritten, so the head moves on.
    state.head = (state.head + 1) % WINDOW_CHUNKS;
  }

  state.nextDistance += CHUNK_LENGTH;
  state.ordinal += 1;
  state.lastExitCells = chunk.exitConstraint.safeCells;
  state.lastExitGrounded = chunk.exitConstraint.requiresGrounded;

  if (chunk.difficulty >= HARD_DIFFICULTY) {
    state.consecutiveHard += 1;
  } else {
    state.consecutiveHard = 0;
  }

  if (chunkIndex !== TRANSITION_INDEX) {
    pushRecent(state, chunkIndex);
  }

  return slot;
}

/** True when the next chunk crosses a theme milestone. */
function crossesMilestone(state: LevelState): boolean {
  if (state.nextMilestone >= THEME_MILESTONES.length) {
    return false;
  }
  const milestone = THEME_MILESTONES[state.nextMilestone] ?? Infinity;
  return state.nextDistance + CHUNK_LENGTH > milestone;
}

/**
 * Emits exactly one chunk and returns it.
 *
 * Called by the caller's own loop — the generator does not decide when it is
 * time for more track, because that depends on the player's distance, which is
 * the sim's business.
 */
export function generateNext(state: LevelState, rng: RngState, flow: number): PlacedChunk {
  if (state.transitionRemaining > 0) {
    state.transitionRemaining -= 1;
    return place(state, TRANSITION_INDEX, TRANSITION_CHUNK);
  }

  if (crossesMilestone(state)) {
    state.nextMilestone += 1;
    state.transitionRemaining = TRANSITION_CHUNK_COUNT - 1;
    return place(state, TRANSITION_INDEX, TRANSITION_CHUNK);
  }

  const tier = difficultyFor(state.nextDistance, flow);
  const index = selectChunk(state, rng, tier);
  const chunk = index === TRANSITION_INDEX ? TRANSITION_CHUNK : (ALL_CHUNKS[index] ?? TRANSITION_CHUNK);
  return place(state, index, chunk);
}

/**
 * Tops the window up so there are always `windowChunks` ahead of the player.
 *
 * @returns how many chunks were emitted this call.
 */
export function fillWindow(
  state: LevelState,
  rng: RngState,
  flow: number,
  playerDistance: number,
): number {
  let emitted = 0;
  const target = playerDistance + WINDOW_CHUNKS * CHUNK_LENGTH;
  while (state.nextDistance < target) {
    generateNext(state, rng, flow);
    emitted += 1;
  }
  return emitted;
}

/** Reads a live slot by age, 0 = oldest. Returns undefined past `count`. */
export function chunkAt(state: LevelState, offset: number): PlacedChunk | undefined {
  if (offset < 0 || offset >= state.count) {
    return undefined;
  }
  return state.window[(state.head + offset) % WINDOW_CHUNKS];
}

/** The most recently emitted chunk. */
export function newestChunk(state: LevelState): PlacedChunk | undefined {
  return chunkAt(state, state.count - 1);
}

export { CHUNK_LENGTH, TRANSITION_INDEX, WINDOW_CHUNKS };
