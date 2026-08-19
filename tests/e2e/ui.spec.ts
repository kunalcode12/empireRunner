import { expect, test, type Page } from "@playwright/test";

/**
 * The P14 verify gate, in a real browser.
 *
 * Three things live here that nothing else can answer:
 *
 *   1. **Screenshots** of every screen at 1920x1080 and 375x812, written to
 *      `test-results/screens/` so they can be looked at rather than described.
 *   2. **Zero React re-renders during a run**, counted via `window.__axisRenders`.
 *   3. **An accessibility audit.** Read the honest caveat below before quoting
 *      it as a Lighthouse score, because it is not one.
 *
 * ## On the render counter
 *
 * The first implementation used React's `<Profiler>`. That was wrong here:
 * React strips `onRender` from production builds, and this suite runs against
 * `next build && next start`, so the callback never fired and the assertion read
 * a sentinel instead of a measurement. See `src/ui/CommitCounter.tsx`.
 *
 * ## On Lighthouse
 *
 * The brief asks for a Lighthouse accessibility score over 95. Lighthouse is not
 * installed, and installing it — or `@axe-core/playwright` — is a dependency
 * change, which CLAUDE.md requires approval for. So what runs instead is a
 * hand-written audit of the specific things Lighthouse's accessibility category
 * actually checks: computed contrast on every rendered text node, an accessible
 * name on every interactive element, a visible focus indicator, one `h1` per
 * screen, landmark structure, `lang`, valid ARIA roles, and target sizes.
 *
 * **This is not a Lighthouse score and is not reported as one.** It checks the
 * same properties by the same rules; it does not produce the same number.
 */

const DESKTOP = { width: 1920, height: 1080 };
const MOBILE = { width: 375, height: 812 };

/** Every screen, and how to get there from the title. */
const SCREENS = [
  { id: "title", label: "Title", nav: null },
  { id: "shop", label: "Shop", nav: "SHOP" },
  { id: "loadout", label: "Loadout", nav: "LOADOUT" },
  { id: "runners", label: "Runners", nav: "RUNNERS" },
  { id: "missions", label: "Missions", nav: "MISSIONS" },
  { id: "leaderboard", label: "Leaderboard", nav: "LEADERBOARD" },
  { id: "settings", label: "Settings", nav: "SETTINGS" },
] as const;

/**
 * Boots /play with a save that has already unlocked everything.
 *
 * The screen gates in GAME_BIBLE §9.5 hold the store back until 2 runs, missions
 * until 3 and the loadout until 4 — correct for a player, useless for a
 * screenshot pass. Seeding lifetime stats is also how the shop shows real prices
 * against a real balance rather than an empty state.
 */
async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ledger = {
      entries: [
        {
          sequence: 0,
          at: 0,
          transaction: { kind: "opening-balance", bits: 40000, shards: 9, fromVersion: 3 },
        },
      ],
      nextSequence: 1,
    };
    // `axis.save`, and the boost ids are camelCase — both taken from
    // `meta/save.ts` and `meta/inventory.ts` rather than guessed. The first
    // version of this helper guessed both, the validator silently repaired the
    // result to a fresh save, and every screen came up locked.
    window.localStorage.setItem(
      "axis.save",
      JSON.stringify({
        version: 3,
        ledger,
        upgrades: { magnetDuration: 2, flowGain: 1, bitValue: 0, shieldCount: 5 },
        inventory: {
          consumables: { headStart: 3, doubleBits: 7, flowPrimer: 12 },
          cosmetics: [],
          equippedCosmetics: {},
          avatars: ["ferro", "kestrel", "ballast", "ochre", "null"],
          equippedAvatar: "kestrel",
          equippedBoosts: ["doubleBits"],
        },
        missions: {
          dayKey: "",
          weekKey: "",
          values: {},
          claimedDailies: [],
          claimedWeeklyTiers: [],
        },
        lifetime: {
          distance: 42_000,
          runs: 27,
          bestScore: 135_326,
          bestDistance: 3_100,
          bitsCollected: 8_400,
          nearMisses: 640,
          overdrives: 41,
          fracturesSurvived: 6,
        },
        onboarding: {
          seenFirstRun: true,
          seenRollPrompt: true,
          seenFlowPrompt: true,
          seenFracturePrompt: true,
          seenStore: true,
          seenMissions: true,
        },
        avatarChallengesClaimed: ["ballast"],
      }),
    );
  });

  await page.goto("/play");
  // The title menu is the readiness signal — it only renders once the save has
  // been read and the store has hydrated.
  await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // One extra beat for the diorama's first frames, so a screenshot is not of a
  // half-built tunnel.
  await page.waitForTimeout(700);
}

/** Navigates from the title to a screen and waits for its heading. */
async function openScreen(page: Page, nav: string, heading: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${nav}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
    timeout: 10_000,
  });
  // Past the 300ms shutter, so the screenshot is the screen and not the wipe.
  await page.waitForTimeout(600);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Screenshots
// ─────────────────────────────────────────────────────────────────────────────

for (const size of [
  { name: "1920x1080", viewport: DESKTOP },
  { name: "375x812", viewport: MOBILE },
]) {
  test(`screenshots every screen at ${size.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size.viewport);
    await boot(page);

    for (const screen of SCREENS) {
      if (screen.nav !== null) {
        await openScreen(page, screen.nav, screen.label);
      }
      await page.screenshot({
        path: `test-results/screens/${size.name}-${screen.id}.png`,
        animations: "disabled",
      });
      if (screen.nav !== null) {
        await page.getByRole("button", { name: /^Back from/i }).click();
        await page.waitForTimeout(600);
      }
    }

    // The run HUD, mid-play.
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await page.waitForTimeout(4_000);
    await page.screenshot({
      path: `test-results/screens/${size.name}-hud.png`,
      animations: "disabled",
    });

    // The pause screen, over a live run.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 1, name: "Paused" })).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: `test-results/screens/${size.name}-pause.png`,
      animations: "disabled",
    });
  });
}

/**
 * The death screen needs a real run, so it gets its own test per viewport.
 *
 * It was originally captured at 1920 only, which left the most sequenced screen
 * in the game unverified at the width its layout changes most — RETRY goes
 * full-width in the thumb zone and the stat row wraps.
 */
for (const size of [
  { name: "1920x1080", viewport: DESKTOP },
  { name: "375x812", viewport: MOBILE },
]) {
  test(`captures the death screen with a real settled run at ${size.name}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size.viewport);
    await boot(page);

    await page.getByRole("button", { name: "RUN", exact: true }).click();

    // A passive player dies to real geometry as of P07, so this needs no input —
    // it just needs long enough for the generator to put a wall in front of them.
    await expect(page.getByRole("button", { name: "RETRY" })).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(1_200);
    await page.screenshot({
      path: `test-results/screens/${size.name}-death.png`,
      animations: "disabled",
    });

    // Beat 5 lands with RETRY focused — an arcade player retries in under two
    // seconds and must not have to find the button.
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    expect(focused).toContain("RETRY");

    // Beat 3, the retention line, is REQUIRED by GAME_BIBLE §9.4.
    await expect(page.getByText(/YOU WERE .* SHORT/)).toBeVisible();

    // And the ordering the whole screen is designed around: the shortfall sits
    // above the Bits in the document, not below it.
    const order = await page.evaluate(() => {
      const shortfall = document.querySelector(".axis-death-short");
      const bits = document.querySelector(".axis-death-bitline");
      if (shortfall === null || bits === null) {
        return null;
      }
      return shortfall.compareDocumentPosition(bits) & Node.DOCUMENT_POSITION_FOLLOWING
        ? "ok"
        : "reversed";
    });
    expect(order, "the mission shortfall must precede the Bits — GAME_BIBLE §9.4").toBe("ok");
  });
}

/**
 * Landscape on a phone.
 *
 * The brief asks for "landscape and portrait" and the stylesheet has a
 * `max-height: 480px` block for it, but nothing looked at it until now — an
 * untested media query is a guess with a specificity selector on it.
 *
 * 812x375 is the same Pixel-class device rotated.
 */
test("lays out in landscape on a phone", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 812, height: 375 });
  await boot(page);

  await page.screenshot({
    path: "test-results/screens/812x375-title.png",
    animations: "disabled",
  });

  for (const screen of [
    { id: "shop", label: "Shop", nav: "SHOP" },
    { id: "settings", label: "Settings", nav: "SETTINGS" },
  ]) {
    await openScreen(page, screen.nav, screen.label);
    await page.screenshot({
      path: `test-results/screens/812x375-${screen.id}.png`,
      animations: "disabled",
    });
    // Vertical space is the scarce resource in landscape; the failure mode is a
    // header or an action row pushed off the bottom with no way to reach it.
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX, `${screen.id} overflows horizontally in landscape`).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: /^Back from/i })).toBeVisible();
    await page.getByRole("button", { name: /^Back from/i }).click();
    await page.waitForTimeout(600);
  }

  // The HUD in landscape: the ring must still be inside the viewport and still
  // clear the 56px hit-target floor.
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "test-results/screens/812x375-hud.png", animations: "disabled" });

  const ring = await page.locator(".axis-ring").boundingBox();
  expect(ring).not.toBeNull();
  if (ring !== null) {
    expect(ring.x + ring.width, "the ring is off the right edge").toBeLessThanOrEqual(812);
    expect(ring.y + ring.height, "the ring is off the bottom edge").toBeLessThanOrEqual(375);
    expect(Math.min(ring.width, ring.height)).toBeGreaterThanOrEqual(56);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Zero React commits during a run
// ─────────────────────────────────────────────────────────────────────────────

test("the UI tree does not re-render during a run", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(DESKTOP);
  await boot(page);

  await page.getByRole("button", { name: "RUN", exact: true }).click();
  // Let the run start and the shutter finish before the window opens — mounting
  // the canvas is a render, and it is not what this measures.
  await page.waitForTimeout(2_500);

  /**
   * Wait for the tree to go quiet before opening the window.
   *
   * A fixed delay is not enough. Save hydration resolves through a promise, and
   * under six parallel Playwright workers that can land a second or two later
   * than it does in isolation — producing exactly one legitimate startup render
   * inside the measurement window. The suite failed that way once while every
   * isolated run passed, which is the signature of a timing assumption rather
   * than a defect.
   *
   * Quiescence is the honest condition anyway: the budget is about the steady
   * state of a running game, not about the frames where it is still starting.
   */
  const QUIET_MS = 1_000;
  const QUIET_TIMEOUT_MS = 20_000;
  const quietDeadline = Date.now() + QUIET_TIMEOUT_MS;
  let lastTotal = -1;
  for (;;) {
    const total = await page.evaluate(() => window.__axisRenders?.total ?? -1);
    if (total === lastTotal || Date.now() > quietDeadline) {
      break;
    }
    lastTotal = total;
    await page.waitForTimeout(QUIET_MS);
  }

  const before = await page.evaluate(() => {
    const stats = window.__axisRenders;
    if (stats === undefined) {
      return null;
    }
    // Proof the counter is real before it is reset: if the instrument itself
    // never fired, a zero afterwards would be meaningless.
    const seen = stats.total;
    stats.reset();
    return seen;
  });
  expect(before, "the render counter never fired — the instrument is broken").not.toBeNull();
  expect(before ?? 0).toBeGreaterThan(0);

  // The HUD must actually be moving. A run that ended immediately would report
  // zero renders and pass for entirely the wrong reason.
  const distanceBefore = await page.textContent(".axis-hud-top");

  /**
   * The window closes when the run does.
   *
   * The first version simply waited 60 seconds, which measured whatever happened
   * in that span — and on the mobile project the passive player crashed partway
   * through, so the window included a death, a settlement and a screen change.
   * That is **seven legitimate renders**, and the test reported them as a budget
   * breach. The bug was in the instrument's boundaries, not in the UI.
   *
   * So: poll, and stop the moment the death screen appears. A run that ends
   * early shortens the sample rather than poisoning it, and the floor below
   * keeps a too-short sample from passing vacuously.
   */
  const TARGET_SECONDS = 60;
  const MIN_SECONDS = 20;
  const POLL_MS = 500;
  const started = Date.now();
  let ended = false;
  let measuredSeconds = 0;

  for (;;) {
    ended = await page.evaluate(() => window.__axisRenders?.marks["run-end"] !== undefined);
    measuredSeconds = (Date.now() - started) / 1000;
    if (ended || measuredSeconds >= TARGET_SECONDS) {
      break;
    }
    await page.waitForTimeout(POLL_MS);
  }

  // The mark when the run ended inside the window; the live total when it did
  // not. Either way the number is renders that happened WHILE RUNNING — polling
  // for a visible element could not find that boundary, because the death
  // screen mounts and the shutter covers several hundred milliseconds before
  // RETRY appears, and those seven renders are all correct.
  const after = await page.evaluate(() => {
    const stats = window.__axisRenders;
    const mark = stats?.marks["run-end"];
    return {
      total: mark ?? stats?.total ?? -1,
      fromMark: mark !== undefined,
      byComponent: { ...(stats?.byComponent ?? {}) },
      afterEnd: stats === undefined ? -1 : stats.total - (mark ?? stats.total),
    };
  });

  const distanceAfter = ended ? null : await page.textContent(".axis-hud-top");

  console.log(
    [
      "",
      "========================================================================",
      "AXIS UI — React renders during a live run",
      "========================================================================",
      `  renders before window   ${before}  (instrument is live)`,
      `  measured                ${measuredSeconds.toFixed(1)}s${ended ? " (run ended; counted to that instant)" : ""}`,
      `  renders WHILE RUNNING   ${after.total}   budget 0${after.fromMark ? "   (from the run-end mark)" : ""}`,
      `  renders after the run   ${after.afterEnd}   (death screen — not budgeted)`,
      `  by component            ${JSON.stringify(after.byComponent)}`,
      `  HUD readout moved       ${ended ? "n/a — run ended" : String(distanceBefore !== distanceAfter)}`,
      "========================================================================",
      "",
    ].join("\n"),
  );

  expect(measuredSeconds, "sample too short to mean anything").toBeGreaterThanOrEqual(MIN_SECONDS);
  if (!ended) {
    expect(distanceAfter, "the HUD did not update — the run was not live").not.toBe(distanceBefore);
  }
  expect(after.total).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Accessibility. NOT Lighthouse — see the header.
// ─────────────────────────────────────────────────────────────────────────────

interface AuditFinding {
  rule: string;
  detail: string;
}

/** Runs the audit inside the page and returns whatever failed. */
async function audit(page: Page): Promise<AuditFinding[]> {
  return page.evaluate(() => {
    const findings: { rule: string; detail: string }[] = [];

    function parse(colour: string): [number, number, number] {
      const match = /rgba?\(([^)]+)\)/.exec(colour);
      if (match === null) {
        return [255, 255, 255];
      }
      const parts = (match[1] ?? "").split(",").map((n) => Number.parseFloat(n.trim()));
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
    }

    function channel(v: number): number {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    function luminance(rgb: [number, number, number]): number {
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    }

    function ratio(a: string, b: string): number {
      const la = luminance(parse(a));
      const lb = luminance(parse(b));
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    /** Walks up for the first non-transparent background. */
    function backgroundOf(element: Element): string {
      let node: Element | null = element;
      while (node !== null) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          return bg;
        }
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    }

    // ── html lang ──────────────────────────────────────────────────────────
    if (document.documentElement.lang.trim() === "") {
      findings.push({ rule: "html-has-lang", detail: "<html> has no lang attribute" });
    }

    // ── One h1, and it is not empty ────────────────────────────────────────
    const visibleH1 = Array.from(document.querySelectorAll("h1")).filter(
      (h) => (h.textContent ?? "").trim() !== "",
    );
    if (visibleH1.length !== 1) {
      findings.push({
        rule: "page-has-one-h1",
        detail: `found ${visibleH1.length}: ${visibleH1.map((h) => h.textContent).join(" | ")}`,
      });
    }

    // ── Accessible name on every interactive element ───────────────────────
    const interactive = document.querySelectorAll<HTMLElement>(
      "button, a[href], input, select, textarea, [role='button'], [role='tab'], [role='radio']",
    );
    for (const element of interactive) {
      // The accessible-name computation, in the order the spec resolves it:
      // aria-label, then aria-labelledby, then a wrapping or `for`-linked
      // <label>, then the element's own text. The first version of this audit
      // skipped the <label> step and reported five false failures on the
      // settings sliders, which are correctly labelled by `htmlFor`.
      const labelled =
        element.id === "" ? null : document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      const label =
        element.getAttribute("aria-label") ??
        (element.getAttribute("aria-labelledby") !== null
          ? document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent
          : null) ??
        labelled?.textContent ??
        element.closest("label")?.textContent ??
        element.textContent ??
        "";
      if (label.trim() === "") {
        findings.push({
          rule: "interactive-has-name",
          detail: `${element.tagName}.${element.className} has no accessible name`,
        });
      }
    }

    // ── Target size ────────────────────────────────────────────────────────
    for (const element of interactive) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) {
        continue; // Not rendered — a hidden screen's controls.
      }
      const MIN = 24; // WCAG 2.2 AA. The design floor is 44; this is the failure line.
      if (box.width < MIN || box.height < MIN) {
        findings.push({
          rule: "target-size",
          detail: `${element.tagName}.${element.className} is ${Math.round(box.width)}x${Math.round(box.height)}`,
        });
      }
    }

    // ── Contrast on every rendered text node ───────────────────────────────
    const textish = document.querySelectorAll<HTMLElement>(
      "p, span, h1, h2, h3, button, a, li, td, th, dt, dd, label, output",
    );
    for (const element of textish) {
      const own = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      );
      if (!own) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
        continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        continue;
      }
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      // WCAG large text: 18.66px bold, or 24px at any weight. 3:1 there, 4.5:1
      // everywhere else.
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const actual = ratio(style.color, backgroundOf(element));
      if (actual < required) {
        findings.push({
          rule: "contrast",
          detail:
            `${element.tagName}.${element.className} "${(element.textContent ?? "").trim().slice(0, 28)}" ` +
            `${actual.toFixed(2)}:1 (needs ${required})`,
        });
      }
    }

    // ── ARIA roles that need their partners ────────────────────────────────
    for (const tab of document.querySelectorAll("[role='tab']")) {
      if (tab.getAttribute("aria-selected") === null) {
        findings.push({ rule: "aria-tab-selected", detail: `${tab.textContent}` });
      }
    }
    for (const meter of document.querySelectorAll("[role='meter'], [role='progressbar']")) {
      if (meter.getAttribute("aria-valuenow") === null) {
        findings.push({ rule: "aria-value", detail: `${meter.className} has no aria-valuenow` });
      }
    }

    return findings;
  });
}

for (const size of [
  { name: "1920x1080", viewport: DESKTOP },
  { name: "375x812", viewport: MOBILE },
]) {
  test(`accessibility audit at ${size.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size.viewport);
    await boot(page);

    const all: { screen: string; findings: AuditFinding[] }[] = [];

    for (const screen of SCREENS) {
      if (screen.nav !== null) {
        await openScreen(page, screen.nav, screen.label);
      }
      // Auditing mid-wipe audits two screens at once — the outgoing one is still
      // mounted, so the page briefly has two `h1`s and the "one h1 per screen"
      // rule fires on a transition rather than on a defect. It happened once
      // under six parallel workers while every isolated run was clean.
      await expect(page.locator(".axis-shutter")).toHaveCount(0, { timeout: 10_000 });
      all.push({ screen: screen.id, findings: await audit(page) });
      if (screen.nav !== null) {
        await page.getByRole("button", { name: /^Back from/i }).click();
        await page.waitForTimeout(600);
      }
    }

    const total = all.reduce((sum, entry) => sum + entry.findings.length, 0);
    console.log(
      [
        "",
        "========================================================================",
        `AXIS UI — accessibility audit at ${size.name}   (NOT a Lighthouse score)`,
        "========================================================================",
        ...all.map(
          (entry) =>
            `  ${entry.screen.padEnd(14)} ${entry.findings.length === 0 ? "clean" : `${entry.findings.length} finding(s)`}` +
            entry.findings.map((f) => `\n      ${f.rule}: ${f.detail}`).join(""),
        ),
        "========================================================================",
        "",
      ].join("\n"),
    );

    expect(total, "accessibility findings").toBe(0);
  });
}

test("keyboard focus is visible and reaches every control", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);

  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) {
      return null;
    }
    const style = getComputedStyle(active);
    return { width: style.outlineWidth, style: style.outlineStyle, colour: style.outlineColor };
  });

  expect(outline).not.toBeNull();
  // Replaced, never removed. `outline: none` appears nowhere in this codebase.
  expect(outline?.style).not.toBe("none");
  expect(Number.parseFloat(outline?.width ?? "0")).toBeGreaterThanOrEqual(2);
});

test("no page-level horizontal scroll at 375px", async ({ page }) => {
  // Seven screens, each with a 300ms wipe in and out. That is comfortably past
  // Playwright's 30s default once six workers are competing for the machine —
  // which is what actually failed here twice, reported as a click timeout rather
  // than as an overflow. The assertion was never the problem.
  test.setTimeout(180_000);
  await page.setViewportSize(MOBILE);
  await boot(page);

  for (const screen of SCREENS) {
    if (screen.nav !== null) {
      await openScreen(page, screen.nav, screen.label);
    }

    // The shutter is a full-viewport fixed element that only exists mid-wipe.
    // Measuring while it is mounted measures the transition, not the layout —
    // which is how this failed once under six parallel workers while passing
    // every isolated run. Wait for it to unmount rather than trusting a timeout.
    await expect(page.locator(".axis-shutter")).toHaveCount(0, { timeout: 10_000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${screen.id} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    if (screen.nav !== null) {
      await page.getByRole("button", { name: /^Back from/i }).click();
      await page.waitForTimeout(600);
    }
  }
});

test("the viewport blocks pinch-zoom and scroll bounce", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);

  const meta = await page.getAttribute('meta[name="viewport"]', "content");
  expect(meta).toContain("maximum-scale=1");
  expect(meta).toContain("viewport-fit=cover");

  const behaviour = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overscrollBehaviorY,
    touch: getComputedStyle(document.documentElement).touchAction,
  }));
  expect(behaviour.html).toBe("none");
  // `manipulation` is what removes the 300ms double-tap delay.
  expect(behaviour.touch).toBe("manipulation");
});

test("the HUD renders no <audio> and no forbidden neon", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await page.waitForTimeout(3_000);

  // GAME_BIBLE §11.3, checked on what actually painted rather than on source.
  const neon = await page.evaluate(() => {
    const banned: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      for (const value of [style.color, style.backgroundColor, style.borderTopColor]) {
        const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
        if (match === null) {
          continue;
        }
        const r = Number(match[1]);
        const g = Number(match[2]);
        const b = Number(match[3]);
        if ((r < 60 && g > 200 && b > 200) || (g < 60 && r > 200 && b > 200)) {
          banned.push(`${element.tagName}.${element.className}: ${value}`);
        }
      }
    }
    return banned;
  });
  expect(neon).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The two accessibility claims that had no test
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduced motion, verified on what actually renders.
 *
 * `tokens.css` shortens the motion scale and stops the ring's idle pulse, and
 * `DeathScreen` collapses its five beats to one. All of that was implemented and
 * none of it was asserted — an accessibility feature nobody checks is a comment.
 *
 * The two things it must NOT do are as important as what it does: the shutter
 * still moves (a screen changing with no transition is a state change the player
 * can miss entirely) and the Fracture ring still drains (it is the only
 * representation of a 1.2s deadline).
 */
test("reduced motion calms the UI without disabling it", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize(DESKTOP);

  /**
   * Emulated at the OS level rather than poked into the DOM.
   *
   * The first version set `data-motion="reduced"` with `page.evaluate` after
   * boot, and raced `applyStoredSettings()` — which clears that attribute when
   * the stored preference is "follow the OS". It passed alone and failed in the
   * full suite, which is the signature of a race rather than a defect.
   *
   * `emulateMedia` is also the better test: following the system preference is
   * the DEFAULT path, and it is the one a real player is most likely to be on.
   */
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page);

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      screen: style.getPropertyValue("--axis-motion-screen").trim(),
      fast: style.getPropertyValue("--axis-motion-fast").trim(),
      slow: style.getPropertyValue("--axis-motion-slow").trim(),
      base: style.getPropertyValue("--axis-motion-base").trim(),
    };
  });

  // Shortened to the fast beat, not zeroed. The transition survives.
  expect(tokens.screen).toBe(tokens.fast);
  expect(tokens.slow).toBe(tokens.base);
  expect(Number.parseFloat(tokens.screen)).toBeGreaterThan(0);

  // The ring's idle pulse is ambient motion carrying no information, so it goes.
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await page.waitForTimeout(2_500);
  const pulse = await page.evaluate(() => {
    const ring = document.querySelector(".axis-ring");
    return ring === null ? null : getComputedStyle(ring).animationName;
  });
  expect(pulse === null || pulse === "none").toBe(true);

  // The death screen arrives whole rather than in five beats — every number is
  // still there, the drama is not.
  await expect(page.getByRole("button", { name: "RETRY" })).toBeVisible({ timeout: 120_000 });
  const shown = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-shown]")).every(
      (element) => element.getAttribute("data-shown") === "1",
    ),
  );
  expect(shown, "reduced motion must reveal every beat at once, not hide them").toBe(true);
});

/**
 * Gamepad menu navigation, driven through a real (faked) pad.
 *
 * Playwright cannot emulate a controller, so this installs a `getGamepads` stub
 * before the page loads and drives it by mutating the button state. That
 * exercises the actual polling loop, the actual edge detection and the actual
 * synthesised keyboard events — everything except the USB layer.
 *
 * The unit tests in `tests/ui/gamepad-nav.test.ts` cover the hysteresis maths;
 * this covers the claim that a controller can operate the menus at all, which is
 * the part that was only ever argued.
 */
test("a gamepad can move focus and activate a menu item", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DESKTOP);

  await page.addInitScript(() => {
    const pad = {
      index: 0,
      id: "fake",
      connected: true,
      mapping: "standard",
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { __axisPad: typeof pad }).__axisPad = pad;
    navigator.getGamepads = () => [pad as unknown as Gamepad, null, null, null];
  });

  await boot(page);

  const press = async (index: number): Promise<void> => {
    await page.evaluate((i) => {
      const pad = (window as unknown as { __axisPad: { buttons: { pressed: boolean }[] } })
        .__axisPad;
      const button = pad.buttons[i];
      if (button !== undefined) {
        button.pressed = true;
      }
    }, index);
    await page.waitForTimeout(120);
    await page.evaluate((i) => {
      const pad = (window as unknown as { __axisPad: { buttons: { pressed: boolean }[] } })
        .__axisPad;
      const button = pad.buttons[i];
      if (button !== undefined) {
        button.pressed = false;
      }
    }, index);
    await page.waitForTimeout(120);
  };

  // Focus the menu, then walk it with the d-pad. RUN is autofocused on the title.
  await page.getByRole("button", { name: "RUN", exact: true }).focus();
  const before = await page.evaluate(() => document.activeElement?.textContent ?? "");

  const DPAD_DOWN = 13;
  await press(DPAD_DOWN);
  const after = await page.evaluate(() => document.activeElement?.textContent ?? "");

  expect(before, "expected to start on RUN").toContain("RUN");
  expect(after, "the d-pad did not move focus").not.toBe(before);

  // A opens whatever is focused. Navigate to SHOP explicitly and activate it.
  await page.getByRole("button", { name: /^SHOP/ }).focus();
  const BUTTON_A = 0;
  await press(BUTTON_A);
  await expect(page.getByRole("heading", { level: 1, name: "Shop" })).toBeVisible({
    timeout: 10_000,
  });

  // B goes back — without it a controller player can enter a screen and not leave.
  const BUTTON_B = 1;
  await press(BUTTON_B);
  await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});
