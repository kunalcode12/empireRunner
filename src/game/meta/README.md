# `src/game/meta/` — everything between runs

## Belongs here

- `economy.ts` — Bits, Shards, the upgrade cost and effect curves
- `inventory.ts` — consumables, cosmetics, the one loadout (1 avatar + 2 boosts)
- `missions.ts` — 3 rotating dailies, the 3-tier weekly contract
- `save.ts` — persistence, schema migrations, integrity

## Does NOT belong here

- **Anything that runs during a run.** Economy and missions settle at run boundaries, off the
  hot path. A mission-progress check inside the tick is a law (d) violation.
- Gameplay numbers. Cost curves live in `config/tuning.ts`; the *arithmetic* lives here.

## The curves

```
cost(tier)   = round5(base * 2.15^(tier - 1))            tier 1..5
effect(tier) = Emax * (1 - k^tier) / (1 - k^5)   k=0.6,  tier 0..5
```

Tier 1 costs 250 Bits and delivers **43.4%** of the total benefit; tier 5 costs 5,340 and
delivers the last 5.6%. That shape is deliberate: early upgrades feel transformative, the last
tier is a completionist flex, and nobody is ever locked out of content by not owning it.

**Tier 5 is +65%, not +400%.** Any upgrade whose tier 5 more than doubles tier 0 is a balance
bug. Shield Count is the exception to the curve — it uses the integer step table
`[1,1,2,2,2,3]`, because you cannot hold 1.43 shields.

## Two rules that keep the economy honest

- **Shards are never spendable on upgrades.** Upgrades are the Bits treadmill; Shards are the
  second-chance and identity currency. Mixing them collapses both.
- **Loadout slots are never sold.** That is how this genre turns a clean meta into a
  spreadsheet.

Full economy: [docs/GAME_BIBLE.md §8](../../../../docs/GAME_BIBLE.md).
