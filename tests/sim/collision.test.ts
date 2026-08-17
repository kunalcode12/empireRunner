import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createEventRing, eventPayloadAt, eventTypeAt, SimEvent } from "@/game/sim/events";
import { createState, F, Phase, type SimState } from "@/game/sim/state";
import {
  classifyContact,
  ContactClass,
  EntityFlag,
  stepCollision,
  sweptOverlap,
} from "@/game/sim/collision";
import { createAabb, obstacleAabb, playerAabb, separation } from "@/game/sim/player/collider";
import { entityCollider } from "@/game/config/entities";
import { EntityType } from "@/game/sim/level/entities";

const DT = TUNING.sim.fixedDelta;

/**
 * Obstacle extents come from the real catalogue as of P07, not from a 0.5u
 * placeholder cube. These tests position geometry relative to the player's box,
 * so they have to ask the catalogue how wide the thing actually is — hardcoding
 * 0.5 silently changed what each test was measuring the moment colliders
 * became real.
 */
/** A Stack: fatal, and wide enough to graze deliberately. */
const GRAZE_KIND = EntityType.Stack;
const grazeHalfWidth = (): number => entityCollider(GRAZE_KIND).halfWidth;
/** An unknown kind, which the catalogue treats as inert — so contact is a Pass
 *  and the near-miss path is what gets exercised. */
const INERT_KIND = -1;
const inertHalfWidth = (): number => entityCollider(INERT_KIND).halfWidth;
const MAX_SPEED = TUNING.speed.maxSpeed;

/** Adds an obstacle to a state and returns its index. */
function addObstacle(
  state: SimState,
  kind: number,
  face: number,
  lane: number,
  x: number,
  y: number,
  z: number,
): number {
  const index = state.obstacles.count;
  state.obstacles.active[index] = 1;
  state.obstacles.kind[index] = kind;
  state.obstacles.face[index] = face;
  state.obstacles.lane[index] = lane;
  state.obstacles.x[index] = x;
  state.obstacles.y[index] = y;
  state.obstacles.z[index] = z;
  state.obstacles.flags[index] = 0;
  state.obstacles.count = index + 1;
  return index;
}

function firstEventOfType(ring: ReturnType<typeof createEventRing>, type: number): number {
  for (let i = 0; i < ring.head; i += 1) {
    if (eventTypeAt(ring, i) === type) {
      return i;
    }
  }
  return -1;
}

describe("swept overlap does not tunnel", () => {
  it("catches a 0.2u-thin obstacle at maxSpeed", () => {
    // At 34 u/s the world advances 0.567u per tick — nearly 3x the obstacle's
    // depth. A discrete once-per-tick overlap test steps straight over it.
    const THIN_DEPTH = 0.2;
    const halfDepth = THIN_DEPTH / 2;
    const perTickMotion = MAX_SPEED * DT;

    expect(perTickMotion).toBeGreaterThan(THIN_DEPTH);

    const player = createAabb();
    const obstacle = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);

    // Place it just beyond reach at the start of the tick, within reach by the end.
    const startZ = player.hz + halfDepth + perTickMotion * 0.5;
    obstacleAabb(obstacle, 0, player.cy, startZ, 0.5, 0.5, halfDepth);

    const discrete =
      Math.abs(player.cz - obstacle.cz) < player.hz + obstacle.hz &&
      Math.abs(player.cx - obstacle.cx) < player.hx + obstacle.hx;
    expect(discrete, "the discrete test should miss it — that is the point").toBe(false);

    const toi = sweptOverlap(player, obstacle, 0, 0, -perTickMotion);
    expect(toi, "the swept test must catch it").toBeGreaterThanOrEqual(0);
    expect(toi).toBeLessThanOrEqual(1);
  });

  it("catches it at every speed from base to max", () => {
    const THIN_HALF = 0.1;
    for (const speed of [12, 18, 24, 28, 31, MAX_SPEED]) {
      const motion = speed * DT;
      const player = createAabb();
      const obstacle = createAabb();
      playerAabb(player, Phase.Running, 0, 0, 0);
      obstacleAabb(
        obstacle,
        0,
        player.cy,
        player.hz + THIN_HALF + motion * 0.5,
        0.5,
        0.5,
        THIN_HALF,
      );

      expect(
        sweptOverlap(player, obstacle, 0, 0, -motion),
        `speed ${speed}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports no hit when the obstacle stays out of reach", () => {
    const player = createAabb();
    const obstacle = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    obstacleAabb(obstacle, 0, player.cy, 50, 0.5, 0.5, 0.5);
    expect(sweptOverlap(player, obstacle, 0, 0, -MAX_SPEED * DT)).toBe(-1);
  });

  it("reports no hit when separated on a perpendicular axis", () => {
    const player = createAabb();
    const obstacle = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    // Two lanes away laterally — motion along Z can never close that.
    obstacleAabb(obstacle, TUNING.geometry.laneWidth * 2, player.cy, 1, 0.5, 0.5, 0.5);
    expect(sweptOverlap(player, obstacle, 0, 0, -MAX_SPEED * DT)).toBe(-1);
  });

  it("returns a time of impact inside the tick, not at its edges", () => {
    const player = createAabb();
    const obstacle = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    const motion = MAX_SPEED * DT;
    obstacleAabb(obstacle, 0, player.cy, player.hz + 0.5 + motion * 0.5, 0.5, 0.5, 0.5);

    const toi = sweptOverlap(player, obstacle, 0, 0, -motion);
    expect(toi).toBeGreaterThan(0);
    expect(toi).toBeLessThan(1);
  });

  it("handles zero motion as a plain overlap test", () => {
    const player = createAabb();
    const obstacle = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);

    obstacleAabb(obstacle, 0, player.cy, 0, 0.5, 0.5, 0.5);
    expect(sweptOverlap(player, obstacle, 0, 0, 0)).toBeGreaterThanOrEqual(0);

    obstacleAabb(obstacle, 0, player.cy, 10, 0.5, 0.5, 0.5);
    expect(sweptOverlap(player, obstacle, 0, 0, 0)).toBe(-1);
  });
});

describe("contact classification", () => {
  it("has three outcomes", () => {
    expect(ContactClass.Pass).toBe(0);
    expect(ContactClass.Stumble).toBe(1);
    expect(ContactClass.Fatal).toBe(2);
  });

  it("classifies a negative kind as PASS", () => {
    expect(classifyContact(-1)).toBe(ContactClass.Pass);
  });

  it("produces both fatal and stumble outcomes", () => {
    // The placeholder table is a stand-in until P07; what matters here is that
    // both branches are reachable and exercised.
    expect(classifyContact(2)).toBe(ContactClass.Fatal);
    expect(classifyContact(3)).toBe(ContactClass.Stumble);
  });
});

describe("resolving contacts", () => {
  function scenario(kind: number, z: number) {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();
    const index = addObstacle(state, kind, 0, 1, 0, 0, z);
    return { state, events, index };
  }

  it("a fatal obstacle crashes the run", () => {
    const { state, events } = scenario(2, 0.3);
    stepCollision(state, DT, events);
    expect(state.player.phase).toBe(Phase.Crashed);
    expect(firstEventOfType(events, SimEvent.Crash)).toBeGreaterThanOrEqual(0);
  });

  it("a stumble obstacle does not crash the run", () => {
    const { state, events } = scenario(3, 0.3);
    stepCollision(state, DT, events);
    expect(state.player.phase).toBe(Phase.Stumbling);
    expect(state.player.stumbleCount).toBe(1);
    expect(firstEventOfType(events, SimEvent.Stumble)).toBeGreaterThanOrEqual(0);
  });

  it("ignores obstacles on another face", () => {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();
    addObstacle(state, 2, 2, 1, 0, 0, 0.3);
    stepCollision(state, DT, events);
    expect(state.player.phase).toBe(Phase.Running);
  });

  it("resolves an obstacle at most once", () => {
    const { state, events, index } = scenario(3, 0.3);
    stepCollision(state, DT, events);
    const afterFirst = state.player.stumbleCount;
    expect(state.obstacles.flags[index]! & EntityFlag.Resolved).toBeTruthy();

    stepCollision(state, DT, events);
    expect(state.player.stumbleCount).toBe(afterFirst);
  });

  it("does nothing when there are no obstacles", () => {
    const state = createState();
    const events = createEventRing();
    stepCollision(state, DT, events);
    expect(state.player.phase).toBe(Phase.Running);
    expect(events.head).toBe(0);
  });

  it("invulnerability absorbs a hit without crashing", () => {
    const { state, events } = scenario(2, 0.3);
    state.f[F.playerInvulnerableTimer] = 1;
    stepCollision(state, DT, events);
    expect(state.player.phase).toBe(Phase.Running);
  });
});

describe("corner forgiveness", () => {
  it("nudges clear instead of killing on a shallow clip", () => {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();

    // Overlap laterally by less than cornerForgiveness.
    const player = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    const graze = TUNING.collision.cornerForgiveness * 0.5;
    const obstacleX = player.hx + grazeHalfWidth() - graze;

    addObstacle(state, GRAZE_KIND, 0, 1, obstacleX, 0, 0);
    stepCollision(state, DT, events);

    expect(state.player.phase, "a graze must not kill").toBe(Phase.Running);
    expect(state.player.cornerForgiveCount).toBe(1);
  });

  it("emits a distinct event so the rate can be measured", () => {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();

    const player = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    const graze = TUNING.collision.cornerForgiveness * 0.5;
    addObstacle(state, GRAZE_KIND, 0, 1, player.hx + grazeHalfWidth() - graze, 0, 0);

    stepCollision(state, DT, events);

    const eventIndex = firstEventOfType(events, SimEvent.CornerForgive);
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    const depth = eventPayloadAt(events, eventIndex, 0);
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(TUNING.collision.cornerForgiveness);
  });

  it("does NOT forgive a penetration deeper than the threshold", () => {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();

    const player = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    const deep = TUNING.collision.cornerForgiveness * 3;
    addObstacle(state, GRAZE_KIND, 0, 1, player.hx + grazeHalfWidth() - deep, 0, 0);

    stepCollision(state, DT, events);
    expect(state.player.phase).toBe(Phase.Crashed);
    expect(state.player.cornerForgiveCount).toBe(0);
  });
});

describe("near-miss detection", () => {
  it("fires when passing within nearMissRadius without contact", () => {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();

    const player = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    // Separated laterally by less than the near-miss radius.
    const gap = TUNING.flow.nearMissRadius * 0.5;
    addObstacle(state, INERT_KIND, 0, 1, player.hx + inertHalfWidth() + gap, 0, 0);

    stepCollision(state, DT, events);

    const index = firstEventOfType(events, SimEvent.NearMiss);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(eventPayloadAt(events, index, 0)).toBeCloseTo(gap, 6);
  });

  it("does NOT fire beyond nearMissRadius", () => {
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();

    const player = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    const gap = TUNING.flow.nearMissRadius * 2;
    addObstacle(state, INERT_KIND, 0, 1, player.hx + inertHalfWidth() + gap, 0, 0);

    stepCollision(state, DT, events);
    expect(firstEventOfType(events, SimEvent.NearMiss)).toBe(-1);
  });

  it("awards at most once per obstacle instance, ever", () => {
    // Without the flag a slow pass emits a near-miss every tick and fills the
    // Flow meter off a single obstacle.
    const state = createState();
    state.f[F.worldSpeed] = MAX_SPEED;
    const events = createEventRing();

    const player = createAabb();
    playerAabb(player, Phase.Running, 0, 0, 0);
    addObstacle(
      state,
      INERT_KIND,
      0,
      1,
      player.hx + inertHalfWidth() + TUNING.flow.nearMissRadius * 0.5,
      0,
      0,
    );

    for (let i = 0; i < 20; i += 1) {
      stepCollision(state, DT, events);
    }

    let count = 0;
    for (let i = 0; i < events.head; i += 1) {
      if (eventTypeAt(events, i) === SimEvent.NearMiss) {
        count += 1;
      }
    }
    expect(count).toBe(1);
  });

  it("measures surface to surface, not centre to centre", () => {
    const a = createAabb();
    const b = createAabb();
    playerAabb(a, Phase.Running, 0, 0, 0);
    obstacleAabb(b, a.hx + 0.5 + 0.25, a.cy, 0, 0.5, 0.5, 0.5);
    expect(separation(a, b)).toBeCloseTo(0.25, 9);
  });
});

describe("the collider changes with phase", () => {
  it("sliding is shorter and deeper than standing", () => {
    const standing = createAabb();
    const sliding = createAabb();
    playerAabb(standing, Phase.Running, 0, 0, 0);
    playerAabb(sliding, Phase.Sliding, 0, 0, 0);

    expect(sliding.hy).toBeLessThan(standing.hy);
    expect(sliding.hz).toBeGreaterThan(standing.hz);
    expect(sliding.hx).toBe(standing.hx);
  });

  it("sliding fits under a Low Bar and standing does not", () => {
    const standing = createAabb();
    const sliding = createAabb();
    playerAabb(standing, Phase.Running, 0, 0, 0);
    playerAabb(sliding, Phase.Sliding, 0, 0, 0);

    const bar = TUNING.slide.lowBarClearance;
    expect(sliding.cy + sliding.hy).toBeLessThan(bar);
    expect(standing.cy + standing.hy).toBeGreaterThan(bar);
  });

  it("airborne uses the standing box", () => {
    const standing = createAabb();
    const airborne = createAabb();
    playerAabb(standing, Phase.Running, 0, 0, 0);
    playerAabb(airborne, Phase.Jumping, 0, 0, 0);
    expect(airborne.hy).toBe(standing.hy);
    expect(airborne.hz).toBe(standing.hz);
  });

  it("the box sits on the feet, not centred on them", () => {
    const box = createAabb();
    const FEET_Y = 2;
    playerAabb(box, Phase.Running, 0, FEET_Y, 0);
    expect(box.cy).toBeCloseTo(FEET_Y + box.hy, 12);
    expect(box.cy - box.hy).toBeCloseTo(FEET_Y, 12);
  });
});
