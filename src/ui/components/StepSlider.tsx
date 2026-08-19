"use client";

/**
 * A slider made of discrete plates.
 *
 * Twenty cells rather than a continuous track, for the reason in `Meter.tsx`: a
 * smooth track needs a gradient or a soft thumb, and this art direction has
 * neither available. Twenty flat cells is also a better control — the player can
 * count where they are, and the value is reproducible between sessions.
 *
 * ## It is a real `input[type=range]`
 *
 * Under the plates. Visually hidden but focusable and operable, so arrow keys,
 * Home/End, page-up/down, screen readers, switch access and voice control all
 * work for free and correctly. Reimplementing a slider with divs and keydown
 * handlers is how a11y bugs get shipped; every project that does it misses at
 * least Home/End.
 *
 * The visible cells are `aria-hidden` decoration driven from the input's value.
 * The whole control is one label + one input as far as assistive tech is
 * concerned.
 */

import { useId } from "react";
import { TUNING } from "@/game/config/tuning";

export interface StepSliderProps {
  readonly label: string;
  /** 0..1 unless `min`/`max` say otherwise. */
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  /** Formats the value for display, e.g. `(v) => v.toFixed(2)`. */
  readonly format?: (value: number) => string;
  /** Extra guidance under the control. Rendered, and linked as the description. */
  readonly hint?: string;
  readonly disabled?: boolean;
  /**
   * Fill outward from zero rather than from the left edge.
   *
   * For the audio-offset slider, whose range straddles zero. Filling from the
   * left drew seven lit cells at 0ms, which reads as "some offset is applied" on
   * precisely the control TUNING §16.8 says must not mislead about what it does.
   */
  readonly bipolar?: boolean;
}

export function StepSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  format,
  hint,
  disabled = false,
  bipolar = false,
}: StepSliderProps): React.ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const cells = TUNING.ui.sliderSteps;
  const span = max - min || 1;
  const step = span / cells;

  const toCell = (v: number): number =>
    Math.round(Math.max(0, Math.min(1, (v - min) / span)) * cells);
  const valueCell = toCell(value);
  // Unipolar fills [0, value). Bipolar fills between zero and the value,
  // whichever side that falls on.
  const originCell = bipolar ? toCell(0) : 0;
  const fillFrom = Math.min(originCell, valueCell);
  const fillTo = Math.max(originCell, valueCell);

  return (
    <div className="axis-slider" data-disabled={disabled ? "1" : "0"}>
      <label className="axis-slider-label" htmlFor={id}>
        {label}
      </label>

      <div className="axis-slider-body">
        <div className="axis-slider-cells" aria-hidden="true">
          {Array.from({ length: cells }, (_unused, index) => (
            <span
              key={index}
              className="axis-slider-cell"
              data-origin={bipolar && index === originCell ? "1" : "0"}
              data-filled={index >= fillFrom && index < fillTo ? "1" : "0"}
            />
          ))}
        </div>

        <input
          id={id}
          className="axis-slider-input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
      </div>

      <output className="axis-slider-value" htmlFor={id}>
        {format === undefined ? value.toFixed(2) : format(value)}
      </output>

      {hint !== undefined && (
        <p id={hintId} className="axis-slider-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
