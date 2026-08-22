/**
 * The theme asset pipeline.
 *
 * Generates each theme's prop geometry, compresses it, and writes one `.glb` per
 * theme per quality tier into `public/themes/`, plus a manifest the runtime
 * loader reads for progress reporting.
 *
 *   node --import ./scripts/lib/ts-register.mjs scripts/build-themes.mjs
 *   npm run build:themes
 *
 * ## meshopt, not Draco
 *
 * The brief allows either. meshopt wins here for a concrete reason rather than a
 * preference: `three` already ships **both** halves of it —
 * `meshopt_decoder.module.js` for runtime and `meshopt_simplifier.module.js` for
 * build-time decimation — so the runtime cost is zero new dependencies and zero
 * extra files in `public/`. Draco would require copying `draco_decoder.wasm`
 * (~200KB) into `public/` and loading it before the first prop can be drawn,
 * which is 200KB spent against a 4MB first-frame budget to decode geometry that
 * meshopt decodes faster.
 *
 * ## No textures, and that is the art direction rather than a shortcut
 *
 * GAME_BIBLE §11.1: "Every surface is one flat colour. No gradient ramps." The
 * halftone is defined as "a screen-space dot pattern" — computed per fragment,
 * not sampled. A KTX2 texture set would be inventing work the art direction
 * forbids, so this pipeline **validates** textures rather than generating them:
 * any texture that appears in `public/` is checked for power-of-two dimensions
 * and against its budget, and the build fails if either is wrong. The check is
 * live; it simply has nothing to reject yet.
 *
 * ## Two tiers
 *
 * `2048 desktop / 1024 mobile` in the brief describes texture sets. With no
 * textures the equivalent axis is geometry: `<slug>.glb` carries the full-detail
 * props for desktop and `<slug>.low.glb` a decimated set for mobile, selected by
 * the same quality tier that already drives shadows and pixel ratio.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

import { BUILDERS, LOD_DETAIL } from "./lib/prop-geometry.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = path.join(ROOT, "public", "themes");

/**
 * Tiers this pipeline emits.
 *
 * Each bundle carries **both LOD levels** for every prop, under the same mesh
 * names in both tiers — so the runtime picks a file and then never branches
 * again. What the tier changes is how detailed "near" is: a mobile bundle's near
 * LOD is roughly a desktop bundle's far one.
 *
 * Shipping one LOD per file was the first design and it was wrong: desktop would
 * have had to fetch both files to get a far LOD, which is two requests to save
 * geometry that is 6KB in total.
 */
const TIERS = [
  { suffix: "", near: LOD_DETAIL.high, far: LOD_DETAIL.low, label: "desktop" },
  { suffix: ".low", near: LOD_DETAIL.mid, far: LOD_DETAIL.low, label: "mobile" },
];

/** Mesh-name suffixes. The contract between this script and `props/PropField`. */
const LOD_NEAR = "near";
const LOD_FAR = "far";

/**
 * Writes one theme's props into a glTF document.
 *
 * One mesh per prop entry, named `<index>-<archetype>` so the runtime can map a
 * loaded mesh back to the registry entry that described it. The name is the only
 * contract between the pipeline and the loader, and it is asserted at both ends.
 */
function buildThemeDocument(theme, tier) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(theme.slug);

  theme.props.forEach((prop, index) => {
    const build = BUILDERS[prop.archetype];
    if (build === undefined) {
      throw new Error(
        `Theme "${theme.slug}" prop ${index} uses unknown archetype "${prop.archetype}". ` +
          `Add a builder to scripts/lib/prop-geometry.mjs.`,
      );
    }

    for (const [lod, detail] of [
      [LOD_NEAR, tier.near],
      [LOD_FAR, tier.far],
    ]) {
      const geo = build(prop.size, detail);
      const key = `${theme.slug}-${index}-${lod}`;

      const position = doc
        .createAccessor(`${key}-pos`)
        .setType("VEC3")
        .setArray(geo.positions)
        .setBuffer(buffer);
      const normal = doc
        .createAccessor(`${key}-nrm`)
        .setType("VEC3")
        .setArray(geo.normals)
        .setBuffer(buffer);
      const indices = doc
        .createAccessor(`${key}-idx`)
        .setType("SCALAR")
        .setArray(geo.indices)
        .setBuffer(buffer);

      const primitive = doc
        .createPrimitive()
        .setAttribute("POSITION", position)
        .setAttribute("NORMAL", normal)
        .setIndices(indices);

      // No material is written. Colour comes from the registry at runtime as a
      // per-instance attribute, which is what lets one prop mesh serve a theme's
      // whole palette and lets a crossfade retint without touching geometry.
      const name = `${index}-${prop.archetype}-${lod}`;
      const mesh = doc.createMesh(name).addPrimitive(primitive);
      scene.addChild(doc.createNode(name).setMesh(mesh));
    }
  });

  return doc;
}

/** Scans `public/` for textures and enforces the rules the brief asks for. */
function validateTextures() {
  const failures = [];
  const publicDir = path.join(ROOT, "public");
  const TEXTURE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".basis"]);
  const MAX_TEXTURE_BYTES = 512 * 1024;

  /** PNG and KTX2 both carry dimensions in a fixed header offset. */
  function dimensionsOf(file) {
    if (path.extname(file).toLowerCase() !== ".png") {
      return null;
    }
    const head = readFileSync(file).subarray(16, 24);
    return { width: head.readUInt32BE(0), height: head.readUInt32BE(4) };
  }

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!TEXTURE_EXT.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const size = statSync(full).size;
      if (size > MAX_TEXTURE_BYTES) {
        failures.push(`${entry.name} is ${(size / 1024).toFixed(0)}KB (max 512KB)`);
      }
      const dims = dimensionsOf(full);
      if (dims !== null) {
        const pot = (n) => (n & (n - 1)) === 0;
        if (!pot(dims.width) || !pot(dims.height)) {
          failures.push(`${entry.name} is ${dims.width}x${dims.height} — not power-of-two`);
        }
      }
    }
  };

  if (existsSync(publicDir)) {
    walk(publicDir);
  }
  return failures;
}

async function main() {
  await MeshoptEncoder.ready;

  const { THEMES } = await import("../src/game/config/themes/index.ts");
  const { TUNING } = await import("../src/game/config/tuning.ts");
  const bundleBudget = TUNING.budgets.themeBundleBytes;

  // Rebuilt from scratch so a removed theme cannot leave a stale bundle behind
  // that the manifest no longer mentions but the browser still caches.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // ALL_EXTENSIONS, not just EXT_meshopt_compression: `meshopt()` also quantises,
  // which needs KHR_mesh_quantization DECLARED or a reader misinterprets the
  // integer accessors as raw integers. Registering only the one extension left
  // gltf-transform warning that something would "not be written" — and the thing
  // it would have dropped was the declaration that makes the file readable.
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
  });

  const manifest = { themes: {}, generatedAt: new Date().toISOString() };
  const failures = [];
  let total = 0;

  for (const theme of THEMES) {
    manifest.themes[theme.slug] = { files: {}, props: theme.props.length };

    for (const tier of TIERS) {
      const doc = buildThemeDocument(theme, tier);

      // meshopt: quantise attributes, then compress. `weld` is deliberately NOT
      // run — these silhouettes are flat-shaded, and welding would merge the
      // vertices whose split normals make the facets read.
      await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));

      const bytes = await io.writeBinary(doc);
      const name = `${theme.slug}${tier.suffix}.glb`;
      writeFileSync(path.join(OUT_DIR, name), bytes);

      manifest.themes[theme.slug].files[tier.label] = { name, bytes: bytes.byteLength };
      total += bytes.byteLength;

      if (bytes.byteLength > bundleBudget) {
        failures.push(
          `${name} is ${(bytes.byteLength / 1024).toFixed(1)}KB, over the ` +
            `${(bundleBudget / 1024).toFixed(0)}KB per-bundle budget`,
        );
      }
      console.log(
        `  ${name.padEnd(22)} ${String(bytes.byteLength).padStart(7)} B  ` +
          `${theme.props.length} props  (${tier.label})`,
      );
    }
  }

  failures.push(...validateTextures());

  writeFileSync(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  ${"manifest.json".padEnd(22)} ${String(total).padStart(7)} B total geometry`);

  if (failures.length > 0) {
    console.error("\nAsset budget failures:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("\nAll theme bundles within budget.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
