import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  DEFAULT_SETTINGS,
  clampLatencyOffset,
  loadSettings,
  sanitiseSettings,
  saveSettings,
} from "@/game/audio/settings";
import { createFakeStorage } from "../helpers/fake-audio";

describe("audio settings", () => {
  it("round-trips through storage", () => {
    const storage = createFakeStorage();
    saveSettings({ ...DEFAULT_SETTINGS, musicGain: 0.25, muted: true }, storage);

    const loaded = loadSettings(storage);
    expect(loaded.musicGain).toBe(0.25);
    expect(loaded.muted).toBe(true);
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings(createFakeStorage())).toEqual({ ...DEFAULT_SETTINGS });
  });

  it("survives a corrupt entry rather than throwing", () => {
    const storage = createFakeStorage({ "axis.audio.v1": "{not json" });
    expect(loadSettings(storage)).toEqual({ ...DEFAULT_SETTINGS });
  });

  /**
   * The one that actually matters. A NaN reaching a GainNode poisons it
   * permanently — the node outputs silence forever with no error and no
   * recovery path in the spec.
   */
  it("never lets a non-finite gain out of storage", () => {
    const storage = createFakeStorage({
      "axis.audio.v1": JSON.stringify({ masterGain: null, musicGain: "loud", sfxGain: 1e400 }),
    });
    const loaded = loadSettings(storage);

    expect(Number.isFinite(loaded.masterGain)).toBe(true);
    expect(Number.isFinite(loaded.musicGain)).toBe(true);
    expect(Number.isFinite(loaded.sfxGain)).toBe(true);
    expect(loaded.masterGain).toBe(DEFAULT_SETTINGS.masterGain);
  });

  it("clamps gains into 0..1", () => {
    const wild = sanitiseSettings({ masterGain: 12, musicGain: -3 });
    expect(wild.masterGain).toBe(1);
    expect(wild.musicGain).toBe(0);
  });

  it("clamps the latency offset to the tuned range", () => {
    expect(clampLatencyOffset(999)).toBe(TUNING.audio.latencyOffsetMax);
    expect(clampLatencyOffset(-999)).toBe(TUNING.audio.latencyOffsetMin);
    expect(clampLatencyOffset(Number.NaN)).toBe(0);
    expect(clampLatencyOffset(0.05)).toBe(0.05);
  });

  it("treats a non-boolean mute as not muted", () => {
    expect(sanitiseSettings({ muted: "yes" }).muted).toBe(false);
    expect(sanitiseSettings({ muted: true }).muted).toBe(true);
  });

  it("swallows a storage that throws on write", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveSettings({ ...DEFAULT_SETTINGS }, hostile)).not.toThrow();
  });
});
