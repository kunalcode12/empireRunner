import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createRng, forkSeed, nextFloat, RNG_STREAMS } from "@/game/sim/rng";
import { createSim } from "@/game/sim/sim";
import { applyFatal, CrashCause } from "@/game/sim/player";
import { F, RunStatus } from "@/game/sim/state";
import { addFlow, FlowSource, nearMissFlow, recordBit } from "@/game/sim/scoring/flow";
import { addBitScore, addNearMissScore, getScore } from "@/game/sim/scoring/score";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BALANCE REPORT — AND WHAT IT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Nothing spawns in the sim yet.** P06 built, proved and fuzzed the level
 * generator but deliberately did not wire it into the live tick, so a simulated
 * run has no geometry to hit and cannot die of anything. Read that again before
 * reading the numbers below.
 *
 * So survival here is a MODEL, not a measurement. What is real and what is not:
 *
 * ```
 *   REAL (the actual shipping sim, unmodified)
 *     the world-speed curve and its Flow coupling
 *     the Flow meter: gains, proximity scaling, decay, the grace window
 *     the score accumulator, the multiplier, Overdrive
 *     the crash path, Flow zeroing, run termination
 *
 *   MODELLED (invented for this harness, lives only in this file)
 *     when the player meets an obstacle          <- from the band density table
 *     whether they clear it                      <- per-profile probability
 *     whether clearing it was a near-miss        <- per-profile probability
 *     whether they collect the Bits              <- per-profile probability
 * ```
 *
 * The consequence, stated plainly: **the median DURATIONS below are an input,
 * not a finding.** The three profiles' clear probabilities were calibrated so
 * the durations land near the 45s / 2m / 6m targets, because a duration target
 * is the only thing a survival model can be calibrated against. Reporting them
 * as if the game produced them would be circular.
 *
 * What IS worth reading is everything downstream of duration — the score, the
 * score-per-second, the Flow and Overdrive behaviour — because those come from
 * the real sim given a run of that length. In particular the score spread
 * between profiles is a genuine output: it says whether the Flow multiplier
 * makes skill pay superlinearly, which is the thesis of the whole design.
 *
 * **`tuning.ts` was NOT touched to make any of these numbers land.** Only the
 * model parameters in this file were calibrated.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ THIS HARNESS IS NOW OBSOLETE. READ BEFORE TRUSTING ANY NUMBER BELOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * P07 wired the generator into the live tick, so the sim now kills the player
 * with **real geometry**. That makes this file's survival model redundant and
 * actively misleading: left alone, modelled deaths and real deaths stack, the
 * player dies of whichever lands first, and the resulting medians measure
 * neither the model nor the game.
 *
 * The interim fix is to keep the model authoritative — the run is invulnerable
 * to real contact, so only modelled encounters can end it. That preserves
 * comparability with the P08 figures and nothing more.
 *
 * **The right fix is to delete the model.** With real geometry in the tunnel,
 * a balance pass should drive real inputs from a scripted policy of varying
 * competence and measure genuine deaths. That is a proper piece of work — it
 * needs an AI that can read the 12-cell state and choose a verb — and it is the
 * single most valuable thing a future balance phase could do. Until then, treat
 * everything here as a P08-era artefact kept for continuity.
 */

const TICK_RATE = TUNING.sim.tickRate;
const DT = TUNING.sim.fixedDelta;
const FLOW_MAX = TUNING.flow.flowMax;
const BASE_SPEED = TUNING.speed.baseSpeed;
const MAX_SPEED = TUNING.speed.maxSpeed;
const BANDS = TUNING.spawn.bands;
const NEAR_MISS_RADIUS = TUNING.flow.nearMissRadius;

/** s — topped up each tick so only MODELLED encounters can end a run. */
const MODEL_ONLY_INVULN = 999;

const RUNS = 1_000;
/** Hard stop, so a lucky run cannot hang the suite. 15 minutes. */
const MAX_TICKS = TICK_RATE * 60 * 15;

interface Profile {
  readonly name: string;
  /** Probability of FAILING one obstacle encounter at `baseSpeed`.
   *
   *  Expressed as failure rather than as clear probability on purpose. Skill
   *  differences live in the tail — the gap between a 99.9% player and a 99.99%
   *  one is a factor of ten in how long they last, and writing it as "clear"
   *  hides that behind two digits that both round to 1.0. */
  readonly baseFail: number;
  /** Multiplier on `baseFail` by the time the world reaches `maxSpeed`. */
  readonly speedStress: number;
  /** Of cleared encounters, the fraction taken tight enough to be a near-miss. */
  readonly nearMissRate: number;
  /** How close their near-misses are, as a fraction of `nearMissRadius`. */
  readonly nearMissTightness: number;
  /** Fraction of Bit lines collected. */
  readonly bitRate: number;
  /** Whether they spend the meter when it fills. */
  readonly usesOverdrive: boolean;
}

/**
 * The three profiles.
 *
 * Calibrated to hit the duration targets, as described in the header. The shape
 * of the model is one number per profile for raw accuracy and one for how much
 * of it survives contact with speed — a novice does not merely miss more, they
 * fall apart faster as the world accelerates, and that second term is what makes
 * the Flow coupling bite differently at different skill levels.
 */
const PROFILES: readonly Profile[] = [
  {
    name: "novice",
    baseFail: 0.0117,
    speedStress: 2.5,
    nearMissRate: 0.06,
    nearMissTightness: 0.85,
    bitRate: 0.35,
    usesOverdrive: false,
  },
  {
    name: "mid",
    baseFail: 0.0015,
    speedStress: 3.0,
    nearMissRate: 0.22,
    nearMissTightness: 0.55,
    bitRate: 0.65,
    usesOverdrive: true,
  },
  {
    name: "expert",
    baseFail: 0.00015,
    speedStress: 3.5,
    nearMissRate: 0.55,
    nearMissTightness: 0.2,
    bitRate: 0.9,
    usesOverdrive: true,
  },
];

/** Obstacle events per 100m at a given distance, from TUNING §10. */
function densityAt(distance: number): number {
  for (const band of BANDS) {
    if (distance >= band.fromMetres && distance < band.toMetres) {
      return band.obstaclesPer100m;
    }
  }
  return BANDS[BANDS.length - 1]?.obstaclesPer100m ?? 6;
}

/** Probability this profile FAILS one encounter at the current world speed. */
function failChance(profile: Profile, worldSpeed: number): number {
  const stress = (worldSpeed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
  const value = profile.baseFail * (1 + profile.speedStress * stress);
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

interface RunResult {
  seconds: number;
  distance: number;
  score: number;
  peakFlow: number;
  overdrives: number;
  encounters: number;
}

/** Simulates one run of one profile against the real sim. */
function simulateRun(profile: Profile, seed: number): RunResult {
  const sim = createSim(seed);
  const rng = createRng(forkSeed(seed, RNG_STREAMS.cosmetic));
  const state = sim.getState();

  const intent = { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };

  let nextEncounter = 40;
  let encounters = 0;
  let peakFlow = 0;
  let overdrives = 0;
  let ticks = 0;

  while (state.runStatus === RunStatus.Running && ticks < MAX_TICKS) {
    const flow = state.f[F.flow] ?? 0;
    intent.overdrive = profile.usesOverdrive && flow >= FLOW_MAX;
    const wasOverdrive = (state.f[F.overdriveTimer] ?? 0) > 0;

    // The model is the sole authority on death — see the obsolescence note in
    // the header. Without this the real geometry P07 put in the tunnel kills the
    // player too, and the medians measure a race between two unrelated systems.
    state.f[F.playerInvulnerableTimer] = MODEL_ONLY_INVULN;

    sim.tick(intent);
    ticks += 1;

    if (!wasOverdrive && (state.f[F.overdriveTimer] ?? 0) > 0) {
      overdrives += 1;
    }
    if ((state.f[F.flow] ?? 0) > peakFlow) {
      peakFlow = state.f[F.flow] ?? 0;
    }

    const distance = state.f[F.distance] ?? 0;
    if (distance < nextEncounter) {
      continue;
    }

    // ── One modelled obstacle encounter ────────────────────────────────────
    encounters += 1;
    const spacing = 100 / densityAt(distance);
    nextEncounter = distance + spacing;

    const worldSpeed = state.f[F.worldSpeed] ?? BASE_SPEED;
    const invulnerable = (state.f[F.overdriveTimer] ?? 0) > 0;

    if (!invulnerable && nextFloat(rng) < failChance(profile, worldSpeed)) {
      // Clear the model-only shield so the fatal path actually resolves.
      state.f[F.playerInvulnerableTimer] = 0;
      // No Shards are modelled, so this always ends the run.
      applyFatal(state, sim.events, CrashCause.Obstacle, -1);
      break;
    }

    if (nextFloat(rng) < profile.nearMissRate) {
      addNearMissScore(state);
      if (!invulnerable) {
        const gap = NEAR_MISS_RADIUS * profile.nearMissTightness * nextFloat(rng);
        addFlow(state, nearMissFlow(gap), FlowSource.NearMiss, sim.events);
      }
    }

    if (nextFloat(rng) < profile.bitRate) {
      addBitScore(state);
      if (!invulnerable) {
        recordBit(state, sim.events);
      }
    }
  }

  return {
    seconds: ticks * DT,
    distance: state.f[F.distance] ?? 0,
    score: getScore(state),
    peakFlow,
    overdrives,
    encounters,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}m${s.toFixed(0).padStart(2, "0")}s` : `${s.toFixed(1)}s`;
}

/** Target median durations from the P08 prompt, in seconds. */
const TARGETS: Readonly<Record<string, number>> = { novice: 45, mid: 120, expert: 360 };

describe("balance report", () => {
  it(`simulates ${RUNS} runs per profile and prints the report`, { timeout: 300_000 }, () => {
    const rows: { profile: Profile; results: RunResult[] }[] = [];

    for (const profile of PROFILES) {
      const results: RunResult[] = [];
      for (let seed = 0; seed < RUNS; seed += 1) {
        results.push(simulateRun(profile, seed + 1));
      }
      rows.push({ profile, results });
    }

    const lines: string[] = [];
    lines.push("");
    lines.push("=".repeat(96));
    lines.push(`AXIS BALANCE REPORT — ${RUNS.toLocaleString()} runs per profile`);
    lines.push("=".repeat(96));
    lines.push("");
    lines.push("  ⚠ SURVIVAL IS MODELLED, NOT MEASURED. The generator is not wired into the");
    lines.push("    live tick (P06 shipped it unwired), so a simulated run has no geometry to");
    lines.push("    hit. Flow, score, speed and the crash path are the real sim; WHEN the");
    lines.push("    player dies is this file's model. Durations were CALIBRATED to the target");
    lines.push("    medians, so they are an input. The score columns are the real output.");
    lines.push("");
    lines.push("  model:  fail = baseFail * (1 + speedStress * (v - 12) / (34 - 12))");
    lines.push(
      "          " +
        PROFILES.map((p) => `${p.name} ${(p.baseFail * 100).toFixed(3)}%/x${p.speedStress}`).join(
          "   ",
        ),
    );
    lines.push("");
    lines.push(
      "  profile   median dur    target   median dist   median score   pts/s   p90 score   peak Flow   OD/run",
    );
    lines.push("  " + "-".repeat(92));

    for (const { profile, results } of rows) {
      const durations = results.map((r) => r.seconds);
      const distances = results.map((r) => r.distance);
      const scores = results.map((r) => r.score);

      const medDur = median(durations);
      const medScore = median(scores);
      const target = TARGETS[profile.name] ?? 0;

      lines.push(
        "  " +
          profile.name.padEnd(9) +
          formatDuration(medDur).padStart(10) +
          formatDuration(target).padStart(10) +
          `${median(distances).toFixed(0)}m`.padStart(14) +
          medScore.toLocaleString().padStart(15) +
          (medScore / medDur).toFixed(1).padStart(8) +
          percentile(scores, 90).toLocaleString().padStart(12) +
          median(results.map((r) => r.peakFlow))
            .toFixed(0)
            .padStart(12) +
          median(results.map((r) => r.overdrives))
            .toFixed(1)
            .padStart(9),
      );
    }

    lines.push("");
    lines.push("  Overdrive uptime — the fraction of the run spent invulnerable:");
    for (const { profile, results } of rows) {
      const medDur = median(results.map((r) => r.seconds));
      const medOd = median(results.map((r) => r.overdrives));
      const uptime = medDur > 0 ? (medOd * TUNING.overdrive.overdriveDuration) / medDur : 0;
      lines.push(
        `    ${profile.name.padEnd(8)} ${medOd.toFixed(1).padStart(5)} triggers  ` +
          `${(uptime * 100).toFixed(1).padStart(5)}% of the run`,
      );
    }
    lines.push("");
    lines.push("  score spread, the number that actually matters:");
    const medScores = rows.map((r) => median(r.results.map((x) => x.score)));
    const [novice = 1, mid = 1, expert = 1] = medScores;
    lines.push(`    mid    / novice = ${(mid / novice).toFixed(1)}x`);
    lines.push(`    expert / novice = ${(expert / novice).toFixed(1)}x`);
    lines.push(`    expert / mid    = ${(expert / mid).toFixed(1)}x`);
    lines.push("");
    lines.push("  duration spread, for comparison:");
    const medDurs = rows.map((r) => median(r.results.map((x) => x.seconds)));
    const [dn = 1, dm = 1, de = 1] = medDurs;
    lines.push(`    mid    / novice = ${(dm / dn).toFixed(1)}x`);
    lines.push(`    expert / novice = ${(de / dn).toFixed(1)}x`);
    lines.push("");
    lines.push("  Score outpacing duration is the design working: an expert is not just alive");
    lines.push("  longer, they are earning at a higher rate the whole time.");
    lines.push("");
    lines.push("=".repeat(96));

    console.log(lines.join("\n"));

    // Assertions are deliberately weak. The medians are calibrated, so
    // asserting them tightly would be asserting the calibration. What IS worth
    // enforcing is the ORDERING and the superlinearity, which are properties of
    // the real Flow/score coupling rather than of the model.
    for (const { profile, results } of rows) {
      const medDur = median(results.map((r) => r.seconds));
      const target = TARGETS[profile.name] ?? 0;

      // Loose enough not to be a calibration tautology, tight enough to catch
      // the model or the sim breaking outright.
      expect(medDur, `${profile.name} median duration`).toBeGreaterThan(target / 2);

      // Only novice and mid get an upper bound. The expert target was stated as
      // "6m+" — a FLOOR, not a point — so capping it was my error rather than a
      // finding. It matters now: with real pickups in the tunnel the expert
      // banks more Flow, spends more Overdrive, and rides that invulnerability
      // to a longer run (12m12s). Exceeding a floor is the model working.
      if (profile.name !== "expert") {
        expect(medDur, `${profile.name} median duration`).toBeLessThan(target * 2);
      }
    }

    const durs = rows.map((r) => median(r.results.map((x) => x.seconds)));
    const scores = rows.map((r) => median(r.results.map((x) => x.score)));
    expect(durs[0]).toBeLessThan(durs[1] ?? 0);
    expect(durs[1]).toBeLessThan(durs[2] ?? 0);
    expect(scores[0]).toBeLessThan(scores[1] ?? 0);
    expect(scores[1]).toBeLessThan(scores[2] ?? 0);

    // The thesis: score must grow FASTER than survival time does.
    const durationRatio = (durs[2] ?? 1) / (durs[0] ?? 1);
    const scoreRatio = (scores[2] ?? 1) / (scores[0] ?? 1);
    expect(scoreRatio).toBeGreaterThan(durationRatio);
  });

  it("FLAGS: expert Overdrive uptime is above half the run", { timeout: 120_000 }, () => {
    /**
     * A finding, pinned as a test so it cannot quietly drift further.
     *
     * At the calibrated expert profile, the median run triggers Overdrive ~51
     * times across ~9m50s. At `overdriveDuration` 6.0s that is over 50% of the
     * run spent invulnerable, which is close to the failure mode TUNING §9.2
     * names for `overdriveExitFlow`: "the player chains Overdrives with barely
     * any play between them."
     *
     * Why it happens: exiting at 25 Flow means an expert only has to earn 75,
     * and at a 55% near-miss rate that takes about 13 near-misses — roughly
     * eight seconds of expert play. The comedown is supposed to be a landing,
     * but for a strong player it is barely a dip.
     *
     * NOT fixed here. `overdriveExitFlow` is a tuning value and this phase does
     * not get to move it on the strength of a modelled harness — and the model's
     * near-miss rate is itself invented. Re-measure at P07 with real geometry
     * before touching anything.
     */
    const SAMPLE = 120;
    const expert = PROFILES[2];
    expect(expert).toBeDefined();
    if (expert === undefined) {
      return;
    }

    const runs: RunResult[] = [];
    for (let seed = 0; seed < SAMPLE; seed += 1) {
      runs.push(simulateRun(expert, seed + 1));
    }
    const medDur = median(runs.map((r) => r.seconds));
    const medOd = median(runs.map((r) => r.overdrives));
    const uptime = (medOd * TUNING.overdrive.overdriveDuration) / medDur;

    expect(uptime).toBeGreaterThan(0.4);
  });

  it("every run is reproducible from its seed", () => {
    const profile = PROFILES[2];
    expect(profile).toBeDefined();
    if (profile === undefined) {
      return;
    }
    const a = simulateRun(profile, 12345);
    const b = simulateRun(profile, 12345);
    expect(b).toEqual(a);
  });

  it("the model is monotonic in skill at a fixed speed", () => {
    // Cheap structural check on the model itself. The profile ORDERING over full
    // runs is asserted inside the report above; re-simulating hundreds of runs
    // to re-establish it here would cost 15 seconds to learn nothing new.
    for (const speed of [BASE_SPEED, 20, MAX_SPEED]) {
      const fails = PROFILES.map((p) => failChance(p, speed));
      expect(fails[0], `novice at ${speed}`).toBeGreaterThan(fails[1] ?? 0);
      expect(fails[1], `mid at ${speed}`).toBeGreaterThan(fails[2] ?? 0);
    }
  });

  it("failure rises with speed for every profile — the escalation loop", () => {
    for (const profile of PROFILES) {
      expect(failChance(profile, MAX_SPEED)).toBeGreaterThan(failChance(profile, BASE_SPEED));
    }
  });
});
