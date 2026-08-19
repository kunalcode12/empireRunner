/**
 * The floating "+6" that leaves the ring on a Flow award.
 *
 * ## Pooled, because a good run emits sixty of these
 *
 * GAME_BIBLE §9.1 has an avatar challenge for 60 near-misses in a single run, so
 * sixty is a design target rather than a worst case. Creating and discarding a
 * DOM node per award is sixty allocations and sixty style recalculations in the
 * frames where the player is doing best — exactly where a hitch is least
 * forgivable. So the nodes are made once and recycled, in the same spirit as
 * ARCHITECTURE law (d), even though this is not the sim and the law does not
 * formally reach here.
 *
 * ## Why the animation is CSS and the recycling is a timer
 *
 * The travel is a `transform` and the disappearance is `visibility` — no opacity
 * fade, per GAME_BIBLE §11.2's rule for numerals. Recycling on `transitionend`
 * would be tidier but that event does not fire if the tab is hidden mid-flight,
 * and the node would then never return to the pool. A timer always fires.
 */

import { TUNING } from "@/game/config/tuning";
import { EASE, MOTION, motionIsReduced } from "../motion";

interface PooledPopup {
  readonly node: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
}

export interface FlowPopups {
  readonly element: HTMLElement;
  /** Shows one award. Silently drops it if every node is in flight. */
  show(amount: number): void;
  dispose(): void;
}

export function createFlowPopups(): FlowPopups {
  const element = document.createElement("div");
  element.className = "axis-flow-popups";
  // Decoration for a value the meter already publishes. Announcing "+6" sixty
  // times would bury everything else a screen reader has to say.
  element.setAttribute("aria-hidden", "true");

  const pool: PooledPopup[] = [];
  for (let i = 0; i < TUNING.ui.flowPopupPool; i += 1) {
    const node = document.createElement("span");
    node.className = "axis-flow-popup";
    node.style.visibility = "hidden";
    element.appendChild(node);
    pool.push({ node, timer: null, busy: false });
  }

  let next = 0;

  return {
    element,

    show(amount: number): void {
      if (!Number.isFinite(amount) || amount <= 0 || motionIsReduced()) {
        return;
      }

      // Round-robin from the last used slot. If everything is in flight the
      // award is dropped rather than stealing a node mid-flight — a numeral
      // that teleports is worse than one that never appeared, and the Flow it
      // represents is already on the meter regardless.
      let slot: PooledPopup | null = null;
      for (let i = 0; i < pool.length; i += 1) {
        const candidate = pool[(next + i) % pool.length];
        if (candidate !== undefined && !candidate.busy) {
          slot = candidate;
          next = (next + i + 1) % pool.length;
          break;
        }
      }
      if (slot === null) {
        return;
      }

      const { node } = slot;
      slot.busy = true;
      node.textContent = `+${Math.round(amount)}`;

      node.style.transition = "none";
      node.style.transform = "translate3d(0, 0, 0)";
      node.style.visibility = "visible";
      void node.offsetWidth;

      node.style.transition = `transform ${MOTION.flowPopup}ms ${EASE.out}`;
      node.style.transform = `translate3d(0, -${TUNING.ui.flowPopupDriftPx}px, 0)`;

      if (slot.timer !== null) {
        clearTimeout(slot.timer);
      }
      slot.timer = setTimeout(() => {
        node.style.visibility = "hidden";
        node.style.transition = "none";
        node.style.transform = "translate3d(0, 0, 0)";
        slot.busy = false;
        slot.timer = null;
      }, MOTION.flowPopup);
    },

    dispose(): void {
      for (const slot of pool) {
        if (slot.timer !== null) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
      }
      pool.length = 0;
      element.remove();
    },
  };
}
