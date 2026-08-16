import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createIntent, type Intent } from "@/game/sim/intent";
import { createTouchSource, TOUCH_CONSTANTS } from "@/game/input/touch";
import { createGamepadSource, GAMEPAD_BINDINGS, type GamepadLike } from "@/game/input/gamepad";
import { createKeyboardSource } from "@/game/input/keyboard";
import { createInputManager } from "@/game/input";

/**
 * The input layer produces intent and nothing else.
 *
 * Everything here runs headless: the touch source is driven with synthetic
 * events against a tiny EventTarget stand-in, and the gamepad source takes an
 * injected `getGamepads`. No browser, no real device.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fakes
// ─────────────────────────────────────────────────────────────────────────────

class FakeTarget implements EventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== "function") {
      return;
    }
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== "function") {
      return;
    }
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touchEvent(type: string, changed: readonly FakeTouch[]): Event {
  const event = { type, changedTouches: changed } as unknown as Event;
  return event;
}

function keyEvent(type: string, code: string, repeat = false): Event {
  return { type, code, repeat } as unknown as Event;
}

function pad(axes: number[], pressed: number[] = []): GamepadLike {
  const BUTTON_COUNT = 17;
  const buttons = [];
  for (let i = 0; i < BUTTON_COUNT; i += 1) {
    buttons.push({ pressed: pressed.includes(i) });
  }
  return { axes, buttons, connected: true };
}

/** Drives a clock the sources read, so nothing depends on wall time. */
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const MIN_DISTANCE = TOUCH_CONSTANTS.swipeMinDistance;
const MIN_DURATION = TOUCH_CONSTANTS.swipeMinDurationMs;

// ─────────────────────────────────────────────────────────────────────────────

describe("touch: swipe recognition", () => {
  function setup() {
    const target = new FakeTarget();
    const time = clock();
    const source = createTouchSource({ target, now: time.now });
    const out: Intent = createIntent();
    return { target, time, source, out };
  }

  it("recognises all four cardinal swipes", () => {
    const cases: readonly (readonly [number, number, keyof Intent, number | boolean])[] = [
      [MIN_DISTANCE * 2, 0, "lateral", 1],
      [-MIN_DISTANCE * 2, 0, "lateral", -1],
      [0, -MIN_DISTANCE * 2, "jump", true],
      [0, MIN_DISTANCE * 2, "slide", true],
    ];

    for (const [dx, dy, field, expected] of cases) {
      const { target, time, source, out } = setup();
      target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
      time.advance(MIN_DURATION + 10);
      target.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientX: dx, clientY: dy }]));
      source.poll(out);
      expect(out[field], `swipe (${dx}, ${dy})`).toBe(expected);
    }
  });

  it("FIRES ON THRESHOLD CROSSING, not on touchend", () => {
    // The whole difference between instant and laggy. Waiting for touchend
    // costs the rest of the gesture, which the player has already committed to.
    const { target, time, source, out } = setup();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(MIN_DURATION + 5);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE + 1, clientY: 0 }]),
    );

    // No touchend has been dispatched.
    source.poll(out);
    expect(out.lateral).toBe(1);
  });

  it("ignores travel under the distance threshold", () => {
    const { target, time, source, out } = setup();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE - 1, clientY: 0 }]),
    );
    source.poll(out);
    expect(out.lateral).toBe(0);
  });

  it("ignores gestures shorter than the minimum duration", () => {
    const { target, time, source, out } = setup();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(MIN_DURATION - 20);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE * 3, clientY: 0 }]),
    );
    source.poll(out);
    expect(out.lateral).toBe(0);
  });

  it("fires at most once per touch", () => {
    const { target, time, source, out } = setup();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE * 2, clientY: 0 }]),
    );
    source.poll(out);
    expect(out.lateral).toBe(1);

    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE * 4, clientY: 0 }]),
    );
    source.poll(out);
    expect(out.lateral).toBe(0);
  });
});

describe("touch: the diagonal dead zone", () => {
  function swipe(dx: number, dy: number): Intent {
    const target = new FakeTarget();
    const time = clock();
    const source = createTouchSource({ target, now: time.now });
    const out = createIntent();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientX: dx, clientY: dy }]));
    source.poll(out);
    return out;
  }

  it("discards a 45-degree swipe rather than guessing", () => {
    // Resolving by whichever axis is marginally larger makes a diagonal flip
    // answers on hand tremor, which reads as the game misreading you.
    const d = MIN_DISTANCE * 2;
    const out = swipe(d, d);
    expect(out.lateral).toBe(0);
    expect(out.jump).toBe(false);
    expect(out.slide).toBe(false);
  });

  it("accepts a clearly horizontal swipe with a small vertical component", () => {
    const out = swipe(MIN_DISTANCE * 3, MIN_DISTANCE * 0.5);
    expect(out.lateral).toBe(1);
  });

  it("accepts a clearly vertical swipe with a small horizontal component", () => {
    const out = swipe(MIN_DISTANCE * 0.5, -MIN_DISTANCE * 3);
    expect(out.jump).toBe(true);
  });

  it("rejects everything inside the ambiguous wedge", () => {
    const major = MIN_DISTANCE * 3;
    const justInsideWedge = major * (TOUCH_CONSTANTS.diagonalDeadZone + 0.05);
    const out = swipe(major, justInsideWedge);
    expect(out.lateral).toBe(0);
  });
});

describe("touch: two-finger roll", () => {
  function setup() {
    const target = new FakeTarget();
    const time = clock();
    const source = createTouchSource({ target, now: time.now });
    return { target, time, source, out: createIntent() };
  }

  it("two fingers swiping horizontally is a ROLL, not a lane change", () => {
    const { target, time, source, out } = setup();
    target.dispatchEvent(
      touchEvent("touchstart", [
        { identifier: 1, clientX: 0, clientY: 0 },
        { identifier: 2, clientX: 40, clientY: 0 },
      ]),
    );
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE * 2, clientY: 0 }]),
    );

    source.poll(out);
    expect(out.roll).toBe(1);
    expect(out.lateral).toBe(0);
  });

  it("one finger swiping horizontally is a LANE CHANGE", () => {
    const { target, time, source, out } = setup();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE * 2, clientY: 0 }]),
    );
    source.poll(out);
    expect(out.lateral).toBe(1);
    expect(out.roll).toBe(0);
  });

  it("a second finger landing outside the tolerance is NOT a roll", () => {
    // twoFingerTolerance is the riskiest number in the touch layer — this is
    // the test that will move when it gets tuned on real hardware.
    const { target, time, source, out } = setup();
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientX: 0, clientY: 0 }]));
    time.advance(TOUCH_CONSTANTS.twoFingerToleranceMs * 2);
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: 2, clientX: 40, clientY: 0 }]));
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(
      touchEvent("touchmove", [{ identifier: 1, clientX: MIN_DISTANCE * 2, clientY: 0 }]),
    );

    source.poll(out);
    expect(out.roll).toBe(0);
    expect(out.lateral).toBe(1);
  });

  it("does not also emit a lane change from the second finger", () => {
    const { target, time, source, out } = setup();
    target.dispatchEvent(
      touchEvent("touchstart", [
        { identifier: 1, clientX: 0, clientY: 0 },
        { identifier: 2, clientX: 40, clientY: 0 },
      ]),
    );
    time.advance(MIN_DURATION + 10);
    target.dispatchEvent(
      touchEvent("touchmove", [
        { identifier: 1, clientX: MIN_DISTANCE * 2, clientY: 0 },
        { identifier: 2, clientX: 40 + MIN_DISTANCE * 2, clientY: 0 },
      ]),
    );

    source.poll(out);
    expect(out.roll).toBe(1);
    expect(out.lateral).toBe(0);
  });
});

describe("keyboard", () => {
  function setup() {
    const target = new FakeTarget();
    const time = clock();
    const source = createKeyboardSource({ target, now: time.now });
    return { target, source, out: createIntent() };
  }

  it("maps the GAME_BIBLE §6.1 bindings", () => {
    const cases: readonly (readonly [string, keyof Intent, number | boolean])[] = [
      ["KeyA", "lateral", -1],
      ["ArrowLeft", "lateral", -1],
      ["KeyD", "lateral", 1],
      ["ArrowRight", "lateral", 1],
      ["Space", "jump", true],
      ["KeyW", "jump", true],
      ["KeyS", "slide", true],
      ["ArrowDown", "slide", true],
      ["KeyQ", "roll", -1],
      ["KeyE", "roll", 1],
      // Shift is OVERDRIVE, not slide. P03 bound it to slide on the shooter
      // "crouch" instinct and this test encoded that mistake; §6.1 is explicit
      // that Shift and F are Overdrive. Corrected at P08.
      ["ShiftLeft", "overdrive", true],
      ["ShiftRight", "overdrive", true],
      ["KeyF", "overdrive", true],
    ];

    for (const [code, field, expected] of cases) {
      const { target, source, out } = setup();
      target.dispatchEvent(keyEvent("keydown", code));
      source.poll(out);
      expect(out[field], code).toBe(expected);
    }
  });

  it("lateral is edge-triggered — a held key produces ONE lane change", () => {
    const { target, source, out } = setup();
    target.dispatchEvent(keyEvent("keydown", "KeyD"));
    source.poll(out);
    expect(out.lateral).toBe(1);

    for (let i = 0; i < 10; i += 1) {
      source.poll(out);
      expect(out.lateral).toBe(0);
    }
  });

  it("ignores auto-repeat", () => {
    const { target, source, out } = setup();
    target.dispatchEvent(keyEvent("keydown", "KeyD"));
    source.poll(out);
    target.dispatchEvent(keyEvent("keydown", "KeyD", true));
    source.poll(out);
    expect(out.lateral).toBe(0);
  });

  it("jump is HELD, so the controller can see the release edge", () => {
    const { target, source, out } = setup();
    target.dispatchEvent(keyEvent("keydown", "Space"));
    for (let i = 0; i < 5; i += 1) {
      source.poll(out);
      expect(out.jump).toBe(true);
    }
    target.dispatchEvent(keyEvent("keyup", "Space"));
    source.poll(out);
    expect(out.jump).toBe(false);
  });

  it("releasing one of two held jump keys keeps the jump held", () => {
    const { target, source, out } = setup();
    target.dispatchEvent(keyEvent("keydown", "Space"));
    target.dispatchEvent(keyEvent("keydown", "KeyW"));
    target.dispatchEvent(keyEvent("keyup", "Space"));
    source.poll(out);
    expect(out.jump).toBe(true);
  });

  it("blur releases everything", () => {
    // Otherwise the player returns to the tab mid-jump.
    const { target, source, out } = setup();
    target.dispatchEvent(keyEvent("keydown", "Space"));
    target.dispatchEvent({ type: "blur" } as Event);
    source.poll(out);
    expect(out.jump).toBe(false);
  });

  it("dispose removes its listeners", () => {
    const target = new FakeTarget();
    const source = createKeyboardSource({ target });
    expect(target.count("keydown")).toBe(1);
    source.dispose();
    expect(target.count("keydown")).toBe(0);
  });
});

describe("gamepad: stick hysteresis", () => {
  it("fires once on crossing the threshold", () => {
    let current = pad([0]);
    const source = createGamepadSource({ getGamepads: () => [current] });
    const out = createIntent();

    source.poll(out);
    expect(out.lateral).toBe(0);

    current = pad([TUNING.input.gamepad.stickThreshold + 0.1]);
    source.poll(out);
    expect(out.lateral).toBe(1);
  });

  it("does NOT repeat while the stick stays deflected", () => {
    const current = pad([1]);
    const source = createGamepadSource({ getGamepads: () => [current] });
    const out = createIntent();

    source.poll(out);
    expect(out.lateral).toBe(1);
    for (let i = 0; i < 10; i += 1) {
      source.poll(out);
      expect(out.lateral).toBe(0);
    }
  });

  it("re-arms only after returning inside the release threshold", () => {
    let current = pad([1]);
    const source = createGamepadSource({ getGamepads: () => [current] });
    const out = createIntent();

    source.poll(out);
    expect(out.lateral).toBe(1);

    // Between the two thresholds: still latched, must not re-fire.
    current = pad([
      (TUNING.input.gamepad.stickThreshold + TUNING.input.gamepad.stickReleaseThreshold) / 2,
    ]);
    source.poll(out);
    expect(out.lateral).toBe(0);

    current = pad([1]);
    source.poll(out);
    expect(out.lateral).toBe(0);

    // Inside the release band: re-armed.
    current = pad([0]);
    source.poll(out);
    current = pad([1]);
    source.poll(out);
    expect(out.lateral).toBe(1);
  });

  it("does not chatter on noise around the threshold", () => {
    // The failure the hysteresis band exists to prevent.
    let current = pad([0]);
    const source = createGamepadSource({ getGamepads: () => [current] });
    const out = createIntent();
    const threshold = TUNING.input.gamepad.stickThreshold;

    let fires = 0;
    for (let i = 0; i < 50; i += 1) {
      current = pad([threshold + (i % 2 === 0 ? 0.01 : -0.01)]);
      source.poll(out);
      if (out.lateral !== 0) {
        fires += 1;
      }
    }
    expect(fires).toBe(1);
  });
});

describe("gamepad: buttons", () => {
  it("maps the GAME_BIBLE §6.3 bindings", () => {
    const out = createIntent();

    const jumpPad = pad([0], [GAMEPAD_BINDINGS.jump]);
    const jumpSource = createGamepadSource({ getGamepads: () => [jumpPad] });
    jumpSource.poll(out);
    expect(out.jump).toBe(true);

    const rollPad = pad([0], [GAMEPAD_BINDINGS.rollRight]);
    const rollSource = createGamepadSource({ getGamepads: () => [rollPad] });
    rollSource.poll(out);
    expect(out.roll).toBe(1);
  });

  it("the d-pad is edge-triggered", () => {
    const held = pad([0], [GAMEPAD_BINDINGS.laneLeft]);
    const source = createGamepadSource({ getGamepads: () => [held] });
    const out = createIntent();

    source.poll(out);
    expect(out.lateral).toBe(-1);
    source.poll(out);
    expect(out.lateral).toBe(0);
  });

  it("produces nothing when no pad is connected", () => {
    const source = createGamepadSource({ getGamepads: () => [null] });
    const out = createIntent();
    source.poll(out);
    expect(out.lateral).toBe(0);
    expect(out.jump).toBe(false);
  });
});

describe("the manager merges sources", () => {
  it("combines keyboard and gamepad without either winning outright", () => {
    const target = new FakeTarget();
    const keyboard = createKeyboardSource({ target });
    const gamepadState = pad([0], [GAMEPAD_BINDINGS.jump]);
    const gamepad = createGamepadSource({ getGamepads: () => [gamepadState] });
    const manager = createInputManager([keyboard, gamepad]);

    target.dispatchEvent(keyEvent("keydown", "KeyD"));
    const intent = manager.poll();

    expect(intent.lateral).toBe(1);
    expect(intent.jump).toBe(true);
  });

  it("sanitises before handing anything to the sim", () => {
    const bogus: IntentSourceStub = {
      name: "bogus",
      isActive: () => true,
      poll(out: Intent) {
        out.lateral = 99;
        out.roll = Number.NaN;
        out.jump = true;
        out.slide = false;
      },
      dispose() {},
    };
    const manager = createInputManager([bogus]);
    const intent = manager.poll();

    expect(intent.lateral).toBe(1);
    expect(intent.roll).toBe(0);
  });

  it("reuses one intent object rather than allocating per frame", () => {
    const manager = createInputManager([]);
    expect(manager.poll()).toBe(manager.poll());
  });

  it("disposes every source", () => {
    const target = new FakeTarget();
    const manager = createInputManager([createKeyboardSource({ target })]);
    expect(target.count("keydown")).toBe(1);
    manager.dispose();
    expect(target.count("keydown")).toBe(0);
  });
});

/** Local structural type so the bogus source above needs no import gymnastics. */
interface IntentSourceStub {
  readonly name: string;
  isActive(): boolean;
  poll(out: Intent): void;
  dispose(): void;
}
