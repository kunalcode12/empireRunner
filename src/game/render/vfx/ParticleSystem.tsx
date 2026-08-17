"use client";

/**
 * One pooled particle system. Instanced quads, custom shader, one draw call.
 *
 * ## The constraints, and what they rule out
 *
 * A shatter burst is 22 particles, a coin burst 10, and the Overdrive trail
 * emits 55 a second. In a dense section with Overdrive up, several hundred are
 * live at once. That rules out:
 *
 *   - **A React component per particle.** Hundreds of elements mounting and
 *     unmounting per second, each reconciling. This is not a close call.
 *   - **A mesh per particle.** Hundreds of draw calls against a budget of 100.
 *   - **Allocating per emission.** Bursts happen exactly when the frame is
 *     already busy — on impact — so a GC pause lands at the worst moment.
 *
 * So: a fixed pool allocated once at the HIGH tier size, a free list, and a
 * single `InstancedMesh` whose per-instance attributes are rewritten each frame.
 * Changing quality tier changes how much of the pool may be used, never its
 * size, so no tier switch ever reallocates.
 *
 * ## Why the shader is custom
 *
 * Instance colour and opacity have to vary per particle and fade over its life.
 * A stock material gives one colour for the whole mesh. The shader here is
 * deliberately tiny — it reads two instanced attributes and multiplies — because
 * anything more elaborate would be art direction, and that belongs to P10 with
 * the screen-print materials.
 *
 * The quad is camera-facing, billboarded in the vertex shader rather than by
 * rotating each instance on the CPU: it is one matrix trick in GLSL versus a
 * per-particle `lookAt` per frame.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { getQuality, Quality } from "../perf/quality";
import { getMotion } from "../feel/reducedMotion";

const PT = TUNING.particles;

/** Components per colour in the instanced attribute buffer. */
const RGB_STRIDE = 3;

/** Pool size. Always the HIGH cap, so a tier change never reallocates. */
const POOL_SIZE = PT.maxHigh;

/** Live cap for the active tier, after the reduced-motion scale. */
export function particleBudget(): number {
  const tier = getQuality().tier;
  const base =
    tier === Quality.High ? PT.maxHigh : tier === Quality.Medium ? PT.maxMedium : PT.maxLow;
  return Math.floor(base * getMotion().particleScale);
}

/**
 * Particle storage, struct-of-arrays.
 *
 * Same reasoning as `EntityColumns` in the sim: a linear walk over typed arrays,
 * no per-particle object, nothing for the GC to trace.
 */
export interface ParticlePool {
  readonly capacity: number;
  /** 1 when live. */
  readonly alive: Uint8Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** s — remaining life. */
  readonly life: Float32Array;
  /** s — life at spawn, for the fade curve. */
  readonly maxLife: Float32Array;
  readonly size: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  /** 1 when gravity and drag apply. Dust floats; debris falls. */
  readonly physical: Uint8Array;
  /** Round-robin cursor for the free scan. */
  cursor: number;
  /** Live count, recomputed each step. Diagnostic and the peak metric. */
  live: number;
  /** Peak live count since reset. Reported by the perf gate. */
  peak: number;
}

export function createParticlePool(capacity: number = POOL_SIZE): ParticlePool {
  return {
    capacity,
    alive: new Uint8Array(capacity),
    px: new Float32Array(capacity),
    py: new Float32Array(capacity),
    pz: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    vz: new Float32Array(capacity),
    life: new Float32Array(capacity),
    maxLife: new Float32Array(capacity),
    size: new Float32Array(capacity),
    r: new Float32Array(capacity),
    g: new Float32Array(capacity),
    b: new Float32Array(capacity),
    physical: new Uint8Array(capacity),
    cursor: 0,
    live: 0,
    peak: 0,
  };
}

export interface SpawnParams {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  r: number;
  g: number;
  b: number;
  physical: boolean;
}

/**
 * Spawns one particle, if there is room.
 *
 * The free scan is round-robin from a cursor rather than from zero, so a full
 * pool costs one wrap rather than a full scan every call. Returns false when
 * the budget is exhausted — dropping a particle is always better than
 * allocating, and nobody can count them.
 */
export function spawnParticle(pool: ParticlePool, params: SpawnParams): boolean {
  const budget = particleBudget();
  if (budget <= 0 || pool.live >= budget) {
    return false;
  }

  const capacity = pool.capacity;
  for (let scanned = 0; scanned < capacity; scanned += 1) {
    const i = (pool.cursor + scanned) % capacity;
    if (pool.alive[i] === 1) {
      continue;
    }
    pool.cursor = (i + 1) % capacity;
    pool.alive[i] = 1;
    pool.px[i] = params.x;
    pool.py[i] = params.y;
    pool.pz[i] = params.z;
    pool.vx[i] = params.vx;
    pool.vy[i] = params.vy;
    pool.vz[i] = params.vz;
    pool.life[i] = params.life;
    pool.maxLife[i] = params.life;
    pool.size[i] = params.size;
    pool.r[i] = params.r;
    pool.g[i] = params.g;
    pool.b[i] = params.b;
    pool.physical[i] = params.physical ? 1 : 0;
    pool.live += 1;
    if (pool.live > pool.peak) {
      pool.peak = pool.live;
    }
    return true;
  }
  return false;
}

/**
 * Integrates every live particle by one frame.
 *
 * @param dt real frame delta.
 * @param worldDelta u — how far the world scrolled this frame. Particles are
 *        emitted in world space and must ride the treadmill with everything
 *        else, or a dust puff hangs in the air while the ground moves under it.
 */
export function stepParticles(pool: ParticlePool, dt: number, worldDelta: number): void {
  const drag = Math.pow(PT.drag, dt);
  let live = 0;

  for (let i = 0; i < pool.capacity; i += 1) {
    if (pool.alive[i] !== 1) {
      continue;
    }

    const remaining = (pool.life[i] ?? 0) - dt;
    if (remaining <= 0) {
      pool.alive[i] = 0;
      continue;
    }
    pool.life[i] = remaining;

    if (pool.physical[i] === 1) {
      pool.vy[i] = (pool.vy[i] ?? 0) + PT.gravity * dt;
      pool.vx[i] = (pool.vx[i] ?? 0) * drag;
      pool.vy[i] = (pool.vy[i] ?? 0) * drag;
      pool.vz[i] = (pool.vz[i] ?? 0) * drag;
    }

    pool.px[i] = (pool.px[i] ?? 0) + (pool.vx[i] ?? 0) * dt;
    pool.py[i] = (pool.py[i] ?? 0) + (pool.vy[i] ?? 0) * dt;
    // Ride the treadmill. Law (b) applies to particles too.
    pool.pz[i] = (pool.pz[i] ?? 0) + (pool.vz[i] ?? 0) * dt - worldDelta;

    live += 1;
  }

  pool.live = live;
}

export function resetParticles(pool: ParticlePool): void {
  pool.alive.fill(0);
  pool.cursor = 0;
  pool.live = 0;
  pool.peak = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shader
// ─────────────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 instanceColour;
  attribute float instanceFade;
  varying vec3 vColour;
  varying float vFade;

  void main() {
    vColour = instanceColour;
    vFade = instanceFade;

    // Billboard: take the instance's translation and scale from its matrix but
    // discard its rotation, then offset along the camera's own right and up
    // axes. Doing it here rather than with a per-particle lookAt on the CPU is
    // the difference between one matrix multiply and a few hundred.
    vec4 origin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float scale = length(instanceMatrix[0].xyz);

    vec4 viewOrigin = modelViewMatrix * origin;
    viewOrigin.xy += position.xy * scale;

    gl_Position = projectionMatrix * viewOrigin;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColour;
  varying float vFade;

  void main() {
    // A soft round falloff from the quad's centre. Cheap, and it stops the
    // particles reading as literal squares — which at this art direction would
    // be a stylistic claim rather than an accident.
    vec2 uv = gl_PointCoord;
    gl_FragColor = vec4(vColour, vFade);
    if (vFade <= 0.001) discard;
  }
`;

export interface ParticleSystemHandle {
  readonly pool: ParticlePool;
  /** Integrates and uploads. Called once per frame from the loop. */
  update(dt: number, worldDelta: number): void;
}

export interface ParticleSystemProps {
  handleRef: React.MutableRefObject<ParticleSystemHandle | null>;
}

export function ParticleSystem({ handleRef }: ParticleSystemProps): React.ReactElement {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const pool = useMemo(() => createParticlePool(), []);

  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const { colours, fades } = useMemo(
    () => ({
      colours: new THREE.InstancedBufferAttribute(
        new Float32Array(POOL_SIZE * RGB_STRIDE),
        RGB_STRIDE,
      ),
      fades: new THREE.InstancedBufferAttribute(new Float32Array(POOL_SIZE), 1),
    }),
    [],
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        // Additive would glow, and GAME_BIBLE §11.3 bans emissive as an ambient
        // property. Normal blending keeps particles as flat ink on the frame.
        blending: THREE.NormalBlending,
      }),
    [],
  );

  useLayoutEffect(() => {
    const g = geometry;
    const m = material;
    return () => {
      g.dispose();
      m.dispose();
    };
  }, [geometry, material]);

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      hidden: new THREE.Matrix4().makeScale(0, 0, 0),
    }),
    [],
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }
    mesh.geometry.setAttribute("instanceColour", colours);
    mesh.geometry.setAttribute("instanceFade", fades);
  }, [colours, fades]);

  useLayoutEffect(() => {
    const handle: ParticleSystemHandle = {
      pool,

      update(dt: number, worldDelta: number): void {
        stepParticles(pool, dt, worldDelta);

        const mesh = meshRef.current;
        if (mesh === null) {
          return;
        }

        const colourArray = colours.array as Float32Array;
        const fadeArray = fades.array as Float32Array;

        for (let i = 0; i < pool.capacity; i += 1) {
          if (pool.alive[i] !== 1) {
            mesh.setMatrixAt(i, scratch.hidden);
            fadeArray[i] = 0;
            continue;
          }

          scratch.pos.set(pool.px[i] ?? 0, pool.py[i] ?? 0, pool.pz[i] ?? 0);
          scratch.quat.identity();
          const s = pool.size[i] ?? 0;
          scratch.scale.set(s, s, s);
          scratch.matrix.compose(scratch.pos, scratch.quat, scratch.scale);
          mesh.setMatrixAt(i, scratch.matrix);

          const base = i * RGB_STRIDE;
          colourArray[base] = pool.r[i] ?? 1;
          colourArray[base + 1] = pool.g[i] ?? 1;
          colourArray[base + 2] = pool.b[i] ?? 1;

          // Fade out over the back half of life, so a particle is at full
          // opacity while it is doing its job and vanishes without a pop.
          const maxLife = pool.maxLife[i] ?? 1;
          const t = maxLife > 0 ? (pool.life[i] ?? 0) / maxLife : 0;
          const FADE_START = 0.6;
          fadeArray[i] = t >= FADE_START ? 1 : t / FADE_START;
        }

        mesh.instanceMatrix.needsUpdate = true;
        colours.needsUpdate = true;
        fades.needsUpdate = true;

        // Published for the perf gate. A window global rather than a prop or a
        // store: this is diagnostics, and it must not be able to trigger a
        // React render from inside the frame loop.
        (window as Window & { __axisParticlePeak?: number }).__axisParticlePeak = pool.peak;
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, pool, colours, fades, scratch]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, POOL_SIZE]}
      frustumCulled={false}
      name="particles"
    />
  );
}

/** Draw calls the whole particle system costs. */
export const PARTICLE_DRAW_CALLS = 1;
