/**
 * A mechanical rolling counter.
 *
 * GAME_BIBLE §11.2, and it is unusually specific: "Numbers roll like a mechanical
 * counter — digits translate vertically, the way a fuel pump or an odometer
 * moves. They never fade, never scale-pop, never count up with an easing tween."
 *
 * So each digit position is a column holding 0-9 stacked vertically inside a
 * clipping window one digit tall, and changing a digit translates the column. The
 * transition is on `transform` only. There is no `opacity` anywhere in this file,
 * and there must never be one — a digit that cross-fades is a web widget.
 *
 * ## Why this is a class and not a component
 *
 * It is written to at up to 15Hz from the frame loop. A React component would
 * reconcile a seven-element subtree every push, for a change that is one
 * `style.transform` string. `tests/e2e/ui.spec.ts` asserts zero React commits
 * during a run, and this file is most of the reason that is achievable.
 *
 * ## Fixed width, always
 *
 * Every column is rendered even when its digit is a leading zero; the zero is
 * hidden with `visibility`, which reserves the space and is instant. The
 * alternative — adding and removing columns — reflows the line every time the
 * score crosses a power of ten, and the whole HUD twitches. `visibility` rather
 * than `opacity` for the same no-fading reason.
 */

import { TUNING } from "@/game/config/tuning";
import { EASE, MOTION } from "../motion";
import { DIGITS, GROUP_SIZE, columnsFor, stripOffsetPercent } from "./odometer-math";

/**
 * Digit column height as a multiple of the font size.
 *
 * Raised from 1.05 after the first screenshot pass: at 1.05 the clipping window
 * was shorter than Martian Mono's glyph box and the tops of the digits were
 * sliced off at 72px. The window has to clear the full em box, not the cap
 * height, because the strip is positioned by whole multiples of this value.
 */
const LINE_HEIGHT = 1.3;

export interface OdometerOptions {
  /** Digit capacity. Defaults to `TUNING.ui.odometerMaxDigits`. */
  readonly maxDigits?: number;
  /** Insert thousands separators. */
  readonly grouped?: boolean;
  /** Extra class on the root, for sizing. */
  readonly className?: string;
  /** Suffix rendered after the digits, e.g. "m". Not part of the roll. */
  readonly suffix?: string;
}

export interface Odometer {
  /** The element to insert into the DOM. */
  readonly element: HTMLElement;
  /** Sets the displayed value. Non-finite input is ignored, never rendered. */
  set(value: number): void;
  /** Sets without animating. Run start, and the death screen's initial state. */
  jump(value: number): void;
  /** Removes listeners and clears references. */
  dispose(): void;
}

/**
 * Builds one digit column: a strip of 0-9 inside a clipping window.
 *
 * The strip is `10 * LINE_HEIGHT` tall and translated by `-digit / 10` of its own
 * height, expressed as a percentage so it stays correct at any font size — which
 * matters because the same component renders at 72px on the death screen and
 * 16px in the title bar.
 */
function createColumn(): HTMLElement {
  const column = document.createElement("span");
  column.className = "axis-odo-col";
  column.setAttribute("aria-hidden", "true");

  const strip = document.createElement("span");
  strip.className = "axis-odo-strip";
  for (let d = 0; d < DIGITS; d += 1) {
    const cell = document.createElement("span");
    cell.className = "axis-odo-cell";
    cell.textContent = String(d);
    strip.appendChild(cell);
  }
  column.appendChild(strip);
  return column;
}

export function createOdometer(options: OdometerOptions = {}): Odometer {
  const maxDigits = options.maxDigits ?? TUNING.ui.odometerMaxDigits;
  const grouped = options.grouped ?? true;

  const element = document.createElement("span");
  element.className = `axis-odo${options.className === undefined ? "" : ` ${options.className}`}`;
  element.style.setProperty("--axis-odo-line", String(LINE_HEIGHT));

  // Built most-significant first so the DOM order matches the reading order,
  // which is what a screen reader would follow if it ever reached these — it
  // does not, because the whole strip is aria-hidden and the accessible value
  // is published on the root as `aria-label` by the caller.
  const columns: HTMLElement[] = [];
  const separators: HTMLElement[] = [];
  for (let i = 0; i < maxDigits; i += 1) {
    const place = maxDigits - i; // 7,6,5...1
    const column = createColumn();
    element.appendChild(column);
    columns.push(column);
    if (grouped && place > 1 && (place - 1) % GROUP_SIZE === 0) {
      const separator = document.createElement("span");
      separator.className = "axis-odo-sep";
      separator.textContent = ",";
      separator.setAttribute("aria-hidden", "true");
      element.appendChild(separator);
      separators.push(separator);
    } else {
      separators.push(document.createElement("span"));
    }
  }

  if (options.suffix !== undefined) {
    const suffix = document.createElement("span");
    suffix.className = "axis-odo-suffix";
    suffix.textContent = options.suffix;
    suffix.setAttribute("aria-hidden", "true");
    element.appendChild(suffix);
  }

  // Only ever compared against, never rendered from — the DOM holds the truth.
  let current = -1;

  function render(value: number, animate: boolean): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const clamped = Math.max(0, Math.floor(value));
    if (clamped === current) {
      return;
    }
    current = clamped;

    // All of the arithmetic lives in `odometer-math.ts`, which is testable
    // without a DOM. This function only applies the result.
    const states = columnsFor(clamped, maxDigits, grouped);

    for (let i = 0; i < maxDigits; i += 1) {
      const column = columns[i];
      const state = states[i];
      if (column === undefined || state === undefined) {
        continue;
      }

      const strip = column.firstElementChild as HTMLElement | null;
      if (strip !== null) {
        strip.style.transition = animate
          ? `transform ${MOTION.odometerRoll}ms ${EASE.out}`
          : "none";
        strip.style.transform = `translateY(${stripOffsetPercent(state.digit)}%)`;
      }
      // Leading zeros are removed from the flow, not merely made invisible.
      //
      // They used to keep their width, on the theory that a fixed box cannot
      // reflow. At 375px that reserved seven columns of empty space to the left
      // of a two-digit score and pushed it straight into the Bits readout — the
      // fix for a twitch had become a collision.
      //
      // Collapsing costs a small re-centre each time the score crosses a power
      // of ten, which happens a handful of times a run and moves the number by
      // half a digit. `display`, not `opacity`: nothing in an odometer fades.
      column.style.display = state.significant ? "inline-block" : "none";

      const separator = separators[i];
      if (separator !== undefined && separator.className === "axis-odo-sep") {
        separator.style.display = state.separator ? "inline-block" : "none";
      }
    }
  }

  return {
    element,
    set(value: number): void {
      render(value, true);
    },
    jump(value: number): void {
      render(value, false);
    },
    dispose(): void {
      element.remove();
      columns.length = 0;
      separators.length = 0;
    },
  };
}
