/**
 * Menu navigation with a gamepad.
 *
 * A game you can play with a controller and then have to reach for a mouse to
 * spend your Bits is not finished, so every screen is fully operable from the
 * pad. GAME_BIBLE §6.3 already maps the pad for gameplay; this is the menu half.
 *
 * ## It synthesises keyboard events rather than moving focus itself
 *
 * D-pad up becomes an `ArrowUp` keydown; A becomes Enter; B becomes Escape. That
 * means `focus.ts`'s roving tabindex, the native `<input type=range>`, `<button>`
 * activation and every screen's Escape handler all work with the pad **without
 * knowing the pad exists**. One implementation of navigation, three input
 * devices. Reimplementing focus movement here would be a second, subtly different
 * navigator that drifts from the keyboard one.
 *
 * ## Hysteresis, reused deliberately
 *
 * The stick is edge-triggered with the same band as gameplay —
 * `stickThreshold` 0.50 to fire, `stickReleaseThreshold` 0.25 to re-arm. A held
 * stick does not repeat, which is right for a menu and matches §6.3 exactly. The
 * numbers come from `TUNING.input` rather than being re-picked, so a change to
 * stick feel applies in both places.
 *
 * ## Only while a screen is open
 *
 * `start()` is called by the screen router when a screen mounts and stopped when
 * the last one closes. During a run the pad belongs to the game, and a D-pad
 * press that both changes lane and moves menu focus would be a real bug.
 */

import { TUNING } from "@/game/config/tuning";

/** Standard Gamepad button indices — GAME_BIBLE §6.3. */
export const BUTTON = {
  a: 0,
  b: 1,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

const AXIS_X = 0;
const AXIS_Y = 1;

/** Button index to the key it stands in for. */
export const KEY_FOR_BUTTON: Readonly<Record<number, string>> = Object.freeze({
  [BUTTON.a]: "Enter",
  [BUTTON.b]: "Escape",
  [BUTTON.dpadUp]: "ArrowUp",
  [BUTTON.dpadDown]: "ArrowDown",
  [BUTTON.dpadLeft]: "ArrowLeft",
  [BUTTON.dpadRight]: "ArrowRight",
});

/**
 * The hysteresis decision for one stick direction, as a pure function.
 *
 * Separated from the polling loop so it is testable without a browser — the
 * repository has no DOM environment in vitest, and the part of this file worth
 * testing is the band logic, not `requestAnimationFrame`.
 *
 * `positive` selects which half of the axis this direction watches. A held
 * direction stays held until the stick returns inside the release band, which is
 * what stops a resting stick from chattering across a menu.
 */
export function stickHeld(
  value: number,
  wasHeld: boolean,
  positive: boolean,
  on: number = TUNING.input.gamepad.stickThreshold,
  off: number = TUNING.input.gamepad.stickReleaseThreshold,
): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  const magnitude = positive ? value : -value;
  return wasHeld ? magnitude > off : magnitude > on;
}

export interface GamepadNav {
  stop(): void;
}

type GetGamepads = () => readonly (Gamepad | null)[];

/**
 * Starts polling.
 *
 * `getGamepads` is injected for the same reason P03 injected it: the Gamepad API
 * cannot be exercised in a test environment, and reaching for `navigator` inside
 * the loop would make this file untestable.
 */
export function startGamepadNav(getGamepads?: GetGamepads): GamepadNav {
  const read: GetGamepads =
    getGamepads ??
    (() =>
      typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
        ? navigator.getGamepads()
        : []);

  // Which inputs are currently held. Edge-triggered: an entry is added on the
  // rising edge and removed once it falls back inside the release band.
  const held = new Set<string>();
  let frame = 0;

  function dispatch(key: string): void {
    const target = document.activeElement ?? document.body;
    // `bubbles` so the roving-tabindex listener on the container sees it, and
    // `cancelable` so `preventDefault()` inside that listener behaves normally.
    const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(down);
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));

    /**
     * Enter needs a real click, not just a key event.
     *
     * A browser turns Enter on a focused button into a click as the **default
     * action** of a *trusted* key event. A synthetic `dispatchEvent` has no
     * default action, so every listener fired and nothing happened — the A
     * button moved focus around perfectly and could not press a single thing.
     *
     * `.click()` is the honest fix: a genuine click event with the normal
     * default behaviour, which is exactly what the key would have produced.
     *
     * Skipped when a listener called `preventDefault`, which is how a screen
     * says it has already handled Enter — firing both would double-activate.
     * Skipped for native controls, which act on the key themselves.
     */
    const NATIVE_ACTIVATION = new Set(["INPUT", "SELECT", "TEXTAREA", "A"]);
    if (
      key === "Enter" &&
      !down.defaultPrevented &&
      target instanceof HTMLElement &&
      !NATIVE_ACTIVATION.has(target.tagName)
    ) {
      target.click();
    }
  }

  function edge(id: string, active: boolean, key: string): void {
    if (active && !held.has(id)) {
      held.add(id);
      dispatch(key);
    } else if (!active && held.has(id)) {
      held.delete(id);
    }
  }

  function poll(): void {
    frame = requestAnimationFrame(poll);
    const pads = read();
    for (const pad of pads) {
      if (pad === null || !pad.connected) {
        continue;
      }

      for (const [index, key] of Object.entries(KEY_FOR_BUTTON)) {
        const button = pad.buttons[Number(index)];
        edge(`${pad.index}:b${index}`, button?.pressed === true, key);
      }

      // Sticks, with the gameplay hysteresis band. Two ids per axis so pushing
      // left then right without returning to centre still fires both.
      const x = pad.axes[AXIS_X] ?? 0;
      const y = pad.axes[AXIS_Y] ?? 0;

      for (const [id, value, positive, key] of [
        [`${pad.index}:xr`, x, true, "ArrowRight"],
        [`${pad.index}:xl`, x, false, "ArrowLeft"],
        [`${pad.index}:yd`, y, true, "ArrowDown"],
        [`${pad.index}:yu`, y, false, "ArrowUp"],
      ] as const) {
        edge(id, stickHeld(value, held.has(id), positive), key);
      }
    }
  }

  frame = requestAnimationFrame(poll);

  return {
    stop(): void {
      cancelAnimationFrame(frame);
      held.clear();
    },
  };
}
