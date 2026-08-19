/**
 * Gamepad menu navigation.
 *
 * The polling loop needs a browser, so what is tested here is the part that
 * decides anything: the button-to-key mapping, and the stick hysteresis. The
 * loop itself is exercised in `tests/e2e/ui.spec.ts`.
 *
 * ## Why the mapping is a test and not just a table
 *
 * The navigator works by **synthesising keyboard events** rather than moving
 * focus itself, so the roving tabindex, the native `<input type=range>`, button
 * activation and every screen's Escape handler all work with a pad without
 * knowing a pad exists. That only holds if the mapping is right: bind B to
 * something other than Escape and a controller player cannot leave a screen.
 */

import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { BUTTON, KEY_FOR_BUTTON, stickHeld } from "@/ui/a11y/gamepad-nav";

const ON = TUNING.input.gamepad.stickThreshold;
const OFF = TUNING.input.gamepad.stickReleaseThreshold;

describe("the button mapping", () => {
  it("uses the Standard Gamepad indices from GAME_BIBLE §6.3", () => {
    expect(BUTTON.a).toBe(0);
    expect(BUTTON.b).toBe(1);
    expect(BUTTON.dpadUp).toBe(12);
    expect(BUTTON.dpadDown).toBe(13);
    expect(BUTTON.dpadLeft).toBe(14);
    expect(BUTTON.dpadRight).toBe(15);
  });

  it("makes A activate and B go back", () => {
    // Without these two a controller player can enter a screen and not leave it.
    expect(KEY_FOR_BUTTON[BUTTON.a]).toBe("Enter");
    expect(KEY_FOR_BUTTON[BUTTON.b]).toBe("Escape");
  });

  it("maps the whole d-pad to arrows", () => {
    expect(KEY_FOR_BUTTON[BUTTON.dpadUp]).toBe("ArrowUp");
    expect(KEY_FOR_BUTTON[BUTTON.dpadDown]).toBe("ArrowDown");
    expect(KEY_FOR_BUTTON[BUTTON.dpadLeft]).toBe("ArrowLeft");
    expect(KEY_FOR_BUTTON[BUTTON.dpadRight]).toBe("ArrowRight");
  });

  it("binds nothing else, so a stray button cannot navigate", () => {
    expect(Object.keys(KEY_FOR_BUTTON)).toHaveLength(6);
  });
});

describe("stick hysteresis", () => {
  it("reuses the gameplay band rather than picking new numbers", () => {
    // §6.3 specifies ±0.5 to fire and a return inside ±0.25 to re-arm. The menu
    // navigator uses the same values so stick feel is one setting, not two.
    expect(ON).toBe(0.5);
    expect(OFF).toBe(0.25);
    expect(OFF).toBeLessThan(ON);
  });

  it("does not fire below the threshold", () => {
    expect(stickHeld(0.49, false, true)).toBe(false);
    expect(stickHeld(0, false, true)).toBe(false);
  });

  it("fires past the threshold", () => {
    expect(stickHeld(0.51, false, true)).toBe(true);
    expect(stickHeld(1, false, true)).toBe(true);
  });

  /**
   * The whole point of the band. A stick resting at 0.4 after a deliberate push
   * must stay held rather than re-firing every frame, which would race a menu
   * from top to bottom in a third of a second.
   */
  it("stays held inside the band once triggered", () => {
    expect(stickHeld(0.4, true, true)).toBe(true);
    expect(stickHeld(0.26, true, true)).toBe(true);
  });

  it("releases only once the stick is back inside the release band", () => {
    expect(stickHeld(0.25, true, true)).toBe(false);
    expect(stickHeld(0.1, true, true)).toBe(false);
  });

  it("treats the two halves of an axis independently", () => {
    // Pushing left then right without passing through centre must fire both.
    expect(stickHeld(-0.8, false, false)).toBe(true);
    expect(stickHeld(-0.8, false, true)).toBe(false);
    expect(stickHeld(0.8, false, true)).toBe(true);
    expect(stickHeld(0.8, false, false)).toBe(false);
  });

  it("never fires on a broken axis reading", () => {
    // A disconnected or misreporting pad returns NaN on some platforms; a NaN
    // comparison is false either way, but stating it makes the behaviour a
    // decision rather than an accident of IEEE-754.
    expect(stickHeld(Number.NaN, false, true)).toBe(false);
    expect(stickHeld(Number.NaN, true, true)).toBe(false);
  });

  it("cannot chatter: no value is both held-releasing and idle-firing", () => {
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const firesFromIdle = stickHeld(v, false, true);
      const staysHeld = stickHeld(v, true, true);
      // A value that fires from idle must also stay held. The reverse is the
      // band, and is allowed.
      if (firesFromIdle) {
        expect(staysHeld, `${v} fires but does not hold`).toBe(true);
      }
    }
  });
});
