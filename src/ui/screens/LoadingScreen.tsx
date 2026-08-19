/**
 * The loading state.
 *
 * A real screen, not a spinner. A spinner says "something is happening"; this
 * says what, and it holds the brand and the palette the moment the page paints,
 * so the first frame of the game is not a jarring change of subject.
 *
 * DOM only. `src/ui/**` never imports `three` or `@react-three/*` — enforced by
 * eslint.config.mjs. That is also why this is safe to use as the Suspense
 * fallback around the canvas: it cannot pull the renderer into its own chunk.
 *
 * The animation is a key-line wipe rather than a rotating spinner because
 * GAME_BIBLE §11 is a print aesthetic — a spinning ring is a web-app idiom and it
 * would be the first thing on screen contradicting the whole art direction.
 *
 * **Retokenised at P14.** It previously read `--axis-bg`, `--axis-fg` and
 * `--axis-muted`, which the P14 token pass renamed to the role names every other
 * component now uses.
 */

export interface LoadingScreenProps {
  /** Optional detail line. Keep it short and factual. */
  detail?: string;
}

export function LoadingScreen({ detail }: LoadingScreenProps): React.ReactElement {
  return (
    <div role="status" aria-live="polite" className="axis-loading">
      <span
        className="axis-wordmark"
        style={{ fontSize: "clamp(2.5rem, 12vw, 7rem)", textShadow: "none" }}
      >
        AXIS
      </span>

      <span className="axis-label" style={{ letterSpacing: "0.32em" }}>
        {detail ?? "Building the tunnel"}
      </span>

      {/* A key-line that wipes left to right. Flat colour, hard edges, no glow. */}
      <span
        aria-hidden="true"
        className="axis-loading-track"
        style={{
          position: "relative",
          display: "block",
          height: "var(--axis-keyline)",
          width: "160px",
          margin: "0 auto",
          overflow: "hidden",
          background: "var(--axis-structural)",
        }}
      >
        <span
          className="axis-loading-bar"
          style={{
            position: "absolute",
            insetBlock: 0,
            left: 0,
            display: "block",
            width: "33%",
            background: "var(--axis-accent)",
          }}
        />
      </span>
    </div>
  );
}

export default LoadingScreen;
