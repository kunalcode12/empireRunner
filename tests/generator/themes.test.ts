import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createLevelState, generateNext } from "@/game/sim/level/generator";
import { createRng } from "@/game/sim/rng";

/**
 * The `ThemeChange` contract.
 *
 * `sim/events.ts` documents `SimEvent.ThemeChange` as carrying `payload0 = theme
 * id`. Until P11 it carried `placed.ordinal` — a monotonic chunk counter — and
 * it fired **once per transition chunk**, which is five times per boundary,
 * because the emitting condition was `chunk.id === "transition"` and a
 * transition is 120m of 24m chunks.
 *
 * Nothing consumed the event before the audio layer, so nothing noticed. P10
 * would have hit it next, from the other side, and a palette cross-fade firing
 * five times with a chunk index for a theme id is a considerably more confusing
 * bug to find from there.
 *
 * These pin both halves.
 */

const CHUNK_LENGTH = TUNING.spawn.chunkLength;
const MILESTONES = TUNING.level.themeMilestones;
const TRANSITION_CHUNKS = Math.round(TUNING.level.transitionLength / CHUNK_LENGTH);

/** Generates far enough to cross every authored milestone. */
function generateThrough(distance: number) {
  const state = createLevelState();
  const rng = createRng(1);
  const placed: { themeIndex: number; themeChanged: boolean; startDistance: number }[] = [];

  while (state.nextDistance < distance) {
    const chunk = generateNext(state, rng, 0);
    placed.push({
      themeIndex: chunk.themeIndex,
      themeChanged: chunk.themeChanged,
      startDistance: chunk.startDistance,
    });
  }
  return placed;
}

describe("theme boundaries", () => {
  it("flags exactly one chunk per boundary, not one per transition chunk", () => {
    const placed = generateThrough(MILESTONES[MILESTONES.length - 1]! + CHUNK_LENGTH * 4);
    const edges = placed.filter((chunk) => chunk.themeChanged);

    // One edge per authored milestone. Five would be the old behaviour.
    expect(edges.length).toBe(MILESTONES.length);
    expect(edges.length).not.toBe(MILESTONES.length * TRANSITION_CHUNKS);
  });

  it("numbers themes 0..3 in order, never a chunk ordinal", () => {
    const placed = generateThrough(MILESTONES[MILESTONES.length - 1]! + CHUNK_LENGTH * 4);
    const edges = placed.filter((chunk) => chunk.themeChanged);

    expect(edges.map((edge) => edge.themeIndex)).toEqual([1, 2, 3]);
  });

  it("starts in theme 0", () => {
    const placed = generateThrough(CHUNK_LENGTH * 4);
    expect(placed[0]?.themeIndex).toBe(0);
    expect(placed[0]?.themeChanged).toBe(false);
  });

  it("the theme index only ever moves forward, one at a time", () => {
    const placed = generateThrough(MILESTONES[MILESTONES.length - 1]! + CHUNK_LENGTH * 4);
    let previous = 0;
    for (const chunk of placed) {
      expect(chunk.themeIndex).toBeGreaterThanOrEqual(previous);
      expect(chunk.themeIndex - previous).toBeLessThanOrEqual(1);
      previous = chunk.themeIndex;
    }
  });

  it("an edge lands at each milestone, and the transition belongs to the theme it leads into", () => {
    const placed = generateThrough(MILESTONES[MILESTONES.length - 1]! + CHUNK_LENGTH * 4);
    const edges = placed.filter((chunk) => chunk.themeChanged);

    edges.forEach((edge, index) => {
      const milestone = MILESTONES[index] ?? 0;
      // The boundary opens on the chunk that crosses the milestone.
      expect(edge.startDistance).toBeGreaterThan(milestone - CHUNK_LENGTH * 2);
      expect(edge.startDistance).toBeLessThanOrEqual(milestone + CHUNK_LENGTH);
      // Fading TOWARDS the new theme is what a cross-fade wants.
      expect(edge.themeIndex).toBe(index + 1);
    });
  });

  it("every theme index maps onto a real stem set", () => {
    const placed = generateThrough(MILESTONES[MILESTONES.length - 1]! + CHUNK_LENGTH * 4);
    for (const chunk of placed) {
      expect(chunk.themeIndex).toBeGreaterThanOrEqual(0);
      // Four themes are authored in audio/recipes.ts. An index past that would
      // wrap, which is correct behaviour, but it must never be negative or NaN.
      expect(Number.isInteger(chunk.themeIndex)).toBe(true);
    }
  });
});
