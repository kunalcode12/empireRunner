/**
 * STATIC — broadcast decay. Scan distortion, signal ghosting, unstable fog.
 *
 * GAME_BIBLE §10: "Decayed CRT scanline plate; the halftone itself glitches. Test
 * cards, dead monitors, cable spools, aerials. Flickering fog, 20-90u, unstable."
 * §10 also: "Static is the unlock, awarded for reaching 5,000m in a single run.
 * It is the only theme with unstable fog, and the only one whose halftone
 * animates."
 *
 * ## The unstable fog has a floor, and it is a gameplay floor
 *
 * The oscillation runs 20u to 90u. The lower bound is not a look — TUNING §13
 * requires `fogFar > minReactionTime * maxSpeed` = **18.7u** in every theme,
 * "Static included (its `unstableMin` is the binding value)". At 20u it clears
 * that by 1.3u, which is the tightest margin in the game and is asserted in
 * `tests/sim/tuning-invariants.test.ts`. A theme is allowed to be unfair; it is
 * not allowed to be unreadable.
 *
 * ## Bleed magenta is structural, and that is how it stays legal
 *
 * §11.3 bans "magenta (#FF00FF and neighbours) as a **primary or accent**".
 * `#9B2247` is a deep crimson nowhere near #FF00FF, and it is never an accent
 * here — it is fill and ghosting ink only. `tests/theme/registry.test.ts` checks
 * the hue distance rather than trusting the argument.
 *
 * Identity in one cropped frame: **grey plate under amber phosphor, scanlines
 * rolling, and the fog visibly breathing.** It is the only theme that moves when
 * the player does not.
 */

import { TUNING } from "../tuning";
import { KEYLINE, PropArchetype, SurfaceEffect, ThemeId, type Theme } from "./types";

const BROADCAST_GREY = "#3a3a3a";
const PHOSPHOR = "#f0a202";
const BLEED = "#9b2247";
const SIGNAL_WHITE = "#f2f2f0";

export const STATIC: Theme = Object.freeze({
  id: ThemeId.Static,
  slug: "static",
  name: "Static",
  blurb: "Dead broadcast. The tunnel forgets to render itself.",
  locked: true,

  palette: Object.freeze([KEYLINE, BROADCAST_GREY, PHOSPHOR, BLEED, SIGNAL_WHITE]),

  ui: Object.freeze({
    ground: KEYLINE,
    surface: BROADCAST_GREY,
    text: SIGNAL_WHITE,
    textDim: PHOSPHOR,
    accent: PHOSPHOR,
    accentOnSurface: true,
    // 1.45:1 on broadcast grey. Fill only, and never behind a glyph.
    structural: Object.freeze([BLEED]),
  }),

  fog: Object.freeze({
    near: TUNING.fog.staticTheme.near,
    far: TUNING.fog.staticTheme.far,
    color: "#101012",
    unstable: Object.freeze({
      min: TUNING.fog.staticTheme.unstableMin,
      max: TUNING.fog.staticTheme.unstableMax,
      // Slow enough to read as instability rather than as a strobe. Above ~0.5Hz
      // it stops being atmosphere and becomes a flicker hazard.
      rate: 0.22,
    }),
  }),

  surface: Object.freeze({
    floor: BROADCAST_GREY,
    wall: KEYLINE,
    ink: SIGNAL_WHITE,
    halftoneScale: 0.36,
    halftoneStrength: 0.26,
    // Scanlines: the tightest pitch of the four, and the reason this reads as a
    // CRT rather than as tile.
    seamSpacing: 0.9,
    seamStrength: 0.5,
    // Phosphor. The scanline IS the amber, which is why it is the accent too.
    effectColor: PHOSPHOR,
    effect: SurfaceEffect.Scan,
    // The strongest surface effect in the game. §11.3 permits scanlines "outside
    // the Static theme" nowhere — here they are the diegetic subject. A
    // linear-space mix fraction (see `kiln.ts`): 0.14 puts the amber roll at
    // sRGB 0.43 over a 0.23 plate, which is a phosphor line rather than a wash.
    effectStrength: 0.14,
    effectSteps: 3,
    effectRate: 1.4,
  }),

  lighting: Object.freeze({
    keyColor: SIGNAL_WHITE,
    keyIntensity: 0.85,
    skyColor: PHOSPHOR,
    groundColor: BLEED,
    hemiIntensity: 0.45,
    keyAzimuth: 0,
  }),

  particles: Object.freeze({
    dust: BROADCAST_GREY,
    coin: PHOSPHOR,
    shatter: SIGNAL_WHITE,
    trail: PHOSPHOR,
    // No ambient emitter, deliberately. Static's motion lives in the surface —
    // adding drifting particles would soften the one theme that should feel
    // like a picture failing rather than a place with air in it.
    ambient: null,
    ambientRate: 0,
    ambientDrift: 0,
  }),

  props: Object.freeze([
    {
      archetype: PropArchetype.Panel,
      color: SIGNAL_WHITE,
      weight: 4,
      size: 1.6,
      label: "Test card",
    },
    {
      archetype: PropArchetype.Panel,
      color: BROADCAST_GREY,
      weight: 3,
      size: 1.4,
      label: "Dead monitor",
    },
    { archetype: PropArchetype.Clutter, color: BLEED, weight: 2, size: 1.1, label: "Cable spool" },
    { archetype: PropArchetype.Mast, color: BROADCAST_GREY, weight: 4, size: 4.0, label: "Aerial" },
    { archetype: PropArchetype.Hanging, color: BLEED, weight: 2, size: 1.5, label: "Torn cable" },
  ]),

  hazardSkin: "dropout",
  stemSet: ThemeId.Static,
});
