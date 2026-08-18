/**
 * One-shot sound effects, driven by the sim event ring.
 *
 * ## Nothing repeats exactly, ever
 *
 * Every shot gets +/-8% pitch and +/-6% gain. That is the single cheapest thing
 * that stops a game sounding like a sample player: the ear is extremely good at
 * detecting an identical waveform played twice, and once it does, every
 * subsequent repeat is heard as "the sound file" rather than as the event. Eight
 * percent is roughly a semitone and a third — enough to defeat recognition,
 * small enough to stay in tune with the music.
 *
 * ## The coin ladder is the bit-streak HUD
 *
 * Successive pickups climb a semitone each, up to an octave, and drop back on a
 * break. It costs one multiplication and it teaches the entire bit-streak
 * system without a single UI element: the player hears the pitch rising, hears
 * it reset when they miss, and works out what they did. A number on screen
 * would say the same thing and nobody would read it mid-run.
 *
 * The sim has no "streak broken" event to hang the reset on — the streak is
 * internal to scoring. A gap longer than `coinStreakResetSeconds` IS the break
 * as the player experiences it, and a crash or stumble resets it outright.
 *
 * ## Ducking is triggered here, not in the mixer
 *
 * Every shot tells the ducker how loud it was, so a coin dips the music barely
 * at all and a crash dips it fully. Ducking driven by a bus meter instead would
 * need an analyser node polled per frame, and would duck for the tail of a
 * sound as well as its transient — which is exactly the smeared, pumping
 * ducking that gives side-chaining a bad name.
 */

import { TUNING } from "@/game/config/tuning";
import { SimEvent } from "@/game/sim/events";
import { cueTime } from "./latency";
import { EVENT_SOUND, Sound, SOUNDS, type SoundKey } from "./recipes";
import { Bus } from "./settings";
import type { VoicePool } from "./voices";
import type { Ducker } from "./ducking";

const SEMITONES_PER_OCTAVE = 12;
/** Quietest a landing can be, so a small hop is still audible. */
const LAND_MIN_GAIN = 0.35;
/** payload0 = 1 means the Fracture was resolved successfully. */
const FRACTURE_SUCCESS = 1;

export interface SfxOptions {
  /** Rendered one-shot buffers, keyed by sound. Missing keys are skipped. */
  buffers: ReadonlyMap<SoundKey, AudioBuffer>;
  sfxPool: VoicePool;
  uiPool: VoicePool;
  ducker: Ducker;
  /** The player's manual latency offset, read fresh on every shot. */
  latencyOffset(): number;
  /** Injected so jitter is deterministic in tests. Defaults to `Math.random`. */
  random?: () => number;
}

export interface SfxSystem {
  /** Plays whatever a sim event maps to. Unmapped events are silently ignored. */
  handle(type: number, payload0: number, now: number): void;
  /** Plays a sound directly. Used for UI and by `handle`. */
  play(key: SoundKey, now: number, gainScale?: number): number | null;
  /** Clears the streak ladder. Run start, crash, stumble. */
  resetStreak(): void;
  /** Current ladder position, in semitones. Diagnostic and tested. */
  readonly streakSemitones: number;
}

export function createSfxSystem(options: SfxOptions): SfxSystem {
  const random = options.random ?? Math.random;

  let streakSteps = 0;
  let lastCoinAt = Number.NEGATIVE_INFINITY;

  /** A symmetric jitter of +/-`range`, as a multiplier around 1. */
  function jitter(range: number): number {
    return 1 + (random() * 2 - 1) * range;
  }

  function ladderSemitones(): number {
    return Math.min(TUNING.audio.coinStreakMax, streakSteps * TUNING.audio.coinStreakSemitone);
  }

  function play(key: SoundKey, now: number, gainScale = 1, semitones = 0): number | null {
    const buffer = options.buffers.get(key);
    if (buffer === undefined) {
      return null;
    }
    const recipe = SOUNDS[key];
    const pool = recipe.bus === Bus.Ui ? options.uiPool : options.sfxPool;

    const pitch = Math.pow(2, semitones / SEMITONES_PER_OCTAVE) * jitter(TUNING.audio.pitchJitter);
    const gain = recipe.gain * gainScale * jitter(TUNING.audio.gainJitter);
    const when = cueTime(now, options.latencyOffset());

    const started = pool.play({
      buffer,
      gain,
      playbackRate: pitch,
      pan: recipe.pan,
      when,
    });

    if (started !== null) {
      options.ducker.trigger(when, recipe.gain * gainScale);
    }
    return started;
  }

  /** Hoisted rather than a method: `handle` calls it, and a method would break
   *  the moment a caller destructured the system — which the director does. */
  function resetStreak(): void {
    streakSteps = 0;
    lastCoinAt = Number.NEGATIVE_INFINITY;
  }

  return {
    get streakSemitones() {
      return ladderSemitones();
    },

    play(key: SoundKey, now: number, gainScale = 1): number | null {
      return play(key, now, gainScale);
    },

    resetStreak,

    handle(type: number, payload0: number, now: number): void {
      switch (type) {
        case SimEvent.Coin: {
          // The gap IS the break. Anything else would need a streak counter
          // mirrored out of scoring, which is state duplicated across a layer
          // boundary for a cosmetic effect.
          if (now - lastCoinAt > TUNING.audio.coinStreakResetSeconds) {
            streakSteps = 0;
          } else {
            streakSteps += 1;
          }
          lastCoinAt = now;
          play(Sound.Coin, now, 1, ladderSemitones());
          return;
        }

        case SimEvent.Land: {
          // payload0 is impact vertical speed. A drop from full jump height is
          // a thud; stepping off a kerb is not, and playing both at one volume
          // makes every landing feel identical.
          const impact = Math.abs(payload0);
          const scale = Math.max(
            LAND_MIN_GAIN,
            Math.min(1, impact / TUNING.feel.squashFullImpactSpeed),
          );
          play(Sound.Land, now, scale);
          return;
        }

        case SimEvent.FractureResolve: {
          play(payload0 === FRACTURE_SUCCESS ? Sound.FractureSuccess : Sound.FractureFail, now);
          resetStreak();
          return;
        }

        case SimEvent.Crash:
        case SimEvent.Stumble:
        case SimEvent.RunStart: {
          resetStreak();
          break;
        }

        default:
          break;
      }

      const key = EVENT_SOUND[type];
      if (key !== undefined) {
        play(key, now);
      }
    },
  };
}
