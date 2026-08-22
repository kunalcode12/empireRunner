/**
 * KILN — a foundry. Cast iron, ember light, falling sparks.
 *
 * GAME_BIBLE §10: "Cast iron plate, riveted seams, heavy halftone on the rivets.
 * Ladles, chain hoists, slag chutes, cooling racks. Warm, dense fog, 45u."
 *
 * The first 1,200m of every run, so it is also the theme that teaches the reader
 * what a theme *is*. Its identity in one cropped frame: **warm ember key light
 * raking across a dark plate, with sparks falling through it.** Nothing else in
 * the game has downward-falling ambient particles.
 */

import { TUNING } from "../tuning";
import { KEYLINE, PropArchetype, SurfaceEffect, ThemeId, type Theme } from "./types";

const GUNMETAL = "#2b2b2f";
const EMBER = "#e4572e";
const ASH = "#8c8c90";
const BONE = "#ede6db";

export const KILN: Theme = Object.freeze({
  id: ThemeId.Kiln,
  slug: "kiln",
  name: "Kiln",
  blurb: "Cast iron and slag. The heat comes off the walls.",
  locked: false,

  palette: Object.freeze([KEYLINE, GUNMETAL, EMBER, ASH, BONE]),

  ui: Object.freeze({
    ground: KEYLINE,
    surface: GUNMETAL,
    text: BONE,
    textDim: ASH,
    accent: EMBER,
    // 3.83:1 on gunmetal. Measured, not assumed — see `index.ts`.
    accentOnSurface: false,
    structural: Object.freeze([GUNMETAL]),
  }),

  fog: Object.freeze({
    near: TUNING.fog.kiln.near,
    far: TUNING.fog.kiln.far,
    // Warm rather than neutral: the fog is the heat, so it carries a trace of
    // the ember rather than being the flat ground colour.
    color: "#1a1214",
    unstable: null,
  }),

  surface: Object.freeze({
    // Face 0 is the floor and it is the LIGHT one — P07 found the inverse made
    // the lane the player stands in the hardest surface to read.
    floor: ASH,
    wall: GUNMETAL,
    ink: KEYLINE,
    halftoneScale: 0.42,
    // "Heavy halftone on the rivets" — heavier than Undertow, lighter than Bazaar.
    halftoneStrength: 0.3,
    // Riveted plate seams, one per half-segment.
    seamSpacing: 6,
    seamStrength: 0.45,
    // The heat itself. Ember, so the shimmer says Kiln even in a cropped frame.
    effectColor: EMBER,
    effect: SurfaceEffect.Shimmer,
    // A LINEAR-space mix fraction, which is why it is so much smaller than it
    // looks like it should be. Gunmetal is 0.027 linear and ember is 0.77, so a
    // nominal 5% blend lands at 0.064 — sRGB 0.28 against a 0.17 plate. Visible
    // warmth, iron still reading as iron. At 0.22 the wall was solid ember.
    effectStrength: 0.05,
    // Four hard bands. §11.1: any unavoidable gradient is posterised into 3-4.
    effectSteps: 4,
    effectRate: 0.55,
  }),

  lighting: Object.freeze({
    keyColor: "#ffd2b8",
    keyIntensity: 0.95,
    skyColor: BONE,
    groundColor: EMBER,
    hemiIntensity: 0.5,
    keyAzimuth: -0.6,
  }),

  particles: Object.freeze({
    dust: ASH,
    coin: EMBER,
    shatter: EMBER,
    trail: BONE,
    // Falling sparks. The only downward ambient drift in the game.
    ambient: EMBER,
    ambientRate: 14,
    ambientDrift: -2.4,
  }),

  props: Object.freeze([
    { archetype: PropArchetype.Hanging, color: ASH, weight: 3, size: 2.2, label: "Chain hoist" },
    { archetype: PropArchetype.Hanging, color: GUNMETAL, weight: 2, size: 1.6, label: "Ladle" },
    {
      archetype: PropArchetype.Clutter,
      color: GUNMETAL,
      weight: 3,
      size: 1.4,
      label: "Slag chute",
    },
    { archetype: PropArchetype.Panel, color: ASH, weight: 2, size: 2.0, label: "Cooling rack" },
    { archetype: PropArchetype.Mast, color: KEYLINE, weight: 2, size: 3.4, label: "Flue pipe" },
  ]),

  hazardSkin: "ember-vent",
  stemSet: ThemeId.Kiln,
});
