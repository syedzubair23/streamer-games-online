/**
 * ROADMAP M0-02: `protocol.ts` and `room.ts` are "copied exactly from SPEC §7 and §9.6" (and
 * `content.ts` carries SPEC §12's `PackKind` / `Pack<T>`). These tests pull the TypeScript
 * blocks straight out of docs/SPEC.md and fail if any declaration in them is missing from, or
 * differs in, the source (comparison ignores comments and whitespace only).
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
  ["SPEC §7 RoomConfig", "export interface RoomConfig", "packages/shared/src/room.ts", 4],
  ["SPEC §9.6 protocol", "export type C2S", "packages/shared/src/protocol.ts", 6],
  ["SPEC §12 content packs", "export type PackKind", "packages/shared/src/content.ts", 2],
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
