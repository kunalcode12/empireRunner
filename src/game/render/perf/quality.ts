/**
 * Quality tiers — read once at boot, forceable by URL for testing.
 *
 * Every quality-sensitive feature in the render layer reads from here rather
 * than sniffing the device itself. One detection site means one place to fix
 * when the heuristics turn out to be wrong on somebody's phone, and one place to
 * override when they need to reproduce a report.
 *
 * ## The heuristics are guesses, and are treated as such
 *
 * There is no reliable way to ask a browser how fast its GPU is.
 * `WEBGL_debug_renderer_info` is spoofed or redacted in most modern browsers,
 * `deviceMemory` is Chromium-only and quantised, and `hardwareConcurrency` says
 * nothing about the GPU at all. So this combines several weak signals and
 * deliberately errs toward MEDIUM: guessing HIGH on a weak phone produces a
 * 20fps first impression, while guessing LOW on a strong desktop produces a
 * slightly duller image nobody complains about.
 *
 * A real fix — measuring actual frame times for a second and downgrading — is a
 * P15 hardening job. The hooks for it are `QUALITY_TIERS` and `resolveQuality`.
 */

import { TUNING } from "@/game/config/tuning";

export const Quality = {
  Low: "LOW",
  Medium: "MEDIUM",
  High: "HIGH",
} as const;
export type QualityTier = (typeof Quality)[keyof typeof Quality];

/** Everything the renderer varies by tier. */
export interface QualitySettings {
  readonly tier: QualityTier;
  /** px — directional shadow map edge. 0 means shadows are off entirely. */
  readonly shadowMapSize: number;
  /** Whether the renderer enables shadow rendering at all. */
  readonly shadows: boolean;
  /** Upper bound on device pixel ratio. */
  readonly pixelRatioCap: number;
  /** Draw-call budget this tier is held to. */
  readonly drawCallBudget: number;
  /** Live tunnel segments. Fewer on low tier means less geometry submitted. */
  readonly tunnelSegments: number;
  /** Whether the dev perf HUD may mount. */
  readonly allowPerfHud: boolean;
}

const LOW_SEGMENT_DIVISOR = 2;

export const QUALITY_TIERS: Readonly<Record<QualityTier, QualitySettings>> = Object.freeze({
  [Quality.Low]: Object.freeze({
    tier: Quality.Low,
    shadowMapSize: TUNING.render.shadowMapLow,
    shadows: false,
    pixelRatioCap: 1,
    drawCallBudget: TUNING.budgets.drawCallsMobile,
    tunnelSegments: Math.ceil(TUNING.render.tunnelSegmentCount / LOW_SEGMENT_DIVISOR),
    allowPerfHud: false,
  }),
  [Quality.Medium]: Object.freeze({
    tier: Quality.Medium,
    shadowMapSize: TUNING.render.shadowMapMedium,
    shadows: true,
    pixelRatioCap: TUNING.camera.pixelRatioCap,
    drawCallBudget: TUNING.budgets.drawCallsMobile,
    tunnelSegments: TUNING.render.tunnelSegmentCount,
    allowPerfHud: true,
  }),
  [Quality.High]: Object.freeze({
    tier: Quality.High,
    shadowMapSize: TUNING.render.shadowMapHigh,
    shadows: true,
    pixelRatioCap: TUNING.camera.pixelRatioCap,
    drawCallBudget: TUNING.budgets.drawCallsDesktop,
    tunnelSegments: TUNING.render.tunnelSegmentCount,
    allowPerfHud: true,
  }),
});

/** What `detectQuality` looked at. Exported so tests can drive it directly. */
export interface DeviceProfile {
  /** GB, quantised, Chromium only. 0 when unavailable. */
  deviceMemory: number;
  /** Logical cores. 0 when unavailable. */
  cores: number;
  /** True when the primary pointer is coarse — a touchscreen, usually a phone. */
  coarsePointer: boolean;
  /** Explicit override from `?quality=`, or null. */
  override: QualityTier | null;
}

const LOW_MEMORY_GB = 4;
const LOW_CORE_COUNT = 4;
const HIGH_MEMORY_GB = 8;
const HIGH_CORE_COUNT = 8;

/** Parses a `?quality=` value. Unknown values are ignored rather than throwing. */
export function parseQualityOverride(raw: string | null | undefined): QualityTier | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const upper = raw.toUpperCase();
  if (upper === Quality.Low || upper === Quality.Medium || upper === Quality.High) {
    return upper;
  }
  return null;
}

/**
 * Picks a tier from a device profile. Pure, so it is testable without a browser.
 *
 * An explicit override always wins — that is the whole point of it. Otherwise:
 * a coarse pointer or genuinely weak hardware drops to LOW, comfortably strong
 * hardware with a fine pointer gets HIGH, and everything ambiguous gets MEDIUM.
 */
export function resolveQuality(profile: DeviceProfile): QualityTier {
  if (profile.override !== null) {
    return profile.override;
  }

  const weakMemory = profile.deviceMemory > 0 && profile.deviceMemory <= LOW_MEMORY_GB;
  const weakCpu = profile.cores > 0 && profile.cores <= LOW_CORE_COUNT;

  if (profile.coarsePointer || weakMemory || weakCpu) {
    return Quality.Low;
  }

  const strongMemory = profile.deviceMemory >= HIGH_MEMORY_GB;
  const strongCpu = profile.cores >= HIGH_CORE_COUNT;

  // Requires BOTH signals, and `deviceMemory` is absent outside Chromium, so
  // Safari and Firefox land on MEDIUM. That is the intended conservative result.
  if (strongMemory && strongCpu) {
    return Quality.High;
  }

  return Quality.Medium;
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

/** Reads the current environment into a profile. Safe to call server-side. */
export function readDeviceProfile(search?: string): DeviceProfile {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { deviceMemory: 0, cores: 0, coarsePointer: false, override: null };
  }

  const nav = navigator as NavigatorWithMemory;
  const query = search ?? window.location.search;
  const override = parseQualityOverride(new URLSearchParams(query).get("quality"));

  const coarsePointer =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

  return {
    deviceMemory: nav.deviceMemory ?? 0,
    cores: nav.hardwareConcurrency ?? 0,
    coarsePointer,
    override,
  };
}

/**
 * Resolved once per page load.
 *
 * Cached because the tier must not change mid-run: reallocating a shadow map or
 * rebuilding the tunnel ring at frame 4,000 is a guaranteed hitch, and a tier
 * that flickers between two values would do it repeatedly.
 */
let cached: QualitySettings | null = null;

export function getQuality(): QualitySettings {
  if (cached === null) {
    cached = QUALITY_TIERS[resolveQuality(readDeviceProfile())];
  }
  return cached;
}

/** Forces a tier. Tests and the dev panel only. */
export function setQuality(tier: QualityTier): QualitySettings {
  cached = QUALITY_TIERS[tier];
  return cached;
}

/** Clears the cache so the next `getQuality` re-detects. Tests only. */
export function resetQuality(): void {
  cached = null;
}
