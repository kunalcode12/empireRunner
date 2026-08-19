/**
 * The three typefaces, self-hosted.
 *
 * ## Why these are committed files and not `next/font/google`
 *
 * P01 removed `next/font/google` for a recorded reason: it fetches at **build**
 * time, so a sandboxed CI runner with no egress fails `next build` for reasons
 * that have nothing to do with the code. `next/font/local` reads from disk, emits
 * a hashed URL, and inlines the `@font-face` rule with zero network at build or
 * at runtime. The cost is 77KB of binary in the repository; the benefit is that
 * the build gate depends on nothing outside it.
 *
 * All three are SIL OFL 1.1 — see `OFL.txt` beside them, which the licence
 * requires be distributed with the files.
 *
 * ## Why these three faces
 *
 * The default answer for an arcade UI is Orbitron or Rajdhani, and that is
 * exactly why they are not here. This is a **print** brief, not a sci-fi one.
 *
 *   Anton         An actual poster face — ultra-heavy, condensed, drawn for
 *                 one-colour screen-printed billboards. GAME_BIBLE §11.2 asks for
 *                 a "heavy condensed grotesque" and this is the canonical one.
 *   Martian Mono  Genuinely WIDE monospace, which is rarer than it sounds; most
 *                 "mono" faces are narrow. Tabular by construction, so an
 *                 odometer digit rolling 9 -> 0 cannot reflow the line.
 *   Archivo       A grotesque built for small high-contrast text. Sits under
 *                 Anton without competing with it.
 *
 * Martian Mono and Archivo are variable fonts — Google serves one file per
 * unicode range covering the whole weight axis, so all three weights of each cost
 * one download, not three.
 *
 * ## `display: "block"`, not `"swap"`
 *
 * Every numeral in this game is monospaced and tabular. Swapping in a fallback
 * would reflow the entire HUD mid-run when the real face arrives, and a score
 * that jumps sideways reads as a bug. A 100ms block on a 23KB file is the better
 * trade. Body text uses `swap`, where a reflow is harmless.
 */

import localFont from "next/font/local";

export const anton = localFont({
  src: "./fonts/anton-latin.woff2",
  weight: "400",
  style: "normal",
  display: "block",
  variable: "--font-anton",
  // Metric-matched to the closest ultra-condensed system face, so the pre-load
  // frame is not laid out at a wildly different width.
  fallback: ["Haettenschweiler", "Arial Narrow", "sans-serif"],
  adjustFontFallback: false,
});

export const martianMono = localFont({
  src: "./fonts/martian-mono-latin.woff2",
  // The variable file carries the whole axis; declaring the range lets the
  // browser synthesise nothing.
  weight: "100 800",
  style: "normal",
  display: "block",
  variable: "--font-martian",
  fallback: ["ui-monospace", "Cascadia Mono", "Consolas", "monospace"],
  adjustFontFallback: false,
});

export const archivo = localFont({
  src: "./fonts/archivo-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-archivo",
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
  adjustFontFallback: false,
});

/** The class list `<html>` needs for the `--font-*` variables to resolve. */
export const fontVariables = `${anton.variable} ${martianMono.variable} ${archivo.variable}`;
