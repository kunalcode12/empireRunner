import { afterEach, describe, expect, it } from "vitest";
import { Phase } from "@/game/sim/state";
import {
  canTransition,
  destinationOf,
  Edge,
  IllegalTransitionError,
  isGroundedPhase,
  isTerminalPhase,
  phaseName,
  setPhaseDevMode,
  TRANSITIONS,
  tryTransition,
  type EdgeName,
} from "@/game/sim/player/phase";

/**
 * The phase machine, exhaustively.
 *
 * Walks every (phase, edge) pair — 8 x 16 = 128 — and asserts that exactly the
 * pairs in the table are legal and every other pair is rejected. That is what
 * "exhaustive, no implicit transitions" has to mean to be worth anything.
 */

const ALL_PHASES: readonly number[] = Object.values(Phase);
const ALL_EDGES: readonly EdgeName[] = Object.values(Edge);

/** Every legal (from, edge, to) triple, written out independently of the table. */
const LEGAL: readonly (readonly [number, EdgeName, number])[] = [
  [Phase.Running, Edge.JumpStart, Phase.Jumping],
  [Phase.Running, Edge.SlideStart, Phase.Sliding],
  [Phase.Running, Edge.RollStart, Phase.Rolling],
  [Phase.Running, Edge.LeaveGround, Phase.Falling],
  [Phase.Running, Edge.StumbleHit, Phase.Stumbling],
  [Phase.Running, Edge.FatalHit, Phase.Crashed],

  [Phase.Jumping, Edge.Apex, Phase.Falling],
  [Phase.Jumping, Edge.Land, Phase.Running],
  [Phase.Jumping, Edge.LandIntoSlide, Phase.Sliding],
  [Phase.Jumping, Edge.StumbleHit, Phase.Stumbling],
  [Phase.Jumping, Edge.FatalHit, Phase.Crashed],

  [Phase.Falling, Edge.JumpStart, Phase.Jumping],
  [Phase.Falling, Edge.Land, Phase.Running],
  [Phase.Falling, Edge.LandIntoSlide, Phase.Sliding],
  [Phase.Falling, Edge.StumbleHit, Phase.Stumbling],
  [Phase.Falling, Edge.FatalHit, Phase.Crashed],
  [Phase.Falling, Edge.FellOutOfWorld, Phase.Crashed],

  [Phase.Sliding, Edge.SlideEnd, Phase.Running],
  [Phase.Sliding, Edge.LeaveGround, Phase.Falling],
  [Phase.Sliding, Edge.StumbleHit, Phase.Stumbling],
  [Phase.Sliding, Edge.FatalHit, Phase.Crashed],

  [Phase.Rolling, Edge.RollEnd, Phase.Running],
  [Phase.Rolling, Edge.JumpStart, Phase.Jumping],
  [Phase.Rolling, Edge.SlideStart, Phase.Sliding],
  [Phase.Rolling, Edge.LeaveGround, Phase.Falling],
  [Phase.Rolling, Edge.StumbleHit, Phase.Stumbling],
  [Phase.Rolling, Edge.FatalHit, Phase.Crashed],

  [Phase.Stumbling, Edge.StumbleRecovered, Phase.Running],
  [Phase.Stumbling, Edge.LeaveGround, Phase.Falling],
  [Phase.Stumbling, Edge.FatalHit, Phase.Crashed],

  [Phase.Crashed, Edge.FractureArm, Phase.Fracturing],

  [Phase.Fracturing, Edge.FractureSuccess, Phase.Running],
  [Phase.Fracturing, Edge.FractureFail, Phase.Crashed],
];

function isLegal(from: number, edge: EdgeName): boolean {
  return LEGAL.some(([f, e]) => f === from && e === edge);
}

afterEach(() => {
  setPhaseDevMode(true);
});

describe("the table matches the independently-written expectation", () => {
  it("has all 8 phases", () => {
    expect(ALL_PHASES).toHaveLength(8);
    expect(Object.keys(TRANSITIONS)).toHaveLength(8);
  });

  it.each(LEGAL)("phase %i --%s--> phase %i is legal", (from, edge, to) => {
    expect(canTransition(from, edge)).toBe(true);
    expect(destinationOf(from, edge)).toBe(to);
    expect(tryTransition(from, edge)).toBe(to);
  });

  it("contains no edges the expectation does not list", () => {
    const extra: string[] = [];
    for (const from of ALL_PHASES) {
      const row = TRANSITIONS[from] ?? {};
      for (const edge of Object.keys(row) as EdgeName[]) {
        if (!isLegal(from, edge)) {
          extra.push(`${phaseName(from)} --${edge}-->`);
        }
      }
    }
    expect(extra).toEqual([]);
  });
});

describe("every illegal pair is rejected", () => {
  it("throws in dev for all 128 - 30 illegal combinations", () => {
    setPhaseDevMode(true);
    let checked = 0;
    for (const from of ALL_PHASES) {
      for (const edge of ALL_EDGES) {
        if (isLegal(from, edge)) {
          continue;
        }
        checked += 1;
        expect(
          () => tryTransition(from, edge),
          `${phaseName(from)} --${edge}--> should be illegal`,
        ).toThrow(IllegalTransitionError);
      }
    }
    expect(checked).toBe(ALL_PHASES.length * ALL_EDGES.length - LEGAL.length);
  });

  it("is ignored in prod, leaving the phase untouched", () => {
    setPhaseDevMode(false);
    for (const from of ALL_PHASES) {
      for (const edge of ALL_EDGES) {
        if (isLegal(from, edge)) {
          continue;
        }
        expect(tryTransition(from, edge)).toBe(from);
      }
    }
  });

  it("names the phase and the edge in the error", () => {
    setPhaseDevMode(true);
    expect(() => tryTransition(Phase.Crashed, Edge.JumpStart)).toThrow(/CRASHED/);
    expect(() => tryTransition(Phase.Crashed, Edge.JumpStart)).toThrow(/JumpStart/);
  });

  it("reports -1 from destinationOf rather than a plausible phase", () => {
    expect(destinationOf(Phase.Crashed, Edge.JumpStart)).toBe(-1);
  });
});

describe("the shapes the rest of the controller relies on", () => {
  it("CRASHED is terminal apart from arming a Fracture", () => {
    const row = TRANSITIONS[Phase.Crashed] ?? {};
    expect(Object.keys(row)).toEqual([Edge.FractureArm]);
  });

  it("every phase except the terminal two can reach CRASHED", () => {
    for (const from of ALL_PHASES) {
      if (from === Phase.Crashed || from === Phase.Fracturing) {
        continue;
      }
      expect(canTransition(from, Edge.FatalHit)).toBe(true);
    }
  });

  it("a slide cannot be cancelled by jumping", () => {
    // docs/TUNING.md §5: the slide runs its full duration. The buffer is what
    // makes an early jump press feel responsive, not a cancel.
    expect(canTransition(Phase.Sliding, Edge.JumpStart)).toBe(false);
  });

  it("classifies grounded phases correctly", () => {
    expect(isGroundedPhase(Phase.Running)).toBe(true);
    expect(isGroundedPhase(Phase.Sliding)).toBe(true);
    expect(isGroundedPhase(Phase.Rolling)).toBe(true);
    expect(isGroundedPhase(Phase.Jumping)).toBe(false);
    expect(isGroundedPhase(Phase.Falling)).toBe(false);
  });

  it("classifies terminal phases correctly", () => {
    expect(isTerminalPhase(Phase.Crashed)).toBe(true);
    expect(isTerminalPhase(Phase.Fracturing)).toBe(true);
    expect(isTerminalPhase(Phase.Running)).toBe(false);
  });

  it("ROLLING can still start a jump or a slide — GAME_BIBLE §3.2", () => {
    // Roll is concurrent. If these were false the roll would be a stance rather
    // than a world rotation, and the design intent would be lost.
    expect(canTransition(Phase.Rolling, Edge.JumpStart)).toBe(true);
    expect(canTransition(Phase.Rolling, Edge.SlideStart)).toBe(true);
  });

  it("names unknown phases rather than throwing", () => {
    expect(phaseName(99)).toContain("UNKNOWN");
  });
});
