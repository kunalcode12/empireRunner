/**
 * The loading state.
 *
 * A real screen, not a spinner. A spinner says "something is happening";
 * this says what, and it holds the brand and the palette the moment the page
 * paints, so the first frame of the game is not a jarring change of subject.
 *
 * DOM only. `src/ui/**` never imports `three` or `@react-three/*` — enforced by
 * eslint.config.mjs. That is also why this is safe to use as the Suspense
 * fallback around the canvas: it cannot pull the renderer into its own chunk.
 *
 * The animation is a key-line wipe rather than a rotating spinner because
 * GAME_BIBLE §11 is a print aesthetic — a spinning ring is a web-app idiom and
 * it would be the first thing on screen contradicting the whole art direction.
 */

export interface LoadingScreenProps {
  /** Optional detail line. Keep it short and factual. */
  detail?: string;
}

export function LoadingScreen({ detail }: LoadingScreenProps): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 flex flex-col items-center justify-center gap-5"
      style={{ background: "var(--axis-bg)" }}
    >
      <span
        className="text-[clamp(2.5rem,12vw,7rem)] leading-none font-black tracking-[0.08em] uppercase"
        style={{ fontFamily: "var(--axis-font-display)", color: "var(--axis-fg)" }}
      >
        AXIS
      </span>

      <span
        className="text-xs tracking-[0.32em] uppercase"
        style={{ fontFamily: "var(--axis-font-mono)", color: "var(--axis-muted)" }}
      >
        {detail ?? "Building the tunnel"}
      </span>

      {/* A key-line that wipes left to right. Flat colour, hard edges, no glow. */}
      <span
        aria-hidden="true"
        className="axis-loading-track relative block h-[var(--axis-keyline-width)] w-40 overflow-hidden"
        style={{ background: "color-mix(in srgb, var(--axis-muted) 30%, transparent)" }}
      >
        <span
          className="axis-loading-bar absolute inset-y-0 left-0 block w-1/3"
          style={{ background: "var(--axis-accent)" }}
        />
      </span>
    </div>
  );
}

export default LoadingScreen;
