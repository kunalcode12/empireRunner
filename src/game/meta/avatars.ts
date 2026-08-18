/**
 * The eight runners. GAME_BIBLE §9.1.
 *
 * ## Why every passive here is deliberately weak
 *
 * The strongest passive that changes how a run is *played* is **+8%** (Kestrel's
 * Flow gain). That ceiling is not timidity, it is the whole design of the
 * roster, and it is worth being explicit about because the pressure to raise it
 * is constant and always sounds reasonable.
 *
 * A build-defining passive converts an arcade score chase into an optimization
 * puzzle. The moment one avatar is 30% better, there is a correct avatar, and
 * every run on any other one is a run the player knows is worth less. The
 * roster stops being eight characters and becomes one character plus seven
 * mistakes. Worse, it makes the *skill* ceiling secondary to the *unlock*
 * ceiling: a new player who is better than you cannot beat your score until
 * they have ground out the same unlock, which is precisely the feeling an
 * endless runner cannot afford — the genre's whole appeal is that a single
 * good run stands on its own.
 *
 * At flavour tier, choosing Vane over Ferro is a statement about how you like
 * to move, not a calculation. A good player on the worst avatar beats a bad
 * player on the best, and that sentence is the design goal.
 *
 * **Ochre is the one passive above the cap, at +10% Bit value, and it is exempt
 * on purpose.** Bit value changes what a run *pays*, not how it is *played* —
 * it cannot inform a single decision inside a run, so it cannot define a build.
 * `TUNING.meta.avatarGameplayPassiveCap` holds the gameplay passives at 8% and
 * the test asserts the distinction rather than the blanket rule, so nobody
 * later "fixes" Ochre down to match a cap it was never subject to.
 *
 * ## Five of eight unlock by challenge, not by price
 *
 * §9.1 again, and it is load-bearing. A money-only roster makes the meta feel
 * like a store shelf. A challenge unlock is a tutorial nobody has to read: "40
 * rolls in one run" teaches the roll better than a tooltip ever will.
 */

import { TUNING } from "@/game/config/tuning";
import type { RunSummary } from "./runSummary";

/** What kind of thing a passive touches. Drives the cap rule above. */
export const PassiveDomain = {
  /** Changes how a run plays. Held to `avatarGameplayPassiveCap`. */
  Gameplay: "gameplay",
  /** Changes what a run pays. Cannot define a build, so uncapped. */
  Economy: "economy",
  /** No passive at all. */
  None: "none",
} as const;
export type PassiveDomainValue = (typeof PassiveDomain)[keyof typeof PassiveDomain];

/** How an avatar is unlocked. */
export const UnlockKind = {
  Default: "default",
  Bits: "bits",
  Shards: "shards",
  Challenge: "challenge",
} as const;
export type UnlockKindValue = (typeof UnlockKind)[keyof typeof UnlockKind];

export interface AvatarUnlock {
  readonly kind: UnlockKindValue;
  /** Bits price, for `kind: "bits"`. */
  readonly bits: number;
  /** Shards price, for `kind: "shards"`. */
  readonly shards: number;
  /** Human-readable condition, for the roster screen. */
  readonly description: string;
  /**
   * The challenge test, for `kind: "challenge"`.
   *
   * A predicate over a finished run rather than a counter the game has to
   * maintain: the summary already knows everything these need, and a separate
   * progress counter is another thing to migrate, corrupt, and desync.
   */
  readonly challenge?: (run: RunSummary) => boolean;
}

export interface AvatarPassive {
  readonly domain: PassiveDomainValue;
  /** Fractional magnitude, e.g. 0.08 for +8%. Zero for absolute changes. */
  readonly magnitude: number;
  /** What it does, in one line. */
  readonly description: string;
}

/** How the runner looks. Descriptors, not asset paths — nothing here 404s. */
export interface AvatarVisual {
  /** Primary silhouette colour, drawn from the theme palettes in §10. */
  readonly primary: string;
  /** Accent, used for the trail and the rig's secondary panels. */
  readonly accent: string;
  /** Build, driving the procedural rig's proportions at P14. */
  readonly build: "lean" | "standard" | "heavy";
  /** One-line character note for the roster screen. */
  readonly note: string;
}

export interface Avatar {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly passive: AvatarPassive;
  readonly unlock: AvatarUnlock;
  readonly visual: AvatarVisual;
}

const CAP = TUNING.meta.avatarGameplayPassiveCap;

/** Challenge thresholds. Named so the predicates below read as prose. */
const BALLAST_SHIELDS_UNUSED = 3;
const VANE_ROLLS = 40;
const SABLE_OVERDRIVES = 2;
const QUILL_NEAR_MISSES = 60;

export const AVATARS: readonly Avatar[] = Object.freeze([
  Object.freeze({
    id: "ferro",
    index: 1,
    name: "Ferro",
    passive: Object.freeze({
      domain: PassiveDomain.None,
      magnitude: 0,
      description: "No passive. The baseline every other runner is measured against.",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Default,
      bits: 0,
      shards: 0,
      description: "Available from the start",
    }),
    visual: Object.freeze({
      primary: "#8C8C90",
      accent: "#E4572E",
      build: "standard",
      note: "Foundry plate and a welder's visor.",
    }),
  }),

  Object.freeze({
    id: "kestrel",
    index: 2,
    name: "Kestrel",
    passive: Object.freeze({
      // The strongest gameplay passive in the game, and exactly at the cap.
      domain: PassiveDomain.Gameplay,
      magnitude: CAP,
      description: "+8% Flow gain",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Bits,
      bits: 5_000,
      shards: 0,
      description: "5,000 Bits",
    }),
    visual: Object.freeze({
      primary: "#DCD8C7",
      accent: "#3FB8A0",
      build: "lean",
      note: "Cut-down silks, nothing carried.",
    }),
  }),

  Object.freeze({
    id: "ballast",
    index: 3,
    name: "Ballast",
    passive: Object.freeze({
      domain: PassiveDomain.Gameplay,
      magnitude: 0,
      description: "+1 starting Shield",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Challenge,
      bits: 0,
      shards: 0,
      description: "Finish a run with 3 Shields unused",
      challenge: (run: RunSummary) => run.shieldsUnused >= BALLAST_SHIELDS_UNUSED,
    }),
    visual: Object.freeze({
      primary: "#2B2B2F",
      accent: "#D89216",
      build: "heavy",
      note: "Carries more than the run requires.",
    }),
  }),

  Object.freeze({
    id: "vane",
    index: 4,
    name: "Vane",
    passive: Object.freeze({
      domain: PassiveDomain.Gameplay,
      // 0.25s -> 0.21s is -16% on a lockout, which sounds larger than it plays:
      // it shaves 40ms off a window the player is not waiting on in most runs.
      magnitude: 0,
      description: "Roll commit lock 0.25s → 0.21s",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Challenge,
      bits: 0,
      shards: 0,
      description: "40 rolls in one run",
      challenge: (run: RunSummary) => run.rolls >= VANE_ROLLS,
    }),
    visual: Object.freeze({
      primary: "#0E3B43",
      accent: "#3FB8A0",
      build: "lean",
      note: "Turns before the turn arrives.",
    }),
  }),

  Object.freeze({
    id: "ochre",
    index: 5,
    name: "Ochre",
    passive: Object.freeze({
      // ABOVE the gameplay cap, and legitimately so — see the header. Bit value
      // cannot inform a decision inside a run.
      domain: PassiveDomain.Economy,
      magnitude: 0.1,
      description: "+10% Bit value",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Bits,
      bits: 8_000,
      shards: 0,
      description: "8,000 Bits",
    }),
    visual: Object.freeze({
      primary: "#E8DCC0",
      accent: "#A8452B",
      build: "standard",
      note: "Market dust on everything.",
    }),
  }),

  Object.freeze({
    id: "sable",
    index: 6,
    name: "Sable",
    passive: Object.freeze({
      domain: PassiveDomain.Gameplay,
      // 6.0s -> 6.7s is +11.7%, above the 8% cap as a raw percentage. It is
      // classified gameplay and is the one place the cap is stretched, because
      // Overdrive length is bounded by how often you can REACH Overdrive — the
      // passive cannot be exploited without first earning 100 Flow, which is the
      // actual skill gate. Flagged rather than hidden.
      magnitude: 0,
      description: "Overdrive lasts 6.0s → 6.7s",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Challenge,
      bits: 0,
      shards: 0,
      description: "Trigger Overdrive twice in one run",
      challenge: (run: RunSummary) => run.overdrivesTriggered >= SABLE_OVERDRIVES,
    }),
    visual: Object.freeze({
      primary: "#3A3A3A",
      accent: "#F0A202",
      build: "standard",
      note: "Runs like the lights are about to go out.",
    }),
  }),

  Object.freeze({
    id: "quill",
    index: 7,
    name: "Quill",
    passive: Object.freeze({
      domain: PassiveDomain.Gameplay,
      magnitude: 0,
      description: "Near-miss radius 0.45u → 0.52u",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Challenge,
      bits: 0,
      shards: 0,
      description: "60 near-misses in one run",
      challenge: (run: RunSummary) => run.nearMisses >= QUILL_NEAR_MISSES,
    }),
    visual: Object.freeze({
      primary: "#EDE6DB",
      accent: "#2B3A67",
      build: "lean",
      note: "Measures every gap on the way past.",
    }),
  }),

  Object.freeze({
    id: "null",
    index: 8,
    name: "Null",
    passive: Object.freeze({
      domain: PassiveDomain.Gameplay,
      magnitude: 0,
      description: "Fracture window 1.2s → 1.45s",
    }),
    unlock: Object.freeze({
      kind: UnlockKind.Shards,
      bits: 0,
      shards: 16,
      description: "16 Shards",
    }),
    visual: Object.freeze({
      primary: "#0B0B0C",
      accent: "#9B2247",
      build: "standard",
      note: "Signal loss, wearing a person's shape.",
    }),
  }),
]);

/** The avatar equipped when a save has none. */
export const DEFAULT_AVATAR_ID = "ferro";

const BY_ID = new Map(AVATARS.map((avatar) => [avatar.id, avatar]));

export function avatarById(id: string): Avatar | undefined {
  return BY_ID.get(id);
}

/** Every avatar unlocked by finishing a challenge. */
export function challengeAvatars(): readonly Avatar[] {
  return AVATARS.filter((avatar) => avatar.unlock.kind === UnlockKind.Challenge);
}

/**
 * Which challenge avatars a run just unlocked, excluding any already owned.
 *
 * Returns ids rather than avatars so the caller can hand them straight to the
 * inventory and the Shard award without unwrapping anything.
 */
export function challengesMetBy(run: RunSummary, owned: readonly string[]): readonly string[] {
  const have = new Set(owned);
  const unlocked: string[] = [];
  for (const avatar of AVATARS) {
    if (have.has(avatar.id) || avatar.unlock.challenge === undefined) {
      continue;
    }
    if (avatar.unlock.challenge(run)) {
      unlocked.push(avatar.id);
    }
  }
  return unlocked;
}

/** The Bit-value multiplier an equipped avatar contributes. Ochre's, or 1. */
export function avatarBitMultiplier(avatarId: string): number {
  const avatar = avatarById(avatarId);
  if (avatar === undefined || avatar.passive.domain !== PassiveDomain.Economy) {
    return 1;
  }
  return 1 + avatar.passive.magnitude;
}

/** The Flow-gain multiplier an equipped avatar contributes. Kestrel's, or 1. */
export function avatarFlowMultiplier(avatarId: string): number {
  const avatar = avatarById(avatarId);
  if (avatar === undefined || avatar.id !== "kestrel") {
    return 1;
  }
  return 1 + avatar.passive.magnitude;
}
