import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  ALL_CHUNKS,
  Archetype,
  CHUNK_LENGTH,
  CHUNKS_BY_TIER,
  MAX_TIER,
  MIN_TIER,
  TRANSITION_CHUNK,
  maskCount,
} from "@/game/sim/level";
import { entityDef } from "@/game/sim/level/entities";
import { formatSlackTable, reportChunk, type ChunkReport } from "@/game/sim/level/validator";

/**
 * The authored pool, and the solver run over every chunk in it.
 *
 * This file is the build-time gate the prompt asks for: a chunk that the solver
 * cannot find a path through fails CI, and the slack table is printed so a
 * chunk that is *technically* survivable but inhuman is visible rather than
 * silently shipped.
 */

const MIN_PER_TIER = 5;
const MIN_CHUNKS = 28;

describe("pool coverage", () => {
  it(`has at least ${MIN_CHUNKS} chunks — the floor, not the target`, () => {
    expect(ALL_CHUNKS.length).toBeGreaterThanOrEqual(MIN_CHUNKS);
  });

  it(`has at least ${MIN_PER_TIER} chunks in every difficulty tier`, () => {
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier += 1) {
      const pool = CHUNKS_BY_TIER[tier] ?? [];
      expect(pool.length, `tier ${tier} has only ${pool.length}`).toBeGreaterThanOrEqual(
        MIN_PER_TIER,
      );
    }
  });

  it("contains every required archetype", () => {
    const required = [
      Archetype.PureDodge,
      Archetype.JumpGauntlet,
      Archetype.SlideCorridor,
      Archetype.ForcedRoll,
      Archetype.RollThenJump,
      Archetype.CoinReward,
      Archetype.NearMissBait,
      Archetype.Breather,
      Archetype.Fork,
      Archetype.MultiFaceWeave,
    ];
    const present = new Set(ALL_CHUNKS.map((c) => c.archetype));
    for (const archetype of required) {
      expect(present.has(archetype), `no chunk with archetype "${archetype}"`).toBe(true);
    }
  });

  it("gives every chunk a unique id", () => {
    const ids = ALL_CHUNKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a difficulty matching the tier it is filed under", () => {
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier += 1) {
      for (const chunk of CHUNKS_BY_TIER[tier] ?? []) {
        expect(chunk.difficulty, `${chunk.id} is filed in tier ${tier}`).toBe(tier);
      }
    }
  });

  it("keeps every entity inside the chunk's bounds", () => {
    for (const chunk of ALL_CHUNKS) {
      for (const e of chunk.entities) {
        expect(e.z, `${chunk.id}: entity z out of range`).toBeGreaterThanOrEqual(0);
        expect(e.z, `${chunk.id}: entity z out of range`).toBeLessThanOrEqual(CHUNK_LENGTH);
        expect(e.face).toBeGreaterThanOrEqual(0);
        expect(e.face).toBeLessThan(TUNING.geometry.faceCount);
        expect(e.lane).toBeGreaterThanOrEqual(0);
        expect(e.lane).toBeLessThan(TUNING.geometry.laneCount);
      }
    }
  });

  it("never uses an entity below its minimum band", () => {
    // A Full-Face Wall in tier 1 would demand a roll the player has not been
    // taught yet. TUNING.md §10.
    for (const chunk of ALL_CHUNKS) {
      for (const e of chunk.entities) {
        const def = entityDef(e.type);
        expect(
          chunk.difficulty,
          `${chunk.id} uses ${def.name} (min band ${def.minBand}) at tier ${chunk.difficulty}`,
        ).toBeGreaterThanOrEqual(def.minBand);
      }
    }
  });

  it("leaves at least one safe cell at every seam", () => {
    for (const chunk of ALL_CHUNKS) {
      expect(maskCount(chunk.entryConstraint.safeCells), `${chunk.id} entry`).toBeGreaterThan(0);
      expect(maskCount(chunk.exitConstraint.safeCells), `${chunk.id} exit`).toBeGreaterThan(0);
    }
  });

  it("keeps the transition chunk empty", () => {
    // It is the run's only guaranteed rest. Anything in it defeats the point.
    expect(TRANSITION_CHUNK.entities).toHaveLength(0);
  });

  it("declares a positive weight for every chunk", () => {
    for (const chunk of ALL_CHUNKS) {
      expect(chunk.weight, chunk.id).toBeGreaterThan(0);
    }
  });
});

describe("every authored chunk is solvable at maxSpeed", () => {
  const reports: ChunkReport[] = ALL_CHUNKS.map(reportChunk);

  it("prints the per-chunk slack table", () => {
    const tight = reports.filter((r) => r.tight);
    const unsolvable = reports.filter((r) => !r.solvable);

    console.log(
      `\n=== SOLVER: per-chunk slack at maxSpeed ${TUNING.speed.maxSpeed} u/s ===\n` +
        `slack = ticks the player can be frozen on entry and still survive\n` +
        `TIGHT = below TUNING.level.minSolverSlackTicks (${TUNING.level.minSolverSlackTicks})\n\n` +
        formatSlackTable(reports) +
        `\n\n${reports.length} chunks | ${unsolvable.length} unsolvable | ${tight.length} tight\n`,
    );

    expect(reports.length).toBe(ALL_CHUNKS.length);
  });

  it.each(ALL_CHUNKS.map((c) => [c.id] as const))("%s has a surviving path", (id) => {
    const report = reports.find((r) => r.chunkId === id);
    expect(report, `no report for ${id}`).toBeDefined();
    expect(report?.solvable, `${id} is UNSOLVABLE — no path exists at maxSpeed`).toBe(true);
  });

  it("solves from every entry cell its constraint permits", () => {
    // A chunk that only works from the centre of the floor is a chunk that
    // kills anyone the previous chunk delivered elsewhere.
    for (const report of reports) {
      expect(report.entriesTested, `${report.chunkId} tested no entries`).toBeGreaterThan(0);
    }
  });

  it("reaches at least one exit cell from every chunk", () => {
    for (const report of reports) {
      expect(maskCount(report.reachableExit), `${report.chunkId}`).toBeGreaterThan(0);
    }
  });

  it("reports how many chunks are tight rather than failing on them", () => {
    // Tightness is a design signal, not an error: a tier-5 chunk SHOULD be
    // tight. What matters is that it is visible and counted.
    const tight = reports.filter((r) => r.tight);
    for (const r of tight) {
      console.log(`[tight] ${r.chunkId} (tier ${r.difficulty}) slack=${r.minSlackTicks}`);
    }
    // A pool where most chunks are frame-perfect is a broken pool.
    expect(tight.length).toBeLessThan(reports.length / 2);
  });
});
