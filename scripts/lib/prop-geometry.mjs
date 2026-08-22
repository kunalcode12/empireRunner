/**
 * Procedural prop geometry, authored at build time.
 *
 * ## Why these are generated rather than modelled
 *
 * CLAUDE.md: "No placeholder asset paths that 404 at runtime. Generate
 * procedural geometry instead." Every other asset class in AXIS follows the same
 * rule — P07's entities are primitives, P11's sounds are oscillators, P14's icons
 * are drawn paths. There is no artist and no asset library, so a prop set has to
 * come from arithmetic.
 *
 * They are generated at **build** time rather than at runtime for three reasons
 * the brief asks for directly: it gives the compressor something real to
 * compress, it gives the loader real bytes to stream and report progress
 * against, and it moves the cost off the main thread at the moment the player is
 * trying to start a run.
 *
 * ## The silhouette rule
 *
 * Every archetype is shaped so it **cannot** be mistaken for something the player
 * can hit. A prop that reads as an obstacle costs a run, and that is a bug the
 * player pays for. Obstacles are upright, solid and squarely in a lane; props
 * hang, sag, lean and clutter, and they are always beyond the wall. The
 * distinction is enforced in three places — the silhouettes here, the placement
 * clearance in `PropField`, and a test that asserts no prop is inside the prism.
 *
 * Everything below returns flat typed arrays. No three.js: this runs in Node,
 * and the GLB writer wants raw buffers anyway.
 */

/** @typedef {{ positions: Float32Array, normals: Float32Array, indices: Uint16Array }} Mesh */

/**
 * A builder collecting triangles.
 *
 * Positions and normals are written per-vertex with no sharing, because these
 * shapes are faceted by design — a flat-shaded silhouette is the art direction,
 * and welding would smooth exactly the edges that make a prop read as a cut-out.
 * `weld()` in the pipeline is therefore NOT applied to prop geometry.
 */
class Builder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.indices = [];
  }

  /** Adds one quad as two triangles, with a flat normal computed from its plane. */
  quad(a, b, c, d) {
    const base = this.positions.length / 3;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    for (const v of [a, b, c, d]) {
      this.positions.push(v[0], v[1], v[2]);
      this.normals.push(nx, ny, nz);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * A box that may taper: the top face can be a different size from the bottom.
   *
   * Taper is what stops props reading as obstacles. Every gameplay obstacle in
   * the catalogue is a right prism; a leaning, tapering form is instantly not one.
   */
  box(cx, cy, cz, w, h, d, topScale = 1) {
    const hw = w / 2;
    const hd = d / 2;
    const tw = hw * topScale;
    const td = hd * topScale;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;

    const b00 = [cx - hw, y0, cz - hd];
    const b10 = [cx + hw, y0, cz - hd];
    const b11 = [cx + hw, y0, cz + hd];
    const b01 = [cx - hw, y0, cz + hd];
    const t00 = [cx - tw, y1, cz - td];
    const t10 = [cx + tw, y1, cz - td];
    const t11 = [cx + tw, y1, cz + td];
    const t01 = [cx - tw, y1, cz + td];

    this.quad(b01, b11, t11, t01); // +z
    this.quad(b10, b00, t00, t10); // -z
    this.quad(b11, b10, t10, t11); // +x
    this.quad(b00, b01, t01, t00); // -x
    this.quad(t00, t01, t11, t10); // top
    this.quad(b01, b00, b10, b11); // bottom
    return this;
  }

  build() {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint16Array(this.indices),
    };
  }
}

/**
 * HANGING — suspended from the ceiling on a line.
 *
 * A thin drop with a wider body that tapers outward at the bottom. Nothing in
 * the obstacle catalogue hangs, so this silhouette is unambiguous the moment it
 * is on screen. `detail` splits the body into segments so the low LOD can be one
 * slab and the high one can sag.
 */
export function hanging(size, detail) {
  const b = new Builder();
  const dropWidth = 0.06 * size;
  const bodyWidth = 0.52 * size;
  const bodyHeight = 0.7 * size;
  const dropHeight = 0.55 * size;

  // The line it hangs from.
  b.box(0, -dropHeight / 2, 0, dropWidth, dropHeight, dropWidth);

  // The body, in `detail` slabs that widen and sway as they descend.
  const segments = Math.max(1, detail);
  const segH = bodyHeight / segments;
  for (let i = 0; i < segments; i += 1) {
    const t = (i + 0.5) / segments;
    const y = -dropHeight - segH * (i + 0.5);
    // A slight lean so it reads as cloth or slack cable rather than a post.
    const lean = Math.sin(t * 2.2) * 0.14 * size;
    b.box(lean, y, 0, bodyWidth * (0.7 + t * 0.5), segH, bodyWidth * 0.28, 0.92);
  }
  return b.build();
}

/**
 * CLUTTER — squat mass against the wall base.
 *
 * Deliberately WIDER than it is tall. Every obstacle that stops a player is at
 * least as tall as they are; a form whose height is well under its footprint
 * reads as scenery even in peripheral vision.
 */
export function clutter(size, detail) {
  const b = new Builder();
  const pieces = Math.max(1, detail);
  for (let i = 0; i < pieces; i += 1) {
    const t = pieces === 1 ? 0 : i / (pieces - 1);
    const w = size * (0.85 - t * 0.3);
    const h = size * (0.42 - t * 0.14);
    b.box(
      (t - 0.5) * size * 0.5,
      h / 2 + t * size * 0.18,
      Math.sin(i * 2.4) * size * 0.22,
      w,
      h,
      size * 0.6,
      0.86,
    );
  }
  return b.build();
}

/**
 * MAST — a tall thin vertical, set behind the wall plane.
 *
 * The one archetype that IS taller than the player, which is why it is the one
 * placed furthest back and given the thinnest profile. A mast at 0.08 of its
 * height cannot be confused with a Stack at 2.4u.
 */
export function mast(size, detail) {
  const b = new Builder();
  const segments = Math.max(1, detail);
  const segH = size / segments;
  for (let i = 0; i < segments; i += 1) {
    const t = (i + 0.5) / segments;
    const thickness = size * 0.075 * (1 - t * 0.45);
    b.box(0, segH * (i + 0.5), 0, thickness, segH, thickness, 0.9);
  }
  // Cross-arms near the top: aerials, conduit brackets, flue stays.
  if (detail > 1) {
    const armY = size * 0.82;
    b.box(0, armY, 0, size * 0.42, size * 0.035, size * 0.035);
    b.box(0, armY - size * 0.12, 0, size * 0.3, size * 0.03, size * 0.03);
  }
  return b.build();
}

/**
 * PANEL — a flat plate fixed to the wall.
 *
 * The lowest-relief archetype, and the cheapest: a panel is one slab plus a
 * frame. It is what fills a wall without adding silhouette, which is why it
 * carries the highest weight in Static (test cards, dead monitors).
 */
export function panel(size, detail) {
  const b = new Builder();
  const w = size;
  const h = size * 0.68;
  const depth = size * 0.08;
  b.box(0, h / 2, 0, w, h, depth);
  if (detail > 1) {
    // An inset face, so the panel reads as framed rather than as a blank slab.
    const inset = size * 0.12;
    b.box(0, h / 2, depth * 0.6, w - inset, h - inset, depth * 0.35);
  }
  return b.build();
}

/** Archetype name to builder. Adding an archetype is one entry here. */
export const BUILDERS = Object.freeze({
  hanging,
  clutter,
  mast,
  panel,
});

/**
 * Detail levels per LOD tier.
 *
 * The low tier is a *simplified silhouette at the same footprint*, never a
 * shrunken copy: a prop that gets smaller with distance reads as the world
 * receding wrongly. Same size, fewer segments.
 */
export const LOD_DETAIL = Object.freeze({ high: 4, mid: 2, low: 1 });
