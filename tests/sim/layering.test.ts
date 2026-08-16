import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

/**
 * The layering law is only worth writing down if it fails the build. This test
 * proves it does — see docs/ARCHITECTURE.md §2a and §5.
 *
 * Each case is linted through ESLint's Node API with a VIRTUAL file path inside
 * src/game/sim/. Nothing is written to disk, so `npm run lint` never sees a
 * deliberately-illegal file; only this test does.
 */

const eslint = new ESLint({ cwd: process.cwd() });

/** Lints `code` as if it lived at `filePath`, and returns every rule id it tripped. */
async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath, warnIgnored: false });
  return results
    .flatMap((result) => result.messages)
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null);
}

const SIM_FILE = "src/game/sim/__layering_fixture__.ts";
const UI_FILE = "src/ui/__layering_fixture__.ts";
const CONFIG_FILE = "src/game/config/__layering_fixture__.ts";

describe("layering law: src/game/sim/ is headless and deterministic", () => {
  const forbidden: ReadonlyArray<readonly [label: string, code: string]> = [
    ["three", `import * as THREE from "three";\nexport const a = THREE;\n`],
    ["react", `import { useState } from "react";\nexport const a = useState;\n`],
    ["react-dom", `import { createPortal } from "react-dom";\nexport const a = createPortal;\n`],
    [
      "@react-three/fiber",
      `import { useFrame } from "@react-three/fiber";\nexport const a = useFrame;\n`,
    ],
    [
      "@react-three/rapier",
      `import { RigidBody } from "@react-three/rapier";\nexport const a = RigidBody;\n`,
    ],
    ["zustand", `import { create } from "zustand";\nexport const a = create;\n`],
    ["next", `import Link from "next/link";\nexport const a = Link;\n`],
    ["the ui layer", `import { hud } from "@/ui/hud/meter";\nexport const a = hud;\n`],
    [
      "the render layer",
      `import { Tunnel } from "@/game/render/Tunnel";\nexport const a = Tunnel;\n`,
    ],
    [
      "the input layer",
      `import { intents } from "@/game/input/intent";\nexport const a = intents;\n`,
    ],
    [
      "a relative escape into render/",
      `import { x } from "../render/Tunnel";\nexport const a = x;\n`,
    ],
    ["a relative escape into meta/", `import { x } from "../meta/economy";\nexport const a = x;\n`],
  ];

  it.each(forbidden)("rejects importing %s", async (_label, code) => {
    const ruleIds = await ruleIdsFor(code, SIM_FILE);
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("rejects dynamic import()", async () => {
    const ruleIds = await ruleIdsFor(
      `export async function load() {\n  return import("three");\n}\n`,
      SIM_FILE,
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("rejects require()", async () => {
    const ruleIds = await ruleIdsFor(
      `declare function require(id: string): unknown;\nexport const three = require("three");\n`,
      SIM_FILE,
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("rejects Math.random(), Date.now() and performance.now()", async () => {
    for (const expression of ["Math.random()", "Date.now()", "performance.now()"]) {
      const ruleIds = await ruleIdsFor(`export const a = ${expression};\n`, SIM_FILE);
      expect(ruleIds, `${expression} should be banned in sim/`).toContain(
        "no-restricted-properties",
      );
    }
  });

  it("rejects DOM globals", async () => {
    const ruleIds = await ruleIdsFor(`export const a = window.innerWidth;\n`, SIM_FILE);
    expect(ruleIds).toContain("no-restricted-globals");
  });

  // The rule has to be targeted, not a blanket ban, or it will be disabled the
  // first time it gets in the way.
  it("ALLOWS importing the config layer", async () => {
    const ruleIds = await ruleIdsFor(
      `import { TUNING } from "@/game/config/tuning";\nexport const a = TUNING.sim.tickRate;\n`,
      SIM_FILE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("ALLOWS a relative import into config/", async () => {
    const ruleIds = await ruleIdsFor(
      `import { TUNING } from "../config/tuning";\nexport const a = TUNING.sim.tickRate;\n`,
      SIM_FILE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("ALLOWS a sibling import inside sim/", async () => {
    const ruleIds = await ruleIdsFor(
      `import { nextFloat } from "./rng";\nexport const a = nextFloat;\n`,
      SIM_FILE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });
});

describe("layering law: src/ui/ is DOM only", () => {
  it("rejects importing three from the UI layer", async () => {
    const ruleIds = await ruleIdsFor(
      `import * as THREE from "three";\nexport const a = THREE;\n`,
      UI_FILE,
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("ALLOWS importing react from the UI layer", async () => {
    const ruleIds = await ruleIdsFor(
      `import { useState } from "react";\nexport const a = useState;\n`,
      UI_FILE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });
});

describe("layering law: src/game/config/ is leaf data", () => {
  it("rejects any non-relative import from the config layer", async () => {
    const ruleIds = await ruleIdsFor(
      `import { TUNING } from "@/game/config/tuning";\nexport const a = TUNING;\n`,
      CONFIG_FILE,
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("ALLOWS a relative sibling import inside config/", async () => {
    const ruleIds = await ruleIdsFor(
      `import { ENTITIES } from "./entities";\nexport const a = ENTITIES;\n`,
      CONFIG_FILE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });
});
