/**
 * The odometer's digit arithmetic, as pure functions.
 *
 * Split out of `Odometer.ts` for the same reason as `ring-geometry.ts`: this is
 * where the behaviour worth testing lives, and testing it directly beats
 * inspecting a rendered `<span>` through a DOM shim the repository does not have.
 *
 * The rendering itself — the translate, the `visibility`, the fact that nothing
 * ever fades — is verified in `tests/e2e/ui.spec.ts` against a real browser.
 */

export const DIGITS = 10;
export const GROUP_SIZE = 3;

/** What one column shows. */
export interface ColumnState {
  /** 0-9 — which digit the strip is translated to. */
  readonly digit: number;
  /** False for a leading zero, which is removed from the flow entirely. */
  readonly significant: boolean;
  /** Whether a thousands separator follows this column. */
  readonly separator: boolean;
}

/**
 * Resolves a value into per-column state, most significant first.
 *
 * ## Overflow pins to all-nines rather than truncating
 *
 * A value past the digit capacity has to do something, and showing the low seven
 * digits would render 10,000,000 as "0,000,000" — a smaller number than the one
 * before it, which is worse than an obviously-capped readout. No run reaches
 * seven digits, but "no run reaches it" is exactly the condition under which
 * nobody notices the wrong branch.
 */
export function columnsFor(value: number, maxDigits: number, grouped: boolean): ColumnState[] {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const text = String(clamped);
  const length = text.length;
  const overflow = length > maxDigits;

  const columns: ColumnState[] = [];
  for (let i = 0; i < maxDigits; i += 1) {
    const place = maxDigits - i;
    const significant = overflow || place <= length;
    const digit = overflow ? DIGITS - 1 : significant ? Number(text.charAt(length - place)) : 0;
    // A separator sits after this column when the remaining places are a
    // multiple of three, and only where there are digits on both sides of it.
    const separator = grouped && place > 1 && (place - 1) % GROUP_SIZE === 0;
    columns.push({
      digit,
      significant,
      separator: separator && significant && place - 1 <= length,
    });
  }
  return columns;
}

/**
 * The strip's `translateY`, as a percentage of its own height.
 *
 * Negative, because the strip moves up to bring a higher digit into the window.
 * Expressed as a percentage so it stays correct at any font size — the same
 * component renders at 72px on the death screen and 16px in the title bar.
 */
export function stripOffsetPercent(digit: number): number {
  return -(digit * 100) / DIGITS;
}

/** Renders the visible text, for asserting what a reader would see. */
export function renderedText(columns: readonly ColumnState[]): string {
  let out = "";
  for (const column of columns) {
    if (!column.significant) {
      continue;
    }
    out += String(column.digit);
    if (column.separator) {
      out += ",";
    }
  }
  return out;
}
