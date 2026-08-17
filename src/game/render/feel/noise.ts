/**
 * Gradient noise, for screen shake.
 *
 * ## Why not a sine
 *
 * A shake driven by `sin(t * f)` is periodic, and the eye locks onto a period
 * almost immediately — it reads as a wobble, or as the camera being on a spring,
 * rather than as an impact. Worse, two shakes that overlap either reinforce or
 * cancel depending on phase, so the same collision feels different depending on
 * when it happened.
 *
 * Gradient noise has no period the viewer can latch onto, and overlapping
 * samples stay uncorrelated. This is the standard trick and it is the difference
 * between "the screen shook" and "something hit me".
 *
 * ## Why 1D and not simplex proper
 *
 * The shake needs three uncorrelated scalar signals over time — x, y and roll.
 * That is three 1D walks, not a 2D or 3D field, so a full simplex implementation
 * with its skew factors and gradient tables would be several hundred lines
 * computing something this does in ten. Each axis gets its own offset into the
 * same 1D noise, far enough apart that they never correlate.
 *
 * This is presentation-only, so unlike the sim it may use any maths it likes —
 * the transcendental ban in eslint.config.mjs is scoped to `src/game/sim/**`.
 */

/** Large, mutually-coprime-ish offsets so the three axes never line up. */
export const NOISE_AXIS_X = 0;
export const NOISE_AXIS_Y = 137.13;
export const NOISE_AXIS_ROLL = 921.71;

// Integer-hash constants. These are the algorithm, not tunables — they are the
// standard mixing primes used by the classic Perlin/Hugo Elias integer hash, and
// changing any of them changes the noise field rather than adjusting a feel.
const HASH_SHIFT = 13;
const HASH_PRIME_A = 15731;
const HASH_PRIME_B = 789221;
const HASH_PRIME_C = 1376312589;
const HASH_MASK = 0x7fffffff;
const HASH_HALF_RANGE = 1073741824;

/** Deterministic hash of an integer lattice point to a gradient in [-1, 1]. */
function gradient(i: number): number {
  // Integer hash (xorshift-ish), then map to a signed unit range. Cheap, and
  // stable across engines — not that it has to be here, but a shake that
  // differed between browsers would be an odd thing to debug later.
  let h = i | 0;
  h = (h << HASH_SHIFT) ^ h;
  const n = (h * (h * h * HASH_PRIME_A + HASH_PRIME_B) + HASH_PRIME_C) & HASH_MASK;
  return 1 - n / HASH_HALF_RANGE;
}

/** Smoothstep, so the interpolation between lattice points has no visible kinks. */
const SMOOTHSTEP_A = 3;
const SMOOTHSTEP_B = 2;

function fade(t: number): number {
  return t * t * (SMOOTHSTEP_A - SMOOTHSTEP_B * t);
}

/**
 * 1D gradient noise in roughly [-1, 1].
 *
 * Continuous and smooth, with no repeating period at any scale the shake uses.
 */
export function noise1D(x: number): number {
  const i = Math.floor(x);
  const f = x - i;

  const a = gradient(i);
  const b = gradient(i + 1);

  // Gradient (Perlin-style) rather than value noise: interpolating the gradients
  // dotted with the local offset avoids the blocky, grid-aligned look that plain
  // value noise has.
  const va = a * f;
  const vb = b * (f - 1);

  return va + fade(f) * (vb - va);
}

/**
 * Layered noise, for a slightly richer jolt.
 *
 * Two octaves is enough. More just costs time — at a 24Hz sample rate over a
 * shake lasting under a second, the higher octaves are past the frame rate.
 */
export function noise1DOctaves(x: number): number {
  const SECOND_OCTAVE_SCALE = 2.17;
  const SECOND_OCTAVE_WEIGHT = 0.35;
  return (
    (noise1D(x) + noise1D(x * SECOND_OCTAVE_SCALE) * SECOND_OCTAVE_WEIGHT) /
    (1 + SECOND_OCTAVE_WEIGHT)
  );
}
