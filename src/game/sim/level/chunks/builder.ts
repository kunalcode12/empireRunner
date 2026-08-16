/**
 * Small helpers for authoring chunk data.
 *
 * These exist so the chunk files read as *data* — a list of what is where —
 * rather than as code. If you find yourself writing a loop or a condition in a
 * chunk file, the chunk wants to be two chunks.
 */

import {
  ALL_CELLS,
  cellBit,
  CHUNK_LENGTH,
  faceMask,
  seam,
  VerbFlag,
  Archetype,
  type ArchetypeValue,
  type Chunk,
  type ChunkEntity,
  type SeamConstraint,
  type ThemeTagValue,
} from "../chunk";
import { EntityType, type EntityTypeValue } from "../entities";

/** Places one entity. `v` is the cosmetic variant, never gameplay. */
export function at(
  type: EntityTypeValue,
  face: number,
  lane: number,
  z: number,
  v = 0,
): ChunkEntity {
  return { type, face, lane, z, variant: v };
}

/** A line of Bits down one cell, evenly spaced. Readable, never scattered. */
export function bitLine(
  face: number,
  lane: number,
  fromZ: number,
  toZ: number,
  count: number,
): ChunkEntity[] {
  const out: ChunkEntity[] = [];
  const step = count > 1 ? (toZ - fromZ) / (count - 1) : 0;
  for (let i = 0; i < count; i += 1) {
    out.push(at(EntityType.Bit, face, lane, fromZ + step * i));
  }
  return out;
}

/** Every cell except those on `face`. The mask a Full-Face Wall leaves behind. */
export function allExceptFace(face: number): number {
  return ALL_CELLS & ~faceMask(face);
}

/** Every cell on `face` except `lane`. */
export function faceExceptLane(face: number, lane: number): number {
  return faceMask(face) & ~cellBit(face, lane);
}

export interface ChunkSpec {
  id: string;
  difficulty: number;
  archetype: ArchetypeValue;
  requiredVerbs: number;
  entities: ChunkEntity[];
  /** Defaults to fully open. */
  entry?: SeamConstraint;
  /** Defaults to fully open. */
  exit?: SeamConstraint;
  themeTags?: ThemeTagValue[];
  weight?: number;
}

const DEFAULT_WEIGHT = 1;

/** Freezes a spec into a Chunk. */
export function chunk(spec: ChunkSpec): Chunk {
  return Object.freeze({
    id: spec.id,
    difficulty: spec.difficulty,
    archetype: spec.archetype,
    requiredVerbs: spec.requiredVerbs,
    entryConstraint: spec.entry ?? seam(ALL_CELLS, true),
    exitConstraint: spec.exit ?? seam(ALL_CELLS, true),
    entities: Object.freeze(spec.entities.slice()),
    themeTags: Object.freeze(spec.themeTags ?? []),
    weight: spec.weight ?? DEFAULT_WEIGHT,
  });
}

export { Archetype, CHUNK_LENGTH, EntityType, VerbFlag, cellBit, faceMask, seam };
