/**
 * Writing the active theme onto the document.
 *
 * The registry in `config/themes.ts` is the data; this is the only thing that
 * turns it into pixels. One function, called from the render bridge when the sim
 * emits `ThemeChange`, and from the screens when the player is not in a run.
 *
 * ## Why custom properties and not a class per theme
 *
 * Four theme classes means four copies of every rule that mentions a colour, and
 * the fifth theme is then a rewrite. Writing six custom properties on the root
 * recolours the entire tree — HUD, screens, transitions — in one assignment, and
 * a new theme is a row in the registry rather than a stylesheet.
 *
 * ## Why the transition is a delay and not a CSS transition
 *
 * Custom properties do animate in modern browsers, but only if registered with
 * `@property` and a syntax, and interpolating between two theme colours produces
 * exactly what GAME_BIBLE §11.1 forbids: a soft gradient, held for two seconds,
 * across every surface at once. So the swap is **instantaneous and hidden** —
 * the 120m transition tunnel is guaranteed obstacle-free (§10) and its title card
 * covers the frame the swap happens on. A cut hidden behind a card, which is how
 * this is done in print.
 */

import { DEFAULT_THEME, THEMES, themeByOrdinal, type Theme } from "@/game/config/themes";

/** Roles written to `documentElement.style`. Order is documentation, not logic. */
const ROLE_PROPERTIES = [
  "--axis-ground",
  "--axis-surface",
  "--axis-text",
  "--axis-text-dim",
  "--axis-accent",
  "--axis-structural",
] as const;

let active: Theme = DEFAULT_THEME;

/** The theme currently applied. Read by screens that show its name. */
export function activeTheme(): Theme {
  return active;
}

/**
 * Applies a theme to the document root.
 *
 * Safe to call with the theme already active — it short-circuits, because this
 * is reachable from a per-frame event drain and six `setProperty` calls a frame
 * would be six style invalidations a frame.
 */
export function applyTheme(theme: Theme, root?: HTMLElement): void {
  const element = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (element === null) {
    return;
  }
  if (active.id === theme.id && element.dataset["theme"] === theme.slug) {
    return;
  }

  const ui = theme.ui;
  const values = [
    ui.ground,
    ui.surface,
    ui.text,
    // A theme with no second text-safe colour falls back to the primary rather
    // than shipping a label under 4.5:1. See the header of config/themes.ts.
    ui.textDim ?? ui.text,
    ui.accent,
    ui.structural[0] ?? ui.surface,
  ];

  for (let i = 0; i < ROLE_PROPERTIES.length; i += 1) {
    const property = ROLE_PROPERTIES[i];
    const value = values[i];
    if (property !== undefined && value !== undefined) {
      element.style.setProperty(property, value);
    }
  }

  // Components that need to special-case a theme read this rather than a colour.
  // Static's scanlines are the only legitimate case today — §11.3 permits them
  // there and nowhere else.
  element.dataset["theme"] = theme.slug;
  // Some accents fail 4.5:1 on their own theme's plate colour. Components that
  // put accent text on a surface read this and fall back to `--axis-text`.
  element.dataset["accentOnSurface"] = ui.accentOnSurface ? "1" : "0";

  active = theme;
}

/** Applies by run-theme ordinal. This is the `ThemeChange` payload contract. */
export function applyThemeOrdinal(ordinal: number, root?: HTMLElement): void {
  applyTheme(themeByOrdinal(ordinal), root);
}

/** Resets to the boot theme. Called when a run ends and the menu returns. */
export function resetTheme(root?: HTMLElement): void {
  applyTheme(DEFAULT_THEME, root);
}

/**
 * Toggles the HUD's Overdrive inversion.
 *
 * A root attribute rather than a class on the HUD, because §4.3 inverts the
 * *palette* and every token has to flip together — including inside screens that
 * can legitimately be open during Overdrive, such as pause.
 */
export function setOverdrive(active_: boolean, root?: HTMLElement): void {
  const element = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (element === null) {
    return;
  }
  if (active_) {
    element.dataset["overdrive"] = "1";
  } else {
    delete element.dataset["overdrive"];
  }
}

/** Every theme, for the settings screen's preview strip. */
export function allThemes(): readonly Theme[] {
  return THEMES;
}
