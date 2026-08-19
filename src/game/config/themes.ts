/**
 * The theme registry — four palettes, straight from docs/GAME_BIBLE.md §10.
 *
 * **Created at P14, ahead of P10.** The UI recolours with the in-run theme, and
 * that needs one authoritative palette table rather than four copies scattered
 * through screens. P10 owns the 3D half — materials, props, fog rendering, the
 * halftone shader — and extends this file rather than replacing it. Everything
 * here is data with no behaviour, which is what `config/` is for.
 *
 * ## Why each theme carries a UI role map as well as a palette
 *
 * These are **art-direction palettes, not UI palettes**, and the difference is
 * measurable. Nine of the twenty colours below cannot legally carry text against
 * the ground they would naturally sit on:
 *
 * ```
 *   Kiln    ember  #E4572E on gunmetal #2B2B2F   3.83 : 1   fails
 *   Kiln    ash    #8C8C90 on gunmetal #2B2B2F   4.21 : 1   fails
 *   Bazaar  ochre  #D89216 on indigo   #2B3A67   4.19 : 1   fails
 *   Bazaar  terra  #A8452B on keyline  #0B0B0C   3.32 : 1   fails
 *   Undertow silt  #5C6B63 on keyline  #0B0B0C   3.50 : 1   fails
 *   Static  bleed  #9B2247 on grey     #3A3A3A   1.45 : 1   fails
 * ```
 *
 * A restricted palette is supposed to constrain the UI. This is what that costs,
 * priced rather than discovered by a player who cannot read a price tag. So each
 * theme names which entries are text-safe **against which ground**, and the
 * remainder are `structural` — legal on plate fills, rules, meter segments and
 * halftone ink, and never behind a glyph. `tests/ui/contrast.test.ts` recomputes
 * every pair from these hex values and fails on anything under 4.5:1.
 *
 * Two themes cannot fill the `textDim` role at all and declare `null`, which the
 * token layer resolves to `text`. A missing role is better than a 4.19:1 label.
 *
 * ## The ground is the key-line, in every theme
 *
 * Not a design shortcut — GAME_BIBLE §11.3 bans "backgrounds darker than the
 * darkest colour in the active theme's palette", and `#0B0B0C` **is** that
 * colour in all four, so it sits exactly at the limit rather than below it. It is
 * also the 3D scene background (see `render/palette.ts`), and matching them is
 * what lets the title menu read as being inside the tunnel instead of over it.
 * Theme identity comes from the surface / text / accent triad, which differs
 * completely between the four.
 */

/** Theme ids, matching the order of `TUNING.level.themeMilestones`. */
export const ThemeId = {
  Kiln: 0,
  Undertow: 1,
  Bazaar: 2,
  Static: 3,
} as const;
export type ThemeIdValue = (typeof ThemeId)[keyof typeof ThemeId];

/** The key-line black. Shared by all four palettes and by the 3D background. */
export const KEYLINE = "#0b0b0c";

/**
 * One theme's UI roles.
 *
 * `textDim` is nullable on purpose: a theme whose palette has no second
 * text-safe colour says so, rather than shipping a failing one.
 */
export interface ThemeUiRoles {
  /** Page ground. Always the key-line — see the header. */
  readonly ground: string;
  /** Raised plate fill. Panels, cards, list rows. */
  readonly surface: string;
  /** Primary text. Must clear 4.5:1 on BOTH ground and surface. */
  readonly text: string;
  /** Secondary text, on ground only. `null` when the palette has none. */
  readonly textDim: string | null;
  /** Accent. Text-safe on ground; check `accentOnSurface` before using it there. */
  readonly accent: string;
  /** True when `accent` also clears 4.5:1 on `surface`. */
  readonly accentOnSurface: boolean;
  /** Legal as fill, rule, meter segment or halftone ink. NEVER behind a glyph. */
  readonly structural: readonly string[];
}

export interface ThemeFog {
  readonly near: number;
  readonly far: number;
  /** Static's fog is unstable; the others hold `far` constant. */
  readonly unstable: boolean;
}

export interface Theme {
  readonly id: ThemeIdValue;
  /** Stable slug. Used as the `data-theme` attribute and in save files. */
  readonly slug: string;
  /** Display name, as shown on the transition title card. */
  readonly name: string;
  /** The complete colour list. GAME_BIBLE §10 caps this at 4-6 including keyline. */
  readonly palette: readonly string[];
  readonly ui: ThemeUiRoles;
  readonly fog: ThemeFog;
  /** One line of flavour for the theme card. Body copy, not a tagline. */
  readonly blurb: string;
}

const KILN: Theme = {
  id: ThemeId.Kiln,
  slug: "kiln",
  name: "Kiln",
  palette: [KEYLINE, "#2b2b2f", "#e4572e", "#8c8c90", "#ede6db"],
  ui: {
    ground: KEYLINE,
    surface: "#2b2b2f",
    text: "#ede6db",
    textDim: "#8c8c90",
    accent: "#e4572e",
    accentOnSurface: false,
    structural: ["#2b2b2f"],
  },
  fog: { near: 8, far: 45, unstable: false },
  blurb: "Cast iron and slag. The heat comes off the walls.",
};

const UNDERTOW: Theme = {
  id: ThemeId.Undertow,
  slug: "undertow",
  name: "Undertow",
  palette: [KEYLINE, "#0e3b43", "#3fb8a0", "#5c6b63", "#dcd8c7"],
  ui: {
    ground: KEYLINE,
    surface: "#0e3b43",
    text: "#dcd8c7",
    // Silt #5C6B63 is 3.50:1 on the key-line. Structural only.
    textDim: null,
    accent: "#3fb8a0",
    accentOnSurface: true,
    structural: ["#5c6b63"],
  },
  fog: { near: 5, far: 30, unstable: false },
  blurb: "Flooded transit. The tile is still on the walls.",
};

const BAZAAR: Theme = {
  id: ThemeId.Bazaar,
  slug: "bazaar",
  name: "Bazaar",
  palette: [KEYLINE, "#2b3a67", "#d89216", "#a8452b", "#e8dcc0"],
  ui: {
    ground: KEYLINE,
    surface: "#2b3a67",
    text: "#e8dcc0",
    // Terracotta #A8452B is 3.32:1 on the key-line. Structural only.
    textDim: null,
    accent: "#d89216",
    // 4.19:1 on indigo. Ochre is a ground colour here, not a plate colour.
    accentOnSurface: false,
    structural: ["#a8452b"],
  },
  fog: { near: 12, far: 70, unstable: false },
  blurb: "Sun-bleached tile and awnings. The longest sightlines in the run.",
};

const STATIC: Theme = {
  id: ThemeId.Static,
  slug: "static",
  name: "Static",
  palette: [KEYLINE, "#3a3a3a", "#f0a202", "#9b2247", "#f2f2f0"],
  ui: {
    ground: KEYLINE,
    surface: "#3a3a3a",
    text: "#f2f2f0",
    textDim: "#f0a202",
    accent: "#f0a202",
    accentOnSurface: true,
    // Bleed magenta is 1.45:1 on broadcast grey. Fill only — which is also how
    // it stays clear of the GAME_BIBLE §11.3 ban: it is never an accent, and
    // #9B2247 is a deep crimson nowhere near #FF00FF.
    structural: ["#9b2247"],
  },
  fog: { near: 4, far: 90, unstable: true },
  blurb: "Dead broadcast. The tunnel forgets to render itself.",
};

/** All four, indexed by `ThemeId`. */
export const THEMES: readonly Theme[] = Object.freeze([KILN, UNDERTOW, BAZAAR, STATIC]);

/** The theme a run opens in. */
export const DEFAULT_THEME = KILN;

/**
 * Resolves a theme id, wrapping past the last one.
 *
 * GAME_BIBLE §10.1: after Static the run cycles back to Kiln, so an ordinal from
 * a long run is not bounded by `THEMES.length`. A negative or non-finite input
 * resolves to the default rather than throwing — this is called from the render
 * loop on a `ThemeChange` event, and a bad payload must not take the frame down.
 */
export function themeByOrdinal(ordinal: number): Theme {
  if (!Number.isFinite(ordinal) || ordinal < 0) {
    return DEFAULT_THEME;
  }
  const index = Math.floor(ordinal) % THEMES.length;
  return THEMES[index] ?? DEFAULT_THEME;
}

/** Looks a theme up by slug. Used when restoring a saved preference. */
export function themeBySlug(slug: string): Theme | null {
  for (const theme of THEMES) {
    if (theme.slug === slug) {
      return theme;
    }
  }
  return null;
}
