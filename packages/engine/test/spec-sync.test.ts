/**
 * ROADMAP M0-04: `game-module.ts`, `client-module.ts` and `scenario.ts` match SPEC §9.3, §9.4
 * and §14 exactly. These tests pull the TypeScript blocks straight out of docs/SPEC.md and fail
 * if any declaration is missing from, or differs in, the source (the comparison ignores `//`
 * comments and whitespace only).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

const SPEC = read("docs/SPEC.md");
const TS_BLOCKS = [...SPEC.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((m) => m[1] as string);

const specBlock = (marker: string): string => {
  const block = TS_BLOCKS.find((b) => b.includes(marker));
  if (block === undefined) throw new Error(`SPEC.md has no ts block containing ${marker}`);
  return block;
};

/** Removes `//` line comments and collapses all whitespace. */
const canonical = (code: string): string =>
  code
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** Splits a block into its top-level `export …` declarations. */
const declarations = (block: string): string[] =>
  canonical(block)
    .split(/(?=\bexport (?:type|interface) )/)
    .map((d) => d.trim())
    .filter((d) => d.startsWith("export "));

describe.each([
  [
    "SPEC §9.3 game module API",
    "export interface GameManifest",
    "packages/engine/src/game-module.ts",
    14,
  ],
  [
    "SPEC §9.4 client module API",
    "export interface GameClientModule",
    "packages/engine/src/client-module.ts",
    5,
  ],
  ["SPEC §14 scenario API", "export interface ScenarioCtx", "packages/engine/src/scenario.ts", 3],
])("%s is copied exactly", (_name, marker, file, count) => {
  const decls = declarations(specBlock(marker));
  const source = canonical(read(file));

  it(`finds the ${count} declarations in the spec block`, () => {
    expect(decls).toHaveLength(count);
  });

  it.each(decls.map((d) => [d.slice(0, 40), d]))("%s…", (_label, decl) => {
    expect(source).toContain(decl);
  });
});

describe("the spec's imports are honoured", () => {
  it("game-module.ts imports the ids and Rng from @sg/shared exactly as SPEC §9.3 does", () => {
    const specImport = canonical(specBlock("export interface GameManifest").split("\n")[0] ?? "");
    expect(specImport).toBe(
      'import type { Rng, PlayerId, TeamId, AudId, GameId } from "@sg/shared";',
    );
    expect(canonical(read("packages/engine/src/game-module.ts"))).toContain(specImport);
  });
});
