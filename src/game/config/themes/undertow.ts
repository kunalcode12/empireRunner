/**
 * UNDERTOW — a flooded transit station. Tile, caustics, drowned furniture.
 *
 * GAME_BIBLE §10: "Flooded transit tile, grout key-lines, animated caustic bands
 * as **flat stepped bands, not gradients**. Turnstiles, hanging signage, drowned
 * benches, conduit. Cool, layered fog, 30u — the tightest."
 *
 * The stepped-caustics instruction is in the design document in bold, so it is
 * not a stylistic preference here — a smooth caustic would be the one place the
 * whole art direction visibly breaks. `effectSteps` is 3, and the tunnel material
 * quantises before it multiplies.
 *
 * Identity in one cropped frame: **teal, tight fog, and hard bands of light
 * crawling along the tile.** It is the darkest and most enclosed of the four.
 */

import { TUNING } from "../tuning";
import { KEYLINE, PropArchetype, SurfaceEffect, ThemeId, type Theme } from "./types";

const DEEP_TEAL = "#0e3b43";
const CAUSTIC = "#3fb8a0";
const SILT = "#5c6b63";
const TILE_BONE = "#dcd8c7";

export const UNDERTOW: Theme = Object.freeze({
  id: ThemeId.Undertow,
  slug: "undertow",
  name: "Undertow",
  blurb: "Flooded transit. The tile is still on the walls.",
  locked: false,

  palette: Object.freeze([KEYLINE, DEEP_TEAL, CAUSTIC, SILT, TILE_BONE]),

  ui: Object.freeze({
    ground: KEYLINE,
    surface: DEEP_TEAL,
    text: TILE_BONE,
    // Silt is 3.50:1 on the key-line. Declared absent rather than shipped failing.
    textDim: null,
    accent: CAUSTIC,
    accentOnSurface: true,
    structural: Object.freeze([SILT]),
  }),

  fog: Object.freeze({
    near: TUNING.fog.undertow.near,
    far: TUNING.fog.undertow.far,
    color: "#08181c",
    unstable: null,
  }),

  surface: Object.freeze({
    floor: SILT,
    wall: DEEP_TEAL,
    ink: KEYLINE,
    // Tile is smaller and more regular than plate, so the halftone is finer and
    // the grout does most of the work.
    halftoneScale: 0.3,
    halftoneStrength: 0.22,
    // Grout key-lines — the tightest seam pitch of the four.
    seamSpacing: 2.4,
    seamStrength: 0.55,
    // Caustic green. The light through the water, not the water.
    effectColor: CAUSTIC,
    effect: SurfaceEffect.Caustics,
    // A linear-space mix fraction — see the note in `kiln.ts`. Caustics are the
    // second strongest effect in the game because §10 makes them this theme's
    // subject, but deep teal is darker than gunmetal still, so the number stays
    // small.
    effectStrength: 0.09,
    // THREE hard bands. §10 is explicit that these are bands and not a gradient.
    effectSteps: 3,
    effectRate: 0.34,
  }),

  lighting: Object.freeze({
    keyColor: "#9fe8dc",
    keyIntensity: 0.95,
    skyColor: CAUSTIC,
    groundColor: DEEP_TEAL,
    hemiIntensity: 0.62,
    keyAzimuth: 0.35,
  }),

  particles: Object.freeze({
    dust: SILT,
    coin: CAUSTIC,
    shatter: TILE_BONE,
    trail: CAUSTIC,
    // Debris floats UP. The inverse of Kiln's sparks, and the fastest read on
    // which theme you are in if the palette is somehow ambiguous.
    ambient: TILE_BONE,
    ambientRate: 9,
    ambientDrift: 1.1,
  }),

  props: Object.freeze([
    { archetype: PropArchetype.Hanging, color: TILE_BONE, weight: 3, size: 1.8, label: "Signage" },
    { archetype: PropArchetype.Clutter, color: SILT, weight: 3, size: 1.2, label: "Drowned bench" },
    {
      archetype: PropArchetype.Clutter,
      color: DEEP_TEAL,
      weight: 2,
      size: 1.5,
      label: "Turnstile",
    },
    { archetype: PropArchetype.Mast, color: SILT, weight: 3, size: 3.0, label: "Conduit" },
    { archetype: PropArchetype.Panel, color: TILE_BONE, weight: 2, size: 1.8, label: "Tile panel" },
  ]),

  hazardSkin: "surge",
  stemSet: ThemeId.Undertow,
});
