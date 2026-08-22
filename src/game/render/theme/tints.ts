/**
 * The live tint set — every colour in the scene that is not a tunnel surface.
 *
 * Particles, speed lines, obstacles, pickups and the runner all take their
 * colour from the active theme, and all of them change during a crossfade. This
 * module is where that happens.
 *
 * ## Mutable module state, deliberately
 *
 * Every other cross-cutting value in the render layer travels through a handle
 * ref. These do not, for a reason particular to what they are: `emitters.ts` is
 * a set of free functions called from deep inside the frame loop and from event
 * handlers, and threading a tint argument through all five of them — and through
 * the loop, and through the event dispatcher — would put a parameter on every
 * call site to express something that is globally true at any instant. There is
 * exactly one active theme.
 *
 * The safety condition is that nothing here is ever *read* by the sim, and
 * nothing here affects a score. These are presentation values, in the same
 * category as `Math.random` in the emitters (see that file's header).
 *
 * ## Mutated in place, never replaced
 *
 * `ENTITY_TINT.obstacle` is assigned straight onto a `MeshLambertMaterial`, so
 * the material and this module share one `THREE.Color` object. Blending it
 * recolours every obstacle in the scene with no per-frame material lookup, no
 * traversal, and no allocation. Replacing the object instead of mutating it
 * would silently break that link and leave the scene on the first theme's
 * colours — which is precisely the bug that the `customProgramCacheKey` note in
 * `materials/screenprint.ts` describes for shaders.
 *
 * ## Entity colours are DERIVED, not new registry fields
 *
 * An obstacle is the theme's accent and a pickup is the theme's primary text
 * colour. Both already exist in `theme.ui`, both are already contrast-checked
 * there, and `tests/theme/registry.test.ts` already asserts no prop may use the
 * accent — a rule that was quietly false while obstacles were a hardcoded ember
 * regardless of theme. Deriving rather than adding fields keeps the fifth-theme
 * promise honest: there is nothing extra to fill in.
 */

import * as THREE from "three";
import type { Theme, ThemeParticles } from "@/game/config/themes";

/** A colour as the particle pool wants it: three 0..1 floats, not a Color. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Live particle tints, by emitter. Read by `vfx/emitters.ts` at spawn time.
 *
 * Plain numbers rather than `THREE.Color` because the pool stores flat float
 * arrays and a `Color` would mean a property read per component per particle.
 */
export const PARTICLE_TINT: Record<keyof ParticleTints, Rgb> = {
  dust: { r: 1, g: 1, b: 1 },
  coin: { r: 1, g: 1, b: 1 },
  shatter: { r: 1, g: 1, b: 1 },
  trail: { r: 1, g: 1, b: 1 },
  ambient: { r: 1, g: 1, b: 1 },
};

/** The emitter tints a theme names. Ambient falls back to dust when absent. */
interface ParticleTints {
  dust: string;
  coin: string;
  shatter: string;
  trail: string;
  ambient: string;
}

/**
 * Live entity colours, shared by reference with the materials that use them.
 *
 * See the header: these objects are handed to `MeshLambertMaterial` and must be
 * mutated, never reassigned.
 */
export const ENTITY_TINT = {
  /** Obstacles. The theme accent — the one colour reserved for "this hurts". */
  obstacle: new THREE.Color(),
  /** Bits, Shards and every other pickup. The theme's primary text colour. */
  pickup: new THREE.Color(),
  /** The runner. Same colour as pickups, so the player reads as "yours". */
  player: new THREE.Color(),
  /** Speed lines. Primary text at low opacity — see `feel/SpeedLines.tsx`. */
  speedLine: new THREE.Color(),
} as const;

/** Scratch, so a blend running every frame of a transition allocates nothing. */
const FROM = new THREE.Color();
const TO = new THREE.Color();

const BYTE = 255;
const RED_SHIFT = 16;
const GREEN_SHIFT = 8;
const MASK = 0xff;

/**
 * Parses `#rrggbb` into 0..1 components WITHOUT a colour-space conversion.
 *
 * Deliberately not `THREE.Color`. The particle material is a raw `ShaderMaterial`
 * whose fragment shader writes the attribute straight to `gl_FragColor`, so it
 * wants sRGB-encoded values; `new THREE.Color(hex)` would convert to linear and
 * every particle would come out roughly twice as dark as its palette swatch.
 * This is the same parse the emitters used before the theme system existed.
 */
function parseSrgb(hex: string, out: Rgb): void {
  const value = Number.parseInt(hex.slice(1), 16);
  out.r = ((value >> RED_SHIFT) & MASK) / BYTE;
  out.g = ((value >> GREEN_SHIFT) & MASK) / BYTE;
  out.b = (value & MASK) / BYTE;
}

/** Scratch for the second operand of a blend. Five blends a frame, zero garbage. */
const TARGET: Rgb = { r: 0, g: 0, b: 0 };

/** Linear interpolation of two sRGB-encoded hexes into `out`. */
function lerpSrgb(from: string, to: string, t: number, out: Rgb): void {
  parseSrgb(from, out);
  parseSrgb(to, TARGET);
  out.r += (TARGET.r - out.r) * t;
  out.g += (TARGET.g - out.g) * t;
  out.b += (TARGET.b - out.b) * t;
}

/** A theme's ambient tint, or its dust tint when the theme has no ambient. */
function ambientOf(particles: ThemeParticles): string {
  return particles.ambient ?? particles.dust;
}

/**
 * Crossfades every tint from one theme toward another.
 *
 * Called once per frame by the director with the same `t` the tunnel and lights
 * use, so particles, obstacles and walls all arrive together rather than the
 * scene changing colour in three visible stages.
 */
export function blendTints(from: Theme, to: Theme, t: number): void {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;

  lerpSrgb(from.particles.dust, to.particles.dust, clamped, PARTICLE_TINT.dust);
  lerpSrgb(from.particles.coin, to.particles.coin, clamped, PARTICLE_TINT.coin);
  lerpSrgb(from.particles.shatter, to.particles.shatter, clamped, PARTICLE_TINT.shatter);
  lerpSrgb(from.particles.trail, to.particles.trail, clamped, PARTICLE_TINT.trail);
  lerpSrgb(ambientOf(from.particles), ambientOf(to.particles), clamped, PARTICLE_TINT.ambient);

  ENTITY_TINT.obstacle.copy(FROM.set(from.ui.accent)).lerp(TO.set(to.ui.accent), clamped);
  ENTITY_TINT.pickup.copy(FROM.set(from.ui.text)).lerp(TO.set(to.ui.text), clamped);
  ENTITY_TINT.player.copy(ENTITY_TINT.pickup);
  ENTITY_TINT.speedLine.copy(ENTITY_TINT.pickup);
}

/** Snaps every tint to one theme. Used at construction and by the tests. */
export function resetTints(theme: Theme): void {
  blendTints(theme, theme, 1);
}
