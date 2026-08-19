/**
 * A linear progress bar, for mission progress and level progress.
 *
 * ## Stepped, not continuous
 *
 * `TUNING.ui.sliderSteps` discrete cells rather than a smooth fill. A smooth bar
 * needs either a gradient or an antialiased leading edge, and GAME_BIBLE §11.1
 * bans the first and undermines the second. Twenty flat plates with key-lines
 * between them reads as printed, and it also quantises the value into something
 * countable at a glance — "seventeen of twenty" is a fact, "about 85%" is an
 * impression.
 *
 * ## The colourblind channel
 *
 * Filled cells carry a halftone pattern as well as the accent fill, gated on
 * `--axis-pattern-opacity`, which the colourblind-safe setting turns on. Dot
 * density is the second channel one-colour screen printing has always used, so
 * this is native to the aesthetic rather than bolted onto it.
 */

import { TUNING } from "@/game/config/tuning";

export interface MeterProps {
  /** Current value. */
  readonly value: number;
  /** Target. Values above it clamp; the meter never overfills. */
  readonly max: number;
  /** Announced to assistive tech, e.g. "2,406 of 3,000 metres". */
  readonly label: string;
  /** Cell count. Fewer for a tight row. */
  readonly steps?: number;
  readonly className?: string;
}

export function Meter({ value, max, label, steps, className }: MeterProps): React.ReactElement {
  const cells = steps ?? TUNING.ui.sliderSteps;
  const safeMax = max > 0 ? max : 1;
  const fraction = Math.max(0, Math.min(1, value / safeMax));
  // Floor, not round: a meter that shows a full cell before the value is reached
  // is lying, and this one sits directly above a "you were 594m short" line.
  const filled = Math.floor(fraction * cells);

  return (
    <div
      className={`axis-meter${className === undefined ? "" : ` ${className}`}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.min(value, safeMax)}
      aria-label={label}
    >
      {Array.from({ length: cells }, (_unused, index) => (
        <span
          key={index}
          className="axis-meter-cell"
          data-filled={index < filled ? "1" : "0"}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
