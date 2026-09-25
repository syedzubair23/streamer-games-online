/**
 * ROADMAP M1-06 Accept: **game code cannot construct any material directly** — a lint rule bans
 * `new Mesh*Material` (and every other `*Material`) outside `@sg/render` (SPEC §10, DOD P2/G2).
 *
 * Each case lints a snippet as if it lived at a repo path (no violating file ever exists), over
 * every place game code or its neighbours can live, and every way of spelling the construction.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function syntaxErrors(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  if (!result) throw new Error(`no lint result for ${filePath}`);
  return result.messages.filter((m) => m.severity === 2 && m.ruleId === "no-restricted-syntax");
}

/** Everywhere outside @sg/render: every game folder, apps, tools, other packages, root tests. */
const OUTSIDE = [
  "packages/games/ludo/src/client/stage.ts",
  "packages/games/ludo/src/client/controller.tsx",
  "packages/games/ludo/src/client/pieces/token.ts",
  "packages/games/ludo/src/logic/index.ts",
  "packages/games/ludo/src/bot.ts",
  "packages/games/ludo/src/scenarios.ts",
  "packages/games/ludo/src/index.ts",
  "packages/games/ludo/test/stage.test.ts",
  "packages/games/ludo/vite.config.ts",
  "apps/client/src/stage/shell.ts",
  "apps/server/src/room.ts",
  "packages/engine/src/client-module.ts",
  "packages/ui/src/board.tsx",
  "packages/audio/src/index.ts",
  "packages/shared/src/index.ts",
  "tools/harness/src/scenarios/stage.ts",
  "tools/harness/screenshots.spec.ts",
  "test/some.test.ts",
];

/** Ways of constructing a material (every three.js material class ends in `Material`). */
const CONSTRUCTIONS: Record<string, string> = {
  "named Mesh*Material":
    'import { MeshToonMaterial } from "three";\nexport const m = new MeshToonMaterial();\n',
  "MeshBasicMaterial with options":
    'import { MeshBasicMaterial } from "three";\nexport const m = new MeshBasicMaterial({ transparent: true });\n',
  MeshLambertMaterial:
    'import { MeshLambertMaterial } from "three";\nexport const m = new MeshLambertMaterial();\n',
  MeshMatcapMaterial:
    'import { MeshMatcapMaterial } from "three";\nexport const m = new MeshMatcapMaterial();\n',
  ShaderMaterial:
    'import { ShaderMaterial } from "three";\nexport const m = new ShaderMaterial({});\n',
  RawShaderMaterial:
    'import { RawShaderMaterial } from "three";\nexport const m = new RawShaderMaterial({});\n',
  SpriteMaterial:
    'import { SpriteMaterial } from "three";\nexport const m = new SpriteMaterial();\n',
  PointsMaterial:
    'import { PointsMaterial } from "three";\nexport const m = new PointsMaterial();\n',
  LineBasicMaterial:
    'import { LineBasicMaterial } from "three";\nexport const m = new LineBasicMaterial();\n',
  "member expression":
    "declare const three: { MeshToonMaterial: new () => object };\nexport const m = new three.MeshToonMaterial();\n",
  "renamed import": 'import { MeshToonMaterial as Toon } from "three";\nexport const m = Toon;\n',
};

describe("direct material construction is banned outside @sg/render (M1-06 Accept)", () => {
  for (const path of OUTSIDE)
    it(`fires in ${path} for every construction`, async () => {
      for (const [label, code] of Object.entries(CONSTRUCTIONS)) {
        const errors = await syntaxErrors(path, code);
        expect(errors.length, `${label} in ${path}`).toBeGreaterThan(0);
        expect(errors.map((e) => e.message).join("\n"), `${label} in ${path}`).toMatch(
          /@sg\/render material factories/,
        );
      }
    });

  it("a namespace import of three is rejected too (so `new THREE.XMaterial` cannot hide)", async () => {
    const errors = await syntaxErrors(
      "packages/games/ludo/src/client/stage.ts",
      'import * as THREE from "three";\nexport const m = new THREE.MeshToonMaterial();\n',
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("material factories and type-only material imports stay legal in game code", async () => {
    expect(
      await syntaxErrors(
        "packages/games/ludo/src/client/stage.ts",
        [
          'import type { Material, MeshToonMaterial } from "three";',
          "declare const ctx: { materials: { makeToon(): MeshToonMaterial } };",
          "export const m: Material = ctx.materials.makeToon();",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("@sg/render, the one factory, may construct materials", async () => {
    for (const path of [
      "packages/render/src/materials/toon.ts",
      "packages/render/src/materials/sky.ts",
      "packages/render/test/materials.test.ts",
    ])
      for (const [label, code] of Object.entries(CONSTRUCTIONS))
        expect(await syntaxErrors(path, code), `${label} in ${path}`).toEqual([]);
  });
});
