/**
 * The Fracture window — 1.2 seconds, one correct verb, one Shard.
 *
 * GAME_BIBLE §5: "The HUD shows the Shard cost and a draining 1.2s ring." This is
 * that ring, and it is the highest-stakes 1.2 seconds in the game, so it gets the
 * centre of the screen and everything else dims behind it.
 *
 * ## It names the verb
 *
 * §5.2: the sim computes the single verb that would have cleared the death, and
 * Fracture only arms when there is exactly one. Withholding it would make the
 * window a memory test on geometry the player has 1.2 seconds to re-read; naming
 * it makes the window an *execution* test, which is what §5 says it is — "a skill
 * test, not a purchase". The difficulty is in the hands, not in the puzzle.
 *
 * ## It is a square, like the AXIS ring
 *
 * Same shape language, drained anticlockwise instead of filled clockwise, so the
 * two are unmistakable at a glance even though they share a vocabulary. The one
 * that fills is opportunity; the one that empties is a deadline.
 *
 * Reduced motion does not touch this. The drain is not decoration — it is the
 * only representation of a hard 1.2s deadline, and removing it would make the
 * mode unplayable rather than calmer.
 */

import { TUNING } from "@/game/config/tuning";
import { Verb } from "@/game/sim/state";

const SVG_NS = "http://www.w3.org/2000/svg";
const PATH_LENGTH = 100;
const BOX = 100;
const INSET = 8;

/** Verb id to the words the prompt shows. Keys mirror `sim/state.ts` `Verb`. */
const VERB_LABEL: Readonly<Record<number, string>> = Object.freeze({
  [Verb.None]: "ANY",
  [Verb.LaneLeft]: "LEFT",
  [Verb.LaneRight]: "RIGHT",
  [Verb.Jump]: "JUMP",
  [Verb.Slide]: "SLIDE",
  [Verb.RollLeft]: "ROLL LEFT",
  [Verb.RollRight]: "ROLL RIGHT",
});

/** The arrow glyph beside the word. Direction is faster to read than text. */
const VERB_ARROW: Readonly<Record<number, string>> = Object.freeze({
  [Verb.None]: "◆",
  [Verb.LaneLeft]: "←",
  [Verb.LaneRight]: "→",
  [Verb.Jump]: "↑",
  [Verb.Slide]: "↓",
  [Verb.RollLeft]: "↺",
  [Verb.RollRight]: "↻",
});

export interface FractureState {
  /** 1 when the window opens, draining to 0. */
  readonly fraction: number;
  /** The single clearing verb, from `SimEvent.FractureArm`. */
  readonly verb: number;
  /** Shards a resume costs — 1 for the first this run, 2 for the second. */
  readonly shardCost: number;
}

export interface FractureRing {
  readonly element: HTMLElement;
  /** Pass `null` to hide it. */
  set(state: FractureState | null): void;
  dispose(): void;
}

export function createFractureRing(): FractureRing {
  const element = document.createElement("div");
  element.className = "axis-fracture";
  element.dataset["open"] = "0";
  // Assertive: this is a 1.2-second deadline. It is the one place in the whole
  // interface where interrupting whatever else is being announced is correct.
  element.setAttribute("role", "alert");
  element.setAttribute("aria-live", "assertive");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${BOX} ${BOX}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("axis-fracture-svg");

  const a = INSET;
  const b = BOX - INSET;
  const d = `M ${a},${b} L ${a},${a} L ${b},${a} L ${b},${b} Z`;

  const track = document.createElementNS(SVG_NS, "path");
  track.setAttribute("d", d);
  track.setAttribute("class", "axis-fracture-track");
  track.setAttribute("pathLength", String(PATH_LENGTH));
  svg.appendChild(track);

  const drain = document.createElementNS(SVG_NS, "path");
  drain.setAttribute("d", d);
  drain.setAttribute("class", "axis-fracture-drain");
  drain.setAttribute("pathLength", String(PATH_LENGTH));
  drain.setAttribute("stroke-dasharray", String(PATH_LENGTH));
  drain.setAttribute("stroke-dashoffset", "0");
  svg.appendChild(drain);

  const inner = document.createElement("div");
  inner.className = "axis-fracture-inner";

  const arrow = document.createElement("span");
  arrow.className = "axis-fracture-arrow";
  inner.appendChild(arrow);

  const label = document.createElement("span");
  label.className = "axis-fracture-verb";
  inner.appendChild(label);

  const cost = document.createElement("span");
  cost.className = "axis-fracture-cost";
  inner.appendChild(cost);

  element.appendChild(svg);
  element.appendChild(inner);

  let open = false;
  let verb = -1;
  let shards = -1;
  let offset = -1;

  return {
    element,

    set(state: FractureState | null): void {
      if (state === null) {
        if (open) {
          open = false;
          verb = -1;
          shards = -1;
          offset = -1;
          element.dataset["open"] = "0";
          element.removeAttribute("aria-label");
        }
        return;
      }

      if (!open) {
        open = true;
        element.dataset["open"] = "1";
      }

      if (state.verb !== verb) {
        verb = state.verb;
        const word = VERB_LABEL[verb] ?? "ANY";
        label.textContent = word;
        arrow.textContent = VERB_ARROW[verb] ?? "◆";
        element.setAttribute("aria-label", `Fracture. Press ${word}.`);
      }

      if (state.shardCost !== shards) {
        shards = state.shardCost;
        // §12 cause 6: a run ends on a fatal hit with 0 Shards held. The sim arms
        // the window without consulting a balance, so the cost shown here is
        // what a resume WILL cost, not proof the player can pay it. See
        // PROGRESS.md P14 — the pre-run Shard count now reaches the sim, so this
        // is honest.
        cost.textContent = `◈ ${shards}`;
      }

      const clamped = state.fraction < 0 ? 0 : state.fraction > 1 ? 1 : state.fraction;
      const next = Math.round((1 - clamped) * PATH_LENGTH);
      if (next !== offset) {
        offset = next;
        drain.setAttribute("stroke-dashoffset", String(next));
      }
    },

    dispose(): void {
      element.remove();
    },
  };
}

/** Exported for the tests, and for the death screen's "you needed JUMP" line. */
export function verbLabel(verb: number): string {
  return VERB_LABEL[verb] ?? "ANY";
}

const MS_PER_SECOND = 1000;

/** The window's real duration, for anything that needs to time against it. */
export const FRACTURE_WINDOW_MS = TUNING.fracture.fractureWindow * MS_PER_SECOND;
