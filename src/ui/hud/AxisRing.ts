/**
 * THE AXIS RING — the Flow meter, and the signature element of this UI.
 *
 * ## It is a square, and that is the whole idea
 *
 * Every game's meter is a circle, and a circle is the one shape that says nothing
 * about *this* game. AXIS is a four-face square prism (GAME_BIBLE §3.1), so the
 * meter is a square with four sides, one per face — the HUD is a diagram of the
 * level rather than a widget laid over it.
 *
 * It also reads better in peripheral vision than an arc, for a mechanical reason.
 * TUNING.md §9.1 makes Flow the thing the player must track while doing something
 * else at 34 u/s, and the periphery is poor at magnitude but good at discrete
 * change. On a square, 25 / 50 / 75 / 100% land exactly on the four corners, so
 * "the ink turned the corner" is an event you can catch without looking. An arc's
 * fill is a continuous quantity the periphery cannot read at all.
 *
 * ## It carries a second fact for free
 *
 * The side representing the face currently under the player's feet is drawn at
 * double key-line weight. Two pieces of information, one element, no extra pixels
 * — and the face indicator is the one HUD readout the 3D view genuinely does not
 * give you at a glance during a roll.
 *
 * ## Full, and asking to be spent
 *
 * At 100 the ring closes, floods to a solid accent plate, the key-line thickens
 * from 6px to 10px, and it pulses in scale **on the musical bar** — the period is
 * derived from `TUNING.audio` arithmetically, so the meter breathes in time with
 * the music already playing without this file importing the audio layer.
 *
 * No glow, ever. GAME_BIBLE §11.3 permits emission only inside Overdrive, so
 * "ready" is carried by ink weight and motion. That constraint produced a better
 * answer than a glow would have.
 *
 * ## Why raw SVG and raw DOM
 *
 * Written at up to 15Hz from the frame loop. Everything here is a `setAttribute`
 * on a node created once. See `hud-sink.ts` for why the frame loop may never read
 * back from any of it.
 */

import { TUNING } from "@/game/config/tuning";
import { EASE, MOTION, motionIsReduced } from "../motion";
import {
  BOX,
  PATH_LENGTH,
  barMilliseconds,
  dashOffsetForFlow,
  facePath,
  isFull,
  normaliseFace,
  ringPath,
  tickCoordinates,
} from "./ring-geometry";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface AxisRing {
  readonly element: HTMLElement;
  /** Flow 0..100. */
  setFlow(value: number): void;
  /** Score multiplier, shown in the centre. */
  setMultiplier(value: number): void;
  /** Which face is the floor, 0..3. */
  setFace(face: number): void;
  /** Shields held, as pips under the ring. */
  setShields(count: number): void;
  /** A near-miss landed. One hard scale kick, decaying. */
  kick(): void;
  /** Overdrive opened or closed. */
  setOverdrive(active: boolean): void;
  dispose(): void;
}

export function createAxisRing(): AxisRing {
  const element = document.createElement("div");
  element.className = "axis-ring";

  // The ring is also the Overdrive button on touch (GAME_BIBLE §6.2), so it is a
  // real button with a real accessible name, not a decorated div. Keyboard and
  // gamepad reach Overdrive through their own bindings, but a screen-reader user
  // on a touch device has only this.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "axis-ring-button";
  button.setAttribute("aria-label", "Flow meter. Activate to spend Overdrive.");
  // The live value is published here rather than on the SVG, so assistive tech
  // reads one number instead of walking a path.
  button.setAttribute("role", "meter");
  button.setAttribute("aria-valuemin", "0");
  button.setAttribute("aria-valuemax", String(TUNING.flow.flowMax));
  button.setAttribute("aria-valuenow", "0");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${BOX} ${BOX}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("axis-ring-svg");

  const inset = TUNING.ui.ringStroke;

  // Track — the unfilled remainder. Structural colour, never text.
  const track = document.createElementNS(SVG_NS, "path");
  track.setAttribute("d", ringPath(inset));
  track.setAttribute("class", "axis-ring-track");
  track.setAttribute("pathLength", String(PATH_LENGTH));
  svg.appendChild(track);

  // Corner ticks at 25 / 50 / 75. Present at all times and independent of hue,
  // so a colourblind player still has the quarter landmarks the shape promises.
  const ticks = document.createElementNS(SVG_NS, "g");
  ticks.setAttribute("class", "axis-ring-ticks");
  for (const [x1, y1, x2, y2] of tickCoordinates(inset)) {
    const tick = document.createElementNS(SVG_NS, "line");
    tick.setAttribute("x1", String(x1));
    tick.setAttribute("y1", String(y1));
    tick.setAttribute("x2", String(x2));
    tick.setAttribute("y2", String(y2));
    ticks.appendChild(tick);
  }
  svg.appendChild(ticks);

  // Fill — the Flow itself.
  const fill = document.createElementNS(SVG_NS, "path");
  fill.setAttribute("d", ringPath(inset));
  fill.setAttribute("class", "axis-ring-fill");
  fill.setAttribute("pathLength", String(PATH_LENGTH));
  fill.setAttribute("stroke-dasharray", String(PATH_LENGTH));
  fill.setAttribute("stroke-dashoffset", String(PATH_LENGTH));
  svg.appendChild(fill);

  // The face indicator, over everything.
  const faceMark = document.createElementNS(SVG_NS, "path");
  faceMark.setAttribute("d", facePath(0, inset));
  faceMark.setAttribute("class", "axis-ring-face");
  svg.appendChild(faceMark);

  button.appendChild(svg);

  const centre = document.createElement("span");
  centre.className = "axis-ring-centre";
  centre.setAttribute("aria-hidden", "true");
  centre.textContent = "1.0×";
  button.appendChild(centre);

  element.appendChild(button);

  const shields = document.createElement("div");
  shields.className = "axis-ring-shields";
  shields.setAttribute("aria-hidden", "true");
  element.appendChild(shields);

  element.style.setProperty("--axis-ring-pulse-ms", `${barMilliseconds()}ms`);

  let flow = -1;
  let face = -1;
  let full = false;
  let multiplier = -1;
  let shieldCount = -1;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;

  function setFull(next: boolean): void {
    if (next === full) {
      return;
    }
    full = next;
    element.dataset["full"] = next ? "1" : "0";
    // The idle pulse is ambient motion with no information in it — the player
    // already knows the meter is full because it is closed and flooded. So it is
    // the one thing here reduced motion removes outright.
    element.dataset["pulse"] = next && !motionIsReduced() ? "1" : "0";
  }

  return {
    element,

    setFlow(value: number): void {
      if (!Number.isFinite(value)) {
        return;
      }
      const offset = dashOffsetForFlow(value);
      if (offset === flow) {
        return;
      }
      flow = offset;
      fill.setAttribute("stroke-dashoffset", String(offset));
      button.setAttribute("aria-valuenow", String(Math.round(value)));
      setFull(isFull(value));
    },

    setMultiplier(value: number): void {
      if (!Number.isFinite(value)) {
        return;
      }
      const rounded = Math.round(value * 10) / 10;
      if (rounded === multiplier) {
        return;
      }
      multiplier = rounded;
      centre.textContent = `${rounded.toFixed(1)}×`;
    },

    setFace(next: number): void {
      const index = normaliseFace(next);
      if (index === face) {
        return;
      }
      face = index;
      faceMark.setAttribute("d", facePath(index, inset));
    },

    setShields(count: number): void {
      const next = Math.max(0, Math.trunc(count));
      if (next === shieldCount) {
        return;
      }
      shieldCount = next;
      // Rebuilt rather than diffed: this changes a handful of times per run at
      // most, and three nodes is cheaper to recreate than to reconcile.
      shields.textContent = "";
      for (let i = 0; i < next; i += 1) {
        const pip = document.createElement("span");
        pip.className = "axis-ring-shield";
        shields.appendChild(pip);
      }
    },

    kick(): void {
      if (motionIsReduced()) {
        return;
      }
      // The attack is instant on purpose — an eased attack on an impact reads as
      // a bounce rather than a hit. Only the recovery is curved.
      element.style.transition = "none";
      element.style.transform = `scale(${TUNING.ui.ringKickScale})`;
      // Forced reflow so the browser does not coalesce the two writes into one.
      void element.offsetWidth;
      element.style.transition = `transform ${MOTION.ringKick}ms ${EASE.out}`;
      element.style.transform = "scale(1)";
      if (kickTimer !== null) {
        clearTimeout(kickTimer);
      }
      kickTimer = setTimeout(() => {
        element.style.transition = "";
        kickTimer = null;
      }, MOTION.ringKick);
    },

    setOverdrive(active: boolean): void {
      element.dataset["overdrive"] = active ? "1" : "0";
    },

    dispose(): void {
      if (kickTimer !== null) {
        clearTimeout(kickTimer);
        kickTimer = null;
      }
      element.remove();
    },
  };
}
