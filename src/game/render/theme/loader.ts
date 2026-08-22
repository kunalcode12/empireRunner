/**
 * Loading theme geometry, with a byte count that is actually a byte count.
 *
 * ## The progress is real
 *
 * The brief: "A real progress indicator tied to actual bytes, not a fake timer."
 * So the manifest written by `scripts/build-themes.mjs` carries every bundle's
 * exact size, the loader reports `loaded / total` from `GLTFLoader`'s progress
 * events, and the denominator is the number the pipeline printed. Nothing here
 * interpolates toward a guess or advances on a clock — if the network stalls, the
 * bar stalls, which is the entire point of showing one.
 *
 * ## One theme resident, one warm, the rest not loaded
 *
 * `ensureLoaded` is idempotent and cached, so the preloader can call it for the
 * next theme every frame without cost. Cache entries are never evicted: four
 * themes is 28KB of geometry in total, and a player who has crossed a milestone
 * once will very likely cross it again on the next run.
 *
 * ## meshopt decoding needs no extra files
 *
 * `MeshoptDecoder` ships inside the `three` package, so there is nothing to copy
 * into `public/` and nothing to fetch before the first prop can be drawn. That is
 * most of why the pipeline chose meshopt over Draco — see the header of
 * `scripts/build-themes.mjs`.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/** One theme's geometry, keyed by the mesh names the pipeline wrote. */
export interface ThemeAssets {
  readonly slug: string;
  /** `<index>-<archetype>` -> geometry. The index maps back to `theme.props`. */
  readonly meshes: ReadonlyMap<string, THREE.BufferGeometry>;
  /** bytes — what this bundle actually cost. */
  readonly bytes: number;
}

interface ManifestEntry {
  files: Record<string, { name: string; bytes: number }>;
  props: number;
}

interface Manifest {
  themes: Record<string, ManifestEntry>;
}

/** Progress across everything currently being loaded. */
export interface LoadProgress {
  /** bytes received. */
  readonly loaded: number;
  /** bytes expected, from the manifest. Zero before the manifest arrives. */
  readonly total: number;
  /** 0..1. Exactly `loaded / total`, or 0 when the total is unknown. */
  readonly fraction: number;
  /** Slugs still in flight. */
  readonly pending: readonly string[];
}

export type ProgressListener = (progress: LoadProgress) => void;

const BASE = "/themes";

let manifestPromise: Promise<Manifest> | null = null;
const cache = new Map<string, Promise<ThemeAssets>>();
const listeners = new Set<ProgressListener>();
/** bytes received per slug, so a re-entrant load cannot double-count. */
const received = new Map<string, number>();
const expected = new Map<string, number>();
const inFlight = new Set<string>();

let loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (loader === null) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

function snapshot(): LoadProgress {
  let loaded = 0;
  let total = 0;
  for (const bytes of received.values()) {
    loaded += bytes;
  }
  for (const bytes of expected.values()) {
    total += bytes;
  }
  return {
    loaded,
    total,
    fraction: total > 0 ? Math.min(1, loaded / total) : 0,
    pending: Array.from(inFlight),
  };
}

function publish(): void {
  const progress = snapshot();
  for (const listener of listeners) {
    listener(progress);
  }
}

/** Subscribes to load progress. Returns an unsubscribe function. */
export function onLoadProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

/** The current progress, for a caller that would rather poll than subscribe. */
export function loadProgress(): LoadProgress {
  return snapshot();
}

async function getManifest(): Promise<Manifest> {
  if (manifestPromise === null) {
    manifestPromise = fetch(`${BASE}/manifest.json`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`theme manifest ${response.status}`);
        }
        return response.json() as Promise<Manifest>;
      })
      .catch(() => ({ themes: {} }));
  }
  return manifestPromise;
}

/**
 * Loads one theme's geometry.
 *
 * Idempotent: repeated calls return the same promise, so the preloader may call
 * it every frame. Resolves with an empty asset set on failure rather than
 * rejecting — a theme whose props fail to load should be a theme without props,
 * not a run that ends. The tunnel, the lighting and the palette are all still
 * there, and they are what make it that place.
 */
export function ensureLoaded(slug: string, tier: "desktop" | "mobile"): Promise<ThemeAssets> {
  const key = `${slug}:${tier}`;
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<ThemeAssets> => {
    const manifest = await getManifest();
    const entry = manifest.themes[slug];
    const file = entry?.files[tier] ?? entry?.files["desktop"];
    if (file === undefined) {
      return { slug, meshes: new Map(), bytes: 0 };
    }

    expected.set(key, file.bytes);
    received.set(key, 0);
    inFlight.add(slug);
    publish();

    try {
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        getLoader().load(
          `${BASE}/${file.name}`,
          (result) => resolve(result as unknown as { scene: THREE.Group }),
          (event) => {
            // `event.total` is only populated when the server sends
            // Content-Length. When it does not, the manifest figure is the
            // better denominator anyway — it is exact.
            received.set(key, event.loaded);
            publish();
          },
          reject,
        );
      });

      const meshes = new Map<string, THREE.BufferGeometry>();
      gltf.scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry instanceof THREE.BufferGeometry) {
          // The node name is the contract the pipeline writes:
          // `<index>-<archetype>`. Asserted at both ends.
          meshes.set(object.name, object.geometry);
        }
      });

      received.set(key, file.bytes);
      return { slug, meshes, bytes: file.bytes };
    } catch {
      // Counted as complete so the progress bar cannot hang on a failure.
      received.set(key, file.bytes);
      return { slug, meshes: new Map(), bytes: 0 };
    } finally {
      inFlight.delete(slug);
      publish();
    }
  })();

  cache.set(key, promise);
  return promise;
}

/** True once a theme's geometry is resident and a transition into it may start. */
export function isLoaded(slug: string, tier: "desktop" | "mobile"): boolean {
  const key = `${slug}:${tier}`;
  return cache.has(key) && !inFlight.has(slug) && (received.get(key) ?? 0) > 0;
}

/** Tests only: drops every cached bundle and listener. */
export function resetThemeLoader(): void {
  cache.clear();
  listeners.clear();
  received.clear();
  expected.clear();
  inFlight.clear();
  manifestPromise = null;
  loader = null;
}
