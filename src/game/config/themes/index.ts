/**
 * The theme registry.
 *
 * Four themes today, and the number is data. **Adding a fifth requires editing
 * this file and nothing else** — write a `Theme` object, add it to `THEMES`, and
 * the render, audio and UI layers pick it up because every one of them reads a
 * field rather than branching on an id. `tests/theme/extensibility.test.ts`
 * proves that by pushing a synthetic fifth theme through every consumer.
 *
 * ## The ground is the key-line in every theme, and that is deliberate
 *
 * GAME_BIBLE §11.3 bans "backgrounds darker than the darkest colour in the active
 * theme's palette". `#0B0B0C` **is** that colour in all four, so it sits exactly
 * at the limit rather than below it. It is also the 3D scene background, and
 * matching them is what lets the title menu read as being inside the tunnel
 * rather than over a screenshot of it. Theme identity comes from the surface /
 * text / accent triad, which differs completely between the four.
 *
 * ## These are art-direction palettes, not UI palettes
 *
 * Recomputing every text pair from the hex values found six that fail WCAG AA:
 *
 * ```
 *   Kiln     ember  #E4572E on gunmetal #2B2B2F   3.83 : 1
 *   Kiln     ash    #8C8C90 on gunmetal #2B2B2F   4.21 : 1
 *   Bazaar   ochre  #D89216 on indigo   #2B3A67   4.19 : 1
 *   Bazaar   terra  #A8452B on keyline  #0B0B0C   3.32 : 1
 *   Undertow silt   #5C6B63 on keyline  #0B0B0C   3.50 : 1
 *   Static   bleed  #9B2247 on grey     #3A3A3A   1.45 : 1
 * ```
 *
 * Nobody spots 4.19 by eye. So each theme declares which entries are text-safe
 * against which ground, and the rest are `structural` — legal on fills, rules and
 * ink, never behind a glyph. Two themes cannot fill a second text role at all and
 * say `null` rather than shipping a failing label.
 * `tests/ui/contrast.test.ts` recomputes the claim.
 */

import { BAZAAR } from "./bazaar";
import { KILN } from "./kiln";
import { STATIC } from "./static";
import { UNDERTOW } from "./undertow";
import { KEYLINE, type Theme } from "./types";

export {
  KEYLINE,
  PropArchetype,
  SurfaceEffect,
  ThemeId,
  type PropArchetypeName,
  type SurfaceEffectName,
  type Theme,
  type ThemeFog,
  type ThemeIdValue,
  type ThemeLighting,
  type ThemeParticles,
  type ThemeProp,
  type ThemeSurface,
  type ThemeUiRoles,
} from "./types";

export { BAZAAR, KILN, STATIC, UNDERTOW };

/**
 * Every theme, in run order.
 *
 * The ONLY list. Nothing else in the codebase may hardcode a theme count, and
 * `THEMES.length` is what the transition, the preloader and the cycle arithmetic
 * all read.
 */
export const THEMES: readonly Theme[] = Object.freeze([KILN, UNDERTOW, BAZAAR, STATIC]);

/** The theme a run opens in, and the one the title screen shows. */
export const DEFAULT_THEME = KILN;

/**
 * Resolves a theme ordinal, wrapping past the last one.
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

/**
 * The theme a player actually reaches at `ordinal`, given what they have unlocked.
 *
 * §10.1: "Static if unlocked; otherwise cycle to Kiln." A locked theme is skipped
 * rather than substituted at random, so the cycle stays predictable — a player
 * without Static sees Kiln → Undertow → Bazaar → Kiln, which is a rotation they
 * can learn, not a gap.
 */
export function playableThemeByOrdinal(ordinal: number, unlocked: readonly string[]): Theme {
  const playable = THEMES.filter((theme) => !theme.locked || unlocked.includes(theme.slug));
  if (playable.length === 0) {
    return DEFAULT_THEME;
  }
  if (!Number.isFinite(ordinal) || ordinal < 0) {
    return playable[0] ?? DEFAULT_THEME;
  }
  return playable[Math.floor(ordinal) % playable.length] ?? DEFAULT_THEME;
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

/**
 * The theme after this one — what the preloader warms.
 *
 * The brief's rule is "preload one theme ahead, always", and this is the whole of
 * the arithmetic behind it. It wraps, so the last theme preloads the first.
 */
export function nextThemeOrdinal(ordinal: number): number {
  if (!Number.isFinite(ordinal) || ordinal < 0) {
    return 1 % THEMES.length;
  }
  return (Math.floor(ordinal) + 1) % THEMES.length;
}

/** Every slug, for the asset pipeline and the preloader. */
export const THEME_SLUGS: readonly string[] = Object.freeze(THEMES.map((theme) => theme.slug));

/** The key-line, re-exported so consumers need not reach into `types`. */
export const THEME_GROUND = KEYLINE;

/** Ordinal of the first locked theme, or -1. Diagnostic. */
export const FIRST_LOCKED_ORDINAL = THEMES.findIndex((theme) => theme.locked);
