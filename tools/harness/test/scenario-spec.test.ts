import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gameTarget, isKnownGame, LAUNCH_GAMES } from "../src/games.ts";
import { buildManifest, emitManifest, loadRegistry } from "../src/scenarios/manifest.ts";
import {
  missingNumberedTests,
  parseAnim,
  parseGameSpec,
  parsePerfScript,
  parseScenarioTable,
  section,
} from "../src/scenarios/spec.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("game spec parsing", () => {
  it("parses every launch spec's Scenarios table, perf script, rules and test cases", () => {
    const specs = readdirSync(join(ROOT, "docs/specs")).filter((f) => f.endsWith(".md"));
    expect(specs.length).toBe(8);
    for (const f of specs) {
      const spec = parseGameSpec(read(`docs/specs/${f}`));
      expect(spec.scenarios.length, f).toBeGreaterThanOrEqual(6);
      expect(spec.scenarios.some((s) => s.roles.includes("stage")), f).toBe(true);
      expect(spec.perfScript.length, `${f} perf script`).toBeGreaterThan(0);
      expect(spec.rules.length, `${f} rules`).toBeGreaterThan(0);
      expect(spec.tests.length, `${f} tests`).toBeGreaterThan(0);
      expect(spec.builderNotes, `${f} builder notes`).not.toBeNull();
    }
  });

  it("reads quip-clash exactly", () => {
    const spec = parseGameSpec(read("docs/specs/quip-clash.md"));
    expect(spec.scenarios.map((s) => s.id)).toEqual([
      "intro", "answering", "reveal", "voting", "results", "quipout", "jinx", "last-quip", "final", "review-wait", "round-predict",
    ]);
    expect(spec.scenarios.find((s) => s.id === "voting")).toMatchObject({ roles: ["stage", "player", "audience"], anim: { name: "hearts", durationMs: 1500 } });
    expect(spec.scenarios.find((s) => s.id === "intro")?.anim).toBeNull();
    expect(spec.perfScript).toEqual(["reveal", "hearts", "results", "quipout"]);
    expect(spec.rules).toContain("R3a");
    expect(spec.rules).toContain("R8");
    expect(spec.tests).toContain("T16");
  });

  it("expands repeats in a perf script and keeps only table anims", () => {
    const spec = parseGameSpec(read("docs/specs/chess.md"));
    expect(spec.perfScript.slice(0, 4)).toEqual(["slide", "slide", "slide", "slide"]);
    const scenarios = parseScenarioTable(read("tools/harness/fixtures/tictactoe.md"));
    expect(parsePerfScript("**Perf script:** `place`, then zoom, then `win` ×2.", scenarios)).toEqual(["place", "win", "win"]);
    expect(parsePerfScript("no script here", scenarios)).toEqual([]);
  });

  it("parses anim cells and rejects malformed tables", () => {
    expect(parseAnim("`plane` 600 ms")).toEqual({ name: "plane", durationMs: 600 });
    expect(parseAnim("`win` 2 s")).toEqual({ name: "win", durationMs: 2000 });
    expect(parseAnim("—")).toBeNull();
    expect(parseAnim("")).toBeNull();
    expect(() => parseAnim("sometimes")).toThrow(/cannot parse anim/);
    const table = (rows: string) => `## Scenarios\n| id | roles | description |\n|---|---|---|\n${rows}\n`;
    expect(() => parseScenarioTable("# x")).toThrow(/no ## Scenarios/);
    expect(() => parseScenarioTable("## Scenarios\n| a | b |\n|---|---|\n| x | y |")).toThrow(/needs id, roles/);
    expect(() => parseScenarioTable(table("| Bad Id | stage | d |"))).toThrow(/bad scenario id/);
    expect(() => parseScenarioTable(table("| a | wizard | d |"))).toThrow(/unknown role/);
    expect(() => parseScenarioTable(table("| a |  | d |"))).toThrow(/no roles/);
    expect(() => parseScenarioTable(table("| a | stage | d |\n| a | stage | d |"))).toThrow(/listed twice/);
    expect(() => parseScenarioTable("## Scenarios\n| id | roles | description |\n|---|---|---|\n")).toThrow(/no rows/);
    expect(section("## A\nx\n### sub\ny\n## B\nz", "a")).toBe("x\n### sub\ny");
    expect(parseGameSpec(table("| a | stage | d |")).builderNotes).toBeNull();
  });

  it("finds rule and test ids without a numbered test (DOD G3)", () => {
    expect(missingNumberedTests(["R1", "R2", "T1", "R3a"], ["logic > R1: seats", "T1: assignment", "xR2: no", "R3a: predict"])).toEqual(["R2"]);
  });
});

describe("game targets and the scenario manifest", () => {
  it("resolves the fixture and the launch games", () => {
    expect(isKnownGame("tictactoe")).toBe(true);
    expect(isKnownGame("pong")).toBe(false);
    expect(() => gameTarget(ROOT, "pong")).toThrow(/unknown game/);
    const t = gameTarget(ROOT, "tictactoe");
    expect(t).toMatchObject({ fixture: true, pkgDir: "packages/engine", spec: "tools/harness/fixtures/tictactoe.md" });
    expect(t.tests.G11).toBeNull();
    for (const id of LAUNCH_GAMES) {
      const g = gameTarget(ROOT, id);
      expect(g.spec).toBe(`docs/specs/${id}.md`);
      expect(g.chunkLimitsKB.stage).toBe(id === "marble-rally" ? 70 : 60);
      // No launch game has its test files yet at M0-05: the gates then fail, never pass by omission.
      expect(g.tests.G3 === null || g.tests.G3.files[0]!.endsWith("logic.test.ts")).toBe(true);
    }
  });

  it("emits artifacts/scenarios/tictactoe.json joining the registry with the spec", async () => {
    const t = gameTarget(ROOT, "tictactoe");
    const reg = await loadRegistry(ROOT, t);
    expect(reg.map((r) => r.id)).toEqual(["intro", "midgame", "win", "draw"]);
    const m = await emitManifest(ROOT, t);
    expect(m.problems).toEqual([]);
    expect(m.perfScript).toEqual(["place", "win"]);
    expect(m.scenarios.find((s) => s.id === "midgame")).toMatchObject({ roles: ["stage", "player", "audience"], anim: { name: "place", durationMs: 320 }, inSpec: true, registered: true });
    expect(JSON.parse(read("artifacts/scenarios/tictactoe.json"))).toEqual(m);
  });

  it("reports unregistered scenarios, anim mismatches, extras and perf anims without a scenario", () => {
    const spec = parseGameSpec(
      "## Scenarios\n| id | roles | description | what | anim |\n|---|---|---|---|---|\n| a | stage | A | x | `pop` 200 ms |\n| b | player | B | y | — |\n| c | stage | C | z | `spin` 300 ms |\n\n**Perf script:** `pop`, then `spin`.\n",
    );
    const m = buildManifest({ id: "g", spec: "s.md" }, spec, [
      { id: "a", description: "A", anim: { name: "pop", durationMs: 250 } },
      { id: "b", description: "B", anim: null },
      { id: "extra", description: "E", anim: null },
    ]);
    expect(m.problems).toEqual([
      'scenario "a": spec anim is pop 200 ms, registered anim is pop 250 ms',
      'scenario "c" is in the spec but not registered in scenarios.ts',
      'perf script anim "spin" has no registered scenario',
    ]);
    expect(m.notes).toEqual(['scenario "extra" is registered but not in the spec table (not screenshotted)']);
    expect(m.scenarios.find((s) => s.id === "extra")).toMatchObject({ inSpec: false, roles: [] });
  });

  it("refuses a module without the registry export or with a malformed entry", async () => {
    const t = gameTarget(ROOT, "tictactoe");
    await expect(loadRegistry(ROOT, { ...t, scenarios: { ...t.scenarios, export: "nope" } })).rejects.toThrow(/does not export/);
    await expect(
      loadRegistry(ROOT, { ...t, scenarios: { module: "tools/harness/test/fixtures/bad-registry.ts", export: "noBuild" } }),
    ).rejects.toThrow(/has no build/);
    await expect(
      loadRegistry(ROOT, { ...t, scenarios: { module: "tools/harness/test/fixtures/bad-registry.ts", export: "wrongId" } }),
    ).rejects.toThrow(/has id "y"/);
  });
});
