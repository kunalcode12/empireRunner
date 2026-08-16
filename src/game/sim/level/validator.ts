/**
 * The chunk solver.
 *
 * A breadth-first search over the verb space that proves at least one
 * survivable path exists through a chunk at `maxSpeed`, entered from a given
 * cell. Every authored chunk is run through it as a build-time test, and a
 * chunk that fails the solver fails CI.
 *
 * ## Why maxSpeed
 *
 * Because it is the worst case and the only one worth proving. A chunk that
 * works at 12 u/s and fails at 34 u/s is a chunk that kills expert players
 * specifically — the ones who earned the speed. Proving the hard case proves
 * every easier one, since lower speed means strictly more ticks to act in.
 *
 * ## Solution slack
 *
 * "Survivable" is a low bar. A chunk can be technically survivable and still be
 * inhuman if the only path through requires a frame-perfect input.
 *
 * Slack is measured as: **how many ticks can the player be frozen on entry —
 * no inputs at all — and still have a surviving path?** That maps directly onto
 * reaction margin, it is measured in the same frames the player experiences,
 * and it is cheap: one BFS per candidate delay.
 *
 * `TUNING.level.minSolverSlackTicks` (3 ticks = 50ms) is the threshold below
 * which a chunk is reported as tight-but-legal rather than simply passing.
 *
 * ## What this model does and does not know
 *
 * It reasons over logical cells and the player's vertical state, not over
 * world-space AABBs — see `entities.ts` for why. It therefore knows about
 * blocking, timing, the roll commit lock and the face/lane transform, and it
 * does NOT know about near-miss radii, corner forgiveness, or the exact
 * penetration depth of a graze. Those make the real game *more* forgiving than
 * the solver, never less, so a chunk the solver passes is safe in the real game.
 * That direction is the important one.
 */

import { TUNING } from "@/game/config/tuning";
import { rollFace, rollLane } from "@/game/sim/player/facing";
import { CHUNK_LENGTH, maskHas, type Chunk, type ChunkEntity } from "./chunk";
import { entityDef, EntityType, Vertical } from "./entities";

const FACE_COUNT = TUNING.geometry.faceCount;
const LANE_COUNT = TUNING.geometry.laneCount;
const MAX_LANE = LANE_COUNT - 1;
const DT = TUNING.sim.fixedDelta;
const MAX_SPEED = TUNING.speed.maxSpeed;

/** Ticks to traverse one chunk at maxSpeed. Ceil so the trailing edge is covered. */
export const CHUNK_TICKS = Math.ceil(CHUNK_LENGTH / (MAX_SPEED * DT));

const JUMP_TICKS = Math.round(TUNING.vertical.airTime / DT);
const SLIDE_TICKS = Math.round(TUNING.slide.slideDuration / DT);
const LANE_TICKS = Math.round(TUNING.lane.laneChangeDuration / DT);
const ROLL_TICKS = Math.round(TUNING.roll.rollDuration / DT);
const ROLL_LOCK_TICKS = Math.round(TUNING.roll.rollCommitLock / DT);

/** Longest a vertical state can persist. Bounds the state encoding. */
const MAX_VERT_TIMER = Math.max(JUMP_TICKS, SLIDE_TICKS) + 1;
const MAX_ROLL_LOCK = ROLL_LOCK_TICKS + 1;

/** u — how much track a single entity occupies along z, for the sweep. */
const ENTITY_DEPTH = 1.0;

/** Standing, Sliding, Airborne. The third axis of the search state. */
const VERTICAL_STATES = 3;

export interface SolveEntry {
  face: number;
  lane: number;
}

export interface SolveResult {
  /** True when at least one path survives the chunk. */
  solvable: boolean;
  /** Ticks the player can be frozen on entry and still survive. -1 if unsolvable. */
  slackTicks: number;
  /** Cells the player can legally be in on exit. 12-bit mask. */
  reachableExit: number;
  /** How many BFS states were expanded. Diagnostic. */
  statesExplored: number;
}

/**
 * Occupancy grid: for each tick and cell, the bitmask of vertical states that
 * are BLOCKED there.
 *
 * Precomputed once per chunk so the BFS inner loop is a single array read.
 * Reused across solves via a module-level buffer — this runs 32 times at build
 * and up to a few thousand times in the fuzz, so churning a 500-element array
 * per call would be noticeable.
 */
const GRID_SIZE = (CHUNK_TICKS + 1) * FACE_COUNT * LANE_COUNT;
const occupancy = new Uint8Array(GRID_SIZE);

function gridIndex(tick: number, face: number, lane: number): number {
  return (tick * FACE_COUNT + face) * LANE_COUNT + lane;
}

/** Converts a chunk's entity list into the per-tick occupancy grid. */
function buildOccupancy(chunk: Chunk): void {
  occupancy.fill(0);

  for (const entity of chunk.entities) {
    const def = entityDef(entity.type);
    if (def.pickup || def.blocks === 0) {
      continue;
    }
    markEntity(entity, def.blocks, def.laneSpan, def.allFaces);
  }
}

function markEntity(
  entity: ChunkEntity,
  blocks: number,
  laneSpan: number,
  allFaces: boolean,
): void {
  // The entity occupies [z, z + ENTITY_DEPTH); convert to the tick range during
  // which the player is inside it at maxSpeed.
  const perTick = MAX_SPEED * DT;
  const firstTick = Math.max(0, Math.floor(entity.z / perTick));
  const lastTick = Math.min(CHUNK_TICKS, Math.ceil((entity.z + ENTITY_DEPTH) / perTick));

  const faces = allFaces ? FACE_COUNT : 1;
  for (let f = 0; f < faces; f += 1) {
    const face = allFaces ? f : entity.face;
    for (let l = 0; l < laneSpan; l += 1) {
      const lane = entity.lane + l;
      if (lane > MAX_LANE) {
        continue;
      }
      for (let t = firstTick; t <= lastTick; t += 1) {
        const index = gridIndex(t, face, lane);
        occupancy[index] = (occupancy[index] ?? 0) | blocks;
      }
    }
  }
}

/** True when a player in `vertical` at this cell and tick is inside geometry. */
function isBlocked(tick: number, face: number, lane: number, vertical: number): boolean {
  if (tick > CHUNK_TICKS) {
    return false;
  }
  const mask = occupancy[gridIndex(tick, face, lane)] ?? 0;
  return (mask & (1 << vertical)) !== 0;
}

/**
 * Corner Braces block a roll across the seam they occupy.
 *
 * Stored separately from the occupancy grid because they are not a collision —
 * they are a restriction on a verb. GAME_BIBLE §7.1.
 */
const blockedRolls: { tick: number; face: number; direction: number }[] = [];

function buildRollBlocks(chunk: Chunk): void {
  blockedRolls.length = 0;
  const perTick = MAX_SPEED * DT;
  for (const entity of chunk.entities) {
    if (entity.type !== EntityType.CornerBrace) {
      continue;
    }
    // A brace at lane 2 blocks the roll toward face+1; at lane 0, toward face-1.
    const direction = entity.lane === MAX_LANE ? 1 : -1;
    const tick = Math.floor(entity.z / perTick);
    blockedRolls.push({ tick, face: entity.face, direction });
  }
}

const ROLL_BLOCK_WINDOW = 8;

function rollIsBlocked(tick: number, face: number, direction: number): boolean {
  for (const block of blockedRolls) {
    if (
      block.face === face &&
      block.direction === direction &&
      Math.abs(block.tick - tick) <= ROLL_BLOCK_WINDOW
    ) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// BFS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State encoding.
 *
 * (tick, face, lane, vertical, vertTimer, rollLock) packed into one integer so
 * `visited` can be a flat Uint8Array. Roughly a million states worst case,
 * which is 1MB — allocated once, reused for every solve.
 */
const STATE_COUNT =
  (CHUNK_TICKS + 2) * FACE_COUNT * LANE_COUNT * VERTICAL_STATES * MAX_VERT_TIMER * MAX_ROLL_LOCK;
const visited = new Uint8Array(STATE_COUNT);

/** Queue of packed states. Sized generously and reused. */
const queue = new Int32Array(STATE_COUNT);

function encode(
  tick: number,
  face: number,
  lane: number,
  vertical: number,
  vertTimer: number,
  rollLock: number,
): number {
  let code = tick;
  code = code * FACE_COUNT + face;
  code = code * LANE_COUNT + lane;
  code = code * VERTICAL_STATES + vertical;
  code = code * MAX_VERT_TIMER + vertTimer;
  code = code * MAX_ROLL_LOCK + rollLock;
  return code;
}

interface Decoded {
  tick: number;
  face: number;
  lane: number;
  vertical: number;
  vertTimer: number;
  rollLock: number;
}

const decoded: Decoded = { tick: 0, face: 0, lane: 0, vertical: 0, vertTimer: 0, rollLock: 0 };

function decode(code: number): Decoded {
  let c = code;
  decoded.rollLock = c % MAX_ROLL_LOCK;
  c = Math.floor(c / MAX_ROLL_LOCK);
  decoded.vertTimer = c % MAX_VERT_TIMER;
  c = Math.floor(c / MAX_VERT_TIMER);
  decoded.vertical = c % VERTICAL_STATES;
  c = Math.floor(c / VERTICAL_STATES);
  decoded.lane = c % LANE_COUNT;
  c = Math.floor(c / LANE_COUNT);
  decoded.face = c % FACE_COUNT;
  c = Math.floor(c / FACE_COUNT);
  decoded.tick = c;
  return decoded;
}

/**
 * Runs the search.
 *
 * @param freezeTicks how many ticks at the start the player may not act. This is
 *        the slack probe: a chunk survivable with `freezeTicks = 5` gives the
 *        player five frames of reaction margin.
 */
function search(chunk: Chunk, entry: SolveEntry, freezeTicks: number): SolveResult {
  buildOccupancy(chunk);
  buildRollBlocks(chunk);
  visited.fill(0);

  let head = 0;
  let tail = 0;
  let explored = 0;
  let reachableExit = 0;

  const start = encode(0, entry.face, entry.lane, Vertical.Standing, 0, 0);
  if (isBlocked(0, entry.face, entry.lane, Vertical.Standing)) {
    return { solvable: false, slackTicks: -1, reachableExit: 0, statesExplored: 0 };
  }
  visited[start] = 1;
  queue[tail] = start;
  tail += 1;

  while (head < tail) {
    const code = queue[head] ?? 0;
    head += 1;
    explored += 1;

    const s = decode(code);
    const tick = s.tick;
    const face = s.face;
    const lane = s.lane;
    const vertical = s.vertical;
    const vertTimer = s.vertTimer;
    const rollLock = s.rollLock;

    if (tick >= CHUNK_TICKS) {
      reachableExit |= 1 << (face * LANE_COUNT + lane);
      continue;
    }

    const canAct = tick >= freezeTicks;
    const grounded = vertical === Vertical.Standing && vertTimer === 0;

    // ── WAIT ────────────────────────────────────────────────────────────────
    pushAdvance(tick, face, lane, vertical, vertTimer, rollLock, 1);

    if (!canAct) {
      continue;
    }

    // ── JUMP ────────────────────────────────────────────────────────────────
    if (grounded) {
      pushAdvance(tick, face, lane, Vertical.Airborne, JUMP_TICKS, rollLock, 1);
    }

    // ── SLIDE ───────────────────────────────────────────────────────────────
    if (grounded) {
      pushAdvance(tick, face, lane, Vertical.Sliding, SLIDE_TICKS, rollLock, 1);
    }

    // ── LANE CHANGE ─────────────────────────────────────────────────────────
    // Dropped, never buffered, while the roll commit lock is active.
    if (rollLock === 0) {
      for (const direction of [-1, 1]) {
        const target = lane + direction;
        if (target < 0 || target > MAX_LANE) {
          continue;
        }
        // In transit the player occupies BOTH lanes. Conservative on purpose:
        // the solver must never claim a path the real controller cannot take.
        if (transitSafe(tick, face, lane, target, vertical, vertTimer, LANE_TICKS)) {
          pushAdvance(tick, face, target, vertical, vertTimer, rollLock, LANE_TICKS);
        }
      }
    }

    // ── ROLL ────────────────────────────────────────────────────────────────
    if (rollLock === 0) {
      for (const direction of [-1, 1]) {
        if (rollIsBlocked(tick, face, direction)) {
          continue;
        }
        const nextFace = rollFace(face, direction);
        const nextLane = rollLane(lane, direction);
        // During the roll the player is still on the old face.
        if (transitSafe(tick, face, lane, lane, vertical, vertTimer, ROLL_TICKS)) {
          pushAdvance(tick, nextFace, nextLane, vertical, vertTimer, 0, ROLL_TICKS);
        }
      }
    }
  }

  return {
    solvable: reachableExit !== 0,
    slackTicks: reachableExit !== 0 ? freezeTicks : -1,
    reachableExit,
    statesExplored: explored,
  };

  /** True when the player survives every tick of a multi-tick move. */
  function transitSafe(
    fromTick: number,
    face2: number,
    laneA: number,
    laneB: number,
    vertical2: number,
    vertTimer2: number,
    duration: number,
  ): boolean {
    let v = vertical2;
    let vt = vertTimer2;
    for (let i = 0; i < duration; i += 1) {
      const t = fromTick + i;
      if (t > CHUNK_TICKS) {
        return true;
      }
      if (isBlocked(t, face2, laneA, v) || isBlocked(t, face2, laneB, v)) {
        return false;
      }
      ({ v, vt } = advanceVertical(v, vt));
    }
    return true;
  }

  /** Enqueues the state `duration` ticks later, if it survives the interval. */
  function pushAdvance(
    fromTick: number,
    face2: number,
    lane2: number,
    vertical2: number,
    vertTimer2: number,
    rollLock2: number,
    duration: number,
  ): void {
    let v = vertical2;
    let vt = vertTimer2;
    let rl = rollLock2;

    for (let i = 0; i < duration; i += 1) {
      const t = fromTick + i;
      if (t <= CHUNK_TICKS && isBlocked(t, face2, lane2, v)) {
        return;
      }
      ({ v, vt } = advanceVertical(v, vt));
      rl = rl > 0 ? rl - 1 : 0;
    }

    const nextTick = fromTick + duration;
    if (nextTick > CHUNK_TICKS) {
      reachableExit |= 1 << (face2 * LANE_COUNT + lane2);
      return;
    }

    const code = encode(nextTick, face2, lane2, v, vt, rl);
    if (visited[code] === 1) {
      return;
    }
    visited[code] = 1;
    queue[tail] = code;
    tail += 1;
  }
}

const verticalScratch = { v: 0, vt: 0 };

/** Ages a vertical state by one tick, returning to Standing when it expires. */
function advanceVertical(vertical: number, vertTimer: number): { v: number; vt: number } {
  if (vertTimer > 1) {
    verticalScratch.v = vertical;
    verticalScratch.vt = vertTimer - 1;
  } else {
    verticalScratch.v = Vertical.Standing;
    verticalScratch.vt = 0;
  }
  return verticalScratch;
}

/**
 * Proves a chunk survivable and measures its slack.
 *
 * Tries increasing freeze durations until the chunk stops being solvable; the
 * last one that worked is the slack.
 */
export function solveChunk(chunk: Chunk, entry: SolveEntry): SolveResult {
  const base = search(chunk, entry, 0);
  if (!base.solvable) {
    return base;
  }

  let best = base;
  for (let freeze = 1; freeze <= CHUNK_TICKS; freeze += 1) {
    const attempt = search(chunk, entry, freeze);
    if (!attempt.solvable) {
      break;
    }
    best = attempt;
  }
  return { ...best, reachableExit: base.reachableExit };
}

/**
 * Solves a chunk from every legal entry cell its constraint allows.
 *
 * A chunk is only genuinely safe if it works from *every* cell the generator
 * might deliver the player into, not just from the centre lane of the floor.
 */
export interface ChunkReport {
  chunkId: string;
  difficulty: number;
  archetype: string;
  solvable: boolean;
  /** Worst slack across all legal entries — the number that matters. */
  minSlackTicks: number;
  /** Entry that produced the worst slack. */
  worstEntry: SolveEntry;
  entriesTested: number;
  reachableExit: number;
  tight: boolean;
}

export function reportChunk(chunk: Chunk): ChunkReport {
  let minSlack = Number.POSITIVE_INFINITY;
  let worstEntry: SolveEntry = { face: 0, lane: 1 };
  let solvable = true;
  let tested = 0;
  let reachableExit = 0;

  for (let face = 0; face < FACE_COUNT; face += 1) {
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      if (!maskHas(chunk.entryConstraint.safeCells, face, lane)) {
        continue;
      }
      tested += 1;
      const result = solveChunk(chunk, { face, lane });
      reachableExit |= result.reachableExit;
      if (!result.solvable) {
        solvable = false;
        minSlack = -1;
        worstEntry = { face, lane };
        break;
      }
      if (result.slackTicks < minSlack) {
        minSlack = result.slackTicks;
        worstEntry = { face, lane };
      }
    }
    if (!solvable) {
      break;
    }
  }

  const slack = solvable ? minSlack : -1;
  return {
    chunkId: chunk.id,
    difficulty: chunk.difficulty,
    archetype: chunk.archetype,
    solvable,
    minSlackTicks: slack === Number.POSITIVE_INFINITY ? CHUNK_TICKS : slack,
    worstEntry,
    entriesTested: tested,
    reachableExit,
    tight: solvable && slack < TUNING.level.minSolverSlackTicks,
  };
}

/** Renders a slack table for the test output. */
export function formatSlackTable(reports: readonly ChunkReport[]): string {
  const ID_WIDTH = 26;
  const ARCH_WIDTH = 17;
  const RULE_EXTRA = 30;
  const TIER_COL = 4;
  const SLACK_COL = 6;
  const ENTRIES_COL = 8;
  const lines: string[] = [];
  lines.push(
    `${"chunk".padEnd(ID_WIDTH)} ${"archetype".padEnd(ARCH_WIDTH)} tier  slack  entries  status`,
  );
  lines.push("-".repeat(ID_WIDTH + ARCH_WIDTH + RULE_EXTRA));

  for (const r of reports) {
    const status = !r.solvable ? "UNSOLVABLE" : r.tight ? "TIGHT" : "ok";
    lines.push(
      `${r.chunkId.padEnd(ID_WIDTH)} ${r.archetype.padEnd(ARCH_WIDTH)} ` +
        `${String(r.difficulty).padStart(TIER_COL)} ${String(r.minSlackTicks).padStart(SLACK_COL)} ` +
        `${String(r.entriesTested).padStart(ENTRIES_COL)}  ${status}`,
    );
  }
  return lines.join("\n");
}
