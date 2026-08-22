/**
 * The screen-print material. Every themed surface in the game is one of these.
 *
 * GAME_BIBLE §11.1 in shader form:
 *
 *   - **Thick flat colour fields.** One base colour, no gradient ramp, no baked
 *     ambient occlusion smudge.
 *   - **Visible halftone grain.** A dot pattern whose size varies with surface
 *     luminance, reading as a print artifact rather than a post filter.
 *   - **No soft gradients anywhere.** Where a value has to vary — the seam bands,
 *     the animated effect — it is `floor()`ed into hard steps first.
 *   - **Deep shadow with a hard edge**, which here means the fog term is also
 *     quantised rather than ramped.
 *
 * ## Why this is one material and not four
 *
 * Kiln's riveted plate, Undertow's grout tile, Bazaar's geometric repeat and
 * Static's scanlines look nothing alike, and they are the same three primitives
 * at different settings: a flat fill, a seam grid, and a stepped animated term.
 * Four bespoke shaders would be four things to keep in step with §11.1 and four
 * places for a fifth theme to need code. One parameterised material is what makes
 * "adding a theme is data" true at the shader level too.
 *
 * ## The halftone does not swim
 *
 * §11.1: "It should read as a print artifact, not a post filter — it **does not**
 * swim when the camera moves." So the dot grid is anchored to **screen space**
 * (`gl_FragCoord`), not to UVs and not to world position. A UV-anchored halftone
 * slides across a surface as the tunnel scrolls, which is exactly the swimming
 * the note forbids; a world-anchored one crawls when the camera rolls. Screen
 * space is the only anchor that stays still, and it is also what a real halftone
 * screen does — the screen is fixed, the paper moves under it.
 *
 * ## Built on MeshLambertMaterial via onBeforeCompile
 *
 * Rather than a raw `ShaderMaterial`. Three's lighting, fog and shadow chunks are
 * genuinely hard to reproduce correctly, and the floor face has to receive the
 * player's contact shadow — the only depth cue the geometry has. Patching the
 * standard chunks keeps all of that and costs one string replace per material.
 */

import * as THREE from "three";
import { SurfaceEffect, type SurfaceEffectName, type ThemeSurface } from "@/game/config/themes";

/** Effect ids as the shader sees them. Kept in step by `EFFECT_INDEX` below. */
const EFFECT_NONE = 0;
const EFFECT_SHIMMER = 1;
const EFFECT_CAUSTICS = 2;
const EFFECT_DRIFT = 3;
const EFFECT_SCAN = 4;

/**
 * Name to shader index.
 *
 * Exhaustive over `SurfaceEffect`, and a `Record` rather than a switch so a new
 * effect is a compile error here instead of a silent fall-through to `none`.
 */
const EFFECT_INDEX: Readonly<Record<SurfaceEffectName, number>> = Object.freeze({
  [SurfaceEffect.None]: EFFECT_NONE,
  [SurfaceEffect.Shimmer]: EFFECT_SHIMMER,
  [SurfaceEffect.Caustics]: EFFECT_CAUSTICS,
  [SurfaceEffect.Drift]: EFFECT_DRIFT,
  [SurfaceEffect.Scan]: EFFECT_SCAN,
});

/** Uniforms the render loop writes every frame. */
export interface ScreenPrintUniforms {
  uTime: { value: number };
  uInk: { value: THREE.Color };
  uGlow: { value: THREE.Color };
  uHalftoneScale: { value: number };
  uHalftoneStrength: { value: number };
  uSeamSpacing: { value: number };
  uSeamStrength: { value: number };
  uEffect: { value: number };
  uEffectStrength: { value: number };
  uEffectSteps: { value: number };
  uEffectRate: { value: number };
  /** World-space scroll, so seams travel with the tunnel rather than sliding. */
  uScroll: { value: number };
}

/**
 * A themed surface material.
 *
 * Either Lambert (lit, receives shadow) or Basic (unlit, flat). The union is
 * deliberate: callers only ever touch `color` and `axisUniforms`, and both of
 * those exist on both classes. See `createScreenPrintMaterial` for why the unlit
 * case is a different class rather than a Lambert with no lights.
 */
export type ScreenPrintMaterial = (THREE.MeshLambertMaterial | THREE.MeshBasicMaterial) & {
  readonly axisUniforms: ScreenPrintUniforms;
};

/**
 * The fragment insert.
 *
 * Runs after `map_fragment` so `diffuseColor` already holds the flat fill, and
 * before lighting so the ink reads as part of the surface rather than as an
 * overlay that ignores the key light.
 *
 * Every varying term in here is `floor()`ed. That is the rule, and it is the
 * whole reason this looks printed rather than rendered.
 */
const FRAGMENT_INSERT = /* glsl */ `
  // ── Halftone, anchored to the SCREEN, never to UV or world space ──────────
  //
  // A rotated 45-degree grid, because an axis-aligned dot screen beats against
  // the seam lines and produces a moire that reads as a rendering fault.
  vec2 hs = gl_FragCoord.xy * uHalftoneScale;
  vec2 hr = vec2(hs.x * 0.7071 - hs.y * 0.7071, hs.x * 0.7071 + hs.y * 0.7071);
  vec2 cell = fract(hr) - 0.5;
  float dotDist = length(cell);

  // Dot RADIUS tracks surface luminance — §11.1's "dot size varying by surface
  // luminance". A dark fill gets fat dots, a bright one gets fine ones, which is
  // how a real halftone encodes value.
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float radius = mix(0.42, 0.12, clamp(lum, 0.0, 1.0));
  // Hard edge: step, not smoothstep — a feathered dot is a soft gradient.
  float dotMask = 1.0 - step(radius, dotDist);
  diffuseColor.rgb = mix(diffuseColor.rgb, uInk, dotMask * uHalftoneStrength);

  // ── Seams: rivets, grout, tile grid, scanlines. One primitive, four pitches ─
  //
  // edge is 0 at the middle of a plate and 1 exactly on the seam, so the band is
  // one step near 1 and nothing else. Written this way round on purpose: the
  // obvious formulation (threshold the distance from the seam) needs a wrap case
  // for the plate either side of phase zero, and getting that wrong paints the
  // WHOLE surface in ink rather than a 6%-wide line — which is exactly the bug
  // that shipped in the first draft and read as "the walls are black".
  float seamPhase = (vWorldPos.z + uScroll) / max(uSeamSpacing, 0.0001);
  float edge = abs(fract(seamPhase) - 0.5) * 2.0;
  float seam = step(0.94, edge);
  diffuseColor.rgb = mix(diffuseColor.rgb, uInk, seam * uSeamStrength);

  // ── The animated term, quantised into hard bands ──────────────────────────
  //
  // Every effect resolves to a 0..1 signal, and the signal MIXES the fill toward
  // the theme's effect colour. It never darkens: GAME_BIBLE §11.3 forbids
  // anything darker than the palette's darkest colour, and Undertow's deep teal
  // and Kiln's gunmetal already sit close to it.
  //
  // Mixed, not added — and the difference is not cosmetic. Three works in LINEAR
  // space, where gunmetal is 0.027 and linear ember is 0.77. Adding even seven
  // percent of ember to that TRIPLES the red channel, so an "effectStrength" of
  // 0.07 rendered as a lava lamp. Mixing is bounded by construction: the result
  // always lies between two palette colours, which is a stronger §11.3 guarantee
  // than any amount of clamping an additive term.
  //
  // These are LIGHT effects — heat, caustics, dust in a sunbeam, a phosphor
  // scanline — and every effect colour is a palette entry brighter than the fill
  // it lands on, so mixing brightens in practice too.
  float band = 0.0;
  if (uEffect > 0.5) {
    float t = uTime * uEffectRate;
    float z = vWorldPos.z + uScroll;

    if (uEffect < 1.5) {
      // SHIMMER — heat rising off the plate. Bands of constant height travelling
      // upward: at 4.5 rad/u a 7.2u wall carries about five, where 1.7 gave two
      // and read as a smear. The z term warps them just enough that they are not
      // dead straight; at 1.2 it swung them into curtains, so it is 0.3.
      band = sin(vWorldPos.y * 4.5 - t * 3.0 + sin(z * 0.6) * 0.3) * 0.5 + 0.5;
    } else if (uEffect < 2.5) {
      // CAUSTICS — two crossing waves, which is what makes the cells read as
      // cells rather than as stripes. GAME_BIBLE §10 requires these be BANDS.
      float a = sin(z * 0.5 + t * 2.0);
      float b = cos(vWorldPos.x * 0.75 - t * 1.3);
      band = max(a * b, 0.0);
    } else if (uEffect < 3.5) {
      // DRIFT — slow, near-static haze. Bazaar's air rather than its light.
      band = (sin(vWorldPos.x * 0.5 + t) * 0.5 + sin(z * 0.22 - t * 0.7) * 0.5) * 0.5 + 0.5;
    } else {
      // SCAN — a roll travelling up the picture, plus ghosting offset in z.
      float roll = fract(vWorldPos.y * 1.6 - t * 0.35);
      float ghost = sin(z * 2.3 + t * 6.0) * 0.5 + 0.5;
      band = roll < 0.22 ? 1.0 : ghost * 0.35;
    }

    // THE quantisation. Without this line the whole art direction is broken:
    // §11.1 requires any unavoidable gradient be "posterised into 3-4 hard
    // steps", and §10 says Undertow's caustics specifically must be bands.
    float steps = max(uEffectSteps, 1.0);
    band = floor(clamp(band, 0.0, 1.0) * steps) / max(steps - 1.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, uGlow, clamp(band, 0.0, 1.0) * uEffectStrength);
  }
`;

/**
 * Creates a themed surface material.
 *
 * `lit` selects Lambert shading or a flat unlit response. P07 found that
 * gunmetal on a VERTICAL face renders around #101010 under an overhead key —
 * dark enough to breach §11.3's "no background darker than the palette's darkest
 * colour" and dark enough that the prism stopped reading as a four-sided space.
 * So walls are unlit and render their palette colour exactly, which is §11.1
 * verbatim anyway. The floor stays lit because it is the only surface that
 * receives the player's contact shadow.
 */
export function createScreenPrintMaterial(
  color: THREE.ColorRepresentation,
  surface: ThemeSurface,
  lit: boolean,
): ScreenPrintMaterial {
  const uniforms: ScreenPrintUniforms = {
    uTime: { value: 0 },
    uInk: { value: new THREE.Color(surface.ink) },
    uGlow: { value: new THREE.Color(surface.effectColor) },
    uHalftoneScale: { value: surface.halftoneScale },
    uHalftoneStrength: { value: surface.halftoneStrength },
    uSeamSpacing: { value: surface.seamSpacing },
    uSeamStrength: { value: surface.seamStrength },
    uEffect: { value: EFFECT_INDEX[surface.effect] },
    uEffectStrength: { value: surface.effectStrength },
    uEffectSteps: { value: surface.effectSteps },
    uEffectRate: { value: surface.effectRate },
    uScroll: { value: 0 },
  };

  /*
   * Two material classes, and the choice matters more than it looks.
   *
   * `MeshBasicMaterial` for unlit, `MeshLambertMaterial` for lit. An earlier
   * version used Lambert for both and made the unlit case work by putting the
   * fill in `emissive` with a black `color`, on the theory that one class meant
   * one code path.
   *
   * It broke the entire print treatment. Lambert computes
   * `outgoingLight = diffuse + totalEmissiveRadiance`, and this material patches
   * `diffuseColor` — so with `color` black, the halftone, the seams and the
   * animated effect were all applied to black and then buried under a flat
   * emissive term. Every wall and every prop rendered as plain untreated colour.
   * Setting BOTH to the fill (the version before that) was worse still: it
   * rendered `fill * light + fill` and ash props came out near-white.
   *
   * `MeshBasicMaterial` uses `diffuseColor` as the final colour with no lighting
   * term at all, so the insert lands exactly where it should. It supports fog,
   * which is what the tunnel needs; it cannot receive shadows, which only the
   * floor needs, and the floor is the lit one.
   */
  const material = lit
    ? new THREE.MeshLambertMaterial({ color: new THREE.Color(color), side: THREE.FrontSide })
    : new THREE.MeshBasicMaterial({ color: new THREE.Color(color), side: THREE.FrontSide });

  material.onBeforeCompile = (shader) => {
    for (const [name, uniform] of Object.entries(uniforms)) {
      shader.uniforms[name] = uniform;
    }

    /*
     * World position is computed here rather than taken from `worldpos_vertex`.
     *
     * Three's `worldPosition` only exists when an envmap, a shadow map or one of
     * three other defines is present — it is inside an `#if`, so relying on it
     * compiles on the floor face (which receives shadows) and fails on the walls
     * (which do not). And `instanceMatrix` only exists under `USE_INSTANCING`,
     * so multiplying by it unconditionally breaks every non-instanced user of
     * this material.
     *
     * `begin_vertex` defines `transformed`; everything after is explicit.
     */
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          "vec4 axisWorld = vec4( transformed, 1.0 );",
          "#ifdef USE_INSTANCING",
          "  axisWorld = instanceMatrix * axisWorld;",
          "#endif",
          "vWorldPos = ( modelMatrix * axisWorld ).xyz;",
        ].join("\n"),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vWorldPos;
         uniform float uTime;
         uniform vec3  uInk;
         uniform vec3  uGlow;
         uniform float uHalftoneScale;
         uniform float uHalftoneStrength;
         uniform float uSeamSpacing;
         uniform float uSeamStrength;
         uniform float uEffect;
         uniform float uEffectStrength;
         uniform float uEffectSteps;
         uniform float uEffectRate;
         uniform float uScroll;`,
      )
      .replace("#include <map_fragment>", `#include <map_fragment>\n${FRAGMENT_INSERT}`);
  };

  // Three caches compiled programs by this key. Without a distinct key every
  // material patched by `onBeforeCompile` shares one program and every theme
  // renders with the first theme's shader — a genuinely baffling bug to chase.
  material.customProgramCacheKey = () =>
    `axis-screenprint-${surface.effect}-${lit ? "lit" : "flat"}`;

  const themed = material as ScreenPrintMaterial;
  Object.defineProperty(themed, "axisUniforms", { value: uniforms, enumerable: false });
  return themed;
}

/** Advances every animated term. Called once per frame with render time. */
export function updateScreenPrint(
  material: ScreenPrintMaterial,
  time: number,
  scroll: number,
): void {
  material.axisUniforms.uTime.value = time;
  material.axisUniforms.uScroll.value = scroll;
}

/**
 * Crossfades a material's surface parameters toward another theme's.
 *
 * Colours lerp in linear space, which is what `THREE.Color.lerp` does, and the
 * ink and effect parameters lerp alongside them. `uEffect` does NOT lerp — it
 * switches at the halfway point, because interpolating between effect *indices*
 * would run the shader's `else if` ladder through whatever sits between them.
 */
/*
 * Scratch colours. This runs once per material per frame for four seconds, and
 * a transition is the one moment in the game where a GC pause would be visible
 * — the verify gate measures precisely that.
 */
const SCRATCH_INK = new THREE.Color();
const SCRATCH_GLOW = new THREE.Color();

export function blendScreenPrint(
  material: ScreenPrintMaterial,
  from: ThemeSurface,
  to: ThemeSurface,
  fromColor: THREE.Color,
  toColor: THREE.Color,
  t: number,
): void {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const u = material.axisUniforms;

  // Both material classes carry the fill in `color`; that is most of why the
  // unlit path is Basic rather than Lambert-with-emissive.
  material.color.copy(fromColor).lerp(toColor, clamped);

  u.uInk.value.set(from.ink).lerp(SCRATCH_INK.set(to.ink), clamped);
  u.uGlow.value.set(from.effectColor).lerp(SCRATCH_GLOW.set(to.effectColor), clamped);
  u.uHalftoneScale.value = lerp(from.halftoneScale, to.halftoneScale, clamped);
  u.uHalftoneStrength.value = lerp(from.halftoneStrength, to.halftoneStrength, clamped);
  u.uSeamSpacing.value = lerp(from.seamSpacing, to.seamSpacing, clamped);
  u.uSeamStrength.value = lerp(from.seamStrength, to.seamStrength, clamped);
  u.uEffectStrength.value = lerp(from.effectStrength, to.effectStrength, clamped);
  u.uEffectSteps.value = Math.round(lerp(from.effectSteps, to.effectSteps, clamped));
  u.uEffectRate.value = lerp(from.effectRate, to.effectRate, clamped);

  const HALF = 0.5;
  u.uEffect.value = EFFECT_INDEX[clamped < HALF ? from.effect : to.effect];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exported for the tests: the shader index a named effect compiles to. */
export function effectIndex(name: SurfaceEffectName): number {
  return EFFECT_INDEX[name];
}
