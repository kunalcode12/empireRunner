/**
 * The icon set — six shapes, drawn here, no library.
 *
 * ## Why not an icon package
 *
 * Two reasons and both are binding. It would be a new dependency, which CLAUDE.md
 * requires approval for and which nothing here needs. And every mainstream icon
 * set is hairline-stroked at 1.5-2px on a 24px grid — a *line-art* vocabulary,
 * which is the opposite of GAME_BIBLE §11.1's "thick flat colour fields, heavy
 * black key-lines". A Lucide chevron next to a 3px Anton heading looks like two
 * different products.
 *
 * These are flat fills with a key-line, on a 24-unit grid, and there are six
 * because six is all the interface needs. A seventh is a design decision.
 *
 * `currentColor` throughout, so a glyph inherits whichever role token its context
 * already resolved — including the Overdrive inversion, for free.
 */

const SIZE = 24;

export type GlyphName = "bit" | "shard" | "flow" | "pause" | "lock" | "chevron";

/**
 * Paths on a 0-24 viewBox.
 *
 * Bit is an octagon rather than a circle: a circle at 16px with a 2px key-line
 * is 60% key-line, and the flats keep it reading as a struck coin. Shard is the
 * same silhouette broken, which is the whole story of the currency.
 */
const PATHS: Readonly<Record<GlyphName, string>> = Object.freeze({
  bit: "M8 2h8l6 6v8l-6 6H8l-6-6V8z",
  shard: "M12 1l7 8-4 14-3-9-6 4z",
  flow: "M3 21V3h18v18z M8 8h8v8H8z",
  pause: "M5 3h5v18H5z M14 3h5v18h-5z",
  lock: "M6 11V8a6 6 0 0 1 12 0v3h2v11H4V11z M9 11V8a3 3 0 0 1 6 0v3z",
  chevron: "M9 3l9 9-9 9-3-3 6-6-6-6z",
});

export interface GlyphProps {
  readonly name: GlyphName;
  /** Rendered size in px. Defaults to 1em so it tracks the text beside it. */
  readonly size?: number | string;
  /**
   * An accessible name.
   *
   * Omit it — the default — for a glyph that sits beside a text label, which is
   * every glyph in this UI except the pause chip. A duplicated name is noise a
   * screen-reader user has to listen to on every row.
   */
  readonly label?: string;
  readonly className?: string;
}

export function Glyph({ name, size = "1em", label, className }: GlyphProps): React.ReactElement {
  const decorative = label === undefined;
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={size}
      height={size}
      className={`axis-glyph${className === undefined ? "" : ` ${className}`}`}
      fill="currentColor"
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name]} fillRule="evenodd" />
    </svg>
  );
}

/**
 * The same shapes as a raw SVG string, for the imperative HUD.
 *
 * `hud/` builds its DOM by hand so the frame loop never touches React, and it
 * still needs the Bit glyph. Sharing the path data here rather than restating it
 * is the difference between one icon set and two that drift.
 */
export function glyphMarkup(name: GlyphName): string {
  return (
    `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="axis-glyph" fill="currentColor" ` +
    `aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="${PATHS[name]}"/></svg>`
  );
}
