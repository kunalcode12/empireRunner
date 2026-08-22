/**
 * What a theme IS. No values live in this file — only the contract.
 *
 * ## The test for this file is the fifth theme
 *
 * The brief's rule: "Adding a fifth theme must require zero code changes — if it
 * requires a code change, the abstraction is wrong." That is only true if every
 * consumer reads a *field* rather than branching on an id, so the shape below has
 * to carry everything the render, audio and UI layers need to build a place:
 * palette, fog, tunnel surface, props, hazard skins, lights, particles, stems,
 * and UI token overrides.
 *
 * `tests/theme/extensibility.test.ts` builds a synthetic fifth theme and pushes
 * it through every consumer. Anything that switches on a theme id fails it.
 *
 * ## Everything here is data a designer could change without a build
 *
 * There are no functions on a theme, no classes, and no imports of anything that
 * can execute. A theme is a frozen object of numbers, strings and enums. That is
 * what makes the registry loadable, diffable and — at P12 — serialisable.
 */

/** Theme ids, in the order the run visits them. GAME_BIBLE §10.1. */
export const ThemeId = {
  Kiln: 0,
  Undertow: 1,
  Bazaar: 2,
  Static: 3,
} as const;
export type ThemeIdValue = (typeof ThemeId)[keyof typeof ThemeId];

/** The key-line black. Shared by every palette and by the 3D background. */
export const KEYLINE = "#0b0b0c";

// ─────────────────────────────────────────────────────────────────────────────
// UI roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One theme's UI roles.
 *
 * `textDim` is nullable on purpose: a theme whose palette has no second
 * text-safe colour says so, rather than shipping one that fails AA. See the
 * contrast note in `index.ts`.
 */
export interface ThemeUiRoles {
  /** Page ground. Always the key-line — see `index.ts`. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Fog
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeFog {
  readonly near: number;
  /**
   * u — where the fog reaches full density.
   *
   * Must exceed `minReactionTime * maxSpeed` = 18.7u or the player cannot see an
   * obstacle in time to answer it. Asserted in `tests/sim/tuning-invariants.test.ts`
   * for every theme, Static's `unstableMin` included.
   */
  readonly far: number;
  /** Fog colour. Usually the ground, but a theme may push it toward its accent. */
  readonly color: string;
  /**
   * Static's fog oscillates. `null` for every stable theme.
   *
   * Both bounds must clear the reaction-time floor — an unstable fog that dips
   * below it is a theme that periodically hides the game.
   */
  readonly unstable: {
    readonly min: number;
    readonly max: number;
    /** Hz — how fast it breathes. */
    readonly rate: number;
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunnel surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stepped surface effect a theme's tunnel material runs.
 *
 * Every one of these is computed **in the material**, in hard steps, never as a
 * post-processing pass and never as a smooth ramp:
 *
 *   - GAME_BIBLE §11.1 requires any unavoidable gradient to be "posterised into
 *     3-4 hard steps", and §10 says Undertow's caustics specifically must be
 *     "flat stepped bands, not gradients".
 *   - ARCHITECTURE §4 licenses `@react-three/postprocessing` for bloom (Overdrive
 *     only), vignette and transient chromatic aberration. A full-screen
 *     distortion pass is outside that permission.
 *
 * In-material is also cheaper: no extra render target, no resolve, and it costs
 * nothing on a face the camera cannot see.
 */
export const SurfaceEffect = {
  /** No animated surface term. */
  None: "none",
  /** Kiln — heat rising off the plate, quantised into bands. */
  Shimmer: "shimmer",
  /** Undertow — caustic bands travelling along the tunnel. */
  Caustics: "caustics",
  /** Bazaar — slow dust drift across the tile. */
  Drift: "drift",
  /** Static — scanline roll plus signal ghosting. */
  Scan: "scan",
} as const;
export type SurfaceEffectName = (typeof SurfaceEffect)[keyof typeof SurfaceEffect];

/** How a theme's tunnel surface is drawn. */
export interface ThemeSurface {
  /** Fill colour of the face underfoot. The most legible surface — P07. */
  readonly floor: string;
  /** Fill colour of the three wall faces. */
  readonly wall: string;
  /** Ink the halftone dots and seam lines are struck in. */
  readonly ink: string;
  /** Halftone dot pitch in world units. Bazaar is the heaviest — §10. */
  readonly halftoneScale: number;
  /** 0..1 — how strongly the halftone reads over the fill. */
  readonly halftoneStrength: number;
  /**
   * u — spacing of the seam lines running across the tunnel.
   *
   * Kiln's riveted plate, Undertow's grout, Bazaar's tile grid and Static's
   * scanlines are all the same primitive at different pitches. One mechanism,
   * four surfaces — which is the difference between a theme system and four
   * bespoke shaders.
   */
  readonly seamSpacing: number;
  /** 0..1 — how strongly the seams read. */
  readonly seamStrength: number;
  /**
   * The colour the animated term adds.
   *
   * Effects only ever brighten — §11.3 forbids anything darker than the
   * palette's darkest colour, and several wall colours already sit close to it.
   * So each theme names the light its surface catches: Kiln's ember heat,
   * Undertow's caustic green, Static's phosphor. Adding white instead would wash
   * every theme toward the same non-colour at exactly the moment the effect is
   * meant to be saying which place this is.
   */
  readonly effectColor: string;
  /** The animated term, and how far it moves the value. */
  readonly effect: SurfaceEffectName;
  /** 0..1 — effect amplitude. Zero is indistinguishable from `None`. */
  readonly effectStrength: number;
  /** How many hard steps the effect is quantised into. Never a smooth ramp. */
  readonly effectSteps: number;
  /** Hz — effect speed. */
  readonly effectRate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decorative geometry archetypes.
 *
 * These are ids, not meshes: the registry says *what* a theme is furnished with
 * and the render layer decides how to build it. That separation is what lets a
 * fifth theme reuse `Hanging` without touching any code.
 *
 * Every archetype is deliberately silhouetted so it **cannot** be mistaken for
 * something the player can hit. GAME_BIBLE has no rule for this because it is
 * obvious once stated and expensive once violated: a prop that reads as an
 * obstacle costs runs. Props hang, sag, lean and clutter; obstacles are upright,
 * solid, and squarely in a lane.
 */
export const PropArchetype = {
  /** Suspended from the ceiling on a line — hoists, signage, rugs, cables. */
  Hanging: "hanging",
  /** Squat clutter against the wall base — chutes, benches, crates, spools. */
  Clutter: "clutter",
  /** Tall thin verticals set BEHIND the wall plane — conduit, aerials, posts. */
  Mast: "mast",
  /** Flat panels fixed to the wall — cooling racks, tile panels, test cards. */
  Panel: "panel",
} as const;
export type PropArchetypeName = (typeof PropArchetype)[keyof typeof PropArchetype];

/** One entry in a theme's prop set. */
export interface ThemeProp {
  readonly archetype: PropArchetypeName;
  /** Fill colour. Must never be the theme's obstacle accent — asserted. */
  readonly color: string;
  /** Relative spawn weight within this theme's set. */
  readonly weight: number;
  /** u — nominal size. The archetype interprets it. */
  readonly size: number;
  /** Human-readable name, straight from GAME_BIBLE §10's prop set column. */
  readonly label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lights and particles
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeLighting {
  /** Key light colour. */
  readonly keyColor: string;
  readonly keyIntensity: number;
  /** Hemisphere sky colour. */
  readonly skyColor: string;
  /** Hemisphere ground colour. */
  readonly groundColor: string;
  readonly hemiIntensity: number;
  /** rad — key light azimuth. Rotating it changes where the shadow falls. */
  readonly keyAzimuth: number;
}

/**
 * Particle tints, by emitter.
 *
 * The ambient emitter is what gives each theme its signature motion — Kiln's
 * falling sparks, Undertow's floating debris, Bazaar's dust motes. Static has
 * none: its motion is in the surface, not the air.
 */
export interface ThemeParticles {
  readonly dust: string;
  readonly coin: string;
  readonly shatter: string;
  readonly trail: string;
  /** The ambient emitter's tint, or `null` for a theme with no ambient motion. */
  readonly ambient: string | null;
  /** particles/second of ambient emission. Zero when `ambient` is null. */
  readonly ambientRate: number;
  /** u/s — vertical drift. Negative falls (sparks), positive rises (debris). */
  readonly ambientDrift: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The theme
// ─────────────────────────────────────────────────────────────────────────────

export interface Theme {
  readonly id: number;
  /** Stable slug. The `data-theme` attribute, the asset filename, the save key. */
  readonly slug: string;
  /** Display name, as shown on the transition title card. */
  readonly name: string;
  /** One line of flavour for the theme card. Body copy, not a tagline. */
  readonly blurb: string;
  /**
   * True when the theme has to be earned. GAME_BIBLE §10: Static is awarded for
   * reaching 5,000m in a single run; a player without it cycles back to Kiln.
   */
  readonly locked: boolean;

  /** The complete colour list. §11.1 caps this at 4-6 including the key-line. */
  readonly palette: readonly string[];
  readonly ui: ThemeUiRoles;
  readonly fog: ThemeFog;
  readonly surface: ThemeSurface;
  readonly lighting: ThemeLighting;
  readonly particles: ThemeParticles;
  readonly props: readonly ThemeProp[];

  /**
   * The hazard this theme skins, from GAME_BIBLE §7.2.
   *
   * The hazards themselves do not exist yet — P07 shipped 12 obstacles and 7
   * pickups and deferred all four. The mapping is carried here anyway so the
   * theme data is complete and the phase that builds them has somewhere to look.
   */
  readonly hazardSkin: string;

  /**
   * Index into the audio layer's stem table.
   *
   * Deliberately a number rather than a name: `audio/recipes.ts` keys its stem
   * sets by theme ordinal, and a second naming scheme here would be one more
   * thing to keep in sync.
   */
  readonly stemSet: number;
}
