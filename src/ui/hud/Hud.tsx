"use client";

/**
 * The run HUD.
 *
 * ## This component renders once and never again
 *
 * It mounts an empty set of containers, fills them imperatively in an effect, and
 * hands back an object implementing the render layer's `HudSink`. From then on
 * every value change is a `setAttribute` or a `style.transform` on a node created
 * at mount. There is no `useState` in this file and there must never be one.
 *
 * docs/ARCHITECTURE.md §3.1 puts the reason plainly: React reconciliation is
 * roughly two orders of magnitude too slow for a 6.9ms frame budget, and one
 * stray `setX` in the frame path re-renders this subtree sixty times a second.
 * `tests/e2e/ui.spec.ts` counts this component's renders across a full
 * sixty-second run and asserts the count is zero, so the rule is enforced rather
 * than remembered.
 *
 * ## Why the sink comes back through a ref callback
 *
 * `src/ui/` may not import `@/game/render` (eslint.config.mjs), and render may
 * not import ui — dependencies point one way. So this file never names the
 * `HudSink` type; it returns a structurally identical object, and
 * `src/app/play/page.tsx` performs the assignment where the compiler can check
 * the two halves match. See `render/hud-sink.ts` for the full argument.
 *
 * ## Layout
 *
 * Score top-centre because it is the chase. Distance under it, smaller, because
 * it is the mission currency rather than the score. Bits top-right. Pause chip
 * top-left (GAME_BIBLE §6.2). The AXIS ring bottom-right, in the thumb zone,
 * because it is also the Overdrive button on touch.
 */

import { useEffect, useRef } from "react";
import { TUNING } from "@/game/config/tuning";
import { setOverdrive as setRootOverdrive } from "../theme";
import { createOdometer, type Odometer } from "./Odometer";
import { createAxisRing, type AxisRing } from "./AxisRing";
import { createFlowPopups, type FlowPopups } from "./FlowPopup";
import { createFractureRing, type FractureRing } from "./FractureRing";
import { glyphMarkup } from "../components/Glyph";
import { countRender } from "../CommitCounter";

/**
 * The imperative surface the frame loop drives.
 *
 * Structurally identical to `HudSink` in `@/game/render/hud-sink`. Not imported
 * — see the header.
 */
export interface HudController {
  setScore(value: number): void;
  setDistance(value: number): void;
  setBits(value: number): void;
  setFlow(value: number): void;
  setMultiplier(value: number): void;
  setFace(face: number): void;
  setShields(value: number): void;
  flowGain(amount: number): void;
  nearMiss(): void;
  setOverdrive(active: boolean): void;
  setFracture(state: { fraction: number; verb: number; shardCost: number } | null): void;
  setPaused(paused: boolean): void;
  reset(): void;
}

export interface HudProps {
  /** Called once with the controller when the DOM is ready, and with null on unmount. */
  readonly onReady: (controller: HudController | null) => void;
  /** The pause chip. */
  readonly onPause: () => void;
  /** Tapping the ring spends Overdrive — GAME_BIBLE §6.2. */
  readonly onOverdrive: () => void;
  /** Hides the HUD without unmounting it, so no counter is rebuilt on resume. */
  readonly hidden?: boolean;
}

export function Hud({
  onReady,
  onPause,
  onOverdrive,
  hidden = false,
}: HudProps): React.ReactElement {
  // The budget this component exists to satisfy. `tests/e2e/ui.spec.ts` asserts
  // this counter does not move across sixty seconds of play.
  countRender("Hud");

  const rootRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const bitsRef = useRef<HTMLDivElement | null>(null);
  const cornerRef = useRef<HTMLDivElement | null>(null);
  const centreRef = useRef<HTMLDivElement | null>(null);

  // Callbacks live in refs so changing one never tears down and rebuilds the
  // whole HUD — which would reset every odometer to zero mid-run.
  const pauseRef = useRef(onPause);
  const overdriveRef = useRef(onOverdrive);
  const readyRef = useRef(onReady);
  useEffect(() => {
    pauseRef.current = onPause;
    overdriveRef.current = onOverdrive;
    readyRef.current = onReady;
  }, [onPause, onOverdrive, onReady]);

  useEffect(() => {
    const top = topRef.current;
    const bitsHost = bitsRef.current;
    const corner = cornerRef.current;
    const centre = centreRef.current;
    if (top === null || bitsHost === null || corner === null || centre === null) {
      return;
    }

    // ── Build ────────────────────────────────────────────────────────────────
    const score: Odometer = createOdometer({ className: "axis-odo-hero" });
    const distance: Odometer = createOdometer({ className: "axis-odo-sub", suffix: "m" });
    const bits: Odometer = createOdometer({ className: "axis-odo-sub", maxDigits: 5 });
    const ring: AxisRing = createAxisRing();
    const popups: FlowPopups = createFlowPopups();
    const fracture: FractureRing = createFractureRing();

    // The accessible readout. The odometer strips are aria-hidden — a screen
    // reader walking seven columns of 0-9 would announce seventy digits — so the
    // real value is published here, politely, and only when it changes.
    const scoreLive = document.createElement("p");
    scoreLive.className = "axis-sr-only";
    scoreLive.setAttribute("aria-live", "polite");
    scoreLive.setAttribute("aria-atomic", "true");

    const scoreLabel = document.createElement("span");
    scoreLabel.className = "axis-hud-label";
    scoreLabel.textContent = "SCORE";

    top.appendChild(scoreLabel);
    top.appendChild(score.element);
    top.appendChild(distance.element);
    top.appendChild(scoreLive);

    // The glyph goes AFTER the number, not before it.
    //
    // The odometer reserves a column per digit and hides the leading zeros, so a
    // glyph on the left is separated from a two-digit value by three columns of
    // empty space and reads as a layout bug. With the glyph on the right and the
    // whole group anchored to the screen edge, the reserved space falls off the
    // left where there is nothing to look at.
    const bitGlyph = document.createElement("span");
    bitGlyph.className = "axis-hud-bitglyph";
    bitGlyph.innerHTML = glyphMarkup("bit");
    bitsHost.appendChild(bits.element);
    bitsHost.appendChild(bitGlyph);

    corner.appendChild(popups.element);
    corner.appendChild(ring.element);
    centre.appendChild(fracture.element);

    const ringButton = ring.element.querySelector("button");
    const onRingClick = (): void => overdriveRef.current();
    ringButton?.addEventListener("click", onRingClick);

    // ── Rate limiting ────────────────────────────────────────────────────────
    //
    // The frame loop calls the setters at up to 60Hz whatever we do here, so the
    // gate lives on this side. Numbers are pushed at hudPushHz; the ring's Flow
    // is NOT gated, because a near-miss kick landing a frame late is visible and
    // a dash-offset write is one attribute.
    const pushIntervalMs = 1000 / TUNING.ui.hudPushHz;
    let lastPush = 0;
    let pendingScore = 0;
    let pendingDistance = 0;
    let pendingBits = 0;
    let dirty = false;
    let liveTimer: ReturnType<typeof setInterval> | null = null;

    function flush(force: boolean): void {
      const now = performance.now();
      if (!force && (!dirty || now - lastPush < pushIntervalMs)) {
        return;
      }
      lastPush = now;
      dirty = false;
      score.set(pendingScore);
      distance.set(pendingDistance);
      bits.set(pendingBits);
    }

    // The polite live region updates far slower than the visual counters. A
    // score read aloud four times a second is unusable; once every four seconds
    // is a progress report.
    const LIVE_INTERVAL_MS = 4000;
    liveTimer = setInterval(() => {
      if (rootRef.current?.dataset["hidden"] === "1") {
        return;
      }
      scoreLive.textContent =
        `Score ${Math.floor(pendingScore)}, ` +
        `${Math.floor(pendingDistance)} metres, ` +
        `${Math.floor(pendingBits)} bits.`;
    }, LIVE_INTERVAL_MS);

    const controller: HudController = {
      setScore(value) {
        if (Number.isFinite(value) && value !== pendingScore) {
          pendingScore = value;
          dirty = true;
          flush(false);
        }
      },
      setDistance(value) {
        if (Number.isFinite(value) && value !== pendingDistance) {
          pendingDistance = value;
          dirty = true;
          flush(false);
        }
      },
      setBits(value) {
        if (Number.isFinite(value) && value !== pendingBits) {
          pendingBits = value;
          dirty = true;
          // Bits are collected in discrete events, so this one flushes
          // immediately: a coin that lands and does not move the counter for
          // 66ms reads as a missed pickup.
          flush(true);
        }
      },
      setFlow(value) {
        ring.setFlow(value);
      },
      setMultiplier(value) {
        ring.setMultiplier(value);
      },
      setFace(face) {
        ring.setFace(face);
      },
      setShields(value) {
        ring.setShields(value);
      },
      flowGain(amount) {
        popups.show(amount);
      },
      nearMiss() {
        ring.kick();
      },
      setOverdrive(active) {
        ring.setOverdrive(active);
        setRootOverdrive(active);
      },
      setFracture(state) {
        fracture.set(state);
      },
      setPaused(paused) {
        const root = rootRef.current;
        if (root !== null) {
          root.dataset["paused"] = paused ? "1" : "0";
        }
      },
      reset() {
        pendingScore = 0;
        pendingDistance = 0;
        pendingBits = 0;
        score.jump(0);
        distance.jump(0);
        bits.jump(0);
        ring.setFlow(0);
        ring.setMultiplier(1);
        ring.setFace(0);
        ring.setShields(0);
        ring.setOverdrive(false);
        fracture.set(null);
        setRootOverdrive(false);
        scoreLive.textContent = "";
      },
    };

    controller.reset();
    readyRef.current(controller);

    return () => {
      readyRef.current(null);
      if (liveTimer !== null) {
        clearInterval(liveTimer);
      }
      ringButton?.removeEventListener("click", onRingClick);
      score.dispose();
      distance.dispose();
      bits.dispose();
      ring.dispose();
      popups.dispose();
      fracture.dispose();
      setRootOverdrive(false);
    };
  }, []);

  return (
    <div ref={rootRef} className="axis-hud" data-hidden={hidden ? "1" : "0"} data-paused="0">
      <button
        type="button"
        className="axis-hud-pause"
        onClick={() => pauseRef.current()}
        aria-label="Pause"
      >
        <span className="axis-hud-pause-glyph" aria-hidden="true" />
      </button>

      <div ref={topRef} className="axis-hud-top" />
      <div ref={bitsRef} className="axis-hud-bits" aria-label="Bits collected" />
      <div ref={centreRef} className="axis-hud-centre" />
      <div ref={cornerRef} className="axis-hud-corner" />
    </div>
  );
}
