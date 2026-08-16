/**
 * The player phase machine.
 *
 * Exhaustive and explicit: every transition is a named edge in the table below.
 * There are no implicit transitions and no fallthrough. A transition that is not
 * in the table is a bug, not a no-op that happens to work.
 *
 * ## Roll is concurrent, not a phase
 *
 * GAME_BIBLE §3.2 requires that "jump and slide remain available throughout" a
 * roll. That is incompatible with `Rolling` being mutually exclusive with
 * `Jumping` and `Sliding`, so the roll runs on its own axis — `playerRollTimer`,
 * `playerRollCommitTimer` and `player.rollDirection` — and can overlap any phase.
 *
 * The `Rolling` phase therefore means specifically: *rolling, grounded, and not
 * otherwise engaged*. A roll begun mid-jump leaves the phase at `Jumping` with
 * the roll timer ticking alongside. This is called out in the table.
 *
 * ## THE TRANSITION TABLE
 *
 * ```
 * FROM         EDGE                  TO           GUARD
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNNING      JumpStart             JUMPING      grounded || coyoteTimer > 0
 * RUNNING      SlideStart            SLIDING      grounded
 * RUNNING      RollStart             ROLLING      rollCooldownTimer <= 0
 * RUNNING      LeaveGround           FALLING      walked off a Void Gap edge
 * RUNNING      StumbleHit            STUMBLING    non-fatal contact
 * RUNNING      FatalHit              CRASHED      fatal contact, no shield
 *
 * JUMPING      Apex                  FALLING      vy <= 0
 * JUMPING      Land                  RUNNING      fast-drop landed before apex
 * JUMPING      LandIntoSlide         SLIDING      fast-drop landed, slide buffered
 * JUMPING      StumbleHit            STUMBLING    non-fatal contact
 * JUMPING      FatalHit              CRASHED      fatal contact, no shield
 *              JumpCut               (self)       release while vy > 0; vy *= 0.5
 *              FastDrop              (self)       slide pressed airborne; dive
 *              RollStart             (concurrent) does not change phase
 *
 *   The two JUMPING land edges exist because of the fast-drop: it slams vy to
 *   -fastDropSpeed, so the player can reach the floor on the very next tick
 *   without ever passing through FALLING. Found by the dev-mode guard below,
 *   which is exactly what it is for.
 *
 * FALLING      JumpStart             JUMPING      coyoteTimer > 0  (COYOTE JUMP)
 * FALLING      Land                  RUNNING      y <= 0, no buffered slide
 * FALLING      LandIntoSlide         SLIDING      y <= 0, slide buffered or held
 * FALLING      StumbleHit            STUMBLING    non-fatal contact
 * FALLING      FatalHit              CRASHED      fatal contact, no shield
 * FALLING      FellOutOfWorld        CRASHED      y <= -fallKillDepth
 *              FastDrop              (self)       slide pressed airborne; dive
 *              RollStart             (concurrent) does not change phase
 *
 * SLIDING      SlideEnd              RUNNING      slideTimer <= 0, grounded
 * SLIDING      LeaveGround           FALLING      slid off an edge
 * SLIDING      StumbleHit            STUMBLING    non-fatal contact
 * SLIDING      FatalHit              CRASHED      fatal contact, no shield
 *              (no JumpStart)                     a slide CANNOT be cancelled
 *              LaneStart             (concurrent) lane change IS legal, TUNING §5
 *              RollStart             (concurrent) does not change phase
 *
 * ROLLING      RollEnd               RUNNING      rollTimer <= 0
 * ROLLING      JumpStart             JUMPING      roll continues concurrently
 * ROLLING      SlideStart            SLIDING      roll continues concurrently
 * ROLLING      LeaveGround           FALLING      roll continues concurrently
 * ROLLING      StumbleHit            STUMBLING    non-fatal contact
 * ROLLING      FatalHit              CRASHED      fatal contact, no shield
 *
 * STUMBLING    StumbleRecovered      RUNNING      stumbleTimer <= 0
 * STUMBLING    LeaveGround           FALLING      stumbled off an edge
 * STUMBLING    FatalHit              CRASHED      second hit during recovery
 *
 * CRASHED      FractureArm           FRACTURING   a Shard is held, P09
 *              (otherwise terminal)
 *
 * FRACTURING   FractureSuccess       RUNNING      correct verb inside window, P09
 * FRACTURING   FractureFail          CRASHED      wrong verb or timeout, P09
 * ```
 *
 * Illegal transitions **throw in dev** and are **ignored in prod**. The dev throw
 * is a bug detector, not gameplay: the ignore path leaves the phase untouched, so
 * a shipped build degrades to "nothing happened" rather than corrupting state.
 *
 * One consequence worth being honest about: because dev throws and prod ignores,
 * a replay that somehow triggered an illegal edge would crash a dev-mode server
 * while a prod client sailed past. That asymmetry is deliberate — a determinism
 * bug should be loud where it can be fixed — but it means the guard must never
 * be load-bearing gameplay logic.
 */

import { Phase } from "@/game/sim/state";

/**
 * Named edges. The value is only an identifier for error messages and tests;
 * nothing depends on the numbering.
 */
export const Edge = {
  JumpStart: "JumpStart",
  SlideStart: "SlideStart",
  RollStart: "RollStart",
  LeaveGround: "LeaveGround",
  StumbleHit: "StumbleHit",
  FatalHit: "FatalHit",
  Apex: "Apex",
  Land: "Land",
  LandIntoSlide: "LandIntoSlide",
  FellOutOfWorld: "FellOutOfWorld",
  SlideEnd: "SlideEnd",
  RollEnd: "RollEnd",
  StumbleRecovered: "StumbleRecovered",
  FractureArm: "FractureArm",
  FractureSuccess: "FractureSuccess",
  FractureFail: "FractureFail",
} as const;
export type EdgeName = (typeof Edge)[keyof typeof Edge];

/** One row of the table: which phase an edge leads to, from a given phase. */
type EdgeMap = Partial<Record<EdgeName, number>>;

/**
 * The machine, as data.
 *
 * Kept as a frozen object rather than a switch so the table can be enumerated by
 * tests — `phase.test.ts` walks every (phase, edge) pair and asserts that exactly
 * the pairs listed here are legal.
 */
export const TRANSITIONS: Readonly<Record<number, Readonly<EdgeMap>>> = Object.freeze({
  [Phase.Running]: Object.freeze({
    [Edge.JumpStart]: Phase.Jumping,
    [Edge.SlideStart]: Phase.Sliding,
    [Edge.RollStart]: Phase.Rolling,
    [Edge.LeaveGround]: Phase.Falling,
    [Edge.StumbleHit]: Phase.Stumbling,
    [Edge.FatalHit]: Phase.Crashed,
  }),
  [Phase.Jumping]: Object.freeze({
    [Edge.Apex]: Phase.Falling,
    // Reachable only via the fast-drop, which can land the player before apex.
    [Edge.Land]: Phase.Running,
    [Edge.LandIntoSlide]: Phase.Sliding,
    [Edge.StumbleHit]: Phase.Stumbling,
    [Edge.FatalHit]: Phase.Crashed,
  }),
  [Phase.Falling]: Object.freeze({
    // The coyote jump. Without this edge, coyoteTime is unreachable: the window
    // only opens once the player is already FALLING.
    [Edge.JumpStart]: Phase.Jumping,
    [Edge.Land]: Phase.Running,
    [Edge.LandIntoSlide]: Phase.Sliding,
    [Edge.StumbleHit]: Phase.Stumbling,
    [Edge.FatalHit]: Phase.Crashed,
    [Edge.FellOutOfWorld]: Phase.Crashed,
  }),
  [Phase.Sliding]: Object.freeze({
    [Edge.SlideEnd]: Phase.Running,
    [Edge.LeaveGround]: Phase.Falling,
    [Edge.StumbleHit]: Phase.Stumbling,
    [Edge.FatalHit]: Phase.Crashed,
  }),
  [Phase.Rolling]: Object.freeze({
    [Edge.RollEnd]: Phase.Running,
    [Edge.JumpStart]: Phase.Jumping,
    [Edge.SlideStart]: Phase.Sliding,
    [Edge.LeaveGround]: Phase.Falling,
    [Edge.StumbleHit]: Phase.Stumbling,
    [Edge.FatalHit]: Phase.Crashed,
  }),
  [Phase.Stumbling]: Object.freeze({
    [Edge.StumbleRecovered]: Phase.Running,
    [Edge.LeaveGround]: Phase.Falling,
    [Edge.FatalHit]: Phase.Crashed,
  }),
  [Phase.Crashed]: Object.freeze({
    [Edge.FractureArm]: Phase.Fracturing,
  }),
  [Phase.Fracturing]: Object.freeze({
    [Edge.FractureSuccess]: Phase.Running,
    [Edge.FractureFail]: Phase.Crashed,
  }),
});

/** Thrown in dev when code attempts a transition the table does not contain. */
export class IllegalTransitionError extends Error {
  constructor(from: number, edge: EdgeName) {
    super(
      `Illegal phase transition: ${phaseName(from)} --${edge}--> (no such edge). ` +
        `The transition table in src/game/sim/player/phase.ts is exhaustive; if this ` +
        `edge should exist, add it there rather than working around it.`,
    );
    this.name = "IllegalTransitionError";
  }
}

const PHASE_NAMES: readonly string[] = [
  "RUNNING",
  "JUMPING",
  "FALLING",
  "SLIDING",
  "ROLLING",
  "STUMBLING",
  "CRASHED",
  "FRACTURING",
];

/** Human-readable phase name, for errors and test output. */
export function phaseName(phase: number): string {
  return PHASE_NAMES[phase] ?? `UNKNOWN(${phase})`;
}

/**
 * Dev-mode flag.
 *
 * Read once at module load rather than per call, so the hot path is a constant
 * branch V8 folds away. Guarded against `process` being undefined so the sim
 * still runs in a bare browser context with no bundler define.
 */
function detectDev(): boolean {
  try {
    return (
      typeof process !== "undefined" &&
      process.env !== undefined &&
      process.env["NODE_ENV"] !== "production"
    );
  } catch {
    return false;
  }
}

let devMode = detectDev();

/** Overrides dev-mode detection. Tests use this to exercise both branches. */
export function setPhaseDevMode(enabled: boolean): void {
  devMode = enabled;
}

/** True when illegal transitions will throw. */
export function isPhaseDevMode(): boolean {
  return devMode;
}

/** Whether `edge` is a legal transition out of `from`. */
export function canTransition(from: number, edge: EdgeName): boolean {
  return TRANSITIONS[from]?.[edge] !== undefined;
}

/** The phase `edge` leads to from `from`, or -1 if the edge is illegal. */
export function destinationOf(from: number, edge: EdgeName): number {
  return TRANSITIONS[from]?.[edge] ?? -1;
}

/**
 * Attempts a transition.
 *
 * @returns the new phase on success, or `from` unchanged if the edge is illegal.
 * @throws IllegalTransitionError in dev mode only.
 */
export function tryTransition(from: number, edge: EdgeName): number {
  const to = TRANSITIONS[from]?.[edge];
  if (to === undefined) {
    if (devMode) {
      throw new IllegalTransitionError(from, edge);
    }
    return from;
  }
  return to;
}

/** True when the phase means the player is on the floor plane. */
export function isGroundedPhase(phase: number): boolean {
  return phase === Phase.Running || phase === Phase.Sliding || phase === Phase.Rolling;
}

/** True when the run is over or resolving. No further movement is processed. */
export function isTerminalPhase(phase: number): boolean {
  return phase === Phase.Crashed || phase === Phase.Fracturing;
}
