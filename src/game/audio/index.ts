/**
 * The audio layer's public surface.
 *
 * Everything outside `src/game/audio/` imports from here. The internals — the
 * voice pool, the synthesiser, the recipe table — are deliberately not
 * re-exported: they are implementation, and a caller reaching for a voice
 * directly has bypassed the ducking and the latency offset.
 *
 * The render layer needs exactly `createAudioDirector` and the three methods on
 * what it returns. Settings and latency are exported for the P14 settings
 * screen, which needs to read and write them without knowing how the graph is
 * wired.
 */

export { createAudioDirector, type AudioDirector, type AudioEvent } from "./director";
export { createAudioEngine, type AudioEngine, type AudioBuses } from "./engine";
export {
  Bus,
  DEFAULT_SETTINGS,
  clampLatencyOffset,
  loadSettings,
  saveSettings,
  type AudioSettings,
  type BusName,
  type SettingsStorage,
} from "./settings";
export { measureLatency, cueTime, type LatencyProbe } from "./latency";
export { Layer, type LayerName, type MusicSystem } from "./music";
export { Sound, THEME_STEMS, type SoundKey } from "./recipes";
