/**
 * Reduced motion — the accessibility gate every effect reads.
 *
 * ## What it disables, and what it must never disable
 *
 * The rule is: **remove motion that carries no information, keep every cue the
 * player needs to play.** A reduced-motion mode that makes the game unplayable
 * is not an accessibility feature, it is a second, worse game.
 *
 * ```
 *   DISABLED                          KEPT
 *   screen shake (trauma offset)      the hit-stop freeze
 *   chromatic aberration pulses       obstacle and pickup positions
 *   speed lines                       the FOV speed ramp, at reduced range
 *   camera roll lean / overshoot      the roll itself, and the world rotating
 *   landing squash and stretch        the landing, and its particle puff
 *   particle velocity jitter          particles, at reduced count
 * ```
 *
 * The distinctions worth defending:
 *
 *   - **Hit-stop stays.** It is a pause, not motion. It is also the clearest
 *     non-auditory signal that you were hit, which matters more, not less, to a
 *     player who has turned other feedback off.
 *   - **The roll stays.** The world rotating 90 degrees IS the game — GAME_BIBLE
 *     §3.2. What goes is the camera's decorative lean and overshoot on top of
 *     it, which is the part that adds vestibular conflict without adding
 *     information. GAME_BIBLE §13 Q1 flags this exact risk.
 *   - **FOV ramp is reduced, not removed.** It is the main speed cue at this art
 *     direction, and removing it entirely leaves the player unable to judge
 *     approach speed. Halving the range keeps the signal and drops most of the
 *     pumping, which is the nausea vector.
 *
 * ## Two sources, OR'd
 *
 * The OS preference (`prefers-reduced-motion`) and an explicit in-game setting.
 * The OS one is honoured immediately at boot without the player having to find
 * a menu; the in-game one exists because plenty of people want it for this game
 * specifically and have not set it system-wide.
 */

import { TUNING } from "@/game/config/tuning";

/** How much of the FOV speed ramp survives reduced motion. */
const REDUCED_FOV_FRACTION = 0.4;
/** How much of the particle budget survives. */
const REDUCED_PARTICLE_FRACTION = 0.5;

export interface MotionSettings {
  /** True when motion should be reduced. */
  readonly reduced: boolean;
  /** Multiplier on screen-shake amplitude. Zero when reduced. */
  readonly shakeScale: number;
  /** Multiplier on chromatic-aberration pulses. Zero when reduced. */
  readonly aberrationScale: number;
  /** Multiplier on speed-line opacity. Zero when reduced. */
  readonly speedLineScale: number;
  /** Multiplier on the camera's decorative roll lean. Zero when reduced. */
  readonly rollLeanScale: number;
  /** Multiplier on squash-and-stretch. Zero when reduced. */
  readonly squashScale: number;
  /** Multiplier on the FOV speed ramp. Reduced, never zero. */
  readonly fovScale: number;
  /** Multiplier on the particle budget. Reduced, never zero. */
  readonly particleScale: number;
}

const FULL: MotionSettings = Object.freeze({
  reduced: false,
  shakeScale: 1,
  aberrationScale: 1,
  speedLineScale: 1,
  rollLeanScale: 1,
  squashScale: 1,
  fovScale: 1,
  particleScale: 1,
});

const REDUCED: MotionSettings = Object.freeze({
  reduced: true,
  shakeScale: 0,
  aberrationScale: 0,
  speedLineScale: 0,
  rollLeanScale: 0,
  squashScale: 0,
  fovScale: REDUCED_FOV_FRACTION,
  particleScale: REDUCED_PARTICLE_FRACTION,
});

/** Reads the OS preference. Safe to call server-side. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Reads a `?motion=reduced|full` override, for testing. */
export function parseMotionOverride(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const value = raw.toLowerCase();
  if (value === "reduced" || value === "reduce") {
    return true;
  }
  if (value === "full" || value === "normal") {
    return false;
  }
  return null;
}

/** Builds settings from the two inputs. Pure, so it is testable without a DOM. */
export function resolveMotion(
  osPrefersReduced: boolean,
  userSetting: boolean | null,
): MotionSettings {
  // An explicit choice wins in both directions: a player who has set the OS
  // preference for everything else may still want full motion here, and must be
  // able to say so.
  if (userSetting !== null) {
    return userSetting ? REDUCED : FULL;
  }
  return osPrefersReduced ? REDUCED : FULL;
}

let cached: MotionSettings | null = null;

/**
 * The active settings.
 *
 * Cached, but re-resolvable: unlike the quality tier, this CAN change mid-run
 * without cost — nothing here is allocated or sized from it — so a settings
 * toggle at P14 just calls `setMotion`.
 */
export function getMotion(): MotionSettings {
  if (cached === null) {
    const override =
      typeof window === "undefined"
        ? null
        : parseMotionOverride(new URLSearchParams(window.location.search).get("motion"));
    cached = resolveMotion(prefersReducedMotion(), override);
  }
  return cached;
}

/** Forces a value. The settings screen and tests. */
export function setMotion(reduced: boolean): MotionSettings {
  cached = reduced ? REDUCED : FULL;
  return cached;
}

/** Clears the cache so the next read re-detects. Tests only. */
export function resetMotion(): void {
  cached = null;
}

/** The FOV boost actually applied, after the reduced-motion scale. */
export function effectiveFovBoost(): number {
  return TUNING.camera.cameraSpeedFovBoost * getMotion().fovScale;
}
