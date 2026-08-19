"use client";

/**
 * The chassis every menu screen is built on.
 *
 * Header, back button, focus trap, Escape handling, and the landmark structure an
 * assistive technology needs to know where it is. Putting it here rather than in
 * each screen means all nine behave identically, and a fix to one is a fix to all
 * — which is the difference between an accessible product and a product with some
 * accessible screens.
 *
 * ## Every screen is a labelled region with one h1
 *
 * Not decoration. A screen reader lists landmarks and headings to navigate, and
 * a `<div>` soup with a styled `<span>` title is invisible to that. The `h1` is
 * the screen name, `aria-labelledby` points the region at it, and the shop's tabs
 * are a real `tablist`.
 */

import { useEffect, useId, useRef } from "react";
import { arrowFocusNavigation, trapFocus, type FocusTrap } from "../a11y/focus";
import { Button } from "../components/Button";
import { Glyph } from "../components/Glyph";

export interface ScreenShellProps {
  readonly title: string;
  readonly children: React.ReactNode;
  /** Escape and the back button both call this. Omit for a root screen. */
  readonly onBack?: () => void;
  /** Rendered in the header's right-hand slot — usually the currency readout. */
  readonly aside?: React.ReactNode;
  /** Overlays the world instead of covering it. Pause and death. */
  readonly overlay?: boolean;
  /** Suppresses the header entirely. The title screen supplies its own. */
  readonly bare?: boolean;
  readonly className?: string;
}

export function ScreenShell({
  title,
  children,
  onBack,
  aside,
  overlay = false,
  bare = false,
  className,
}: ScreenShellProps): React.ReactElement {
  const headingId = useId();
  const containerRef = useRef<HTMLElement | null>(null);

  // Held behind a ref and refreshed in an effect rather than assigned during
  // render. Assigning during render is what `react-hooks/refs` rejects, and it
  // is genuinely wrong under concurrent rendering: a render that React throws
  // away would still have mutated the ref.
  const backRef = useRef<(() => void) | undefined>(onBack);
  useEffect(() => {
    backRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let trap: FocusTrap | null = null;
    // Deferred one frame. The shutter is still covering when this mounts, and
    // focusing an element behind an opaque overlay makes a sighted keyboard user
    // watch the ring appear on something they cannot see yet.
    const handle = requestAnimationFrame(() => {
      trap = trapFocus(container);
    });

    // Arrow keys move focus across the screen. This is what makes a gamepad able
    // to reach anything at all — see the header of `arrowFocusNavigation`.
    const arrows = arrowFocusNavigation(container);

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && backRef.current !== undefined) {
        event.preventDefault();
        backRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(handle);
      trap?.release();
      arrows.release();
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <section
      ref={containerRef}
      className={`axis-screen${className === undefined ? "" : ` ${className}`}`}
      data-overlay={overlay ? "1" : "0"}
      aria-labelledby={headingId}
    >
      {!bare && (
        <header className="axis-screen-head">
          {onBack !== undefined ? (
            <Button variant="ghost" onClick={onBack} ariaLabel={`Back from ${title}`}>
              <Glyph name="chevron" className="axis-glyph-back" />
              <span>BACK</span>
            </Button>
          ) : (
            <span className="axis-screen-spacer" />
          )}
          <h1 id={headingId} className="axis-screen-title">
            {title}
          </h1>
          <div className="axis-screen-aside">{aside}</div>
        </header>
      )}
      {bare && (
        <h1 id={headingId} className="axis-sr-only">
          {title}
        </h1>
      )}
      <div className="axis-screen-body">{children}</div>
    </section>
  );
}

/** The Bits and Shards readout every shop-side screen puts in its header. */
export function CurrencyBar({
  bits,
  shards,
}: {
  readonly bits: number;
  readonly shards: number;
}): React.ReactElement {
  return (
    <p className="axis-currency">
      <span className="axis-currency-item">
        <Glyph name="bit" label="Bits" />
        <span className="axis-num">{bits.toLocaleString("en-US")}</span>
      </span>
      <span className="axis-currency-item">
        <Glyph name="shard" label="Shards" />
        <span className="axis-num">{shards.toLocaleString("en-US")}</span>
      </span>
    </p>
  );
}
