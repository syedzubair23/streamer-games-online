/**
 * Fixture tests for the architecture and determinism lint rules in `eslint.config.js`
 * (ROADMAP M0-01 Accept, DOD P2/G2). Each case lints a snippet as if it lived at a given
 * repo path, so no violating file ever exists in the tree.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function lint(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  if (!result) throw new Error(`no lint result for ${filePath}`);
  return result.messages;
}

function errors(messages: Linter.LintMessage[]): Linter.LintMessage[] {
  return messages.filter((m) => m.severity === 2);
}

function ruleIds(messages: Linter.LintMessage[]): string[] {
  return errors(messages).map((m) => m.ruleId ?? "(fatal)");
}

async function expectClean(filePath: string, code: string): Promise<void> {
  const messages = await lint(filePath, code);
  expect(errors(messages), JSON.stringify(messages, null, 2)).toEqual([]);
}

async function expectRule(filePath: string, code: string, ruleId: string): Promise<void> {
  const messages = await lint(filePath, code);
  expect(ruleIds(messages), JSON.stringify(messages, null, 2)).toContain(ruleId);
}

const LOGIC = "packages/games/x/src/logic/index.ts";

describe("determinism in **/logic/**", () => {
  it("rejects a deliberate Math.random() in packages/games/x/src/logic/", async () => {
    await expectRule(
      LOGIC,
      "export const roll = (): number => Math.floor(Math.random() * 6) + 1;\n",
      "no-restricted-properties",
    );
  });

  it("rejects Date in every form", async () => {
    await expectRule(LOGIC, "export const t = Date.now();\n", "no-restricted-globals");
    await expectRule(LOGIC, "export const d = new Date();\n", "no-restricted-syntax");
    await expectRule(LOGIC, "export const d = globalThis.Date;\n", "no-restricted-properties");
  });

  it("rejects wall clocks, timers and platform globals", async () => {
    await expectRule(LOGIC, "export const t = performance.now();\n", "no-restricted-globals");
    await expectRule(LOGIC, "setTimeout(() => undefined, 5);\n", "no-restricted-globals");
    await expectRule(
      LOGIC,
      "export const b = crypto.getRandomValues(new Uint8Array(4));\n",
      "no-restricted-globals",
    );
    await expectRule(LOGIC, "export const w = window.innerWidth;\n", "no-restricted-globals");
  });

  it("rejects three, render/ui/audio, the DOM and node built-ins", async () => {
    await expectRule(
      LOGIC,
      'import { Vector3 } from "three";\nexport const v = new Vector3();\n',
      "no-restricted-imports",
    );
    await expectRule(LOGIC, 'export { } from "@sg/render";\n', "no-restricted-imports");
    await expectRule(LOGIC, 'export { } from "@sg/ui";\n', "no-restricted-imports");
    await expectRule(LOGIC, 'export { } from "@sg/audio";\n', "no-restricted-imports");
    await expectRule(LOGIC, 'export { h } from "preact";\n', "no-restricted-imports");
    await expectRule(LOGIC, 'export { readFileSync } from "node:fs";\n', "no-restricted-imports");
  });

  it("applies to any logic folder, not only games", async () => {
    await expectRule(
      "packages/engine/src/logic/helper.ts",
      "export const r = Math.random();\n",
      "no-restricted-properties",
    );
  });

  it("allows deterministic code that uses the injected rng and clock", async () => {
    await expectClean(
      LOGIC,
      [
        'import type { Rng } from "@sg/shared";',
        "export interface Ctx { rng: Rng; now: number }",
        "export const deadline = (ctx: Ctx, ms: number): number => ctx.now + ms;",
        "export const floor = (n: number): number => Math.floor(n);",
        "",
      ].join("\n"),
    );
  });

  it("does not ban Math.random outside logic", async () => {
    await expectClean(
      "packages/render/src/fx/sparkle.ts",
      "export const jitter = Math.random();\n",
    );
  });
});

describe("no game imports another game", () => {
  it("rejects a package import of another game from game logic", async () => {
    await expectRule(LOGIC, 'export { GAME_ID } from "@sg/game-chess";\n', "no-restricted-imports");
  });

  it("rejects a subpath import of another game from a game client", async () => {
    await expectRule(
      "packages/games/ludo/src/client/stage.ts",
      'export { GAME_ID } from "@sg/game-chess/logic";\n',
      "no-restricted-imports",
    );
  });

  it("rejects a relative import into another game (boundaries)", async () => {
    await expectRule(
      "packages/games/ludo/src/bot.ts",
      'export { GAME_ID } from "../../chess/src/index.ts";\n',
      "boundaries/dependencies",
    );
  });

  it("allows a game to import its own files", async () => {
    await expectClean(
      "packages/games/ludo/src/client/stage.ts",
      'export { GAME_ID } from "../index.ts";\n',
    );
  });

  it("rejects game logic importing its own client code", async () => {
    await expectRule(
      "packages/games/chess/src/logic/rules.ts",
      'export * from "../client/stage.ts";\n',
      "no-restricted-imports",
    );
  });
});

describe("package boundaries (SPEC §9.2)", () => {
  it("rejects engine reaching into render", async () => {
    await expectRule(
      "packages/engine/src/runner.ts",
      'export * from "../../render/src/index.ts";\n',
      "boundaries/dependencies",
    );
  });

  it("rejects shared depending on engine", async () => {
    await expectRule(
      "packages/shared/src/rng.ts",
      'export * from "../../engine/src/index.ts";\n',
      "boundaries/dependencies",
    );
  });

  it("allows engine to depend on shared", async () => {
    await expectClean(
      "packages/engine/src/runner.ts",
      'export * from "../../shared/src/index.ts";\n',
    );
  });

  it("rejects kit packages depending on each other", async () => {
    await expectRule(
      "packages/ui/src/index.ts",
      'export * from "../../render/src/index.ts";\n',
      "boundaries/dependencies",
    );
    await expectRule(
      "packages/render/src/index.ts",
      'export * from "../../audio/src/index.ts";\n',
      "boundaries/dependencies",
    );
  });

  it("allows kit packages to depend on shared", async () => {
    await expectClean("packages/ui/src/index.ts", 'export * from "../../shared/src/index.ts";\n');
  });

  it("rejects the server importing a client entry", async () => {
    await expectRule(
      "apps/server/src/games.ts",
      'export * from "@sg/game-chess/client";\n',
      "no-restricted-imports",
    );
    await expectRule(
      "apps/server/src/games.ts",
      'export * from "../../../packages/render/src/index.ts";\n',
      "boundaries/dependencies",
    );
  });

  it("allows the server to import a game's package entry", async () => {
    await expectClean(
      "apps/server/src/games.ts",
      'export { GAME_ID } from "../../../packages/games/chess/src/index.ts";\n',
    );
  });
});

describe("three.js hygiene", () => {
  it("rejects `import * as THREE` everywhere", async () => {
    for (const file of [
      "packages/render/src/renderer.ts",
      "packages/games/ludo/src/client/stage.ts",
      "apps/client/src/dev/scenario.ts",
    ]) {
      await expectRule(
        file,
        'import * as THREE from "three";\nexport { THREE };\n',
        "no-restricted-syntax",
      );
    }
  });

  it("allows named imports from three in render and game clients", async () => {
    await expectClean(
      "packages/games/ludo/src/client/stage.ts",
      'import { Group } from "three";\nexport const root = new Group();\n',
    );
  });

  it("rejects banned three features", async () => {
    await expectRule(
      "packages/render/src/materials/toon.ts",
      'export { MeshStandardMaterial } from "three";\n',
      "no-restricted-imports",
    );
    await expectRule(
      "packages/render/src/renderer.ts",
      'export { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";\n',
      "no-restricted-imports",
    );
  });

  it("rejects direct material construction outside @sg/render", async () => {
    await expectRule(
      "packages/games/ludo/src/client/stage.ts",
      'import { MeshBasicMaterial } from "three";\nexport const m = new MeshBasicMaterial();\n',
      "no-restricted-syntax",
    );
  });

  it("allows material construction inside @sg/render", async () => {
    await expectClean(
      "packages/render/src/materials/basic.ts",
      'import { MeshBasicMaterial } from "three";\nexport const m = new MeshBasicMaterial();\n',
    );
  });
});

describe("games never own a render loop", () => {
  it("rejects raw requestAnimationFrame in a game client", async () => {
    await expectRule(
      "packages/games/ludo/src/client/stage.ts",
      "export const id = requestAnimationFrame(() => undefined);\n",
      "no-restricted-globals",
    );
    await expectRule(
      "packages/games/ludo/src/client/stage.ts",
      "export const id = window.requestAnimationFrame(() => undefined);\n",
      "no-restricted-properties",
    );
  });

  it("allows the platform render loop to use requestAnimationFrame", async () => {
    await expectClean(
      "packages/render/src/loop.ts",
      "export const id = requestAnimationFrame(() => undefined);\n",
    );
  });
});

describe("tokens only in games/*/src/client/**", () => {
  const CLIENT = "packages/games/quip-clash/src/client/stage.ts";

  it.each([
    ['export const c = "#ff8800";', "hex string"],
    ['export const c = "#FFF";', "short hex"],
    ["export const c = 0xff8800;", "hex number"],
    ['export const c = "rgb(255, 136, 0)";', "rgb()"],
    ['export const c = "hsl(30 100% 50%)";', "hsl()"],
    ['export const d = "300ms";', "ms duration"],
    ['export const d = "2.5s";', "s duration"],
    ['export const t = "opacity 300ms ease-out";', "transition shorthand"],
    ["export const t = `transform 1s ${String(2)}`;", "template duration"],
    ["setTimeout(() => undefined, 400);", "timer literal"],
  ])("rejects %s (%s)", async (code) => {
    await expectRule(CLIENT, `${code}\n`, "no-restricted-syntax");
  });

  it("allows ordinary strings and numbers", async () => {
    await expectClean(
      CLIENT,
      'export const label = "Round 3 of 5";\nexport const id = "#room";\nexport const n = 42;\nexport const scale = 0.5;\n',
    );
  });

  it("allows literals where tokens are defined (@sg/ui)", async () => {
    await expectClean(
      "packages/ui/src/tokens.ts",
      'export const amber = "#f2a541";\nexport const fast = "180ms";\n',
    );
  });
});

describe("phone entries stay free of three", () => {
  it("rejects a static three or @sg/render import from controller.tsx", async () => {
    const file = "packages/games/chess/src/client/controller.tsx";
    await expectRule(file, 'export { Group } from "three";\n', "no-restricted-imports");
    await expectRule(file, 'export * from "@sg/render";\n', "no-restricted-imports");
    await expectRule(file, 'export * from "./stage.ts";\n', "no-restricted-imports");
  });

  it("allows type-only imports and dynamic import() from controller.tsx", async () => {
    await expectClean(
      "packages/games/chess/src/client/controller.tsx",
      'import type { Group } from "three";\nexport type G = Group;\nexport const load = () => import("three");\n',
    );
  });
});

describe("hygiene", () => {
  it("rejects an eslint-disable without a -- reason", async () => {
    await expectRule(
      "packages/shared/src/util.ts",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const x: any = 1;\n",
      "@eslint-community/eslint-comments/require-description",
    );
  });

  it("accepts an eslint-disable with a -- reason", async () => {
    await expectClean(
      "packages/shared/src/util.ts",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture for the lint test\nexport const x: any = 1;\n",
    );
  });

  it("rejects banned frameworks", async () => {
    await expectRule("apps/client/src/app.ts", 'export * from "react";\n', "no-restricted-imports");
    await expectRule(
      "apps/server/src/bin.ts",
      'export * from "socket.io";\n',
      "no-restricted-imports",
    );
  });
});

describe("pnpm lint integration", () => {
  it("the eslint CLI exits non-zero for Math.random() in packages/games/x/src/logic/", () => {
    const run = (): string =>
      execFileSync(
        process.execPath,
        [
          resolve(ROOT, "node_modules/eslint/bin/eslint.js"),
          "--max-warnings",
          "0",
          "--stdin",
          "--stdin-filename",
          LOGIC,
        ],
        { cwd: ROOT, input: "export const r = Math.random();\n", encoding: "utf8", stdio: "pipe" },
      );
    let failure: { status: number | null; stdout: string } | undefined;
    try {
      run();
    } catch (error) {
      failure = error as { status: number | null; stdout: string };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stdout).toContain("no-restricted-properties");
  });
});
