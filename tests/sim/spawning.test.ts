import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { entityCollider } from "@/game/config/entities";
import { eventTypeAt, SimEvent, type EventRing } from "@/game/sim/events";
import { blocksVertical, entityDef, EntityType, Vertical } from "@/game/sim/level/entities";
import { classifyContact, ContactClass } from "@/game/sim/collision";
import { entityCentreX } from "@/game/sim/level/entities";
import { liveCount } from "@/game/sim/generator";
import { createSim } from "@/game/sim/sim";
import { F, RunStatus } from "@/game/sim/state";

/**
 * The generator is live.
 *
 * From P02 to P08 `stepGenerator` was a no-op, so nothing spawned and every
 * downstream system — collision, Flow gains, scoring beyond distance, the whole
 * feel layer — was unreachable in a real run. These tests exist to keep that
 * from silently regressing.
 */

const TICK_RATE = TUNING.sim.tickRate;

function idle() {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
}

function countEvents(ring: EventRing, type: number, from = 0): number {
  let n = 0;
  for (let i = from; i < ring.head; i += 1) {
    if (eventTypeAt(ring, i) === type) {
      n += 1;
    }
  }
  return n;
}

describe("track actually spawns", () => {
  it("puts obstacles in the tunnel within the first seconds", () => {
    const sim = createSim(1);
    for (let i = 0; i < TICK_RATE * 3; i += 1) {
      sim.tick(idle());
    }
    expect(liveCount(sim.getState().obstacles)).toBeGreaterThan(0);
  });

  it("spawns pickups too", () => {
    const sim = createSim(2);
    for (let i = 0; i < TICK_RATE * 10; i += 1) {
      sim.tick(idle());
    }
    expect(liveCount(sim.getState().pickups)).toBeGreaterThan(0);
  });

  it("never spawns on top of the player — everything arrives from ahead", () => {
    // A chunk placed at or behind the player is an instant unavoidable death.
    const sim = createSim(3);
    const seen = new Set<number>();
    for (let i = 0; i < TICK_RATE * 20; i += 1) {
      const before = sim.getState().obstacles;
      for (let j = 0; j < before.count; j += 1) {
        if (before.active[j] === 1 && !seen.has(j)) {
          seen.add(j);
          expect(before.z[j] ?? 0).toBeGreaterThan(0);
        }
      }
      sim.tick(idle());
      // Slots are reused, so forget any that freed this tick.
      const after = sim.getState().obstacles;
      for (const j of [...seen]) {
        if (after.active[j] !== 1) {
          seen.delete(j);
        }
      }
    }
  });

  it("recycles rather than growing without bound", () => {
    const sim = createSim(4);
    for (let i = 0; i < TICK_RATE * 120; i += 1) {
      sim.tick(idle());
      const obstacles = sim.getState().obstacles;
      expect(obstacles.count).toBeLessThanOrEqual(TUNING.pools.maxObstacles);
      expect(sim.getState().pickups.count).toBeLessThanOrEqual(TUNING.pools.maxPickups);
    }
  });

  it("keeps the live population bounded over a long run", () => {
    // The lookahead is finite, so live entities should plateau rather than climb.
    const sim = createSim(5);
    for (let i = 0; i < TICK_RATE * 30; i += 1) {
      sim.tick(idle());
    }
    const early = liveCount(sim.getState().obstacles);

    for (let i = 0; i < TICK_RATE * 120; i += 1) {
      sim.tick(idle());
    }
    const late = liveCount(sim.getState().obstacles);

    // Density rises with the band, so `late` may exceed `early` — but not by an
    // order of magnitude, which is what an unbounded leak would look like.
    expect(late).toBeLessThan(early * 5 + 20);
  });

  it("is deterministic: same seed, same track", () => {
    function fingerprint(seed: number): string {
      const sim = createSim(seed);
      for (let i = 0; i < TICK_RATE * 20; i += 1) {
        sim.tick(idle());
      }
      const o = sim.getState().obstacles;
      const parts: string[] = [];
      for (let i = 0; i < o.count; i += 1) {
        parts.push(
          `${o.active[i]}:${o.kind[i]}:${o.face[i]}:${o.lane[i]}:${(o.z[i] ?? 0).toFixed(6)}`,
        );
      }
      return parts.join("|");
    }

    expect(fingerprint(99)).toBe(fingerprint(99));
    expect(fingerprint(99)).not.toBe(fingerprint(100));
  });

  it("reset clears the track", () => {
    const sim = createSim(6);
    for (let i = 0; i < TICK_RATE * 10; i += 1) {
      sim.tick(idle());
    }
    expect(liveCount(sim.getState().obstacles)).toBeGreaterThan(0);

    sim.reset(6);
    expect(liveCount(sim.getState().obstacles)).toBe(0);
    expect(liveCount(sim.getState().pickups)).toBe(0);
  });
});

describe("the contact classifier is real", () => {
  it("kills on anything that blocks every vertical state", () => {
    expect(classifyContact(EntityType.FullFaceWall)).toBe(ContactClass.Fatal);
    expect(classifyContact(EntityType.Stack)).toBe(ContactClass.Fatal);
    expect(classifyContact(EntityType.ShearRing)).toBe(ContactClass.Fatal);
  });

  it("stumbles on anything that leaves a vertical answer open", () => {
    // The player had an out and missed it. A fumble, not a death.
    expect(classifyContact(EntityType.Block)).toBe(ContactClass.Stumble);
    expect(classifyContact(EntityType.LowBar)).toBe(ContactClass.Stumble);
    expect(classifyContact(EntityType.HighGate)).toBe(ContactClass.Stumble);
  });

  it("passes through non-fatal entities and pickups", () => {
    expect(classifyContact(EntityType.Kicker)).toBe(ContactClass.Pass);
    expect(classifyContact(EntityType.CornerBrace)).toBe(ContactClass.Pass);
    expect(classifyContact(EntityType.Bit)).toBe(ContactClass.Pass);
    expect(classifyContact(EntityType.None)).toBe(ContactClass.Pass);
  });

  it("REGRESSION: is no longer decided by the parity of the kind id", () => {
    // The placeholder returned Fatal for even ids and Stumble for odd. Block(1)
    // and Stack(2) are adjacent ids with genuinely different answers, so if
    // parity ever creeps back this pair catches it.
    expect(classifyContact(EntityType.Block)).toBe(ContactClass.Stumble); // odd id
    expect(classifyContact(EntityType.LowBar)).toBe(ContactClass.Stumble); // odd id
    expect(classifyContact(EntityType.HighGate)).toBe(ContactClass.Stumble); // even id
    expect(classifyContact(EntityType.Stack)).toBe(ContactClass.Fatal); // even id
  });
});

describe("colliders agree with the solver's blocking model", () => {
  /**
   * The cross-check P06 deferred.
   *
   * `sim/level/entities.ts` says what each entity *blocks*, and the P06 solver
   * proved all 43 chunks survivable against that model. `config/entities.ts`
   * says what the player actually *hits*. If the two disagree, the game is
   * unfair in a way no chunk test can detect: the solver signs off on a chunk
   * whose real geometry kills you.
   */
  const PLAYER_STAND = TUNING.geometry.playerHeightStand;
  const PLAYER_SLIDE = TUNING.geometry.playerHeightSlide;
  const APEX = TUNING.vertical.jumpApexHeight;

  /** Vertical span the player's box occupies in each state, feet-relative. */
  const SPANS: Readonly<Record<number, { low: number; high: number }>> = {
    [Vertical.Standing]: { low: 0, high: PLAYER_STAND },
    [Vertical.Sliding]: { low: 0, high: PLAYER_SLIDE },
    [Vertical.Airborne]: { low: APEX, high: APEX + PLAYER_STAND },
  };

  const OBSTACLES = [
    EntityType.Block,
    EntityType.Stack,
    EntityType.LowBar,
    EntityType.HighGate,
    EntityType.PillarPair,
    EntityType.FullFaceWall,
    EntityType.Piston,
    EntityType.ShearRing,
  ];

  for (const type of OBSTACLES) {
    const name = entityDef(type).name;
    it(`${name}: the collider overlaps exactly the states the mask blocks`, () => {
      const collider = entityCollider(type);
      const boxLow = collider.centreY - collider.halfHeight;
      const boxHigh = collider.centreY + collider.halfHeight;

      for (const vertical of [Vertical.Standing, Vertical.Sliding, Vertical.Airborne]) {
        const span = SPANS[vertical];
        expect(span).toBeDefined();
        if (span === undefined) {
          continue;
        }
        const overlaps = span.low < boxHigh && span.high > boxLow;
        const claimed = blocksVertical(type, vertical);

        expect(
          overlaps,
          `${name} vertical=${vertical}: mask says blocks=${claimed}, ` +
            `collider [${boxLow.toFixed(2)}, ${boxHigh.toFixed(2)}] vs ` +
            `player [${span.low.toFixed(2)}, ${span.high.toFixed(2)}]`,
        ).toBe(claimed);
      }
    });
  }

  it("a Low Bar admits a slide and stops a stand — the mechanic, in numbers", () => {
    const bar = entityCollider(EntityType.LowBar);
    const underside = bar.centreY - bar.halfHeight;
    expect(underside).toBeCloseTo(TUNING.slide.lowBarClearance, 9);
    expect(PLAYER_SLIDE).toBeLessThan(underside);
    expect(PLAYER_STAND).toBeGreaterThan(underside);
  });

  it("a High Gate stops a slide and admits a jump", () => {
    const gate = entityCollider(EntityType.HighGate);
    const top = gate.centreY + gate.halfHeight;
    expect(top).toBeCloseTo(TUNING.slide.highGateClearance, 9);
    expect(PLAYER_SLIDE).toBeGreaterThan(0);
    expect(APEX).toBeGreaterThan(top);
  });
});

describe("lane centring", () => {
  it("centres a single-lane entity on its lane", () => {
    const width = TUNING.geometry.laneWidth;
    expect(entityCentreX(0, EntityType.Block)).toBeCloseTo(-width, 9);
    expect(entityCentreX(1, EntityType.Block)).toBeCloseTo(0, 9);
    expect(entityCentreX(2, EntityType.Block)).toBeCloseTo(width, 9);
  });

  it("centres a three-lane entity on the FACE, not on its anchor lane", () => {
    // Multi-lane entities are anchored at their leftmost lane. Treating that as
    // the centre puts a full-face wall a lane off, which presents as dying to
    // thin air on one side and walking through geometry on the other.
    expect(entityCentreX(0, EntityType.FullFaceWall)).toBeCloseTo(0, 9);
    expect(entityCentreX(0, EntityType.LowBar)).toBeCloseTo(0, 9);
  });

  it("centres a two-lane entity between its two lanes", () => {
    const half = TUNING.geometry.laneWidth / 2;
    expect(entityCentreX(0, EntityType.PillarPair)).toBeCloseTo(-half, 9);
  });
});

describe("events the feel layer depends on actually fire", () => {
  /**
   * The whole point of wiring the generator in. Before this, Coin, NearMiss,
   * Crash and Stumble were unreachable in a live run, which made every impact
   * effect dead code.
   */
  function runUntil(seed: number, type: number, maxSeconds: number): boolean {
    const sim = createSim(seed);
    for (let i = 0; i < TICK_RATE * maxSeconds; i += 1) {
      sim.tick(idle());
      if (countEvents(sim.events, type) > 0) {
        return true;
      }
      if (sim.getState().runStatus === RunStatus.Ended) {
        sim.reset(seed + i);
      }
    }
    return false;
  }

  it("Coin fires — a pickup is collected", () => {
    expect(runUntil(11, SimEvent.Coin, 60)).toBe(true);
  });

  it("a passive player eventually dies to real geometry", () => {
    // Standing still through band 1 with no input must not be survivable, or
    // the entire difficulty curve is decorative.
    const sim = createSim(12);
    let ended = false;
    for (let i = 0; i < TICK_RATE * 120 && !ended; i += 1) {
      sim.tick(idle());
      ended = sim.getState().runStatus === RunStatus.Ended;
    }
    expect(ended).toBe(true);
  });

  it("Crash carries a cause the presentation layer can read", () => {
    const sim = createSim(13);
    for (let i = 0; i < TICK_RATE * 120; i += 1) {
      sim.tick(idle());
      if (sim.getState().runStatus === RunStatus.Ended) {
        break;
      }
    }
    expect(countEvents(sim.events, SimEvent.Crash)).toBeGreaterThan(0);
  });
});

describe("law (b) still holds with the generator live", () => {
  it("the player never leaves the origin", () => {
    const sim = createSim(21);
    for (let i = 0; i < TICK_RATE * 60; i += 1) {
      sim.tick(idle());
      expect(Math.abs(sim.getState().f[F.playerZ] ?? 0)).toBeLessThan(50);
    }
  });
});
