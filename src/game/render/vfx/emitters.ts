/**
 * Emitters — the five things that make particles.
 *
 * Each is a plain function that pushes into the shared pool. No emitter owns
 * state, no emitter allocates, and every one is driven by a sim event or by
 * interpolated sim state. Nothing here decides anything about gameplay.
 *
 * ```
 *   foot dust        every footfall, from the rig's stride phase
 *   coin burst       SimEvent.Coin
 *   shatter debris   SimEvent.Shatter
 *   Overdrive trail  continuous while overdriveTimer > 0
 *   Fracture shards  SimEvent.FractureArm
 * ```
 *
 * ## Randomness here is `Math.random`, and that is correct
 *
 * The sim bans `Math.random` outright because a replay must re-simulate
 * identically on a server (law a). Particles are presentation: they are never
 * read back, never affect a score, and are not in the replay. Using the sim's
 * seeded RNG here would be actively wrong — it would advance the generator
 * stream, so spawning a dust puff would change the track layout. That is the
 * exact failure the named-stream design in `rng.ts` exists to prevent.
 */

import { TUNING } from "@/game/config/tuning";
import { GREYBOX } from "../palette";
import { spawnParticle, type ParticlePool } from "./ParticleSystem";

const PT = TUNING.particles;

/** Parses a palette hex into linear-ish 0..1 components, once at module load. */
function rgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  const BYTE = 255;
  const RED_SHIFT = 16;
  const GREEN_SHIFT = 8;
  const MASK = 0xff;
  return {
    r: ((value >> RED_SHIFT) & MASK) / BYTE,
    g: ((value >> GREEN_SHIFT) & MASK) / BYTE,
    b: (value & MASK) / BYTE,
  };
}

// Per-emitter variation ranges. Shape data for a burst, in the same spirit as
// the pose curves: they describe what a puff looks like, not how the game plays.
const DUST_LIFE_LO = 0.7;
const DUST_LIFE_SPAN = 0.6;
const DUST_SIZE_LO = 0.6;
const DUST_SIZE_SPAN = 0.8;
const SHATTER_SPEED_LO = 0.4;
const SHATTER_SPEED_SPAN = 0.8;
const SHATTER_LIFE_LO = 0.6;
const SHATTER_LIFE_SPAN = 0.8;
const SHATTER_SPREAD = 0.4;
const SHATTER_RISE = 0.8;
const TRAIL_DRIFT = 0.3;
const TRAIL_BACKWARD = 1.2;
const SHARD_RISE = 1.5;
const SHARD_LIFE_FACTOR = 1.5;
const SHARD_SIZE_FACTOR = 1.2;
const SHARD_COUNT = 18;
const SHARD_SPEED = 0.9;

const ASH = rgb(GREYBOX.ash);
const BONE = rgb(GREYBOX.bone);
const EMBER = rgb(GREYBOX.ember);

const HALF = 0.5;

/** Symmetric random in [-1, 1]. Presentation only — see the header. */
function jitter(): number {
  return Math.random() * 2 - 1;
}

/**
 * Scales `base` by a random factor in [0.5, 1.0].
 *
 * Every burst varies its particles this way. Uniform particles read as a
 * mechanism; varied ones read as debris.
 */
function varied(base: number): number {
  return base * (HALF + Math.random() * HALF);
}

/** Scales `base` by a random factor in [lo, lo + span]. */
function variedBy(base: number, lo: number, span: number): number {
  return base * (lo + Math.random() * span);
}

/**
 * Foot dust.
 *
 * Emitted at the contact point, drifting up and back. Non-physical: dust hangs
 * and dissipates rather than falling, so gravity is off for it.
 */
export function emitFootDust(pool: ParticlePool, x: number, y: number, z: number): void {
  const SPREAD = 0.22;
  const BACKWARD = 1.4;
  for (let i = 0; i < PT.dustPerStep; i += 1) {
    spawnParticle(pool, {
      x: x + jitter() * SPREAD,
      y: y + Math.random() * SPREAD,
      z: z + jitter() * SPREAD,
      vx: jitter() * HALF,
      vy: varied(PT.dustRise),
      vz: -varied(BACKWARD),
      life: variedBy(PT.dustLife, DUST_LIFE_LO, DUST_LIFE_SPAN),
      size: variedBy(PT.dustSize, DUST_SIZE_LO, DUST_SIZE_SPAN),
      r: ASH.r,
      g: ASH.g,
      b: ASH.b,
      physical: false,
    });
  }
}

/**
 * Coin collect burst.
 *
 * A tight outward spray in bone. Short-lived and bright — the whole point is a
 * single crisp pop confirming the grab, not a lingering cloud.
 */
export function emitCoinBurst(pool: ParticlePool, x: number, y: number, z: number): void {
  for (let i = 0; i < PT.coinBurst; i += 1) {
    // Spherical-ish spread. Not uniform on the sphere, and it does not need to
    // be — the bias toward the axes is invisible at ten particles.
    const dx = jitter();
    const dy = jitter();
    const dz = jitter();
    const length = Math.hypot(dx, dy, dz) || 1;
    const speed = varied(PT.coinSpeed);

    spawnParticle(pool, {
      x,
      y,
      z,
      vx: (dx / length) * speed,
      vy: (dy / length) * speed + 1,
      vz: (dz / length) * speed,
      life: variedBy(PT.coinLife, DUST_LIFE_LO, DUST_LIFE_SPAN),
      size: PT.coinSize,
      r: BONE.r,
      g: BONE.g,
      b: BONE.b,
      physical: true,
    });
  }
}

/**
 * Shatter debris.
 *
 * The Overdrive payoff. Bigger, faster and physical, so pieces arc and fall —
 * this should read as the obstacle coming apart, not as a puff.
 */
export function emitShatter(pool: ParticlePool, x: number, y: number, z: number): void {
  for (let i = 0; i < PT.shatterBurst; i += 1) {
    const dx = jitter();
    const dy = Math.random();
    const dz = jitter();
    const length = Math.hypot(dx, dy, dz) || 1;
    const speed = variedBy(PT.shatterSpeed, SHATTER_SPEED_LO, SHATTER_SPEED_SPAN);

    spawnParticle(pool, {
      x: x + jitter() * SHATTER_SPREAD,
      y: y + Math.random() * SHATTER_RISE,
      z: z + jitter() * SHATTER_SPREAD,
      vx: (dx / length) * speed,
      vy: (dy / length) * speed,
      vz: (dz / length) * speed,
      life: variedBy(PT.shatterLife, SHATTER_LIFE_LO, SHATTER_LIFE_SPAN),
      size: variedBy(PT.shatterSize, HALF, 1),
      r: EMBER.r,
      g: EMBER.g,
      b: EMBER.b,
      physical: true,
    });
  }
}

/**
 * Overdrive trail.
 *
 * Continuous while the window is open. Rate-based rather than per-frame-count,
 * so the density is the same at 60 and 144fps — a per-frame emitter would make
 * the trail twice as thick on a better monitor.
 *
 * @param accumulator carried between frames; returns the new value.
 */
export function emitOverdriveTrail(
  pool: ParticlePool,
  x: number,
  y: number,
  z: number,
  dt: number,
  accumulator: number,
): number {
  let carried = accumulator + PT.trailPerSecond * dt;
  const SPREAD = 0.35;

  while (carried >= 1) {
    carried -= 1;
    spawnParticle(pool, {
      x: x + jitter() * SPREAD,
      y: y + Math.random() * TUNING.geometry.playerHeightStand,
      z: z + jitter() * SPREAD,
      vx: jitter() * TRAIL_DRIFT,
      vy: jitter() * TRAIL_DRIFT,
      vz: -TRAIL_BACKWARD,
      life: PT.trailLife,
      size: PT.trailSize,
      r: EMBER.r,
      g: EMBER.g,
      b: EMBER.b,
      physical: false,
    });
  }

  return carried;
}

/**
 * Fracture shards.
 *
 * Fired when the window opens. Deliberately slow and long-lived: during a
 * Fracture the world is at `fractureTimeScale` 0.15 and everything should look
 * suspended, so these hang in the air rather than dispersing.
 */
export function emitFractureShards(pool: ParticlePool, x: number, y: number, z: number): void {
  for (let i = 0; i < SHARD_COUNT; i += 1) {
    const dx = jitter();
    const dy = jitter();
    const dz = jitter();
    const length = Math.hypot(dx, dy, dz) || 1;

    spawnParticle(pool, {
      x: x + jitter() * HALF,
      y: y + Math.random() * SHARD_RISE,
      z: z + jitter() * HALF,
      vx: (dx / length) * SHARD_SPEED,
      vy: (dy / length) * SHARD_SPEED,
      vz: (dz / length) * SHARD_SPEED,
      // Outlives the 1.2s window, so shards are still hanging when it resolves.
      life: TUNING.fracture.fractureWindow * SHARD_LIFE_FACTOR,
      size: PT.shatterSize * SHARD_SIZE_FACTOR,
      r: BONE.r,
      g: BONE.g,
      b: BONE.b,
      physical: false,
    });
  }
}
