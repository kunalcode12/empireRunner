/**
 * Focus management for screens.
 *
 * Two jobs, both of which are invisible when done and obvious when not:
 *
 *   - **A screen traps focus.** Tabbing out of an open pause menu onto the game
 *     canvas behind it puts the focus ring somewhere the player cannot see, and
 *     the next Enter presses a button nobody knows is focused.
 *   - **A screen restores focus on close.** Coming back from Settings should
 *     return the ring to the Settings button, not to the top of the document.
 *
 * Both are standard and both are usually skipped, which is why the a11y gate in
 * `tests/e2e/ui.spec.ts` checks them explicitly.
 */

/**
 * Elements that can hold focus.
 *
 * `:not([disabled])` and the negative-tabindex exclusion matter: a roving-tabindex
 * grid sets `tabindex="-1"` on every cell but the current one, and those must not
 * be reachable by Tab or the trap will cycle through forty avatar tiles.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Everything focusable inside a container, in document order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  const found = container.querySelectorAll<HTMLElement>(FOCUSABLE);
  const result: HTMLElement[] = [];
  for (const element of found) {
    // `offsetParent === null` catches `display: none` ancestors, which
    // `querySelectorAll` happily returns. `hidden` catches the attribute.
    if (element.offsetParent !== null || element.tagName === "SUMMARY") {
      result.push(element);
    }
  }
  return result;
}

export interface FocusTrap {
  release(): void;
}

/**
 * Traps Tab inside a container and restores focus when released.
 *
 * `autoFocus` names the element to focus on open; without it the first focusable
 * element gets it. Escape is NOT handled here — the screen owns that, because
 * what Escape means differs (close the modal, resume the run, go back a level).
 */
export function trapFocus(container: HTMLElement, autoFocus?: HTMLElement | null): FocusTrap {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // An explicit `[data-autofocus]` wins over document order. Without it the trap
  // takes the first focusable element, which on the pause screen is the header's
  // BACK button rather than RESUME — see the note in `Button.tsx`.
  const marked = container.querySelector<HTMLElement>("[data-autofocus='1']");
  const initial = autoFocus ?? marked ?? focusableWithin(container)[0] ?? container;
  // A container with nothing focusable still needs to receive focus, or a screen
  // reader stays on the page behind it.
  if (initial === container && !container.hasAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
  }
  initial.focus();

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Tab") {
      return;
    }
    const items = focusableWithin(container);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !container.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onKeyDown, true);

  return {
    release(): void {
      document.removeEventListener("keydown", onKeyDown, true);
      // Guard on `isConnected`: the trigger may have unmounted with the screen
      // that opened it, and focusing a detached node silently drops focus to
      // `<body>`, which is the bug this function exists to prevent.
      if (previous !== null && previous.isConnected) {
        previous.focus();
      }
    },
  };
}

/**
 * Arrow-key focus movement across a whole screen.
 *
 * ## Why this exists — "full gamepad navigation" was not true without it
 *
 * The gamepad navigator synthesises `ArrowUp`/`ArrowDown`/`Enter`/`Escape`, on
 * the theory that whatever handles keyboard navigation will handle the pad for
 * free. That theory had a hole: **nothing moved focus between plain buttons.**
 * Arrow keys move focus inside a roving grid and inside a tablist, and a
 * keyboard user reaches everything else with Tab — but a controller has no Tab.
 *
 * So a player on a pad could activate whichever button happened to be
 * autofocused and nothing else. The title menu, the shop list and the settings
 * screen were all unreachable. Caught by driving a fake pad through a real
 * browser; every unit test passed throughout, because the units were all correct.
 *
 * ## What it must not break
 *
 * Arrow keys already mean something in three places, and this defers to all of
 * them: a native control (a range input adjusts its value), a roving container
 * (the avatar grid moves within the grid), and a tablist (arrows switch tabs).
 * Deference is by `defaultPrevented` plus an explicit check, because a handler
 * that only checks one of those will eat a slider.
 */
export function arrowFocusNavigation(container: HTMLElement): { release(): void } {
  const NATIVE = new Set(["INPUT", "SELECT", "TEXTAREA"]);

  function onKeyDown(event: KeyboardEvent): void {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back) {
      return;
    }
    // A child already acted on it — a roving grid, or a tablist.
    if (event.defaultPrevented) {
      return;
    }

    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !container.contains(active)) {
      return;
    }
    // Native controls own their arrows. A range input must adjust, not move on.
    if (NATIVE.has(active.tagName)) {
      return;
    }
    // Roving containers and tablists own theirs too.
    if (active.hasAttribute("data-nav") || active.closest("[role='tablist']") !== null) {
      return;
    }

    const items = focusableWithin(container);
    const index = items.indexOf(active);
    if (index < 0 || items.length === 0) {
      return;
    }
    // Clamped, not wrapped: wrapping from the last control back to the first is
    // disorienting when the whole screen is not visible at once.
    const next = Math.max(0, Math.min(items.length - 1, index + (forward ? 1 : -1)));
    if (next === index) {
      return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  container.addEventListener("keydown", onKeyDown);
  return {
    release(): void {
      container.removeEventListener("keydown", onKeyDown);
    },
  };
}

/**
 * Roving tabindex over a grid or list.
 *
 * One element is tabbable; arrows move between them. This is what WAI-ARIA asks
 * for on a composite widget and it is also what makes gamepad navigation
 * possible, since `gamepad-nav.ts` synthesises the same arrow keys.
 *
 * Returns a function to re-scan after the item set changes.
 */
export function rovingTabindex(
  container: HTMLElement,
  columns: number,
): { refresh(): void; release(): void } {
  function items(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-nav]"));
  }

  function refresh(): void {
    const list = items();
    let hasTabbable = false;
    for (const item of list) {
      if (item.getAttribute("tabindex") === "0") {
        hasTabbable = true;
      }
    }
    if (!hasTabbable) {
      for (let i = 0; i < list.length; i += 1) {
        list[i]?.setAttribute("tabindex", i === 0 ? "0" : "-1");
      }
    }
  }

  function move(from: number, delta: number): void {
    const list = items();
    if (list.length === 0) {
      return;
    }
    // Clamped rather than wrapped. Wrapping a 2D grid from the end of one row to
    // the start of the next is fine; wrapping from the last tile to the first is
    // disorienting when you cannot see the whole grid, which is the mobile case.
    const next = Math.max(0, Math.min(list.length - 1, from + delta));
    for (let i = 0; i < list.length; i += 1) {
      list[i]?.setAttribute("tabindex", i === next ? "0" : "-1");
    }
    list[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (index < 0) {
      return;
    }
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        move(index, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        move(index, -1);
        break;
      case "ArrowDown":
        event.preventDefault();
        move(index, columns);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(index, -columns);
        break;
      case "Home":
        event.preventDefault();
        move(index, -index);
        break;
      case "End":
        event.preventDefault();
        move(index, list.length - 1 - index);
        break;
      default:
        break;
    }
  }

  container.addEventListener("keydown", onKeyDown);
  refresh();

  return {
    refresh,
    release(): void {
      container.removeEventListener("keydown", onKeyDown);
    },
  };
}
