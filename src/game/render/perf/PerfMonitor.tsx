"use client";

/**
 * Frame and draw-call instrumentation.
 *
 * Two separate things live here, for two different audiences:
 *
 *   - `<PerfMonitor>` mounts r3f-perf in dev. Human-facing, never shipped.
 *   - `<DrawCallGuard>` asserts the budget every second in dev. Machine-facing;
 *     it is the thing that catches a regression the day it lands rather than
 *     three phases later when it is expensive to unpick.
 *
 * ## The budget is not advisory
 *
 * TUNING.md §14 sets **< 100** desktop and **< 50** mobile, and calls these
 * "tests, not aspirations". The reason to enforce it now, with a grey-box scene
 * that draws about a dozen calls, is that draw calls are only ever added. Every
 * phase from here adds entities, props, debris and post-processing passes. A
 * budget checked for the first time at P14 is a budget already blown.
 *
 * ## Why r3f-perf must not reach production
 *
 * It is a dev dependency and it hooks the renderer's own draw path to measure
 * it, which costs frame time. The import is behind a `NODE_ENV` check and a
 * lazy import so the bundler drops it from the production graph entirely —
 * ARCHITECTURE §4 requires it to be absent from the production bundle, and a
 * static top-level import would defeat that regardless of whether it renders.
 */

import { useEffect, useRef, useState, type ComponentType } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { getQuality } from "./quality";

const isDev = process.env.NODE_ENV !== "production";

/** Rolling frame statistics, sampled without allocating per frame. */
export interface FrameStats {
  fps: number;
  minFps: number;
  avgFps: number;
  drawCalls: number;
  triangles: number;
  frames: number;
}

/**
 * Samples renderer statistics into a ref.
 *
 * Deliberately writes into a caller-owned ref rather than component state: a
 * `setState` here would re-render every frame, which is the exact failure this
 * whole layer is built to avoid. The Playwright perf spec reads the ref through
 * `window.__axisPerf`.
 */
export function useFrameStats(): React.MutableRefObject<FrameStats> {
  const gl = useThree((s) => s.gl);
  const stats = useRef<FrameStats>({
    fps: 0,
    minFps: Number.POSITIVE_INFINITY,
    avgFps: 0,
    drawCalls: 0,
    triangles: 0,
    frames: 0,
  });

  const acc = useRef({ elapsed: 0, samples: 0, fpsSum: 0 });

  useFrame((_state, delta) => {
    const s = stats.current;
    const a = acc.current;

    s.frames += 1;
    if (delta > 0) {
      const fps = 1 / delta;
      s.fps = fps;
      a.fpsSum += fps;
      a.samples += 1;
      a.elapsed += delta;

      // Ignore the first second: the initial frames include shader compilation
      // and buffer upload, and reporting those as the minimum makes the figure
      // meaningless. This is a steady-state measurement.
      const WARMUP_SECONDS = 1;
      if (a.elapsed > WARMUP_SECONDS && fps < s.minFps) {
        s.minFps = fps;
      }
      s.avgFps = a.fpsSum / a.samples;
    }

    s.drawCalls = gl.info.render.calls;
    s.triangles = gl.info.render.triangles;
  });

  return stats;
}

interface PerfWindow extends Window {
  __axisPerf?: FrameStats;
}

/**
 * Publishes frame stats on `window` and asserts the draw-call budget in dev.
 *
 * The budget check runs once a second rather than per frame: `console.error` is
 * synchronous and expensive, and a blown budget at 144Hz would produce 144
 * identical messages a second and hide everything else in the console.
 */
export function DrawCallGuard(): null {
  const stats = useFrameStats();
  const budget = getQuality().drawCallBudget;
  const lastWarn = useRef(0);

  useEffect(() => {
    const w = window as PerfWindow;
    w.__axisPerf = stats.current;
    return () => {
      delete w.__axisPerf;
    };
  }, [stats]);

  useFrame((state) => {
    if (!isDev) {
      return;
    }
    const now = state.clock.elapsedTime;
    const WARN_INTERVAL_SECONDS = 1;
    if (now - lastWarn.current < WARN_INTERVAL_SECONDS) {
      return;
    }
    lastWarn.current = now;

    const calls = stats.current.drawCalls;
    if (calls >= budget) {
      console.error(
        `[AXIS] Draw call budget exceeded: ${calls} >= ${budget}. ` +
          `TUNING.md §14 is a gate, not a guideline — fix it now, it only gets ` +
          `harder from here. Check that new geometry is instanced.`,
      );
    }
  });

  return null;
}

/**
 * The dev perf HUD.
 *
 * Lazily imported so r3f-perf never enters the production module graph.
 */
export function PerfMonitor(): React.ReactElement | null {
  const [Perf, setPerf] = useState<ComponentType<{ position?: string }> | null>(null);
  const allowed = isDev && getQuality().allowPerfHud;

  useEffect(() => {
    if (!allowed) {
      return;
    }
    let cancelled = false;
    void import("r3f-perf")
      .then((mod) => {
        if (!cancelled) {
          setPerf(() => mod.Perf as ComponentType<{ position?: string }>);
        }
      })
      .catch(() => {
        // A missing dev dependency must not take the game down.
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!allowed || Perf === null) {
    return null;
  }
  return <Perf position="bottom-left" />;
}
