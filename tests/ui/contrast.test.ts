/**
 * Every text role clears WCAG AA against the ground it actually sits on.
 *
 * ## Why this test exists rather than a style-guide note
 *
 * The four palettes in GAME_BIBLE §10 are **art-direction** palettes. They were
 * chosen to look like screen-printed posters, and nothing about that process
 * guarantees a legible text pair. Recomputing every combination from the hex
 * values found six that fail:
 *
 * ```
 *   Kiln     ember  on gunmetal   3.83 : 1
 *   Kiln     ash    on gunmetal   4.21 : 1
 *   Bazaar   ochre  on indigo     4.19 : 1
 *   Bazaar   terra  on keyline    3.32 : 1
 *   Undertow silt   on keyline    3.50 : 1
 *   Static   bleed  on grey       1.45 : 1
 * ```
 *
 * A style-guide note would not have caught any of them, and 4.19 is exactly the
 * kind of near-miss nobody spots by eye. So `config/themes.ts` declares which
 * entries are text-safe on which ground, and this recomputes the claim.
 *
 * The contrast maths is the WCAG 2.x relative-luminance formula, written out
 * rather than pulled from a package — it is nine lines and this repository does
 * not add a dependency for nine lines.
 */

import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { KEYLINE, THEMES, themeByOrdinal, themeBySlug } from "@/game/config/themes";

const MIN = TUNING.budgets.uiContrastMin;

/** sRGB channel to linear. The 0.03928 break and 2.4 exponent are from WCAG 2.x. */
function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("the contrast formula itself", () => {
  // A test whose own instrument is wrong passes everything. These are the two
  // fixed points WCAG defines exactly.
  it("gives 21:1 for black on white and 1:1 for a colour on itself", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#e4572e", "#e4572e")).toBeCloseTo(1, 10);
  });
});

describe("every theme's text roles are legible", () => {
  for (const theme of THEMES) {
    describe(theme.name, () => {
      const { ground, surface, text, textDim, accent, accentOnSurface } = theme.ui;

      it("primary text clears 4.5:1 on BOTH the ground and the surface", () => {
        expect(contrast(text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(MIN);
        expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(MIN);
      });

      it("dim text clears 4.5:1 on the ground, or is declared absent", () => {
        if (textDim === null) {
          // Not a skip — the absence is the assertion. A theme with no second
          // text-safe colour must say so rather than ship a failing one.
          expect(textDim).toBeNull();
          return;
        }
        expect(contrast(textDim, ground), `${textDim} on ${ground}`).toBeGreaterThanOrEqual(MIN);
      });

      it("the accent clears 4.5:1 on the ground", () => {
        expect(contrast(accent, ground), `${accent} on ${ground}`).toBeGreaterThanOrEqual(MIN);
      });

      it("accentOnSurface is the truth, not an aspiration", () => {
        const actual = contrast(accent, surface);
        if (accentOnSurface) {
          expect(actual, `${accent} on ${surface}`).toBeGreaterThanOrEqual(MIN);
        } else {
          // The flag must be false BECAUSE it fails, not out of caution — a
          // false flag on a passing pair would silently downgrade a legal accent.
          expect(actual, `${accent} on ${surface} passes; the flag should be true`).toBeLessThan(
            MIN,
          );
        }
      });

      it("text on an accent plate is legible", () => {
        // Components put `--axis-on-accent` (the key-line) over an accent fill.
        expect(contrast(KEYLINE, accent)).toBeGreaterThanOrEqual(MIN);
      });

      it("structural colours are NOT text-safe, which is why they are structural", () => {
        for (const colour of theme.ui.structural) {
          const asText = contrast(colour, ground);
          const isTextRole = colour === text || colour === textDim || colour === accent;
          if (!isTextRole) {
            expect(asText, `${colour} would pass as text and could be promoted`).toBeLessThan(MIN);
          }
        }
      });
    });
  }
});

describe("the palettes match the design document", () => {
  it("caps every theme at 6 colours including the key-line — §11.1", () => {
    for (const theme of THEMES) {
      expect(theme.palette.length, theme.name).toBeLessThanOrEqual(6);
      expect(theme.palette.length, theme.name).toBeGreaterThanOrEqual(4);
      expect(theme.palette).toContain(KEYLINE);
    }
  });

  it("grounds every theme on the key-line, which is its darkest colour", () => {
    for (const theme of THEMES) {
      expect(theme.ui.ground).toBe(KEYLINE);
      for (const colour of theme.palette) {
        // §11.3: no background darker than the darkest palette colour. The
        // ground IS that colour, so nothing may be darker than the ground.
        expect(luminance(colour), `${colour} in ${theme.name}`).toBeGreaterThanOrEqual(
          luminance(theme.ui.ground) - 1e-12,
        );
      }
    }
  });

  it("uses no neon cyan or magenta as a text or accent role — §11.3", () => {
    // The ban names #00FFFF and #FF00FF "and neighbours". A saturated
    // cyan/magenta has one channel near zero and the other two near full; every
    // legitimate colour here is far from that.
    for (const theme of THEMES) {
      for (const colour of [theme.ui.text, theme.ui.textDim, theme.ui.accent]) {
        if (colour === null) {
          continue;
        }
        const raw = colour.replace("#", "");
        const r = Number.parseInt(raw.slice(0, 2), 16);
        const g = Number.parseInt(raw.slice(2, 4), 16);
        const b = Number.parseInt(raw.slice(4, 6), 16);
        const neonCyan = r < 60 && g > 200 && b > 200;
        const neonMagenta = g < 60 && r > 200 && b > 200;
        expect(neonCyan || neonMagenta, `${colour} in ${theme.name}`).toBe(false);
      }
    }
  });
});

describe("theme lookup", () => {
  it("cycles past the last theme rather than falling off the end", () => {
    // GAME_BIBLE §10.1: after Static the run cycles back to Kiln, so a long run
    // produces ordinals well past THEMES.length.
    expect(themeByOrdinal(0).slug).toBe("kiln");
    expect(themeByOrdinal(THEMES.length).slug).toBe("kiln");
    expect(themeByOrdinal(THEMES.length + 2).slug).toBe("bazaar");
  });

  it("survives a hostile ordinal rather than throwing", () => {
    // Reached from an event-ring payload inside the frame loop. A bad value must
    // not take the frame down.
    expect(themeByOrdinal(Number.NaN).slug).toBe("kiln");
    expect(themeByOrdinal(-5).slug).toBe("kiln");
    expect(themeByOrdinal(Number.POSITIVE_INFINITY).slug).toBe("kiln");
  });

  it("finds themes by slug and returns null for an unknown one", () => {
    expect(themeBySlug("undertow")?.name).toBe("Undertow");
    expect(themeBySlug("nope")).toBeNull();
  });
});
