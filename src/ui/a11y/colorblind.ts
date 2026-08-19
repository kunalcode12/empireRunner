/**
 * Colourblind-safe mode.
 *
 * ## What this setting actually does, and what is unconditional
 *
 * The requirement is that **hazard identification never depends on hue alone**.
 * The honest way to meet that is not a toggle — it is to never build the
 * dependency in the first place, so the redundant channels in this UI are
 * **always on**:
 *
 * ```
 *   tier pips        fill + key-line presence + a corner notch
 *   active tab       fill + 4px height difference
 *   selected avatar  fill + double key-line + corner notch
 *   AXIS ring        fill + corner ticks at 25/50/75 + stroke weight at 100
 *   locked item      fill + a padlock glyph
 *   mission complete fill + a struck-through label
 * ```
 *
 * What the toggle adds is the **halftone pattern** channel on meters and pips,
 * which is off by default only because it costs a little legibility when nobody
 * needs it. Dot density is the second channel one-colour screen printing has used
 * for a century, so this reads as more of the aesthetic rather than an overlay.
 *
 * ## The part this cannot fix, stated plainly
 *
 * In-world hazard identification is the render layer's problem, not the DOM's.
 * The four theme hazards from GAME_BIBLE §7.2 do not exist yet (deferred at P07),
 * and the shipping obstacles are distinguished by silhouette rather than colour
 * already. When the hazards land at P10, they need the same treatment there — a
 * shape or pattern channel, not a second palette — and this setting should drive
 * it. It is recorded in PROGRESS.md rather than quietly claimed as done.
 */

const ATTRIBUTE = "colorblind";

/** Applies the setting to the document root. */
export function setColorblindSafe(enabled: boolean, root?: HTMLElement): void {
  const element = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (element === null) {
    return;
  }
  if (enabled) {
    element.dataset[ATTRIBUTE] = "1";
  } else {
    delete element.dataset[ATTRIBUTE];
  }
}

/** Reads the current state from the DOM, so it survives a store rehydration. */
export function colorblindSafeEnabled(root?: HTMLElement): boolean {
  const element = root ?? (typeof document === "undefined" ? null : document.documentElement);
  return element?.dataset[ATTRIBUTE] === "1";
}
