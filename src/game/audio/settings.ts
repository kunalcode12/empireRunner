/**
 * Persisted audio settings — bus volumes, mute, and the manual latency offset.
 *
 * ## Every value is clamped on the way OUT, not just on the way in
 *
 * `localStorage` is user-writable, survives across builds, and is the first
 * thing a corrupted profile corrupts. A single `NaN` reaching a `GainNode`
 * poisons that node permanently — the Web Audio spec has no recovery path, the
 * node outputs silence forever, and the player's only symptom is "the sound
 * stopped working and reinstalling didn't help". So a value read from storage is
 * treated as hostile input: parsed, range-checked, and replaced with the default
 * if it is anything other than a finite number in range.
 *
 * ## Storage is injected
 *
 * `src/game/audio/` has to run under Node in vitest (`environment: "node"`, and
 * that is deliberate — see vitest.config.ts). Reaching for the `localStorage`
 * global directly would make every one of these functions untestable and would
 * throw during SSR. The default is resolved lazily and falls back to an
 * in-memory map, so nothing here can crash a server render.
 */

import { TUNING } from "@/game/config/tuning";

/** The subset of the `Storage` interface this module needs. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Bumping the version discards old settings rather than migrating them.
 *
 * Correct for this data: the entire payload is six preferences a player can
 * reset in three seconds, and a migration path for it would be more code than
 * the thing it migrates.
 */
const STORAGE_KEY = "axis.audio.v1";

export interface AudioSettings {
  /** x — master bus gain, 0..1. */
  masterGain: number;
  /** x — music bus gain, 0..1. */
  musicGain: number;
  /** x — sfx bus gain, 0..1. */
  sfxGain: number;
  /** x — ui bus gain, 0..1. */
  uiGain: number;
  /** Silences the master bus without discarding the individual volumes. */
  muted: boolean;
  /**
   * s — the player's manual audio offset, added to every scheduled cue.
   *
   * Exists because measured output latency is an estimate and Bluetooth
   * headphones make it a bad one. See `latency.ts` for what a negative value
   * can and cannot do.
   */
  latencyOffset: number;
}

export const DEFAULT_SETTINGS: Readonly<AudioSettings> = Object.freeze({
  masterGain: TUNING.audio.masterGain,
  musicGain: TUNING.audio.musicGain,
  sfxGain: TUNING.audio.sfxGain,
  uiGain: TUNING.audio.uiGain,
  muted: false,
  latencyOffset: 0,
});

const GAIN_MIN = 0;
const GAIN_MAX = 1;

/** Clamps to `[min, max]`, mapping anything non-finite to `fallback`. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** Clamps a latency offset to the tuned range. */
export function clampLatencyOffset(value: unknown): number {
  return clampNumber(
    value,
    TUNING.audio.latencyOffsetMin,
    TUNING.audio.latencyOffsetMax,
    DEFAULT_SETTINGS.latencyOffset,
  );
}

/** Coerces an arbitrary parsed object into valid settings. Never throws. */
export function sanitiseSettings(raw: unknown): AudioSettings {
  if (raw === null || typeof raw !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const record = raw as Record<string, unknown>;
  return {
    masterGain: clampNumber(record.masterGain, GAIN_MIN, GAIN_MAX, DEFAULT_SETTINGS.masterGain),
    musicGain: clampNumber(record.musicGain, GAIN_MIN, GAIN_MAX, DEFAULT_SETTINGS.musicGain),
    sfxGain: clampNumber(record.sfxGain, GAIN_MIN, GAIN_MAX, DEFAULT_SETTINGS.sfxGain),
    uiGain: clampNumber(record.uiGain, GAIN_MIN, GAIN_MAX, DEFAULT_SETTINGS.uiGain),
    muted: record.muted === true,
    latencyOffset: clampLatencyOffset(record.latencyOffset),
  };
}

/** An in-memory fallback, so SSR and Node tests never touch a DOM global. */
function createMemoryStorage(): SettingsStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/**
 * Resolves the default storage.
 *
 * `localStorage` throws on access — not just on write — in a sandboxed iframe
 * and in Safari's private mode with cookies blocked, so the access itself is
 * guarded rather than merely the read.
 */
export function defaultStorage(): SettingsStorage {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // Access denied. Fall through to memory.
  }
  return createMemoryStorage();
}

/** Reads and sanitises. A corrupt or absent entry yields the defaults. */
export function loadSettings(storage: SettingsStorage = defaultStorage()): AudioSettings {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (raw === null) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return sanitiseSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Writes settings.
 *
 * A failed write is swallowed. Storage being full or blocked is a reason for a
 * preference not to persist; it is not a reason for the game to stop.
 */
export function saveSettings(
  settings: AudioSettings,
  storage: SettingsStorage = defaultStorage(),
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitiseSettings(settings)));
  } catch {
    // Ignored by design.
  }
}

/** The buses a gain setting can address. */
export const Bus = {
  Master: "master",
  Music: "music",
  Sfx: "sfx",
  Ui: "ui",
} as const;
export type BusName = (typeof Bus)[keyof typeof Bus];

/** Maps a bus to the settings field that holds its gain. */
export const BUS_SETTING: Readonly<Record<BusName, keyof AudioSettings>> = Object.freeze({
  [Bus.Master]: "masterGain",
  [Bus.Music]: "musicGain",
  [Bus.Sfx]: "sfxGain",
  [Bus.Ui]: "uiGain",
});
