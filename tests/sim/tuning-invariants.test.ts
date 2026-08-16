import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";

/**
 * Tuning invariants — docs/ARCHITECTURE.md §5, assigned to P01.
 *
 * These exist so a bad edit to tuning.ts fails loudly instead of quietly breaking
 * game feel. Every assertion here corresponds to a "Must stay ..." note in
 * docs/TUNING.md; if you change a number and one of these goes red, the number is
 * wrong, not the test.
 */

describe("the four required invariants", () => {
  it("rollCommitLock < rollDuration", () => {
    // Equal or greater means the player lands from a roll with no ability to
    // adjust, so every roll into a partially-blocked face is an unavoidable death.
    expect(TUNING.roll.rollCommitLock).toBeLessThan(TUNING.roll.rollDuration);
  });

  it("speedCeiling + flowSpeedBonus <= maxSpeed", () => {
    // Otherwise Flow's contribution is clipped by the hard clamp and the
    // self-escalation loop stops being reachable. docs/TUNING.md §2.
    expect(TUNING.speed.speedCeiling + TUNING.speed.flowSpeedBonus).toBeLessThanOrEqual(
      TUNING.speed.maxSpeed,
    );
  });

  it("playerHeightSlide < lowBarClearance", () => {
    // A slide that does not fit under a Low Bar makes the verb useless.
    expect(TUNING.geometry.playerHeightSlide).toBeLessThan(TUNING.slide.lowBarClearance);
  });

  it("stickReleaseThreshold < stickThreshold", () => {
    // This gap is the hysteresis band. Without it, stick chatter re-triggers.
    expect(TUNING.input.gamepad.stickReleaseThreshold).toBeLessThan(
      TUNING.input.gamepad.stickThreshold,
    );
  });
});

describe("derived physics match their inputs", () => {
  const { jumpApexHeight, jumpApexTime, fallGravityMultiplier } = TUNING.vertical;

  it("gravityRise = 2h / t²", () => {
    expect(TUNING.vertical.gravityRise).toBeCloseTo(
      (2 * jumpApexHeight) / (jumpApexTime * jumpApexTime),
      9,
    );
  });

  it("gravityFall = gravityRise * fallGravityMultiplier", () => {
    expect(TUNING.vertical.gravityFall).toBeCloseTo(
      TUNING.vertical.gravityRise * fallGravityMultiplier,
      9,
    );
  });

  it("jumpImpulse = 2h / t", () => {
    expect(TUNING.vertical.jumpImpulse).toBeCloseTo((2 * jumpApexHeight) / jumpApexTime, 9);
  });

  it("a jump actually reaches its stated apex height", () => {
    // v² = 2 * g * h, integrated back out of the impulse we ship.
    const apexFromImpulse =
      (TUNING.vertical.jumpImpulse * TUNING.vertical.jumpImpulse) /
      (2 * TUNING.vertical.gravityRise);
    expect(apexFromImpulse).toBeCloseTo(jumpApexHeight, 9);
  });

  it("airTime = jumpApexTime + fallTime", () => {
    expect(TUNING.vertical.airTime).toBeCloseTo(
      TUNING.vertical.jumpApexTime + TUNING.vertical.fallTime,
      9,
    );
  });

  it("the fall is faster than the rise", () => {
    // The whole point of asymmetric gravity. If this flips, the jump is floaty.
    expect(TUNING.vertical.fallTime).toBeLessThan(TUNING.vertical.jumpApexTime);
  });

  it("fixedDelta = 1 / tickRate and maxAccumulator follows maxTicksPerFrame", () => {
    expect(TUNING.sim.fixedDelta).toBeCloseTo(1 / TUNING.sim.tickRate, 12);
    expect(TUNING.sim.maxAccumulator).toBeCloseTo(
      TUNING.sim.maxTicksPerFrame * TUNING.sim.fixedDelta,
      12,
    );
  });

  it("prismInnerSize follows laneWidth, laneCount and wallMargin", () => {
    const { laneWidth, laneCount, wallMargin, prismInnerSize } = TUNING.geometry;
    expect(prismInnerSize).toBeCloseTo(laneWidth * (laneCount - 1) + 2 * wallMargin, 9);
  });

  it("rollRecovery = rollDuration - rollCommitLock", () => {
    expect(TUNING.roll.rollRecovery).toBeCloseTo(
      TUNING.roll.rollDuration - TUNING.roll.rollCommitLock,
      9,
    );
  });
});

describe("geometry stays self-consistent", () => {
  it("the player fits inside a lane", () => {
    expect(TUNING.geometry.playerWidth).toBeLessThan(TUNING.geometry.laneWidth);
  });

  it("a standing player does NOT fit under a High Gate", () => {
    // If they did, the jump verb would answer nothing.
    expect(TUNING.geometry.playerHeightStand).toBeGreaterThan(TUNING.slide.highGateClearance);
  });

  it("a jump clears a High Gate, with margin", () => {
    expect(TUNING.vertical.jumpApexHeight).toBeGreaterThan(TUNING.slide.highGateClearance);
  });

  it("an outer-lane player does not clip the wall", () => {
    const halfWidth = TUNING.geometry.playerWidth / 2;
    expect(halfWidth).toBeLessThan(TUNING.geometry.wallMargin);
  });

  it("there are 12 positions", () => {
    // The whole design thesis, asserted. GAME_BIBLE §3.
    expect(TUNING.geometry.faceCount * TUNING.geometry.laneCount).toBe(12);
  });
});

describe("flow, overdrive and fracture stay coherent", () => {
  it("Overdrive costs exactly a full meter", () => {
    expect(TUNING.overdrive.overdriveCost).toBe(TUNING.flow.flowMax);
  });

  it("Overdrive exits below full, so it cannot be chained for free", () => {
    expect(TUNING.overdrive.overdriveExitFlow).toBeLessThan(TUNING.flow.flowMax);
  });

  it("Overdrive beats the best Flow multiplier, or it is not worth 100 Flow", () => {
    expect(TUNING.overdrive.overdriveMultiplier).toBeGreaterThan(TUNING.flow.flowMultiplierMax);
  });

  it("a perfect slide is worth less than a near-miss", () => {
    // Otherwise slide-farming out-earns risk, which inverts the design thesis.
    expect(TUNING.flow.flowPerPerfectSlide).toBeLessThan(TUNING.flow.flowPerNearMiss);
  });

  it("there is a Shard cost for every permitted Fracture", () => {
    expect(TUNING.fracture.fractureShardCost).toHaveLength(TUNING.fracture.maxFracturesPerRun);
  });

  it("Fracture retains some Flow but not all of it", () => {
    expect(TUNING.fracture.fractureFlowRetained).toBeGreaterThan(0);
    expect(TUNING.fracture.fractureFlowRetained).toBeLessThan(1);
  });
});

describe("pickups and spawning stay coherent", () => {
  it("the magnet can close its own radius before a Bit leaves range", () => {
    // Bits ride the world, so they already approach at worldSpeed (law (b)) — the
    // pull only has to close LATERAL distance. A Bit crosses the magnet sphere in
    // 2r / worldSpeed seconds and may be up to r away, so the floor is:
    //
    //   magnetPullSpeed > r / (2r / maxSpeed) = maxSpeed / 2
    //
    // Worst case is maxSpeed, where the dwell window is shortest.
    const dwellSeconds = (2 * TUNING.pickups.magnetRadius) / TUNING.speed.maxSpeed;
    const requiredPullSpeed = TUNING.pickups.magnetRadius / dwellSeconds;

    expect(TUNING.pickups.magnetPullSpeed).toBeGreaterThan(requiredPullSpeed);
    expect(requiredPullSpeed).toBeCloseTo(TUNING.speed.maxSpeed / 2, 9);
  });

  it("the shield step table covers tier 0 through max", () => {
    expect(TUNING.pickups.shieldCountByTier).toHaveLength(TUNING.economy.upgradeMaxTier + 1);
  });

  it("the shield step table never decreases", () => {
    const tiers = TUNING.pickups.shieldCountByTier;
    for (let i = 1; i < tiers.length; i += 1) {
      expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1] ?? 0);
    }
  });

  it("difficulty bands are contiguous and ascending", () => {
    const bands = TUNING.spawn.bands;
    expect(bands.length).toBeGreaterThan(0);
    expect(bands[0]?.fromMetres).toBe(0);

    for (let i = 1; i < bands.length; i += 1) {
      const previous = bands[i - 1];
      const current = bands[i];
      expect(current?.fromMetres).toBe(previous?.toMetres);
      expect(current?.obstaclesPer100m).toBeGreaterThan(previous?.obstaclesPer100m ?? 0);
    }

    expect(bands[bands.length - 1]?.toMetres).toBe(Number.POSITIVE_INFINITY);
  });

  it("the teaching band uses one face and spawns no Full-Face Walls", () => {
    // Band 1 has to teach jump/slide/lane before the tunnel ever rotates.
    expect(bandAt(0)?.maxSimultaneousFaces).toBe(1);
    expect(bandAt(0)?.fullFaceWallChance).toBe(0);
  });

  it("Full-Face Walls only appear once the roll has been taught", () => {
    // The roll is introduced in band 2; walls that REQUIRE it start in band 3.
    expect(bandAt(600)?.fullFaceWallChance).toBe(0);
    expect(bandAt(2000)?.fullFaceWallChance).toBeGreaterThan(0);
  });

  it("no band exceeds the four faces that exist", () => {
    for (const band of TUNING.spawn.bands) {
      expect(band.maxSimultaneousFaces).toBeLessThanOrEqual(TUNING.geometry.faceCount);
    }
  });
});

describe("the reaction-time floor is respected at every speed", () => {
  it("minSpawnGap at maxSpeed is still shorter than a chunk", () => {
    // If the required gap exceeded a chunk, the generator could never place
    // anything at terminal speed.
    const minSpawnGapAtMaxSpeed = TUNING.spawn.minReactionTime * TUNING.speed.maxSpeed;
    expect(minSpawnGapAtMaxSpeed).toBeLessThan(TUNING.spawn.chunkLength);
  });

  it("every theme's fog reaches past the reaction floor", () => {
    // An obstacle has to be visible for at least minReactionTime before it must be
    // answered, or the death is unfair regardless of density. Undertow is the
    // binding case at 30u — deliberately the tightest sightline in the game.
    const sightlineNeeded = TUNING.spawn.minReactionTime * TUNING.speed.maxSpeed;
    const themes = [
      ["kiln", TUNING.fog.kiln.far],
      ["undertow", TUNING.fog.undertow.far],
      ["bazaar", TUNING.fog.bazaar.far],
      // Static oscillates; its floor is what has to clear the bar.
      ["static", TUNING.fog.staticTheme.unstableMin],
    ] as const;

    for (const [name, far] of themes) {
      expect(far, `${name} fog must exceed ${sightlineNeeded.toFixed(1)}u`).toBeGreaterThan(
        sightlineNeeded,
      );
    }
  });
});

/** Returns the difficulty band covering `metres`, or undefined. */
function bandAt(metres: number) {
  return TUNING.spawn.bands.find((band) => metres >= band.fromMetres && metres < band.toMetres);
}
