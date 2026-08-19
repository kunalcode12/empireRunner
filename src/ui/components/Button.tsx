/**
 * The button.
 *
 * ## Focus is visible, always, and it is not a browser default
 *
 * `:focus-visible` gets a 3px accent key-line plus an inset offset — two channels,
 * because a single coloured outline is invisible to a player who cannot separate
 * the accent from the plate under it. The default outline is not suppressed
 * anywhere in this codebase; it is replaced with something louder.
 *
 * ## Press is a translate, not a shadow change
 *
 * The plate's shadow is a hard 6px offset. Pressing moves the button 3px along
 * that diagonal and halves the offset, so it reads as physically depressing into
 * the page — the print-block idiom. Animating a blur radius would be the web
 * idiom, and there is no blur radius to animate.
 *
 * ## Minimum target
 *
 * `TUNING.ui.minTargetPx` (44) on both axes, unconditionally. WCAG 2.2 AA asks
 * for 24; 44 is the platform convention and the honest floor for a thumb during
 * a run. The `chip` variant is the only smaller one and it still clears 44 with
 * its padding.
 */

import { TUNING } from "@/game/config/tuning";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "chip";

export interface ButtonProps {
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** Fills the container. The mobile layout leans on this heavily. */
  readonly block?: boolean;
  /** Marks the button as the current item in a tablist or grid. */
  readonly selected?: boolean;
  readonly ariaLabel?: string;
  readonly ariaControls?: string;
  readonly role?: "tab" | "menuitem" | "radio";
  /** Removes it from sequential tab order. Roving-tabindex grids need this. */
  readonly notTabbable?: boolean;
  readonly className?: string;
  readonly autoFocus?: boolean;
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
  /** Identifies the button to the gamepad navigator. */
  readonly navId?: string;
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled = false,
  block = false,
  selected,
  ariaLabel,
  ariaControls,
  role,
  notTabbable = false,
  className,
  autoFocus = false,
  buttonRef,
  navId,
}: ButtonProps): React.ReactElement {
  // `aria-selected` belongs on a tab, `aria-checked` on a radio, and neither
  // belongs on a plain button — putting the wrong one on is an axe violation and
  // a lie to a screen reader, so the role decides.
  const selectionAttrs =
    selected === undefined
      ? {}
      : role === "radio"
        ? { "aria-checked": selected }
        : role === "tab"
          ? { "aria-selected": selected }
          : { "aria-pressed": selected };

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`axis-button${className === undefined ? "" : ` ${className}`}`}
      data-variant={variant}
      data-block={block ? "1" : "0"}
      data-selected={selected === true ? "1" : "0"}
      style={{ minHeight: TUNING.ui.minTargetPx, minWidth: TUNING.ui.minTargetPx }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      role={role}
      tabIndex={notTabbable ? -1 : undefined}
      data-nav={navId}
      // A marker the screen's focus trap can find.
      //
      // React's `autoFocus` focuses on mount, but `ScreenShell` installs its trap
      // one frame later — deliberately, so focus does not land behind the
      // shutter — and the trap then moved focus to the first focusable element,
      // stealing it back. On the pause screen that put the ring on BACK instead
      // of RESUME, which is the opposite of the intent. React does not reliably
      // render `autofocus` as an attribute on the client, so the trap cannot
      // query for it; this is an explicit marker it can.
      data-autofocus={autoFocus ? "1" : undefined}
      {...selectionAttrs}
      // The death screen must land with RETRY focused: an arcade player retries
      // in under two seconds and should not have to find the button first. Used
      // on exactly one element per screen.
      autoFocus={autoFocus}
    >
      {children}
    </button>
  );
}
