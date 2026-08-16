import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Playwright covers the things only a real browser can answer: that the app boots,
 * and — from P05 onward — the draw-call and frame budgets in docs/TUNING.md §14.
 *
 * Two viewport projects because the budgets differ: < 100 draw calls desktop,
 * < 50 mobile. Wiring both now means P05 does not have to retrofit the mobile gate.
 *
 * Not part of the GitHub Actions workflow — browser downloads would dominate CI
 * time for a scaffold. Run locally with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],

  webServer: {
    command: "npm run build && npm run start",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
