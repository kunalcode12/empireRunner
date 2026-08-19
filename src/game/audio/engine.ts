/**
 * The `AudioContext`, the bus graph, and the whole lifecycle around them.
 *
 * ## Nothing is constructed until the player touches something
 *
 * Every browser blocks audio until a user gesture, and the ones that do not
 * block it still *create* the context in the `suspended` state. Constructing an
 * `AudioContext` at module load therefore produces a permanently silent graph
 * that looks completely healthy from the console — the single most common Web
 * Audio bug, and the hardest to spot because nothing errors.
 *
 * So: no context exists until `unlock()` runs, `unlock()` is wired to real
 * gesture events, and it explicitly handles the case where the context is
 * created suspended and must be resumed. The gesture listeners stay armed until
 * a resume actually succeeds, then remove themselves.
 *
 * ## The bus graph
 *
 * ```
 *   music voices ──> musicGain ──> musicDuck ─┐
 *   sfx voices   ──> sfxGain ────────────────>├──> master ──> destination
 *   ui voices    ──> uiGain  ────────────────>┘
 * ```
 *
 * `musicGain` and `musicDuck` are two nodes on purpose. The player's music
 * volume and the side-chain ducker both want to own "the music level", and if
 * they share a param they overwrite each other's automation — the symptom is
 * music that gets quieter every time you crash and never comes back. Separate
 * nodes means each owns exactly one thing.
 *
 * ## Interruption recovery
 *
 * A phone call, a screen lock, or another app taking the audio session moves the
 * context to `suspended` — or, on Safari, to `interrupted`, a state that is not
 * in the TypeScript `AudioContextState` union but is real and does occur. The
 * `statechange` handler treats any unexpected departure from `running` as an
 * interruption: it tries an immediate resume, and if that is refused (it usually
 * is, because there is no gesture) it re-arms the gesture listeners so the next
 * tap brings the game back. Without that re-arming, audio is dead for the rest
 * of the page's life — the failure this handler exists to prevent.
 */

import { TUNING } from "@/game/config/tuning";
import { measureLatency, type LatencyProbe } from "./latency";
import {
  Bus,
  BUS_SETTING,
  clampLatencyOffset,
  clampNumber,
  loadSettings,
  saveSettings,
  type AudioSettings,
  type BusName,
  type SettingsStorage,
} from "./settings";

/** Gesture events that count as "the player touched the page". */
const GESTURE_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

const GAIN_MIN = 0;
const GAIN_MAX = 1;
/** The state a healthy context is in. */
const RUNNING = "running";
/**
 * Safari's interrupted state. Absent from `AudioContextState` in lib.dom, which
 * is why the comparison is made against a widened string rather than the union.
 */
const INTERRUPTED = "interrupted";
/** ms — how long to hold after a fade before suspending, so the fade is heard. */
const MS_PER_SECOND = 1000;

/** Every gain node the rest of the layer plugs into. */
export interface AudioBuses {
  readonly master: GainNode;
  readonly music: GainNode;
  /** Owned exclusively by `ducking.ts`. Nothing else may automate it. */
  readonly musicDuck: GainNode;
  readonly sfx: GainNode;
  readonly ui: GainNode;
}

/**
 * The WebKit-only Audio Session API.
 *
 * Not present in `lib.dom.d.ts` — I checked — so it is declared narrowly here
 * and feature-detected at every use. Declaring it is not the same as assuming
 * it: every call site guards on `typeof`.
 *
 * This is the closest the web platform comes to the iOS silent switch. There is
 * no API that reports the switch's position; what `audioSession.type` does is
 * declare INTENT, and the platform then decides whether the switch applies. A
 * game is `"playback"` — audio the user asked for — but declaring
 * `"auto"` leaves the switch honoured, which for a game with a mute button is
 * the respectful default and the one used here.
 */
interface AudioSessionLike {
  type: string;
}
interface NavigatorWithAudioSession extends Navigator {
  audioSession?: AudioSessionLike;
}

export interface AudioEngineOptions {
  /** Builds the context. Injected so tests never need a browser. */
  contextFactory?: () => AudioContext;
  /** Where gesture listeners are attached. `null` disables auto-unlock. */
  gestureTarget?: EventTarget | null;
  /** Where `visibilitychange` is observed. `null` disables it. */
  visibilityTarget?: (EventTarget & { visibilityState?: string }) | null;
  /** Where settings persist. */
  storage?: SettingsStorage;
}

export interface AudioEngine {
  /** The context, or null before the first gesture. */
  readonly context: AudioContext | null;
  /** The bus graph, or null before the first gesture. */
  readonly buses: AudioBuses | null;
  /** True once a context exists and is running. */
  readonly running: boolean;
  /** Current settings. Treat as read-only; mutate through the setters. */
  readonly settings: Readonly<AudioSettings>;
  /** Latency as last probed. Re-probed on every unlock and resume. */
  readonly latency: LatencyProbe;
  /** `AudioContext.currentTime`, or 0 before there is a context. */
  now(): number;

  /** Creates and/or resumes the context. Safe to call repeatedly. */
  unlock(): Promise<boolean>;
  /** Registers a callback fired once, when the graph first becomes available. */
  onReady(callback: (buses: AudioBuses, context: AudioContext) => void): () => void;

  setBusGain(bus: BusName, value: number): void;
  setMuted(muted: boolean): void;
  setLatencyOffset(seconds: number): void;

  suspend(): Promise<void>;
  resume(): Promise<boolean>;
  dispose(): void;
}

/** Reads a context's state as a plain string, so Safari's extra state compares. */
function stateOf(context: AudioContext): string {
  return context.state;
}

function defaultContextFactory(): AudioContext {
  return new AudioContext();
}

/**
 * Declares the audio session type where the platform supports it.
 *
 * `"auto"` leaves the iOS silent switch in control, which is what a game with
 * its own mute control should do. Guarded twice: the navigator may not have the
 * property, and assigning an unknown value throws on some builds.
 */
function declareAudioSession(): void {
  if (typeof navigator === "undefined") {
    return;
  }
  const nav = navigator as NavigatorWithAudioSession;
  if (nav.audioSession === undefined || typeof nav.audioSession.type !== "string") {
    return;
  }
  try {
    nav.audioSession.type = "auto";
  } catch {
    // The platform rejected the value. Nothing to do and nothing to report.
  }
}

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  const contextFactory = options.contextFactory ?? defaultContextFactory;
  const gestureTarget =
    options.gestureTarget === undefined
      ? typeof window === "undefined"
        ? null
        : window
      : options.gestureTarget;
  const visibilityTarget =
    options.visibilityTarget === undefined
      ? typeof document === "undefined"
        ? null
        : document
      : options.visibilityTarget;

  const settings = loadSettings(options.storage);

  let context: AudioContext | null = null;
  let buses: AudioBuses | null = null;
  let latency: LatencyProbe = measureLatency(null);
  let disposed = false;
  let gestureArmed = false;
  /**
   * True while a suspend was our own idea.
   *
   * The difference between "the tab was backgrounded" and "a phone call took the
   * audio device away" is not visible in `AudioContext.state` — both read
   * `suspended`. This flag is the only thing that distinguishes them, and the
   * two need opposite responses: leave one alone, fight to recover the other.
   */
  let suspendRequested = false;
  let readyCallbacks: ((buses: AudioBuses, context: AudioContext) => void)[] = [];

  /** The gain the master bus should sit at right now, mute included. */
  function targetMasterGain(): number {
    return settings.muted ? 0 : settings.masterGain;
  }

  function buildBuses(ctx: AudioContext): AudioBuses {
    const master = ctx.createGain();
    const music = ctx.createGain();
    const musicDuck = ctx.createGain();
    const sfx = ctx.createGain();
    const ui = ctx.createGain();

    master.gain.value = 0;
    music.gain.value = settings.musicGain;
    musicDuck.gain.value = 1;
    sfx.gain.value = settings.sfxGain;
    ui.gain.value = settings.uiGain;

    music.connect(musicDuck);
    musicDuck.connect(master);
    sfx.connect(master);
    ui.connect(master);
    master.connect(ctx.destination);

    // Fade the master up rather than starting at full: the first sample of a
    // graph that jumps from 0 to 0.9 is a step discontinuity, which is a click.
    const start = ctx.currentTime;
    master.gain.setValueAtTime(0, start);
    master.gain.linearRampToValueAtTime(targetMasterGain(), start + TUNING.audio.masterFadeIn);

    return { master, music, musicDuck, sfx, ui };
  }

  function fireReady(): void {
    if (buses === null || context === null) {
      return;
    }
    const callbacks = readyCallbacks;
    readyCallbacks = [];
    const readyBuses = buses;
    const readyContext = context;
    for (const callback of callbacks) {
      callback(readyBuses, readyContext);
    }
  }

  const onGesture = (): void => {
    void unlock();
  };

  function armGestures(): void {
    if (gestureArmed || gestureTarget === null || disposed) {
      return;
    }
    gestureArmed = true;
    for (const type of GESTURE_EVENTS) {
      gestureTarget.addEventListener(type, onGesture);
    }
  }

  function disarmGestures(): void {
    if (!gestureArmed || gestureTarget === null) {
      return;
    }
    gestureArmed = false;
    for (const type of GESTURE_EVENTS) {
      gestureTarget.removeEventListener(type, onGesture);
    }
  }

  /**
   * The context left `running` **without being asked to**.
   *
   * Try an immediate resume — sometimes the interruption has already cleared and
   * it just works — and re-arm the gesture listeners either way, so the next tap
   * recovers. This is the phone-call path.
   *
   * ## `suspendRequested` is what makes "without being asked to" true
   *
   * Found at P14. `statechange` fires for a deliberate `suspend()` exactly as it
   * does for an interruption, and this handler used to resume unconditionally.
   * Once a context has been unlocked by a gesture, `resume()` generally succeeds
   * with no further gesture — so backgrounding the tab faded the master to zero,
   * suspended, and was immediately brought back. The tab kept an audio graph
   * running in the background forever, which is precisely what the visibility
   * handler exists to stop.
   *
   * It surfaced on mobile-chromium and not on desktop, which is the usual shape
   * of a race: both were wrong, only one lost consistently.
   */
  const onStateChange = (): void => {
    if (context === null || disposed) {
      return;
    }
    const state = stateOf(context);
    if (state === RUNNING) {
      disarmGestures();
      latency = measureLatency(context);
      return;
    }
    if (suspendRequested) {
      // We asked for this. `resume()` happens on the way back, from the
      // visibility handler — not from here.
      return;
    }
    if (state === INTERRUPTED || state === "suspended") {
      armGestures();
      void context.resume().catch(() => {
        // Expected without a gesture. The listeners above are the recovery.
      });
    }
  };

  async function unlock(): Promise<boolean> {
    if (disposed) {
      return false;
    }
    if (context === null) {
      declareAudioSession();
      try {
        context = contextFactory();
      } catch {
        // No Web Audio at all. The game stays playable and silent.
        return false;
      }
      context.addEventListener("statechange", onStateChange);
      buses = buildBuses(context);
      latency = measureLatency(context);
      fireReady();
    }

    if (stateOf(context) !== RUNNING) {
      try {
        await context.resume();
      } catch {
        // Gesture requirement not satisfied yet. Listeners remain armed.
        return false;
      }
    }

    const running = stateOf(context) === RUNNING;
    if (running) {
      disarmGestures();
      latency = measureLatency(context);
    }
    return running;
  }

  /** Ramps the master bus and waits for the ramp before acting. */
  function fadeMaster(to: number): number {
    if (context === null || buses === null) {
      return 0;
    }
    const at = context.currentTime;
    const fade = TUNING.audio.suspendFade;
    buses.master.gain.cancelScheduledValues(at);
    buses.master.gain.setValueAtTime(buses.master.gain.value, at);
    buses.master.gain.linearRampToValueAtTime(to, at + fade);
    return fade;
  }

  /**
   * The one `setTimeout` in the audio layer, and it is not a musical schedule.
   *
   * `AudioContext.suspend()` stops the clock immediately, so a fade scheduled on
   * that clock would be cut off mid-ramp — which is the click the fade exists to
   * prevent. Waiting out the fade in wall-clock time is the only way to let it
   * finish. Nothing musical is ever timed this way; see `music.ts`.
   */
  function afterFade(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, seconds * MS_PER_SECOND);
    });
  }

  async function suspend(): Promise<void> {
    if (context === null || stateOf(context) !== RUNNING) {
      return;
    }
    // Set BEFORE the fade, not just before `suspend()`. The state can change
    // under us during the wait, and `onStateChange` has to know it was us.
    suspendRequested = true;
    const fade = fadeMaster(0);
    await afterFade(fade);
    if (context === null || disposed) {
      return;
    }
    try {
      await context.suspend();
    } catch {
      // Already suspended, or closed underneath us.
    }
  }

  async function resume(): Promise<boolean> {
    // Cleared first: from here on, any departure from `running` is genuinely
    // unrequested and the interruption path should handle it.
    suspendRequested = false;
    const running = await unlock();
    if (running) {
      fadeMaster(targetMasterGain());
    } else {
      // The autoplay policy re-locked while we were away. Without this the
      // listeners stay disarmed and audio never comes back at all.
      armGestures();
    }
    return running;
  }

  const onVisibility = (): void => {
    if (visibilityTarget === null || disposed) {
      return;
    }
    if (visibilityTarget.visibilityState === "hidden") {
      void suspend();
    } else {
      void resume();
    }
  };

  if (visibilityTarget !== null) {
    visibilityTarget.addEventListener("visibilitychange", onVisibility);
  }
  armGestures();

  return {
    get context() {
      return context;
    },
    get buses() {
      return buses;
    },
    get running() {
      return context !== null && stateOf(context) === RUNNING;
    },
    get settings() {
      return settings;
    },
    get latency() {
      return latency;
    },

    now(): number {
      return context === null ? 0 : context.currentTime;
    },

    unlock,
    resume,
    suspend,

    onReady(callback): () => void {
      if (buses !== null && context !== null) {
        callback(buses, context);
        return () => undefined;
      }
      readyCallbacks.push(callback);
      return () => {
        readyCallbacks = readyCallbacks.filter((entry) => entry !== callback);
      };
    },

    setBusGain(bus: BusName, value: number): void {
      const clamped = clampNumber(value, GAIN_MIN, GAIN_MAX, GAIN_MAX);
      const field = BUS_SETTING[bus];
      if (field === "muted" || field === "latencyOffset") {
        return;
      }
      settings[field] = clamped;
      saveSettings(settings, options.storage);

      if (buses === null || context === null) {
        return;
      }
      const at = context.currentTime;
      const node =
        bus === Bus.Master
          ? buses.master
          : bus === Bus.Music
            ? buses.music
            : bus === Bus.Sfx
              ? buses.sfx
              : buses.ui;
      const target = bus === Bus.Master ? targetMasterGain() : clamped;
      node.gain.cancelScheduledValues(at);
      node.gain.setValueAtTime(node.gain.value, at);
      node.gain.linearRampToValueAtTime(target, at + TUNING.audio.suspendFade);
    },

    setMuted(muted: boolean): void {
      settings.muted = muted;
      saveSettings(settings, options.storage);
      fadeMaster(targetMasterGain());
    },

    setLatencyOffset(seconds: number): void {
      settings.latencyOffset = clampLatencyOffset(seconds);
      saveSettings(settings, options.storage);
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      disarmGestures();
      readyCallbacks = [];
      if (visibilityTarget !== null) {
        visibilityTarget.removeEventListener("visibilitychange", onVisibility);
      }
      if (context !== null) {
        context.removeEventListener("statechange", onStateChange);
        try {
          void context.close();
        } catch {
          // Already closed.
        }
      }
      context = null;
      buses = null;
    },
  };
}
