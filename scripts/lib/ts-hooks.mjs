/**
 * A module-resolution hook that lets build scripts import the real TypeScript
 * source instead of a copy of it.
 *
 * ## Why this exists
 *
 * `scripts/build-themes.mjs` needs every theme's prop list. It has three ways to
 * get it: duplicate the lists into the script, parse the TypeScript with a regex,
 * or import the actual registry. The first two are how a build script and a
 * runtime quietly disagree — and duplicated constants have already caused two
 * real bugs in this project (the `ThemeChange` payload at P11, the pickup kinds
 * at P13). So: import the real thing.
 *
 * Node 24 strips TypeScript types natively, so no transpiler is needed. What it
 * will not do is guess a file extension: the source uses extensionless
 * specifiers (`./bazaar`, `../tuning`) as TypeScript requires, and Node's ESM
 * resolver refuses them. This hook fills exactly that gap and nothing else.
 *
 * ## Deliberately minimal
 *
 * It resolves `./x` to `./x.ts`, then `./x/index.ts`, and resolves the `@/`
 * alias the same way `tsconfig.json` does. It does not transform, cache or
 * rewrite anything — Node does the type stripping. If this file ever needs to
 * understand TypeScript, the right answer is a real build step, not more code
 * here.
 *
 * Used as: `node --import ./scripts/lib/ts-register.mjs script.mjs`
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC = path.join(ROOT, "src");

/** The candidate files an extensionless specifier could mean, in TS's order. */
function candidates(base) {
  return [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
}

function firstExisting(base) {
  for (const candidate of candidates(base)) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // The `@/*` -> `./src/*` alias from tsconfig.json.
  if (specifier.startsWith("@/")) {
    const resolved = firstExisting(path.join(SRC, specifier.slice(2)));
    if (resolved !== null) {
      return { url: resolved, shortCircuit: true };
    }
  }

  // Extensionless relative specifiers, which is every internal import.
  if (specifier.startsWith(".") && path.extname(specifier) === "") {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : ROOT;
    const resolved = firstExisting(path.resolve(path.dirname(parentPath), specifier));
    if (resolved !== null) {
      return { url: resolved, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
