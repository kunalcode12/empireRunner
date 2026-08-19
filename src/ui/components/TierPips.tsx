/**
 * Upgrade tier pips — five squares, one per tier.
 *
 * Three states, and each is distinguished by **two** channels, never by colour
 * alone:
 *
 * ```
 *   owned    accent fill      + solid
 *   next     accent key-line  + halftone fill  + a corner notch
 *   locked   structural fill  + no key-line
 * ```
 *
 * That is the colourblind rule applied where it is easiest to forget it — a row
 * of small squares is exactly the kind of element that gets shipped as
 * "orange means bought". `data-state` drives all three channels from one
 * attribute so they cannot drift apart in the stylesheet.
 */

import { TUNING } from "@/game/config/tuning";

export interface TierPipsProps {
  /** Tiers owned, 0..5. */
  readonly tier: number;
  /** Announced label, e.g. "Magnet Duration, tier 2 of 5". */
  readonly label: string;
}

export function TierPips({ tier, label }: TierPipsProps): React.ReactElement {
  const max = TUNING.economy.upgradeMaxTier;
  const owned = Math.max(0, Math.min(max, Math.trunc(tier)));

  return (
    <span className="axis-pips" role="img" aria-label={`${label}, tier ${owned} of ${max}`}>
      {Array.from({ length: max }, (_unused, index) => {
        const state = index < owned ? "owned" : index === owned ? "next" : "locked";
        return <span key={index} className="axis-pip" data-state={state} aria-hidden="true" />;
      })}
    </span>
  );
}
