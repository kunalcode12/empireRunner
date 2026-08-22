/**
 * "A prop is never inside a lane", checked exhaustively rather than sampled.
 *
 * This is the one claim in the prop system a player can be hurt by. A prop that
 * reaches into the play space either reads as an obstacle — costing a run to a
 * dodge that was never needed — or worse, reads as scenery while sitting where
 * the player expects to be able to go.
 *
 * So it is not spot-checked. Every side, every slot at every quality tier, every
 * archetype in every theme, at the archetype's real measured extent: the full
 * cross product, which is a few thousand cases and runs in milliseconds.
 *
 * ## The geometry is measured, not assumed
 *
 * The half-extent comes from the same builders `scripts/build-themes.mjs` uses,
 * so the number under test is the number that ships. Asserting against a size
 * from the registry instead would test the arithmetic while leaving the actual
 * question — how big is the mesh — unasked, which is precisely how the first
 * version of this passed while 2u panels drove a metre into the outer lane.
 */

import { describe, expect, it } from "vitest";
import { THEMES, type PropArchetypeName, type Theme } from "@/game/config/themes";
import { TUNING } from "@/game/config/tuning";
import { BUILDERS, LOD_DETAIL } from "../../scripts/lib/prop-geometry.mjs";
import { PLAYER_MAX_LATERAL, PROP_MIN_LATERAL, propLateral } from "@/game/render/props/PropField";

/** Every slot count the game can run at. */
const SLOT_COUNTS = [
  TUNING.props.maxPerSideLow,
  TUNING.props.maxPerSideMedium,
  TUNING.props.maxPerSideHigh,
];

const FACE_COUNT = TUNING.geometry.faceCount;

/**
 * The lateral half-extent of an archetype's mesh, after the base yaw.
 *
 * `PropField` applies a quarter turn so a wall-mounted prop's width runs ALONG
 * the tunnel, which means the geometry's local Z is what points laterally. Same
 * axis the runtime measures, from the same builder.
 */
function halfExtent(archetype: PropArchetypeName, size: number): number {
  const build = BUILDERS[archetype];
  let worst = 0;
  // Both LODs: they are simplifications at the SAME footprint, but the claim is
  // about whichever is on screen, so both are measured.
  for (const detail of [LOD_DETAIL.high, LOD_DETAIL.low]) {
    const mesh = build(size, detail);
    for (let i = 2; i < mesh.positions.length; i += 3) {
      const z = Math.abs(mesh.positions[i] ?? 0);
      if (z > worst) {
        worst = z;
      }
    }
  }
  return worst;
}

describe("prop placement can never reach the player", () => {
  it("puts the clearance boundary outside the player's widest reach", () => {
    // The boundary itself, before any prop is placed. `PLAYER_MAX_LATERAL` is
    // the outer lane centre plus half the player's width, symmetric across all
    // twelve cells, so it is the reach after ANY sequence of rolls.
    expect(PROP_MIN_LATERAL).toBeGreaterThan(PLAYER_MAX_LATERAL);
    expect(PROP_MIN_LATERAL - PLAYER_MAX_LATERAL).toBeCloseTo(TUNING.props.laneClearance, 6);
  });

  it("agrees with the tunnel geometry about where the player can be", () => {
    // Derived independently of `PropField`, so a change to either the lane
    // layout or the reach calculation shows up as a disagreement rather than as
    // two files quietly moving together.
    const expected =
      (TUNING.geometry.laneWidth * (TUNING.geometry.laneCount - 1)) / 2 +
      TUNING.geometry.playerWidth / 2;
    expect(PLAYER_MAX_LATERAL).toBeCloseTo(expected, 6);
    // And the reach must fit inside the prism, or the player is in the wall.
    expect(PLAYER_MAX_LATERAL).toBeLessThan(TUNING.geometry.prismInnerSize / 2);
  });

  it.each(THEMES.map((theme) => [theme.slug, theme] as const))(
    "%s: every prop's INNER EDGE clears the boundary, at every slot",
    (_slug, theme: Theme) => {
      let checked = 0;
      let tightest = Number.POSITIVE_INFINITY;

      for (const prop of theme.props) {
        const extent = halfExtent(prop.archetype, prop.size);
        for (const slots of SLOT_COUNTS) {
          for (let side = 0; side < FACE_COUNT; side += 1) {
            for (let slot = 0; slot < slots; slot += 1) {
              const anchor = propLateral(side, slot, extent);
              // The inner edge: the anchor pulled back toward the centreline by
              // the prop's own reach. This is the number that matters, and
              // anchoring the CENTRE instead is the bug this test exists for.
              const innerEdge = Math.abs(anchor) - extent;
              expect(
                innerEdge,
                `${theme.slug}/${prop.label} side ${side} slot ${slot}: inner edge ${innerEdge.toFixed(3)}u`,
              ).toBeGreaterThanOrEqual(PROP_MIN_LATERAL - 1e-9);
              tightest = Math.min(tightest, innerEdge);
              checked += 1;
            }
          }
        }
      }

      // The loop actually ran. A test that silently checks nothing is worse
      // than no test, because it reports success.
      expect(checked).toBeGreaterThan(200);
      expect(tightest).toBeGreaterThanOrEqual(PROP_MIN_LATERAL - 1e-9);
    },
  );

  it("furnishes both edges of every face rather than only one", () => {
    // Placement alternates sign on `(side + slot) % 2`. If it did not, three of
    // the four faces would be bare down one side and the tunnel would look
    // built rather than found.
    for (let side = 0; side < FACE_COUNT; side += 1) {
      const signs = new Set<number>();
      for (let slot = 0; slot < TUNING.props.maxPerSideHigh; slot += 1) {
        signs.add(Math.sign(propLateral(side, slot, 0)));
      }
      expect(signs.size, `side ${side} is furnished on one edge only`).toBe(2);
    }
  });

  it("is deterministic across calls", () => {
    // Placement is a hash of the slot index, not a draw from the sim RNG — the
    // same rule particles follow (TUNING §13d). Taking from the sim stream would
    // mean spawning a lantern changed the track layout.
    for (let side = 0; side < FACE_COUNT; side += 1) {
      for (let slot = 0; slot < 32; slot += 1) {
        expect(propLateral(side, slot, 1.25)).toBe(propLateral(side, slot, 1.25));
      }
    }
  });

  it("spreads laterally rather than stacking on one line", () => {
    const values = new Set<number>();
    for (let side = 0; side < FACE_COUNT; side += 1) {
      for (let slot = 0; slot < TUNING.props.maxPerSideHigh; slot += 1) {
        values.add(Number(propLateral(side, slot, 0).toFixed(4)));
      }
    }
    // A hash with a collapsed range would produce a handful of distinct values.
    expect(values.size).toBeGreaterThan(TUNING.props.maxPerSideHigh);
  });

  it("keeps the per-side slot counts ordered by quality tier", () => {
    expect(TUNING.props.maxPerSideLow).toBeLessThan(TUNING.props.maxPerSideMedium);
    expect(TUNING.props.maxPerSideMedium).toBeLessThan(TUNING.props.maxPerSideHigh);
    // The cull distance has to exceed the LOD swap, or the far mesh is never
    // drawn and the second LOD in every bundle is dead weight.
    expect(TUNING.props.cullDistance).toBeGreaterThan(TUNING.props.lodDistance);
  });
});
