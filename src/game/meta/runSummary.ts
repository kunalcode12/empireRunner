/**
 * The object that crosses from the sim to the meta layer at run end.
 *
 * ## Why a recorder exists at all, and why it is allowed to
 *
 * `docs/ARCHITECTURE.md` §3 says `meta/` never runs during a run. That rule is
 * about economy and mission logic — work that allocates, branches on player
 * state, and has no business inside a frame. It is not about counting.
 *
 * The counting has to happen live because there is nowhere else for it to come
 * from. `bitsCollected`, `nearMisses`, `overdrivesTriggered` and `peakFlow` are
 * not fields in `SimState` — they are consequences of events — and the event
 * ring holds only `TUNING.pools.maxEvents` entries, so by the time a run ends
 * the first thirty seconds of it have been overwritten. Reconstructing the
 * summary at run end is not merely awkward; the data is gone.
 *
 * So `RunRecorder` is a bag of integers fed from the same event drain that
 * already feeds the feel layer and the audio director. It allocates nothing, it
 * decides nothing, and it cannot touch a balance — there is no economy import in
 * this file. §3 has been amended to name this exception rather than let the code
 * quietly contradict the document.
 *
 * ## Nothing here is trusted
 *
 * A `RunSummary` is client-authored and therefore forgeable. It drives rewards,
 * missions and unlocks, all of which are local and none of which matter to
 * anyone else. The **leaderboard** does not read this object: it reads the
 * replay blob and re-simulates it server-side at P12. That split is deliberate —
 * cheating yourself out of a mission is your business; cheating a leaderboard is
 * not.
 */

import { TUNING } from "@/game/config/tuning";
import { SimEvent } from "@/game/sim/events";
import { EntityType } from "@/game/sim/level/entities";

/** Which theme a distance falls in. GAME_BIBLE §10.1. */
const THEME_MILESTONES = TUNING.level.themeMilestones;

/** payload0 of `SimEvent.FractureResolve` when the player found the verb. */
const FRACTURE_SUCCEEDED = 1;

/**
 * Everything the meta layer is allowed to know about a finished run.
 *
 * Deliberately flat and deliberately all-integer except `peakFlow` and
 * `distance`: this object is serialised into the save file as part of mission
 * progress, and a nested or float-heavy shape makes every migration harder for
 * no benefit.
 */
export interface RunSummary {
  /** m — distance travelled. */
  distance: number;
  /** pts — final score, already divided out of fixed point. */
  score: number;
  /** count — Bits picked up in the run, BEFORE `bitValueMult` and boosts. */
  bitsCollected: number;
  /** count — Shards picked up in the run. */
  shardsCollected: number;
  /** 0..100 — highest Flow reached. */
  peakFlow: number;
  /** count — Overdrives triggered. */
  overdrivesTriggered: number;
  /** count — near-misses banked. */
  nearMisses: number;
  /** count — obstacles passed without contact. */
  obstaclesCleared: number;
  /** count — obstacles shattered during Overdrive. */
  obstaclesShattered: number;
  /** count — deaths avoided by a successful Fracture. */
  fracturesSurvived: number;
  /** count — Fractures attempted, successful or not. Drives the Shard cost. */
  fracturesUsed: number;
  /** count — fatal hits a Shield absorbed. */
  shieldsUsed: number;
  /** count — Shields still held at the end. Ballast's unlock challenge. */
  shieldsUnused: number;
  /** count — rolls completed. Vane's unlock challenge. */
  rolls: number;
  /** count — jumps. */
  jumps: number;
  /** count — slides. */
  slides: number;
  /** count — stumbles survived. */
  stumbles: number;
  /** count — highest combo reached. */
  bestCombo: number;
  /** 0..3 — the furthest theme reached. GAME_BIBLE §10.1. */
  themeReached: number;
  /** Index into `TUNING.spawn.bands` at run end. */
  bandReached: number;
  /** s — wall-clock length of the run, in sim time. */
  durationSeconds: number;
  /** The run seed, so a summary can be tied back to its replay. */
  seed: number;
  /** True when the run ended in a death rather than a quit. */
  died: boolean;
  /**
   * The P02 replay blob, for later server-side validation.
   *
   * Optional because a summary is useful without it — missions and rewards never
   * touch it — and because holding every run's input log in the save file would
   * grow it without bound. P12 submits it and then drops it.
   */
  replay?: Uint8Array;
}

/**
 * Live counters. One per run, reused, never reallocated.
 *
 * Every field is an integer or a bounded float so V8 keeps the whole object in
 * Smi/double slots rather than boxing. This is fed inside the frame loop, so it
 * is held to the same standard as anything else there.
 */
export interface RunRecorder {
  bitsCollected: number;
  shardsCollected: number;
  peakFlow: number;
  overdrivesTriggered: number;
  nearMisses: number;
  obstaclesShattered: number;
  fracturesSurvived: number;
  fracturesUsed: number;
  shieldsUsed: number;
  rolls: number;
  jumps: number;
  slides: number;
  stumbles: number;
  died: boolean;
}

export function createRunRecorder(): RunRecorder {
  return {
    bitsCollected: 0,
    shardsCollected: 0,
    peakFlow: 0,
    overdrivesTriggered: 0,
    nearMisses: 0,
    obstaclesShattered: 0,
    fracturesSurvived: 0,
    fracturesUsed: 0,
    shieldsUsed: 0,
    rolls: 0,
    jumps: 0,
    slides: 0,
    stumbles: 0,
    died: false,
  };
}

/** Zeroes a recorder in place. Called at run start; allocates nothing. */
export function resetRunRecorder(recorder: RunRecorder): void {
  recorder.bitsCollected = 0;
  recorder.shardsCollected = 0;
  recorder.peakFlow = 0;
  recorder.overdrivesTriggered = 0;
  recorder.nearMisses = 0;
  recorder.obstaclesShattered = 0;
  recorder.fracturesSurvived = 0;
  recorder.fracturesUsed = 0;
  recorder.shieldsUsed = 0;
  recorder.rolls = 0;
  recorder.jumps = 0;
  recorder.slides = 0;
  recorder.stumbles = 0;
  recorder.died = false;
}

/**
 * The entity kinds a `Coin` event carries in payload0.
 *
 * Read from the sim's own entity table rather than restated here. Restating
 * them is precisely the mistake that produced the `ThemeChange` bug at P11: a
 * consumer held its own copy of a sim constant, the sim's value moved, and
 * nothing failed until someone read the output and found it meaningless. The
 * first draft of this file guessed 1/2/3; the real values are 20/21/22.
 */
export const CoinKind = {
  Bit: EntityType.Bit,
  BitCluster: EntityType.BitCluster,
  Shard: EntityType.Shard,
} as const;

/** Bits granted by a cluster pickup. GAME_BIBLE §7.3. */
const BITS_PER_CLUSTER = 8;

/**
 * Folds one drained sim event into the recorder.
 *
 * Runs inside the frame loop. No allocation, no branching on anything but the
 * event kind, and no reads of anything outside the two arguments.
 */
export function recordEvent(recorder: RunRecorder, type: number, payload0: number): void {
  switch (type) {
    case SimEvent.Coin:
      if (payload0 === CoinKind.Shard) {
        recorder.shardsCollected += 1;
      } else if (payload0 === CoinKind.BitCluster) {
        recorder.bitsCollected += BITS_PER_CLUSTER;
      } else {
        recorder.bitsCollected += 1;
      }
      return;
    case SimEvent.NearMiss:
      recorder.nearMisses += 1;
      return;
    case SimEvent.OverdriveStart:
      recorder.overdrivesTriggered += 1;
      return;
    case SimEvent.Shatter:
      recorder.obstaclesShattered += 1;
      return;
    case SimEvent.RollEnd:
      recorder.rolls += 1;
      return;
    case SimEvent.Jump:
      recorder.jumps += 1;
      return;
    case SimEvent.SlideStart:
      recorder.slides += 1;
      return;
    case SimEvent.Stumble:
      recorder.stumbles += 1;
      return;
    case SimEvent.ShieldAbsorb:
      recorder.shieldsUsed += 1;
      return;
    case SimEvent.FractureArm:
      recorder.fracturesUsed += 1;
      return;
    case SimEvent.FractureResolve:
      if (payload0 === FRACTURE_SUCCEEDED) {
        recorder.fracturesSurvived += 1;
      }
      return;
    case SimEvent.Crash:
      recorder.died = true;
      return;
    default:
      return;
  }
}

/** Tracks the Flow high-water mark. Called once per frame with interpolated Flow. */
export function recordFlow(recorder: RunRecorder, flow: number): void {
  if (flow > recorder.peakFlow) {
    recorder.peakFlow = flow;
  }
}

/**
 * Which theme a distance falls in.
 *
 * Reads the same milestone table the generator does rather than restating it,
 * so a change to the theme layout cannot leave the summary describing a
 * different run from the one the player had.
 */
export function themeForDistance(distance: number): number {
  let theme = 0;
  for (const milestone of THEME_MILESTONES) {
    if (distance >= milestone) {
      theme += 1;
    }
  }
  return theme;
}

/** The sim-side facts a summary needs, so this module never imports the Sim. */
export interface RunEndState {
  distance: number;
  score: number;
  bestCombo: number;
  band: number;
  elapsedSeconds: number;
  seed: number;
  /** Shields still held. The sim tracks these; a quit run keeps them. */
  shieldsHeld: number;
}

/**
 * Freezes a recorder plus the sim's end state into a summary.
 *
 * Allocates — deliberately. This runs exactly once, after the run is over, and
 * the result is an immutable object that several independent systems read. A
 * reused mutable summary handed to economy, missions and progression in turn is
 * a bug waiting for the first system that stores a reference.
 */
export function buildRunSummary(
  recorder: Readonly<RunRecorder>,
  end: Readonly<RunEndState>,
  replay?: Uint8Array,
): RunSummary {
  const summary: RunSummary = {
    distance: Math.max(0, end.distance),
    score: Math.max(0, Math.floor(end.score)),
    bitsCollected: recorder.bitsCollected,
    shardsCollected: recorder.shardsCollected,
    peakFlow: recorder.peakFlow,
    overdrivesTriggered: recorder.overdrivesTriggered,
    nearMisses: recorder.nearMisses,
    // Cleared, not merely passed: a shattered obstacle was destroyed rather than
    // avoided, so it is counted separately and neither figure double-counts.
    obstaclesCleared: recorder.nearMisses + recorder.obstaclesShattered,
    obstaclesShattered: recorder.obstaclesShattered,
    fracturesSurvived: recorder.fracturesSurvived,
    fracturesUsed: recorder.fracturesUsed,
    shieldsUsed: recorder.shieldsUsed,
    shieldsUnused: Math.max(0, end.shieldsHeld),
    rolls: recorder.rolls,
    jumps: recorder.jumps,
    slides: recorder.slides,
    stumbles: recorder.stumbles,
    bestCombo: end.bestCombo,
    themeReached: themeForDistance(end.distance),
    bandReached: end.band,
    durationSeconds: Math.max(0, end.elapsedSeconds),
    seed: end.seed,
    died: recorder.died,
  };
  if (replay !== undefined) {
    summary.replay = replay;
  }
  return Object.freeze(summary);
}

/** An all-zero summary. Tests, and the "no runs yet" state of the death screen. */
export function emptyRunSummary(): RunSummary {
  return buildRunSummary(createRunRecorder(), {
    distance: 0,
    score: 0,
    bestCombo: 0,
    band: 0,
    elapsedSeconds: 0,
    seed: 0,
    shieldsHeld: 0,
  });
}
