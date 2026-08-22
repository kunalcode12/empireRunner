/**
 * The theme registry as data: every invariant that has to hold for all four
 * themes, checked against the registry itself rather than restated here.
 *
 * Nothing in this file names a theme except where a claim in GAME_BIBLE §10 is
 * specifically about one — Static's unstable fog, Bazaar's heaviest halftone.
 * Everything else iterates `THEMES`, which is what makes these tests still mean
 * something when a fifth theme is added.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  KEYLINE,
  nextThemeOrdinal,
  playableThemeByOrdinal,
  PropArchetype,
  SurfaceEffect,
  themeByOrdinal,
  themeBySlug,
  THEME_SLUGS,
  THEMES,
  type Theme,
} from "@/game/config/themes";
import { TUNING } from "@/game/config/tuning";

const HEX = /^#[0-9a-f]{6}$/;

/** sRGB hex to relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((byte) => {
    const c = byte / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees, for the magenta-ban check. */
function hue(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) {
    return 0;
  }
  let h: number;
  if (max === r) {
    h = ((g - b) / delta) % 6;
  } else if (max === g) {
    h = (b - r) / delta + 2;
  } else {
    h = (r - g) / delta + 4;
  }
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const AA = 4.5;

describe("theme registry", () => {
  it("has four themes in milestone order", () => {
    expect(THEMES).toHaveLength(4);
    THEMES.forEach((theme, index) => {
      expect(theme.id, `${theme.slug} id`).toBe(index);
    });
  });

  it("boots on the first theme", () => {
    expect(DEFAULT_THEME).toBe(THEMES[0]);
    expect(DEFAULT_THEME.locked).toBe(false);
  });

  it("has unique slugs and resolves each one", () => {
    expect(new Set(THEME_SLUGS).size).toBe(THEME_SLUGS.length);
    for (const slug of THEME_SLUGS) {
      expect(themeBySlug(slug)?.slug).toBe(slug);
    }
    expect(themeBySlug("not-a-theme")).toBeNull();
  });

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: palette is 4-6 flat colours including the key-line",
    (_slug, theme: Theme) => {
      // GAME_BIBLE §11.1 caps a theme at 4-6 colours. The cap is the art
      // direction, not a performance limit — a sixth colour is what turns a
      // screen-print into an illustration.
      expect(theme.palette.length).toBeGreaterThanOrEqual(4);
      expect(theme.palette.length).toBeLessThanOrEqual(6);
      expect(theme.palette).toContain(KEYLINE);
      for (const colour of theme.palette) {
        expect(colour, `${theme.slug} palette entry`).toMatch(HEX);
      }
      expect(new Set(theme.palette).size, `${theme.slug} duplicate palette entry`).toBe(
        theme.palette.length,
      );
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: every UI role comes from the palette",
    (_slug, theme: Theme) => {
      const palette = new Set(theme.palette);
      const roles = [theme.ui.ground, theme.ui.surface, theme.ui.text, theme.ui.accent];
      for (const role of roles) {
        expect(palette.has(role), `${theme.slug}: ${role} is not in the palette`).toBe(true);
      }
      if (theme.ui.textDim !== null) {
        expect(palette.has(theme.ui.textDim)).toBe(true);
      }
      for (const structural of theme.ui.structural) {
        expect(palette.has(structural)).toBe(true);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: text clears AA on both ground and surface",
    (_slug, theme: Theme) => {
      // The role `text` is the one colour promised legible everywhere. P14's
      // audit found 75 elements failing because `textDim` was assumed to carry
      // the same promise; it does not, and the registry says so by allowing it
      // to be null.
      expect(contrast(theme.ui.text, theme.ui.ground)).toBeGreaterThanOrEqual(AA);
      expect(contrast(theme.ui.text, theme.ui.surface)).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: textDim is either AA on the ground or declared absent",
    (_slug, theme: Theme) => {
      if (theme.ui.textDim === null) {
        return;
      }
      expect(contrast(theme.ui.textDim, theme.ui.ground)).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: accent is AA on the ground, and accentOnSurface is MEASURED",
    (_slug, theme: Theme) => {
      expect(contrast(theme.ui.accent, theme.ui.ground)).toBeGreaterThanOrEqual(AA);
      // The flag is not a preference. A theme claiming its accent is legible on
      // its own plate has to actually clear 4.5:1 — Kiln's ember is 3.83:1 on
      // gunmetal and Bazaar's ochre is 4.19:1 on indigo, both near misses that
      // nobody catches by eye.
      const measured = contrast(theme.ui.accent, theme.ui.surface) >= AA;
      expect(theme.ui.accentOnSurface, `${theme.slug}: accentOnSurface`).toBe(measured);
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: no prop uses the accent",
    (_slug, theme: Theme) => {
      // The accent is the obstacle colour — `render/theme/tints.ts` derives it
      // from exactly this field. A prop sharing it is a prop that reads as
      // something the player must dodge, which costs runs.
      for (const prop of theme.props) {
        expect(prop.color, `${theme.slug}: prop "${prop.label}" uses the accent`).not.toBe(
          theme.ui.accent,
        );
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: props are well-formed and drawn from the palette",
    (_slug, theme: Theme) => {
      expect(theme.props.length).toBeGreaterThanOrEqual(4);
      const archetypes = new Set(Object.values(PropArchetype));
      const palette = new Set(theme.palette);
      for (const prop of theme.props) {
        expect(archetypes.has(prop.archetype), `unknown archetype ${prop.archetype}`).toBe(true);
        expect(palette.has(prop.color), `${prop.label} colour off-palette`).toBe(true);
        expect(prop.weight).toBeGreaterThan(0);
        expect(prop.size).toBeGreaterThan(0);
        expect(prop.label.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: fog clears the reaction-time floor",
    (_slug, theme: Theme) => {
      // TUNING §13: `fogFar > minReactionTime * maxSpeed`, or the player cannot
      // see an obstacle in time to answer it. Static's `unstableMin` is the
      // binding value in the whole game.
      const floor = TUNING.spawn.minReactionTime * TUNING.speed.maxSpeed;
      expect(theme.fog.far).toBeGreaterThan(floor);
      expect(theme.fog.near).toBeLessThan(theme.fog.far);
      if (theme.fog.unstable !== null) {
        expect(theme.fog.unstable.min).toBeGreaterThan(floor);
        expect(theme.fog.unstable.max).toBeGreaterThan(theme.fog.unstable.min);
        expect(theme.fog.unstable.rate).toBeGreaterThan(0);
        // Above ~0.5Hz an oscillating fog stops being atmosphere and becomes a
        // flicker hazard.
        expect(theme.fog.unstable.rate).toBeLessThanOrEqual(0.5);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: the surface effect is quantised into hard steps",
    (_slug, theme: Theme) => {
      // §11.1: any unavoidable gradient is "posterised into 3-4 hard steps", and
      // §10 says Undertow's caustics specifically must be bands not gradients.
      const effects = new Set(Object.values(SurfaceEffect));
      expect(effects.has(theme.surface.effect)).toBe(true);
      if (theme.surface.effect !== SurfaceEffect.None) {
        expect(theme.surface.effectSteps).toBeGreaterThanOrEqual(3);
        expect(theme.surface.effectSteps).toBeLessThanOrEqual(4);
        expect(theme.surface.effectStrength).toBeGreaterThan(0);
        // A linear-space mix fraction. Above ~0.2 the effect colour swamps the
        // fill and the theme stops reading as its own material — see the note
        // in `kiln.ts` for the arithmetic.
        expect(theme.surface.effectStrength).toBeLessThanOrEqual(0.2);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: surface and particle colours are on-palette",
    (_slug, theme: Theme) => {
      const palette = new Set(theme.palette);
      for (const colour of [
        theme.surface.floor,
        theme.surface.wall,
        theme.surface.ink,
        theme.surface.effectColor,
        theme.particles.dust,
        theme.particles.coin,
        theme.particles.shatter,
        theme.particles.trail,
      ]) {
        expect(palette.has(colour), `${theme.slug}: ${colour} is off-palette`).toBe(true);
      }
      if (theme.particles.ambient !== null) {
        expect(palette.has(theme.particles.ambient)).toBe(true);
        expect(theme.particles.ambientRate).toBeGreaterThan(0);
      } else {
        expect(theme.particles.ambientRate).toBe(0);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: the fog is never darker than the palette's darkest colour",
    (_slug, theme: Theme) => {
      // §11.3 bans "backgrounds darker than the darkest colour in the active
      // theme palette". The fog IS the background — the scene keeps them equal
      // so the tunnel has no visible end.
      const darkest = Math.min(...theme.palette.map(luminance));
      expect(luminance(theme.fog.color), `${theme.slug} fog`).toBeGreaterThanOrEqual(
        darkest - 1e-6,
      );
    },
  );

  it("bans neon magenta as a primary or accent", () => {
    // §11.3 bans "#FF00FF and neighbours" as a primary or accent. Static's bleed
    // `#9B2247` is a deep crimson and is structural only, which is the argument
    // its file makes — this checks the argument rather than trusting it.
    const MAGENTA_HUE = 300;
    const FORBIDDEN_ARC = 20;
    const SATURATED = 0.45;
    for (const theme of THEMES) {
      for (const colour of [theme.ui.accent, theme.ui.text, theme.surface.effectColor]) {
        const distance = Math.abs(((hue(colour) - MAGENTA_HUE + 540) % 360) - 180);
        const value = Number.parseInt(colour.slice(1), 16);
        const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
        const max = Math.max(...channels) / 255;
        const min = Math.min(...channels) / 255;
        const saturation = max === 0 ? 0 : (max - min) / max;
        const isNeonMagenta = 180 - distance < FORBIDDEN_ARC && saturation > SATURATED;
        expect(isNeonMagenta, `${theme.slug}: ${colour} is neon magenta`).toBe(false);
      }
    }
  });

  it("cycles ordinals and honours the unlock", () => {
    // The cycle is modular, so a run that outlasts the last milestone wraps
    // rather than running out of places to be.
    expect(themeByOrdinal(0).slug).toBe("kiln");
    expect(themeByOrdinal(THEMES.length).slug).toBe("kiln");
    expect(nextThemeOrdinal(THEMES.length - 1)).toBe(0);

    // A player without Static gets the first playable theme instead — and the
    // SIM is not consulted, which is what keeps the unlock out of the replay.
    const withoutStatic = ["kiln", "undertow", "bazaar"];
    expect(playableThemeByOrdinal(3, withoutStatic).locked).toBe(false);
    expect(playableThemeByOrdinal(3, THEME_SLUGS).slug).toBe("static");
  });

  it("names Bazaar's halftone as the heaviest, per GAME_BIBLE §10", () => {
    const bazaar = themeBySlug("bazaar");
    expect(bazaar).not.toBeNull();
    const others = THEMES.filter((theme) => theme.slug !== "bazaar");
    for (const theme of others) {
      expect(bazaar?.surface.halftoneStrength).toBeGreaterThan(theme.surface.halftoneStrength);
    }
  });

  it("gives exactly one theme unstable fog, and it is the locked one", () => {
    const unstable = THEMES.filter((theme) => theme.fog.unstable !== null);
    expect(unstable).toHaveLength(1);
    expect(unstable[0]?.locked).toBe(true);
  });

  it("gives every theme a distinct ambient signature", () => {
    // GAME_BIBLE §10: the ambient emitter is the fastest read on which theme you
    // are in. Kiln's sparks fall, Undertow's debris rises, Bazaar's dust hangs,
    // Static has none.
    const drifts = THEMES.map((theme) => Math.sign(theme.particles.ambientDrift));
    expect(new Set(drifts).size).toBeGreaterThanOrEqual(3);
  });

  it("is frozen all the way down", () => {
    for (const theme of THEMES) {
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.ui)).toBe(true);
      expect(Object.isFrozen(theme.fog)).toBe(true);
      expect(Object.isFrozen(theme.surface)).toBe(true);
      expect(Object.isFrozen(theme.props)).toBe(true);
    }
  });
});
