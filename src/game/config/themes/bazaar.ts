/**
 * BAZAAR — a sun-bleached market. Patterned tile, hanging fabric, dust motes.
 *
 * GAME_BIBLE §10: "Sun-bleached patterned tile, geometric repeat, heaviest
 * halftone. Awnings, hanging rugs, crates, lanterns, spice sacks. Bright, thin
 * fog, 70u — the longest sightlines."
 *
 * The 70u fog is the design point, not a number: this is the one theme where you
 * can see a long way, and everything else follows from it. The prop set is the
 * densest of the four because clutter is what fills a sightline, and the halftone
 * is the heaviest because a bright surface is where a print artifact actually
 * reads.
 *
 * Identity in one cropped frame: **warm plaster and indigo running away from you
 * into open distance, hung with fabric, full of drifting dust.**
 */

import { TUNING } from "../tuning";
import { KEYLINE, PropArchetype, SurfaceEffect, ThemeId, type Theme } from "./types";

const INDIGO = "#2b3a67";
const OCHRE = "#d89216";
const PLASTER = "#e8dcc0";
const TERRACOTTA = "#a8452b";

export const BAZAAR: Theme = Object.freeze({
  id: ThemeId.Bazaar,
  slug: "bazaar",
  name: "Bazaar",
  blurb: "Sun-bleached tile and awnings. The longest sightlines in the run.",
  locked: false,

  palette: Object.freeze([KEYLINE, INDIGO, OCHRE, TERRACOTTA, PLASTER]),

  ui: Object.freeze({
    ground: KEYLINE,
    surface: INDIGO,
    text: PLASTER,
    // Terracotta is 3.32:1 on the key-line. Structural only.
    textDim: null,
    accent: OCHRE,
    // 4.19:1 on indigo — a near miss nobody spots by eye, which is exactly why
    // it is measured rather than judged.
    accentOnSurface: false,
    structural: Object.freeze([TERRACOTTA]),
  }),

  fog: Object.freeze({
    near: TUNING.fog.bazaar.near,
    far: TUNING.fog.bazaar.far,
    /*
     * The only LIGHT fog in the game, and it has to be.
     *
     * GAME_BIBLE §10 calls this fog "bright, thin, 70u — the longest sightlines",
     * and every other theme's fog is a near-black that distance fades toward.
     * Copying that pattern here — the first draft used #241C1A — put a black
     * rectangle at the vanishing point of the one theme whose entire design point
     * is being able to see a long way. It read as the tunnel ending in a doorway.
     *
     * §11.3 bans a background DARKER than the palette's darkest colour. It says
     * nothing about lighter, because a lighter background is haze and haze is
     * what a sun-bleached exterior actually does.
     */
    color: "#b8a189",
    unstable: null,
  }),

  surface: Object.freeze({
    // Plaster floor: the brightest surface in the game, and the reason this
    // theme feels open rather than enclosed.
    floor: PLASTER,
    wall: INDIGO,
    ink: KEYLINE,
    halftoneScale: 0.55,
    // The heaviest halftone of the four — §10 says so explicitly.
    halftoneStrength: 0.4,
    // A geometric tile repeat rather than a plate seam: wider pitch, softer weight.
    seamSpacing: 3.2,
    seamStrength: 0.38,
    // Sunlit dust. Plaster rather than ochre — the air is bright, not gold.
    effectColor: PLASTER,
    effect: SurfaceEffect.Drift,
    // A linear-space mix fraction — see the note in `kiln.ts`. The weakest of
    // the four: it is haze in the air, and on the plaster floor it is a no-op by
    // construction because the effect colour IS the floor colour.
    effectStrength: 0.06,
    effectSteps: 4,
    effectRate: 0.18,
  }),

  lighting: Object.freeze({
    keyColor: "#ffe6b8",
    keyIntensity: 1.3,
    skyColor: PLASTER,
    groundColor: TERRACOTTA,
    hemiIntensity: 0.7,
    keyAzimuth: -0.95,
  }),

  particles: Object.freeze({
    dust: PLASTER,
    coin: OCHRE,
    shatter: TERRACOTTA,
    trail: OCHRE,
    // Dust motes: slow, almost neutral drift. They hang rather than travel.
    ambient: PLASTER,
    ambientRate: 11,
    ambientDrift: 0.25,
  }),

  /*
   * Ochre is this theme's ACCENT, and the accent is the colour obstacles are
   * drawn in — `render/theme/tints.ts` derives the obstacle tint from exactly
   * that field. So nothing here may be ochre, however much a spice sack wants
   * to be. The awning is bleached canvas and the sack is hessian instead, which
   * is truer to the reference anyway; `tests/theme/registry.test.ts` asserts it
   * rather than trusting anybody to remember.
   */
  props: Object.freeze([
    {
      archetype: PropArchetype.Hanging,
      color: TERRACOTTA,
      weight: 4,
      size: 2.4,
      label: "Hanging rug",
    },
    { archetype: PropArchetype.Hanging, color: PLASTER, weight: 3, size: 1.9, label: "Awning" },
    { archetype: PropArchetype.Hanging, color: TERRACOTTA, weight: 2, size: 1.1, label: "Lantern" },
    { archetype: PropArchetype.Clutter, color: TERRACOTTA, weight: 3, size: 1.3, label: "Crate" },
    { archetype: PropArchetype.Clutter, color: PLASTER, weight: 2, size: 1.0, label: "Spice sack" },
    { archetype: PropArchetype.Panel, color: INDIGO, weight: 2, size: 2.2, label: "Tile panel" },
  ]),

  hazardSkin: "sand-curtain",
  stemSet: ThemeId.Bazaar,
});
