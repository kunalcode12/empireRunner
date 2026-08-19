"use client";

/**
 * The instrument behind "zero React re-renders during a run".
 *
 * ## Why not `<Profiler>`
 *
 * That was the first implementation and it does not work here. React strips
 * `Profiler`'s `onRender` callback from **production** builds unless the bundle
 * aliases `react-dom/profiling`, so against `next build && next start` — which is
 * what the e2e gate runs — it silently never fired and the counter read -1.
 *
 * Switching the test to a dev server would have made the number meaningless in a
 * different way: development React double-invokes render under StrictMode, so
 * every count would be doubled and the one thing being asserted is a count.
 *
 * So this counts renders directly, from the render body of each component that
 * could plausibly re-render during a run. It works in the shipped bundle, and it
 * measures the literal claim — a React **re-render**, not a commit.
 *
 * ## Counting from a render body is a side effect, and it is the right one
 *
 * Normally a mutation during render is a bug: React may discard a render, and
 * the mutation survives. Here that is precisely the desired behaviour — a
 * discarded render still cost the reconciliation this budget exists to forbid,
 * so it should still be counted. The value is a monotonic diagnostic that
 * nothing reads back during render.
 *
 * ## No dependency was added
 *
 * `@axe-core/playwright`, Lighthouse and `react-devtools` would all have been
 * dependency changes, which CLAUDE.md requires approval for. This is nineteen
 * lines and an import of nothing.
 */

export interface RenderStats {
  /** Renders per component id, since the last reset. */
  readonly byComponent: Record<string, number>;
  /** Every render since the last reset. */
  total: number;
  /**
   * Named snapshots of `total`, taken at moments the app knows about.
   *
   * The e2e test cannot observe "the instant the run ended" by polling: the
   * death screen mounts, the shutter covers, and RETRY appears at beat five —
   * several hundred milliseconds and seven perfectly legitimate renders after
   * the run actually finished. Polling for a visible element therefore always
   * measured a window that had already crossed the boundary.
   *
   * So the boundary marks itself. `mark("run-end")` records the total at the
   * moment `onRunEnd` fires, which is the last instant that is unambiguously
   * "during a run".
   */
  readonly marks: Record<string, number>;
  /** Called by the test immediately before the measurement window opens. */
  reset(): void;
}

declare global {
  interface Window {
    __axisRenders?: RenderStats;
  }
}

function stats(): RenderStats | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (window.__axisRenders === undefined) {
    const created: RenderStats = {
      byComponent: {},
      total: 0,
      marks: {},
      reset(): void {
        for (const key of Object.keys(created.byComponent)) {
          delete created.byComponent[key];
        }
        for (const key of Object.keys(created.marks)) {
          delete created.marks[key];
        }
        created.total = 0;
      },
    };
    window.__axisRenders = created;
  }
  return window.__axisRenders;
}

/**
 * Records one render of `id`.
 *
 * Call it as the first statement of a component body. Server-safe: it no-ops
 * without a `window`, so a prerendered pass counts nothing.
 */
export function countRender(id: string): void {
  const current = stats();
  if (current === null) {
    return;
  }
  current.byComponent[id] = (current.byComponent[id] ?? 0) + 1;
  current.total += 1;
}

/**
 * Records the render total under `name`.
 *
 * Called from event handlers, never from a render body — the point is to
 * timestamp a moment, and a render body has already contributed to the count it
 * would be recording.
 */
export function markRenderCheckpoint(name: string): void {
  const current = stats();
  if (current === null) {
    return;
  }
  current.marks[name] = current.total;
}

export interface CommitCounterProps {
  readonly children: React.ReactNode;
}

/**
 * A marker around the instrumented tree.
 *
 * It counts its own renders and otherwise passes children through untouched. It
 * exists so the boundary of what is being measured is visible in the JSX rather
 * than implied by which components happen to call `countRender`.
 */
export function CommitCounter({ children }: CommitCounterProps): React.ReactElement {
  countRender("CommitCounter");
  return <>{children}</>;
}
