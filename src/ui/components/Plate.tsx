/**
 * The one surface primitive. Every panel in this interface is one of these.
 *
 * A plate is a flat fill, a heavy key-line, and a hard offset shadow — GAME_BIBLE
 * §11.1's "deep shadow: a single flat darker colour from the palette, with a hard
 * edge. Not a blur."
 *
 * ## What it deliberately is not
 *
 * The reflex for a panel over a 3D scene is `backdrop-filter: blur()` with a
 * translucent white and a 12px corner radius. That is glassmorphism, it is a soft
 * gradient twice over (the blur and the alpha ramp), and §11.1 forbids both. It
 * is also the single clearest tell of a UI that was styled by defaults rather
 * than designed. Plates are opaque, square-cornered, and cast a shadow with zero
 * blur radius.
 *
 * Every screen composing from this primitive is what keeps the look coherent
 * without a component library.
 */

export type PlateTone = "surface" | "accent" | "ground";

export interface PlateProps {
  readonly children?: React.ReactNode;
  /** Which role token fills it. `accent` flips the text to `--axis-on-accent`. */
  readonly tone?: PlateTone;
  /** Drop the offset shadow — for plates inside a plate, where it reads as mud. */
  readonly flat?: boolean;
  /** Renders as a different element. Lists want `li`, sections want `section`. */
  readonly as?: "div" | "section" | "li" | "article";
  readonly className?: string;
  readonly id?: string;
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
}

export function Plate({
  children,
  tone = "surface",
  flat = false,
  as = "div",
  className,
  id,
  ariaLabel,
  ariaLabelledBy,
}: PlateProps): React.ReactElement {
  const Tag = as;
  return (
    <Tag
      id={id}
      className={`axis-plate${className === undefined ? "" : ` ${className}`}`}
      data-tone={tone}
      data-flat={flat ? "1" : "0"}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {children}
    </Tag>
  );
}
