# `tests/e2e/` — Playwright

Things only a real browser can answer.

## Here now (P01)

- `smoke.spec.ts` — the page boots, the wordmark renders, the background is the theme black
  and not a white flash, and the console is clean.

## Scheduled (P05 onward)

The budgets in [docs/TUNING.md §14](../../docs/TUNING.md), read off
`renderer.info.render.calls`:

| Budget | Limit |
|---|---|
| Draw calls, desktop | < 100 |
| Draw calls, mobile | < 50 |
| First-load JS | < 250KB gzip |
| Pixel ratio | ≤ 2 |

`playwright.config.ts` already defines both a `desktop-chromium` and a `mobile-chromium`
project, because those two budgets differ and P05 should not have to retrofit the mobile gate.

## Not in CI

Run locally with `npm run test:e2e`. Browser downloads would dominate CI time for what is
currently a scaffold; the GitHub Actions workflow runs typecheck, lint, test and build. Revisit
when the budget assertions land and actually protect something.

## Note

`webServer` runs `npm run build && npm run start` — a production build, not `next dev`. Dev-mode
draw calls and bundle sizes are meaningless as budget measurements.
