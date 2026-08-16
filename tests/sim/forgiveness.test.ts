import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createState, F, Phase, Verb } from "@/game/sim/state";
import {
  ageForgiveness,
  beginCoyote,
  bufferVerb,
  clearBuffer,
  clearCoyote,
  consumeBuffer,
  coyoteActive,
  peekBuffer,
} from "@/game/sim/player/forgiveness";
import { createSim } from "@/game/sim/sim";
import { createIntent, type Intent } from "@/game/sim/intent";

const DT = TUNING.sim.fixedDelta;
const COYOTE_TIME = TUNING.input.coyoteTime;
const INPUT_BUFFER = TUNING.input.inputBuffer;

/** Ticks a window survives before it closes. 0.10s / 0.016667s = 6. */
const COYOTE_TICKS = Math.round(COYOTE_TIME / DT);
const BUFFER_TICKS = Math.round(INPUT_BUFFER / DT);

function held(partial: Partial<Intent>): Intent {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false, ...partial };
}

describe("coyote time fires at the boundary tick and not one past it", () => {
  it("is open for exactly coyoteTime worth of ticks", () => {
    const state = createState();
    beginCoyote(state);

    for (let i = 0; i < COYOTE_TICKS; i += 1) {
      expect(coyoteActive(state), `should still be open at tick ${i}`).toBe(true);
      ageForgiveness(state, DT);
    }

    expect(coyoteActive(state), "should be closed one tick past the window").toBe(false);
  });

  it("the last legal tick is the one before expiry", () => {
    const state = createState();
    beginCoyote(state);
    for (let i = 0; i < COYOTE_TICKS - 1; i += 1) {
      ageForgiveness(state, DT);
    }
    expect(coyoteActive(state)).toBe(true);
    ageForgiveness(state, DT);
    expect(coyoteActive(state)).toBe(false);
  });

  it("does not lose its first tick to the step that opened it", () => {
    // The reason ageForgiveness runs at the END of the player step.
    const state = createState();
    beginCoyote(state);
    expect(state.f[F.playerCoyoteTimer]).toBeCloseTo(COYOTE_TIME, 12);
  });

  it("clears immediately on request", () => {
    const state = createState();
    beginCoyote(state);
    clearCoyote(state);
    expect(coyoteActive(state)).toBe(false);
  });

  it("never goes negative", () => {
    const state = createState();
    beginCoyote(state);
    for (let i = 0; i < 100; i += 1) {
      ageForgiveness(state, DT);
    }
    expect(state.f[F.playerCoyoteTimer]).toBe(0);
  });
});

describe("the input buffer fires at the boundary tick and not one past it", () => {
  it("holds a verb for exactly inputBuffer worth of ticks", () => {
    const state = createState();
    bufferVerb(state, Verb.Jump);

    for (let i = 0; i < BUFFER_TICKS; i += 1) {
      expect(peekBuffer(state), `should still hold at tick ${i}`).toBe(Verb.Jump);
      ageForgiveness(state, DT);
    }

    expect(peekBuffer(state), "should be empty one tick past the window").toBe(Verb.None);
  });

  it("is one slot — newest wins", () => {
    const state = createState();
    bufferVerb(state, Verb.Jump);
    bufferVerb(state, Verb.Slide);
    expect(peekBuffer(state)).toBe(Verb.Slide);
  });

  it("re-arms the window when overwritten", () => {
    const state = createState();
    bufferVerb(state, Verb.Jump);
    ageForgiveness(state, DT);
    ageForgiveness(state, DT);
    bufferVerb(state, Verb.Slide);
    expect(state.f[F.playerBufferedTimer]).toBeCloseTo(INPUT_BUFFER, 12);
  });

  it("consuming empties the slot", () => {
    const state = createState();
    bufferVerb(state, Verb.Jump);
    expect(consumeBuffer(state)).toBe(Verb.Jump);
    expect(peekBuffer(state)).toBe(Verb.None);
  });

  it("consuming an empty buffer is a no-op, not an error", () => {
    const state = createState();
    expect(consumeBuffer(state)).toBe(Verb.None);
  });

  it("clears fully", () => {
    const state = createState();
    bufferVerb(state, Verb.Jump);
    clearBuffer(state);
    expect(peekBuffer(state)).toBe(Verb.None);
    expect(state.f[F.playerBufferedTimer]).toBe(0);
  });
});

describe("forgiveness in a real run", () => {
  it("a jump pressed just before landing fires on the landing tick", () => {
    // The most common "it didn't register" complaint in the genre.
    const sim = createSim(100);
    const jumping = held({ jump: true });
    sim.tick(jumping);

    // Fall until one tick before landing.
    let guard = 0;
    while (sim.getState().player.grounded === 0 && guard < 200) {
      sim.tick(held({}));
      guard += 1;
    }

    // Now grounded. Simulate the press having been buffered mid-air by pressing
    // again immediately: it should jump on this very tick.
    sim.tick(jumping);
    expect(sim.getState().player.phase).toBe(Phase.Jumping);
  });

  it("a jump pressed during a slide fires when the slide finishes", () => {
    const sim = createSim(101);
    sim.tick(held({ slide: true }));
    expect(sim.getState().player.phase).toBe(Phase.Sliding);

    // Press jump close enough to the end that the buffer is still alive.
    const slideTicks = Math.round(TUNING.slide.slideDuration / DT);
    const recoveryTicks = Math.ceil(TUNING.slide.slideRecovery / DT);
    const pressAt = slideTicks + recoveryTicks - 2;

    for (let i = 0; i < pressAt; i += 1) {
      sim.tick(held({}));
    }
    sim.tick(held({ jump: true }));

    for (let i = 0; i < BUFFER_TICKS; i += 1) {
      sim.tick(held({ jump: true }));
      if (sim.getState().player.phase === Phase.Jumping) {
        break;
      }
    }

    expect(sim.getState().player.phase).toBe(Phase.Jumping);
  });

  it("a stale buffered verb is discarded rather than firing late", () => {
    const sim = createSim(102);
    sim.tick(held({ slide: true }));
    // Press jump at the very start of a long slide; the buffer must expire.
    sim.tick(held({ jump: true }));

    const slideTicks = Math.round(TUNING.slide.slideDuration / DT);
    for (let i = 0; i < slideTicks + 10; i += 1) {
      sim.tick(held({}));
    }

    expect(sim.getState().player.phase).toBe(Phase.Running);
  });
});

describe("lateral input during the roll commit lock is DROPPED, not buffered", () => {
  it("does not resurface when the lock lifts", () => {
    // docs/TUNING.md §7. This is the one place the buffer deliberately does not
    // apply, and it is the whole risk of the roll.
    const sim = createSim(103);
    sim.tick(held({ roll: 1 }));
    sim.tick(held({ lateral: 1 }));

    const rollTicks = Math.round(TUNING.roll.rollDuration / DT);
    for (let i = 0; i < rollTicks + 6; i += 1) {
      sim.tick(createIntent());
    }

    const state = sim.getState();
    expect(state.player.lane).toBe(state.player.targetLane);
    expect(state.player.bufferedVerb).not.toBe(Verb.LaneLeft);
    expect(state.player.bufferedVerb).not.toBe(Verb.LaneRight);
  });
});
