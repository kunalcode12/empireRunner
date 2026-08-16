/**
 * The level generator — public surface.
 *
 * **NOT WIRED INTO THE LIVE TICK.** `src/game/sim/generator.ts` is still the
 * P02 no-op stub. Connecting this would spawn entities that `collision.ts`'s
 * placeholder classifier mishandles (it currently splits fatal/stumble on
 * odd-vs-even kind ids), and per-entity collider extents do not exist yet.
 * Both are P07's job. See the P06 entry in PROGRESS.md.
 *
 * Everything here is complete, deterministic and tested on its own terms.
 */

export {
  ALL_CELLS,
  Archetype,
  CELL_COUNT,
  CHUNK_LENGTH,
  OPEN_GROUNDED_SEAM,
  OPEN_SEAM,
  ThemeTag,
  VerbFlag,
  cellBit,
  cellIndex,
  cellMask,
  faceMask,
  maskCount,
  maskHas,
  seam,
  seamOverlap,
  seamsCompatible,
  type ArchetypeValue,
  type Chunk,
  type ChunkEntity,
  type SeamConstraint,
  type ThemeTagValue,
  type VerbFlagValue,
} from "./chunk";

export {
  BlockBit,
  ENTITY_DEFS,
  EntityType,
  Vertical,
  blocksVertical,
  entityDef,
  isObstacle,
  type EntityDef,
  type EntityTypeValue,
  type VerticalValue,
} from "./entities";

export {
  ALL_CHUNKS,
  CHUNKS_BY_TIER,
  MAX_TIER,
  MIN_TIER,
  TIER_1,
  TIER_2,
  TIER_3,
  TIER_4,
  TIER_5,
  TRANSITION_CHUNK,
} from "./chunks";

export {
  TRANSITION_INDEX,
  WINDOW_CHUNKS,
  chunkAt,
  createLevelState,
  difficultyFor,
  fillWindow,
  generateNext,
  newestChunk,
  resetLevelState,
  type LevelState,
  type PlacedChunk,
} from "./generator";

export {
  CHUNK_TICKS,
  formatSlackTable,
  reportChunk,
  solveChunk,
  type ChunkReport,
  type SolveEntry,
  type SolveResult,
} from "./validator";
