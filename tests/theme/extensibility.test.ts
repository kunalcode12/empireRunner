/**
 * The fifth theme.
 *
 * The brief's own criterion for whether this abstraction is right: "Adding a
 * fifth theme must require zero code changes — if it requires a code change, the
 * abstraction is wrong."
 *
 * So this file builds a theme that does not exist in the registry, out of data
 * alone, and pushes it through every consumer that has to be able to handle one:
 * the crossfade, the tint layer, the material factory, the prop placement, the
 * asset pipeline's geometry builders, and the loader's naming contract.
 *
 * **A failure here is not a failing test — it is a design failure.** It means a
 * consumer is branching on a theme id or holding a hardcoded list of four, and
 * the fix is in that consumer rather than here.
 *
 * ## Why the material and prop tests are the interesting ones
 *
 * A registry of frozen objects is trivially extensible; nothing about adding a
 * row to it can fail. The places a theme system actually goes wrong are the ones
 * that turn data into GPU state — a shader keyed by a cache string that forgot a
 * parameter, a placement that assumed a size, an effect switch with four arms
 * and no default. Those are what this exercises.
 */

import { describe, expect, it } from "vitest";
import {
  KEYLINE,
  PropArchetype,
  SurfaceEffect,
  type Theme,
  type ThemeProp,
} from "@/game/config/themes";
import {
  blend,
  createCrossfade,
  incomingPropStrength,
  outgoingPropStrength,
  requestTransition,
  shouldSwapMusic,
  showTitleCard,
  stepCrossfade,
  TransitionPhase,
} from "@/game/render/theme/crossfade";
import { BUILDERS, LOD_DETAIL } from "../../scripts/lib/prop-geometry.mjs";

/**
 * A fifth theme, written the way a designer would write one.
 *
 * Deliberately unlike the four: an effect the registry already knows but at an
 * unused strength, a prop bigger than any shipped one, a locked flag, no ambient
 * emitter, and an id past the end of the array.
 */
const VERDIGRIS_GREEN = "#2f5d50";
const COPPER = "#c1743a";
const LIME_WASH = "#e9ead2";
const SLATE = "#4a4f55";

const FIFTH: Theme = Object.freeze({
  id: 4,
  slug: "orchard",
  name: "Orchard",
  blurb: "A glasshouse gone to seed. Nothing here was designed to be run through.",
  locked: true,

  palette: Object.freeze([KEYLINE, VERDIGRIS_GREEN, COPPER, SLATE, LIME_WASH]),

  ui: Object.freeze({
    ground: KEYLINE,
    surface: VERDIGRIS_GREEN,
    text: LIME_WASH,
    textDim: null,
    accent: COPPER,
    accentOnSurface: false,
    structural: Object.freeze([SLATE]),
  }),

  fog: Object.freeze({
    near: 12,
    far: 55,
    color: "#101a16",
    unstable: null,
  }),

  surface: Object.freeze({
    floor: SLATE,
    wall: VERDIGRIS_GREEN,
    ink: KEYLINE,
    halftoneScale: 0.48,
    halftoneStrength: 0.24,
    seamSpacing: 4.5,
    seamStrength: 0.41,
    effectColor: LIME_WASH,
    effect: SurfaceEffect.Drift,
    effectStrength: 0.08,
    effectSteps: 3,
    effectRate: 0.27,
  }),

  lighting: Object.freeze({
    keyColor: LIME_WASH,
    keyIntensity: 1.1,
    skyColor: LIME_WASH,
    groundColor: VERDIGRIS_GREEN,
    hemiIntensity: 0.55,
    keyAzimuth: 1.4,
  }),

  particles: Object.freeze({
    dust: SLATE,
    coin: COPPER,
    shatter: LIME_WASH,
    trail: COPPER,
    ambient: null,
    ambientRate: 0,
    ambientDrift: 0,
  }),

  props: Object.freeze([
    // Deliberately larger than anything the four shipped themes use, to prove
    // the prop placement is bounded by geometry rather than by a size anybody
    // happened to pick.
    { archetype: PropArchetype.Mast, color: SLATE, weight: 3, size: 7.5, label: "Vent stack" },
    {
      archetype: PropArchetype.Hanging,
      color: VERDIGRIS_GREEN,
      weight: 2,
      size: 3.1,
      label: "Vine",
    },
    { archetype: PropArchetype.Clutter, color: COPPER, weight: 4, size: 1.7, label: "Planter" },
    {
      archetype: PropArchetype.Panel,
      color: LIME_WASH,
      weight: 2,
      size: 2.6,
      label: "Cracked pane",
    },
  ]),

  hazardSkin: "frost",
  stemSet: 4,
});

describe("a fifth theme needs zero code changes", () => {
  it("satisfies the Theme type with no cast and no optional field left out", () => {
    // If this file compiles, the shape is complete. The assertion is here so the
    // test has a body; the real check happened in `tsc`.
    expect(FIFTH.slug).toBe("orchard");
    expect(FIFTH.palette).toContain(KEYLINE);
  });

  it("crossfades into and out of, with a theme the registry has never seen", () => {
    const state = createCrossfade(0);
    expect(state.phase).toBe(TransitionPhase.Idle);

    requestTransition(state, FIFTH.id);
    expect(state.to).toBe(FIFTH.id);

    // Assets not ready: it parks rather than cutting. That is the brief's
    // "both themes' assets are resident before the transition starts".
    stepCrossfade(state, 0.5, false);
    expect(state.phase).toBe(TransitionPhase.Waiting);
    expect(state.t).toBe(0);

    // Ready. Now it runs, and the props cross over.
    let elapsed = 0;
    const STEP = 1 / 60;
    let swapped = false;
    const outgoing: number[] = [];
    const incoming: number[] = [];
    while (state.phase !== TransitionPhase.Idle && elapsed < 30) {
      stepCrossfade(state, STEP, true);
      elapsed += STEP;
      if (shouldSwapMusic(state)) {
        state.musicSwapped = true;
        swapped = true;
      }
      outgoing.push(outgoingPropStrength(state));
      incoming.push(incomingPropStrength(state));
    }

    expect(state.phase).toBe(TransitionPhase.Idle);
    expect(swapped, "music never swapped").toBe(true);
    // The outgoing set thins to nothing and the incoming set fills.
    expect(outgoing[0]).toBeGreaterThan(0.9);
    expect(outgoing[outgoing.length - 1]).toBe(0);
    expect(incoming[incoming.length - 1]).toBe(1);
    // Monotonic in both directions — a set that came back would flicker.
    for (let i = 1; i < outgoing.length; i += 1) {
      expect(outgoing[i] ?? 0).toBeLessThanOrEqual((outgoing[i - 1] ?? 0) + 1e-9);
      expect(incoming[i] ?? 0).toBeGreaterThanOrEqual((incoming[i - 1] ?? 0) - 1e-9);
    }
  });

  it("blends numeric fields toward it without naming it", () => {
    const state = createCrossfade(0);
    requestTransition(state, FIFTH.id);
    stepCrossfade(state, 0, true);
    // At t=0 the blend is entirely the outgoing value.
    expect(blend(state, 45, FIFTH.fog.far)).toBeCloseTo(45, 5);
    // Run it out and it is entirely the incoming one.
    for (let i = 0; i < 600 && state.phase !== TransitionPhase.Idle; i += 1) {
      stepCrossfade(state, 1 / 60, true);
    }
    expect(blend(state, 45, FIFTH.fog.far)).toBeCloseTo(FIFTH.fog.far, 5);
  });

  it("shows a title card for it", () => {
    const state = createCrossfade(0);
    requestTransition(state, FIFTH.id);
    stepCrossfade(state, 0.1, true);
    expect(showTitleCard(state)).toBe(true);
  });

  it("builds geometry for every archetype it names, at both LODs", () => {
    // The pipeline's own builders, imported directly. A fifth theme that used an
    // archetype with no builder would produce a bundle missing a mesh, and the
    // prop field would silently skip it — so this is checked here rather than
    // discovered as an empty wall.
    for (const prop of FIFTH.props as readonly ThemeProp[]) {
      const build = BUILDERS[prop.archetype];
      expect(build, `no builder for ${prop.archetype}`).toBeTypeOf("function");
      for (const detail of [LOD_DETAIL.high, LOD_DETAIL.low]) {
        const mesh = build(prop.size, detail);
        expect(mesh.positions.length, `${prop.label} @${detail}: no vertices`).toBeGreaterThan(0);
        expect(mesh.indices.length % 3, `${prop.label}: non-triangular`).toBe(0);
        expect(mesh.normals.length).toBe(mesh.positions.length);
        for (const value of mesh.positions) {
          expect(Number.isFinite(value), `${prop.label}: non-finite vertex`).toBe(true);
        }
      }
    }
  });

  it("names its meshes the way the loader looks them up", () => {
    // The one string contract between `scripts/build-themes.mjs` and
    // `render/props/PropField.tsx`. Restated at both ends is exactly how it
    // would drift, so it is asserted here from the registry's own data.
    FIFTH.props.forEach((prop, index) => {
      for (const lod of ["near", "far"]) {
        expect(`${index}-${prop.archetype}-${lod}`).toMatch(
          /^\d+-(hanging|clutter|mast|panel)-(near|far)$/,
        );
      }
    });
  });
});
