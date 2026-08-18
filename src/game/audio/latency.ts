/**
 * Output latency measurement, and the honest limits of compensating for it.
 *
 * ## What the two numbers mean
 *
 * `baseLatency` is the delay the `AudioContext` itself introduces — the render
 * quantum plus its internal buffering. It is always available and it is a lower
 * bound.
 *
 * `outputLatency` is the browser's estimate of the FULL path: context, OS mixer,
 * device buffer, and — where the platform reports it — the Bluetooth link. It is
 * the number that actually matters and it is the one to prefer. Both are real
 * properties of `AudioContext` in `lib.dom.d.ts`; neither is invented.
 *
 * `outputLatency` reads 0 before the context has rendered its first quantum and
 * on platforms that decline to estimate, so it is treated as "unknown" rather
 * than "zero" when it is not a positive finite number.
 *
 * ## What compensation can and cannot do
 *
 * A cue scheduled at time `T` is *heard* at `T + latency`. To make a sound land
 * on a visual event you must schedule it `latency` seconds EARLIER — and you
 * cannot schedule into the past. So measured latency is not something audio can
 * cancel out on its own: it is published here so the presentation layer can
 * align to it, and the player's manual offset can only ever add delay.
 *
 * That is why `latencyOffsetMin` is negative but the resulting lead clamps at
 * zero. A player on Bluetooth headphones hearing everything 200ms late cannot be
 * fixed by this slider, and pretending otherwise would be a lie in a settings
 * menu. What the slider genuinely fixes is the opposite case: audio arriving
 * *ahead* of a display that is itself buffered.
 */

import { TUNING } from "@/game/config/tuning";
import { clampLatencyOffset } from "./settings";

/** What a probe found. All seconds. */
export interface LatencyProbe {
  /** The context's own reported base latency. Always present, possibly 0. */
  base: number;
  /** The browser's full-path estimate, or 0 when it declines to give one. */
  output: number;
  /** The value to report to the rest of the game: `output` if usable, else `base`. */
  effective: number;
  /** True when `output` was a usable estimate rather than a fallback. */
  estimated: boolean;
}

/** The parts of `AudioContext` a probe reads. Narrow, so tests can fake it. */
export interface LatencySource {
  readonly baseLatency?: number;
  readonly outputLatency?: number;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Reads both latency figures and picks the better one. Pure; never throws. */
export function measureLatency(source: LatencySource | null | undefined): LatencyProbe {
  const base = finiteOrZero(source?.baseLatency);
  const output = finiteOrZero(source?.outputLatency);
  return {
    base,
    output,
    effective: output > 0 ? output : base,
    estimated: output > 0,
  };
}

/**
 * The earliest time a cue may be scheduled.
 *
 * `scheduleAhead` is a floor, not a preference: scheduling at exactly
 * `currentTime` races the render quantum, and the loser is the head of the
 * sound — which for a percussive one-shot is the entire transient, i.e. the
 * whole sound.
 *
 * A negative user offset shortens the lead and stops at that floor, because the
 * past is not schedulable. A positive one delays the cue, which is the direction
 * that genuinely works.
 */
export function cueTime(now: number, userOffset: number): number {
  const offset = clampLatencyOffset(userOffset);
  const lead = TUNING.audio.scheduleAhead + offset;
  return now + (lead > 0 ? lead : 0);
}
