import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  applyRoll,
  clampLane,
  createFaceLane,
  isValidFace,
  isValidLane,
  laneCentreX,
  mirrorLateral,
  RollDirection,
  rollFace,
  rollLane,
} from "@/game/sim/player/facing";

/**
 * The face/lane transform, exhaustively.
 *
 * 4 faces x 3 lanes x 2 directions = 24 cases, every one of them written out
 * rather than generated, so a wrong expectation is visible in the diff instead
 * of being computed by the same (possibly wrong) rule the code uses.
 */

const FACE_COUNT = TUNING.geometry.faceCount;
const LANE_COUNT = TUNING.geometry.laneCount;

/** [fromFace, fromLane, direction, toFace, toLane] */
type Case = readonly [number, number, number, number, number];

const RIGHT = RollDirection.Right;
const LEFT = RollDirection.Left;

const ALL_24_CASES: readonly Case[] = [
  // ── roll RIGHT: face + 1, lane mirrors ────────────────────────────────────
  [0, 0, RIGHT, 1, 2],
  [0, 1, RIGHT, 1, 1],
  [0, 2, RIGHT, 1, 0],
  [1, 0, RIGHT, 2, 2],
  [1, 1, RIGHT, 2, 1],
  [1, 2, RIGHT, 2, 0],
  [2, 0, RIGHT, 3, 2],
  [2, 1, RIGHT, 3, 1],
  [2, 2, RIGHT, 3, 0],
  [3, 0, RIGHT, 0, 2],
  [3, 1, RIGHT, 0, 1],
  [3, 2, RIGHT, 0, 0],

  // ── roll LEFT: face - 1, lane mirrors ─────────────────────────────────────
  [0, 0, LEFT, 3, 2],
  [0, 1, LEFT, 3, 1],
  [0, 2, LEFT, 3, 0],
  [1, 0, LEFT, 0, 2],
  [1, 1, LEFT, 0, 1],
  [1, 2, LEFT, 0, 0],
  [2, 0, LEFT, 1, 2],
  [2, 1, LEFT, 1, 1],
  [2, 2, LEFT, 1, 0],
  [3, 0, LEFT, 2, 2],
  [3, 1, LEFT, 2, 1],
  [3, 2, LEFT, 2, 0],
];

describe("all 24 face/lane transforms", () => {
  it("covers every face, lane and direction exactly once", () => {
    expect(ALL_24_CASES).toHaveLength(FACE_COUNT * LANE_COUNT * 2);
    const keys = new Set(ALL_24_CASES.map(([f, l, d]) => `${f}:${l}:${d}`));
    expect(keys.size).toBe(24);
  });

  it.each(ALL_24_CASES)(
    "face %i lane %i rolling %i -> face %i lane %i",
    (fromFace, fromLane, direction, toFace, toLane) => {
      const out = createFaceLane();
      applyRoll(fromFace, fromLane, direction, out);
      expect(out.face).toBe(toFace);
      expect(out.lane).toBe(toLane);
    },
  );
});

describe("the worked example from GAME_BIBLE §3.2", () => {
  it("face 0, lane 2, roll right -> face 1, lane 0", () => {
    const out = createFaceLane();
    applyRoll(0, 2, RollDirection.Right, out);
    expect(out.face).toBe(1);
    expect(out.lane).toBe(0);
  });
});

describe("face arithmetic", () => {
  it("wraps forward past the last face", () => {
    expect(rollFace(FACE_COUNT - 1, RollDirection.Right)).toBe(0);
  });

  it("wraps backward past face 0 without going negative", () => {
    // JavaScript's % is a remainder, not a modulus: (0 - 1) % 4 === -1.
    expect(rollFace(0, RollDirection.Left)).toBe(FACE_COUNT - 1);
    expect(rollFace(0, RollDirection.Left)).toBeGreaterThanOrEqual(0);
  });

  it("is a no-op for RollDirection.None", () => {
    for (let face = 0; face < FACE_COUNT; face += 1) {
      expect(rollFace(face, RollDirection.None)).toBe(face);
    }
  });

  it("four rolls in one direction return to the start", () => {
    for (const direction of [RollDirection.Left, RollDirection.Right]) {
      let face = 0;
      for (let i = 0; i < FACE_COUNT; i += 1) {
        face = rollFace(face, direction);
      }
      expect(face).toBe(0);
    }
  });

  it("left and right are inverses", () => {
    for (let face = 0; face < FACE_COUNT; face += 1) {
      expect(rollFace(rollFace(face, RollDirection.Right), RollDirection.Left)).toBe(face);
    }
  });
});

describe("lane mirroring", () => {
  it("mirrors in BOTH directions — the counterintuitive part", () => {
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      expect(rollLane(lane, RollDirection.Right)).toBe(LANE_COUNT - 1 - lane);
      expect(rollLane(lane, RollDirection.Left)).toBe(LANE_COUNT - 1 - lane);
    }
  });

  it("leaves the centre lane alone", () => {
    const centre = (LANE_COUNT - 1) / 2;
    expect(rollLane(centre, RollDirection.Right)).toBe(centre);
  });

  it("is its own inverse — a 180 returns the original lane", () => {
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      const after180 = rollLane(rollLane(lane, RollDirection.Right), RollDirection.Right);
      expect(after180).toBe(lane);
    }
  });

  it("a 180 lands on the opposite face in the same relative lane", () => {
    const out = createFaceLane();
    applyRoll(0, 0, RollDirection.Right, out);
    applyRoll(out.face, out.lane, RollDirection.Right, out);
    expect(out.face).toBe(2);
    expect(out.lane).toBe(0);
  });
});

describe("lateral coordinates", () => {
  it("lane centres are symmetric about zero", () => {
    expect(laneCentreX(0)).toBeCloseTo(-TUNING.geometry.laneWidth, 12);
    expect(laneCentreX(1)).toBe(0);
    expect(laneCentreX(2)).toBeCloseTo(TUNING.geometry.laneWidth, 12);
  });

  it("a roll is exactly a negation of x", () => {
    // The property that lets a lane tween survive a roll with no special case.
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      const before = laneCentreX(lane);
      const after = laneCentreX(rollLane(lane, RollDirection.Right));
      expect(after).toBeCloseTo(mirrorLateral(before), 12);
    }
  });

  it("mirrors mid-tween positions too, not just lane centres", () => {
    const midTween = 0.83;
    expect(mirrorLateral(midTween)).toBeCloseTo(-midTween, 12);
  });
});

describe("validation and clamping", () => {
  it("accepts every real face and lane", () => {
    for (let face = 0; face < FACE_COUNT; face += 1) {
      expect(isValidFace(face)).toBe(true);
    }
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      expect(isValidLane(lane)).toBe(true);
    }
  });

  it("rejects out-of-range and non-integer indices", () => {
    expect(isValidFace(-1)).toBe(false);
    expect(isValidFace(FACE_COUNT)).toBe(false);
    expect(isValidFace(1.5)).toBe(false);
    expect(isValidLane(-1)).toBe(false);
    expect(isValidLane(LANE_COUNT)).toBe(false);
  });

  it("clamps rather than erroring at the walls", () => {
    // Walking into the wall should feel like nothing happened.
    expect(clampLane(-1)).toBe(0);
    expect(clampLane(LANE_COUNT)).toBe(LANE_COUNT - 1);
    expect(clampLane(1)).toBe(1);
  });
});

describe("the transform never produces an invalid position", () => {
  it("holds for all 24 cases", () => {
    const out = createFaceLane();
    for (const [face, lane, direction] of ALL_24_CASES) {
      applyRoll(face, lane, direction, out);
      expect(isValidFace(out.face)).toBe(true);
      expect(isValidLane(out.lane)).toBe(true);
    }
  });

  it("holds across a thousand random rolls", () => {
    const out = createFaceLane();
    let face = 0;
    let lane = 1;
    for (let i = 0; i < 1000; i += 1) {
      const direction = i % 2 === 0 ? RollDirection.Right : RollDirection.Left;
      applyRoll(face, lane, direction, out);
      face = out.face;
      lane = out.lane;
      expect(isValidFace(face)).toBe(true);
      expect(isValidLane(lane)).toBe(true);
    }
  });
});
