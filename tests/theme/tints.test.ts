/**
 * The live tint set.
 *
 * Two things are worth testing here and they are both easy to get wrong:
 *
 *   1. **The colour objects are mutated, never replaced.** `ENTITY_TINT.obstacle`
 *      is handed straight to a `MeshLambertMaterial`, so the material and the
 *      module share one object. Reassigning it instead of mutating it would
 *      break the link silently and leave the scene on the first theme's colours
 *      forever — with no error and no visible symptom until a transition.
 *   2. **Particle tints are sRGB, not linear.** The particle material is a raw
 *      `ShaderMaterial` writing the attribute straight out, so a `THREE.Color`
 *      conversion would render every particle about half as bright as its
 *      palette swatch.
 */

import { describe, expect, it } from "vitest";
import { THEMES, type Theme } from "@/game/config/themes";
import { blendTints, ENTITY_TINT, PARTICLE_TINT, resetTints } from "@/game/render/theme/tints";

const KILN = THEMES[0] as Theme;
const UNDERTOW = THEMES[1] as Theme;

/** `#rrggbb` to 0..1 sRGB components, the same parse the module uses. */
function srgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

describe("theme tints", () => {
  it("keeps particle tints in sRGB, matching the palette swatch exactly", () => {
    resetTints(KILN);
    const [r, g, b] = srgb(KILN.particles.dust);
    expect(PARTICLE_TINT.dust.r).toBeCloseTo(r, 6);
    expect(PARTICLE_TINT.dust.g).toBeCloseTo(g, 6);
    expect(PARTICLE_TINT.dust.b).toBeCloseTo(b, 6);
  });

  it("falls back to dust for a theme with no ambient emitter", () => {
    // Static has no ambient tint by design — its motion is in the surface. The
    // emitter must still have a colour rather than reading undefined.
    const staticTheme = THEMES.find((theme) => theme.particles.ambient === null);
    expect(staticTheme, "no theme without an ambient emitter").toBeTruthy();
    if (staticTheme === undefined) {
      return;
    }
    resetTints(staticTheme);
    const [r] = srgb(staticTheme.particles.dust);
    expect(PARTICLE_TINT.ambient.r).toBeCloseTo(r, 6);
  });

  it("MUTATES the entity colours rather than replacing them", () => {
    // The whole reason materials pick up a theme change for free.
    resetTints(KILN);
    const obstacle = ENTITY_TINT.obstacle;
    const pickup = ENTITY_TINT.pickup;

    resetTints(UNDERTOW);
    expect(ENTITY_TINT.obstacle, "obstacle colour was replaced").toBe(obstacle);
    expect(ENTITY_TINT.pickup, "pickup colour was replaced").toBe(pickup);
  });

  it("derives the obstacle colour from the theme accent", () => {
    for (const theme of THEMES) {
      resetTints(theme);
      // `getHexString` returns sRGB, which is what the palette is written in.
      expect(`#${ENTITY_TINT.obstacle.getHexString()}`).toBe(theme.ui.accent);
      expect(`#${ENTITY_TINT.pickup.getHexString()}`).toBe(theme.ui.text);
    }
  });

  it("blends monotonically between two themes", () => {
    const samples: number[] = [];
    for (let i = 0; i <= 10; i += 1) {
      blendTints(KILN, UNDERTOW, i / 10);
      samples.push(PARTICLE_TINT.coin.g);
    }
    const first = samples[0] ?? 0;
    const last = samples[samples.length - 1] ?? 0;
    expect(first).toBeCloseTo(srgb(KILN.particles.coin)[1], 6);
    expect(last).toBeCloseTo(srgb(UNDERTOW.particles.coin)[1], 6);
    const rising = last > first;
    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1] ?? 0;
      const current = samples[i] ?? 0;
      expect(rising ? current >= previous - 1e-9 : current <= previous + 1e-9).toBe(true);
    }
  });

  it("clamps out-of-range blend factors", () => {
    blendTints(KILN, UNDERTOW, -5);
    expect(PARTICLE_TINT.coin.g).toBeCloseTo(srgb(KILN.particles.coin)[1], 6);
    blendTints(KILN, UNDERTOW, 5);
    expect(PARTICLE_TINT.coin.g).toBeCloseTo(srgb(UNDERTOW.particles.coin)[1], 6);
  });

  it("keeps the runner and the speed lines on the pickup colour", () => {
    // The player and the things they want are the same colour; the things that
    // hurt them are the accent. That is a two-value language, and it is the only
    // one a player reads at 34 u/s.
    resetTints(UNDERTOW);
    expect(ENTITY_TINT.player.getHex()).toBe(ENTITY_TINT.pickup.getHex());
    expect(ENTITY_TINT.speedLine.getHex()).toBe(ENTITY_TINT.pickup.getHex());
    expect(ENTITY_TINT.player.getHex()).not.toBe(ENTITY_TINT.obstacle.getHex());
  });
});
