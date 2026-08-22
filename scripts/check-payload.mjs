/**
 * The first-playable-frame payload budget.
 *
 *   npm run check:payload        (after `npm run build`)
 *
 * The brief: "Total initial download for first playable frame must be under 4MB.
 * Themes beyond the first load lazily."
 *
 * ## What counts, and why
 *
 * The first playable frame needs: the HTML for `/play`, every JS and CSS chunk
 * that route pulls, the three self-hosted fonts, and **the first theme's
 * geometry bundle**. It does not need the other three themes — those are fetched
 * by the preloader while the player is already running, which is the entire
 * point of the lazy path, and counting them would measure something nobody waits
 * for.
 *
 * Sizes are **gzipped**, because that is what crosses the wire. Reporting raw
 * bytes against a network budget overstates the cost by roughly 3x and would
 * make the number useless for the decision it exists to inform.
 *
 * ## Read from the prerendered HTML, not from a guess
 *
 * The first attempt walked `.next/app-build-manifest.json`, which is what the
 * webpack builder emits. **Turbopack does not write it** — Next 16 builds with
 * Turbopack here, and its `build-manifest.json` carries no per-route App Router
 * mapping at all, so the check reported "cannot measure" rather than a number.
 *
 * The prerendered `/play` HTML is the better source anyway: it is literally the
 * document the browser parses, and every `/_next/static/...` it references is
 * something the browser will fetch before the page is interactive. Measuring the
 * real output beats trusting a manifest about it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NEXT_DIR = path.join(ROOT, ".next");
const ROUTE = "/play";

const KB = 1024;
const MB = KB * KB;

function gzipBytes(file) {
  try {
    return gzipSync(readFileSync(file)).byteLength;
  } catch {
    return 0;
  }
}

/**
 * Every static asset the prerendered `/play` document references.
 *
 * Split into scripts/styles and fonts because they compress differently — woff2
 * is already Brotli-compressed internally, so gzipping it again is a no-op and
 * its raw size IS its wire size.
 */
function routeAssets() {
  const html = path.join(NEXT_DIR, "server", "app", `${ROUTE.replace(/^\//, "")}.html`);
  if (!existsSync(html)) {
    return null;
  }
  const source = readFileSync(html, "utf8");

  // The trailing backslash class catches references inside the inlined RSC
  // payload, where paths appear escaped. Without it the same chunk is counted
  // twice under two spellings.
  const matches = [...source.matchAll(/\/_next\/(static\/[^"'\\]+)/g)].map((match) => match[1]);

  const code = new Set();
  const fonts = new Set();
  for (const relative of matches) {
    if (relative.endsWith(".woff2") || relative.endsWith(".woff")) {
      fonts.add(relative);
    } else if (relative.endsWith(".js") || relative.endsWith(".css")) {
      code.add(relative);
    }
  }
  return { code: [...code], fonts: [...fonts] };
}

function main() {
  if (!existsSync(NEXT_DIR)) {
    console.error("No .next directory. Run `npm run build` first.");
    process.exitCode = 1;
    return;
  }

  const rows = [];
  let total = 0;

  const assets = routeAssets();
  if (assets === null) {
    console.error(`No prerendered ${ROUTE} HTML — cannot measure the route honestly.`);
    process.exitCode = 1;
    return;
  }

  let jsCss = 0;
  for (const relative of assets.code) {
    const full = path.join(NEXT_DIR, relative);
    if (existsSync(full)) {
      jsCss += gzipBytes(full);
    }
  }
  rows.push(["JS + CSS for /play", jsCss, `${assets.code.length} chunks, gzipped`]);
  total += jsCss;

  let fonts = 0;
  for (const relative of assets.fonts) {
    const full = path.join(NEXT_DIR, relative);
    if (existsSync(full)) {
      fonts += statSync(full).size;
    }
  }
  rows.push(["Fonts (woff2)", fonts, `${assets.fonts.length} files, already compressed`]);
  total += fonts;

  // The first theme only. The rest stream after the run has started.
  const manifestPath = path.join(ROOT, "public", "themes", "manifest.json");
  let firstTheme = 0;
  let themeNote = "not built";
  if (existsSync(manifestPath)) {
    const themes = JSON.parse(readFileSync(manifestPath, "utf8"));
    const slugs = Object.keys(themes.themes ?? {});
    const first = slugs[0];
    if (first !== undefined) {
      const file = themes.themes[first].files.desktop;
      const full = path.join(ROOT, "public", "themes", file.name);
      firstTheme = gzipBytes(full);
      themeNote = `${first} (${slugs.length - 1} more stream later)`;
    }
  }
  rows.push(["First theme geometry", firstTheme, themeNote]);
  total += firstTheme;

  const budget = 4 * MB;

  console.log("");
  console.log("=".repeat(72));
  console.log("AXIS — first playable frame payload (gzipped)");
  console.log("=".repeat(72));
  for (const [label, bytes, note] of rows) {
    console.log(`  ${label.padEnd(24)} ${(bytes / KB).toFixed(1).padStart(9)} KB   ${note}`);
  }
  console.log("  " + "-".repeat(68));
  console.log(
    `  ${"TOTAL".padEnd(24)} ${(total / KB).toFixed(1).padStart(9)} KB   ` +
      `budget ${(budget / MB).toFixed(0)}MB  (${((total / budget) * 100).toFixed(1)}% used)`,
  );
  console.log("=".repeat(72));
  console.log("");

  if (total > budget) {
    console.error(`Over budget by ${((total - budget) / KB).toFixed(1)} KB.`);
    process.exitCode = 1;
    return;
  }
  console.log("Within the 4MB first-frame budget.");
}

main();
