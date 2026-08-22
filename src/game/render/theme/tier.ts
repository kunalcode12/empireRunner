/**
 * Which asset bundle tier this device should fetch.
 *
 * The brief asks for "per-quality-tier texture sets (2048 desktop, 1024
 * mobile)". With no textures — see the header of `scripts/build-themes.mjs` for
 * why the art direction has none — the equivalent axis is geometry detail, and
 * the same quality tier that already decides shadow map size and pixel ratio
 * decides which bundle to fetch.
 *
 * Its own file rather than a method on the quality module because the loader,
 * the director and the tests all need it and none of them should have to import
 * the whole render quality system to ask one question.
 */

import { getQuality, Quality } from "../perf/quality";

export type AssetTier = "desktop" | "mobile";

/**
 * LOW takes the mobile bundle; MEDIUM and HIGH take the desktop one.
 *
 * Deliberately keyed to the quality tier rather than to a user-agent sniff: a
 * laptop that has been dropped to LOW for thermal reasons wants the cheaper
 * geometry too, and a tablet running at HIGH can afford the detailed one.
 */
export function assetTier(): AssetTier {
  return getQuality().tier === Quality.Low ? "mobile" : "desktop";
}
