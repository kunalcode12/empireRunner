# `src/game/meta/` — everything between runs

Shipped at **P13**. Pure functions over frozen data, no framework, no DOM except behind an
injected interface.

## Files

| File | What lives there |
|---|---|
| `runSummary.ts` | The sim → meta boundary object, and the event recorder that fills it |
| `economy.ts` | Bits and Shards as an **append-only transaction ledger** |
| `backend.ts` | `EconomyBackend` — the one door every currency read and write goes through |
| `upgrades.ts` | 4 tracks × 5 tiers: cost curve, diminishing effect curve, the balance table |
| `avatars.ts` | 8 runners — passives, unlock conditions, visual descriptors |
| `inventory.ts` | Consumables, cosmetics, the 1 avatar + 2 boost loadout |
| `missionPool.ts` | The mission catalogue (data — exempt from `no-magic-numbers`) |
| `missions.ts` | UTC-seeded dailies, the weekly contract, and the near-miss line |
| `progression.ts` | Player level, unlock gating, onboarding flags |
| `settle.ts` | Applies a finished run. The single entry point P14 calls |
| `save.ts` | Versioned schema, migration chain, repairing validator |

## Does NOT belong here

- **Economy or mission logic during a run.** It settles at run boundaries, off the hot path.
  **One exception**, and it is named in [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) §3:
  the recorder in `runSummary.ts` counts events inside the frame loop. It allocates nothing,
  decides nothing, and has no economy import. It exists because `bitsCollected`, `nearMisses`
  and `peakFlow` are not `SimState` fields and the event ring holds 256 entries — at run end
  the data is *gone*, not merely awkward to reach.
- Gameplay numbers. Cost curves live in `config/tuning.ts`; the *arithmetic* lives here.
- Direct balance access. Read through `EconomyBackend` or not at all.

## The curves

```
cost(tier)   = round5(base * 2.15^(tier - 1))            tier 1..5
effect(tier) = Emax * (1 - k^tier) / (1 - k^5)   k=0.6,  tier 0..5
```

Tier 1 costs 250 Bits and delivers **43.4%** of the total benefit; tier 5 costs 5,340 and
delivers the last 5.6%. Early upgrades feel transformative, the last tier is a completionist
flex, and nobody is locked out of content by not owning it.

**Tier 5 is +65%, not +400%.** Any upgrade whose tier 5 more than doubles tier 0 is a balance
bug, and the test fails on it. Shield Count is the exception to the curve — the integer step
table `[1,1,2,2,2,3]`, because you cannot hold 1.43 shields.

`tests/meta/upgrades.test.ts` snapshots the **entire** cost and effect table, so a change to
`upgradeEffectK` shows up as a six-column table diff in review rather than as one character in
a config file.

## Four rules that keep this honest

- **Balances are never assigned — they are folded from the ledger.** A balance you can assign
  is a balance nobody can explain. A ledger answers "where did my Bits go" with evidence, and
  it is the only structure that makes cross-device sync a merge rather than a coin-flip.
- **Shards are never spendable on upgrades.** Upgrades are the Bits treadmill; Shards are the
  second-chance and identity currency. Mixing them collapses both.
- **Loadout slots are never sold.** That is how this genre turns a clean meta into a
  spreadsheet. The count is read from tuning, there is no function to change it, and the save
  validator truncates a hostile file to it.
- **Nothing in `save.ts` throws.** A save that fails to load is a permanent uninstall.
  Truncated JSON, wrong types, a version from the future — all three produce a working save,
  repaired field by field.

Full economy: [docs/GAME_BIBLE.md §8](../../../docs/GAME_BIBLE.md). Meta systems: §9.
