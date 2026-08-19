/**
 * The halftone grain.
 *
 * GAME_BIBLE §11.1: "A screen-space dot pattern over the fill... It should read as
 * a print artifact, not a post filter — it does **not** swim when the camera
 * moves."
 *
 * For the DOM half that means the dot grid is anchored to the **viewport**, not
 * to any element, so a screen sliding in during a transition slides *under* a
 * stationary grain. A pattern that travels with its panel is a texture on a
 * moving object; a pattern that stays put is ink on the page the object is
 * printed on. That distinction is most of the effect.
 *
 * ## It is legal, and that took some care
 *
 * The dots are a `radial-gradient` — but with **hard stops** (`X 0 45%,
 * transparent 46%`), which produces a circle with an aliased edge, not a ramp.
 * §11.1 bans soft gradients, and a hard-stop gradient is a fill primitive that
 * happens to share a keyword with one. There is no smooth colour ramp anywhere in
 * the output.
 *
 * `pointer-events: none` and `aria-hidden`: it is texture, and it must never
 * intercept a tap or be described to anyone.
 */

export function Halftone(): React.ReactElement {
  return <div className="axis-halftone" aria-hidden="true" />;
}
