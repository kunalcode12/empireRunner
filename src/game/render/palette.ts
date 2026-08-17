/**
 * Grey-box palette — **placeholder, P05 only.**
 *
 * P10 replaces this entirely with `config/themes.ts` and the four real theme
 * palettes. Nothing here is art direction; it exists so the grey-box has legible
 * flat colours instead of default-material white.
 *
 * ## It still has to obey the ban
 *
 * GAME_BIBLE §11.3 bans the near-black-plus-neon-cyan-and-magenta look
 * **explicitly as a placeholder** — "It is banned as a placeholder. It is banned
 * 'just for now until we get real art.'" So the grey-box does not get to be
 * neon-on-black just because it is temporary.
 *
 * These are the real Kiln palette from GAME_BIBLE §10, which is the theme the
 * first 1,200m of a run is set in. Using the actual shipping colours costs
 * nothing, keeps the background above the "darker than the darkest palette
 * colour" floor, and means the grey-box already reads as this game rather than
 * as any endless runner.
 *
 * Flat colours only. No emissive — GAME_BIBLE §11.3 permits emission exclusively
 * inside Overdrive, and that lands at P09/P10.
 */

/** Kiln, from GAME_BIBLE §10. Six colours including the key-line. */
export const GREYBOX = {
  /** Key-line black. The darkest value permitted on screen. */
  keyline: "#0b0b0c",
  /** Gunmetal — tunnel floor. */
  gunmetal: "#2b2b2f",
  /** Ash — tunnel walls, so the floor reads as distinct from the sides. */
  ash: "#8c8c90",
  /** Bone — the ceiling face and the player. */
  bone: "#ede6db",
  /** Ember — the accent. Obstacles, so hazards are unmistakable in grey-box. */
  ember: "#e4572e",
} as const;

/**
 * Per-face tunnel colours, indexed by face id 0..3.
 *
 * Deliberately NOT four different hues. The four faces are the same tunnel and
 * should read as one space; what distinguishes them is which one is currently
 * underfoot, and that is communicated by the camera, not by colour-coding.
 *
 * **Face 0 — the floor — is the LIGHT one.** The first pass had this inverted:
 * floor gunmetal, walls ash. Looking at a captured frame, the floor came out the
 * darkest surface on screen and very close to the background it was fogging
 * into, so the lane the player is actually standing in was the hardest thing to
 * read. Obstacles sit on the floor; the floor has to be the legible surface.
 */
export const FACE_COLORS: readonly string[] = [
  GREYBOX.ash,
  GREYBOX.gunmetal,
  GREYBOX.gunmetal,
  GREYBOX.gunmetal,
];

/** Obstacle grey-box colour. One value: P07 gives each entity type its own. */
export const OBSTACLE_COLOR = GREYBOX.ember;

/** Pickup grey-box colour. */
export const PICKUP_COLOR = GREYBOX.bone;

/** The player capsule. */
export const PLAYER_COLOR = GREYBOX.bone;

/**
 * Scene background and fog.
 *
 * Key-line black, and that is legal rather than a breach. GAME_BIBLE §11.3 bans
 * "backgrounds darker than the darkest colour in the active theme palette" —
 * #0b0b0c IS Kiln's darkest entry, so this sits exactly at the limit, not below
 * it. Nothing darker may ever appear.
 *
 * It has to be this rather than gunmetal because the WALLS are gunmetal. With
 * both the same, the wall/background boundary vanished and the tunnel read as a
 * floor strip floating in a void instead of an enclosed prism — visible in the
 * captured frames. Separating them by one palette step is what makes the four
 * faces read as a space.
 */
export const BACKGROUND_COLOR = GREYBOX.keyline;
