import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameTarget } from "../src/games.ts";
import { matrixCounts } from "../src/matrix.ts";
import { emitManifest } from "../src/scenarios/manifest.ts";
import { parseGameSpec } from "../src/scenarios/spec.ts";
import {
  declaredPacks,
  gateG13,
  headCommit,
  nextRound,
  qualitySample,
  verifyGame,
  type VerifyDeps,
} from "../src/verify/game.ts";
import { isVisualItem, readItemSpec, verifyItem } from "../src/verify/item.ts";
import { checkOutputs } from "../src/verify/outputs.ts";
import {
  pwGate,
  readCoveragePct,
  readPlaywrightJson,
  readVitestJson,
} from "../src/verify/reports.ts";
import { formatCmd, spawnRunner, tailLines, type CommandRunner } from "../src/verify/run.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const tmp = (): string => mkdtempSync(join(tmpdir(), "sg-verify-"));
const write = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

describe("report readers", () => {
  it("reads Vitest JSON, coverage summaries and Playwright JSON", () => {
    const d = tmp();
    write(join(d, "v.json"), {
      testResults: [
        {
          name: "a.test.ts",
          status: "passed",
          assertionResults: [
            { fullName: "R1: seats", status: "passed" },
            { title: "skipped one", status: "skipped" },
          ],
        },
        {
          name: "b.test.ts",
          status: "failed",
          message: "boom",
          assertionResults: [{ fullName: "T2: x", status: "failed" }],
        },
      ],
    });
    expect(readVitestJson(join(d, "v.json"))).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      tests: [
        { name: "R1: seats", status: "passed" },
        { name: "skipped one", status: "skipped" },
        { name: "T2: x", status: "failed" },
      ],
      fileErrors: ["b.test.ts: boom"],
    });
    expect(readVitestJson(join(d, "missing.json"))).toBeNull();
    write(join(d, "bad.json"), "{nope");
    expect(readVitestJson(join(d, "bad.json"))).toBeNull();
    write(join(d, "arr.json"), "[]");
    expect(readVitestJson(join(d, "arr.json"))).toBeNull();

    write(join(d, "c.json"), { total: { lines: { pct: 91.5 }, branches: { pct: "Unknown" } } });
    expect(readCoveragePct(join(d, "c.json"), "lines")).toBe(91.5);
    expect(readCoveragePct(join(d, "c.json"), "branches")).toBeNull();
    expect(readCoveragePct(join(d, "none.json"), "lines")).toBeNull();
    expect(readCoveragePct(join(d, "bad.json"), "lines")).toBeNull();

    write(join(d, "pw.json"), {
      suites: [
        {
          file: "a.spec.ts",
          specs: [
            {
              title: "G7 stage: x.png",
              tests: [{ projectName: "swiftshader", status: "expected", results: [{}] }],
            },
          ],
          suites: [
            {
              specs: [
                {
                  title: "G7 clip: y",
                  tests: [
                    {
                      projectName: "swiftshader",
                      status: "unexpected",
                      results: [{ error: { message: "\u001b[31mboom\u001b[0m" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      errors: [{ message: "global" }],
    });
    const pw = readPlaywrightJson(join(d, "pw.json"))!;
    expect(pw.errors).toEqual(["global"]);
    expect(pw.tests).toEqual([
      { file: "a.spec.ts", title: "G7 stage: x.png", project: "swiftshader", status: "expected" },
      {
        file: "a.spec.ts",
        title: "G7 clip: y",
        project: "swiftshader",
        status: "unexpected",
        error: "boom",
      },
    ]);
    expect(pwGate(pw.tests, "G7 ")).toMatchObject({ total: 2, passed: 1, skipped: 0 });
    expect(readPlaywrightJson(join(d, "none.json"))).toBeNull();
    expect(readPlaywrightJson(join(d, "bad.json"))).toBeNull();
  });
});

describe("command runner", () => {
  it("runs commands, captures output and formats them", async () => {
    const script = join(tmp(), "exit3.mjs");
    write(script, "console.log('out'); console.error('err'); process.exit(3);");
    const r = await spawnRunner(process.execPath, [script], { cwd: ROOT });
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe("out");
    expect(tailLines(r)).toBe("out\nerr");
    const shell = await spawnRunner(`node -e "process.exit(0)"`, [], { cwd: ROOT, shell: true });
    expect(shell.code).toBe(0);
    const missing = await spawnRunner("definitely-not-a-command-sg", [], { cwd: ROOT });
    expect(missing.code).not.toBe(0);
    expect(formatCmd("pnpm", ["exec", "a b", "c"])).toBe('pnpm exec "a b" c');
    // arguments with spaces survive the Windows shell pnpm needs
    const echo = join(tmp(), "argv.mjs");
    write(echo, "console.log(JSON.stringify(process.argv.slice(2)));");
    const args = await spawnRunner(
      "pnpm",
      ["exec", "node", echo, "contract: tictactoe", 'say "hi"', "a&b"],
      { cwd: ROOT },
    );
    const lastLine = args.stdout.trim().split(/\r?\n/).pop()!;
    expect(JSON.parse(lastLine)).toEqual(["contract: tictactoe", 'say "hi"', "a&b"]);
  });
});

describe("verify-game helpers", () => {
  it("G13 checks Builder notes and the handoff length", () => {
    const t = gameTarget(ROOT, "tictactoe");
    const ok = gateG13(ROOT, t, parseGameSpec(readFileSync(join(ROOT, t.spec), "utf8")));
    expect(ok).toMatchObject({ ok: true, notesLines: 1 });
    const root = tmp();
    const game = gameTarget(root, "ludo");
    const spec = {
      scenarios: [],
      perfScript: [],
      rules: [],
      tests: [],
      builderNotes: Array.from({ length: 21 }, () => "x"),
    };
    expect(gateG13(root, game, spec).note).toMatch(
      /21 lines \(max 20\).*handoff\/ludo\.md is missing/,
    );
    write(
      join(root, "artifacts/handoff/ludo.md"),
      Array.from({ length: 41 }, () => "l").join("\n"),
    );
    expect(gateG13(root, game, { ...spec, builderNotes: null }).note).toMatch(
      /no "## Builder notes".*41 lines/,
    );
  });

  it("finds declared packs, reads quality samples and the next critic round", () => {
    const root = tmp();
    write(join(root, "content/packs/prompts/quip-core.json"), "{}");
    expect(
      declaredPacks(
        root,
        "## Content\nThe packs are `quip-core` and `quip-spicy`.\n## Builder notes\n",
      ),
    ).toEqual(["quip-core"]);
    expect(declaredPacks(tmp(), "## Content\n`x`")).toEqual([]);
    write(join(root, "q1.json"), { scores: [4, 5, 3] });
    write(join(root, "q2.json"), { items: [{ score: 2 }, { score: 5 }, { nope: 1 }] });
    write(join(root, "q3.json"), { scores: [] });
    expect(qualitySample(join(root, "q1.json"))).toEqual({ mean: 4, min: 3, n: 3 });
    expect(qualitySample(join(root, "q2.json"))).toEqual({ mean: 3.5, min: 2, n: 2 });
    expect(qualitySample(join(root, "q3.json"))).toBeNull();
    expect(qualitySample(join(root, "none.json"))).toBeNull();
    write(join(root, "bad.json"), "{");
    expect(qualitySample(join(root, "bad.json"))).toBeNull();
    expect(nextRound(root, "ludo")).toBe("1");
    write(join(root, "artifacts/critic/ludo/round-2.json"), "{}");
    write(join(root, "artifacts/critic/ludo/round-10.json"), "{}");
    write(join(root, "artifacts/critic/ludo/notes.md"), "");
    expect(nextRound(root, "ludo")).toBe("11");
    mkdirSync(join(root, "artifacts/critic/chess"), { recursive: true });
    expect(nextRound(root, "chess")).toBe("1");
    expect(headCommit(root)).toBe("unknown");
    expect(headCommit(ROOT)).toMatch(/^[0-9a-f]{7,}$/);
  });
});

// ---- verifyGame orchestration with fake commands --------------------------------------------

const KEEP = [
  "artifacts/perf/tictactoe.json",
  "artifacts/perf/tictactoe-gpu.json",
  "artifacts/verify/tictactoe-pacing.json",
  "artifacts/verify/tictactoe-sim.json",
];
const saved = new Map<string, string | null>();
beforeAll(() => {
  for (const f of KEEP)
    saved.set(f, existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : null);
});
afterAll(() => {
  for (const [f, v] of saved) {
    if (v === null) rmSync(join(ROOT, f), { force: true });
    else writeFileSync(join(ROOT, f), v);
  }
  rmSync(join(ROOT, "artifacts/tmp/verify/test-tictactoe.json"), { force: true });
});

function fakeRunner(opts: { failTsc?: boolean; failG9?: boolean; gpu?: "skip" | "pass" } = {}): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const counts = { stills: 0, clips: 0 };
  const runner: CommandRunner = async (cmd, args, o) => {
    calls.push([cmd, ...args]);
    const flag = (name: string) =>
      args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
    if (args.includes("tsc"))
      return {
        code: opts.failTsc ? 2 : 0,
        stdout: opts.failTsc ? "error TS1" : "",
        stderr: "",
        ms: 1,
      };
    if (args.includes("eslint")) return { code: 0, stdout: "", stderr: "", ms: 1 };
    if (args.includes("vitest")) {
      const out = flag("--outputFile")!;
      const filter = args[args.indexOf("-t") + 1];
      write(out, {
        testResults: [
          {
            name: "x",
            status: "passed",
            assertionResults: [{ fullName: `fake ${filter ?? "all"}`, status: "passed" }],
          },
        ],
      });
      const cov = flag("--coverage.reportsDirectory");
      if (cov !== undefined)
        write(join(cov, "coverage-summary.json"), { total: { branches: { pct: 95 } } });
      if (filter === "G14")
        write(join(ROOT, "artifacts/verify/tictactoe-pacing.json"), {
          groups: [{ medianMs: 120_000, p90Ms: 180_000 }],
          audienceIdleMaxMs: 9_000,
          playerIdleMaxMs: 12_000,
        });
      if (filter === "G5")
        write(join(ROOT, "artifacts/verify/tictactoe-sim.json"), { ok: true, games: 1000 });
      return { code: 0, stdout: "", stderr: "", ms: 1 };
    }
    if (args.includes("playwright")) {
      const env = o.env ?? {};
      const project = args[args.indexOf("--project") + 1];
      const tests: { title: string; status: string }[] = [];
      if (project === "gpu") {
        tests.push({
          title: "G8b: tictactoe perf script on the GPU @gpu",
          status: opts.gpu === "pass" ? "expected" : "skipped",
        });
        write(
          join(ROOT, "artifacts/perf/tictactoe-gpu.json"),
          opts.gpu === "pass"
            ? { g8b: { p95Low: 9, p95High: 5, heapGrowthMB: 0.1 } }
            : { g8b: { skipped: "no-gpu", renderer: "SwiftShader" } },
        );
      } else {
        const m = JSON.parse(
          readFileSync(join(ROOT, "artifacts/scenarios/tictactoe.json"), "utf8"),
        );
        const c = matrixCounts(m);
        counts.stills = c.stills;
        counts.clips = c.clips;
        for (let i = 0; i < c.stills; i++)
          tests.push({ title: `G7 stage: s${i}.png`, status: "expected" });
        for (let i = 0; i < c.clips; i++)
          tests.push({ title: `G7 clip: c${i}`, status: "expected" });
        tests.push({
          title: "determinism: intro renders pixel-identical twice",
          status: "expected",
        });
        tests.push({ title: "G8a: tictactoe midgame budgets at low tier", status: "expected" });
        tests.push({
          title: "G9 axe controller: x",
          status: opts.failG9 ? "unexpected" : "expected",
        });
        write(join(ROOT, "artifacts/perf/tictactoe.json"), {
          g8a: {
            draws: 6,
            tris: 1700,
            programs: 8,
            texMB: 2.7,
            idleRendersPerSec: 0,
            leakedGeometries: 0,
            leakedTextures: 0,
          },
        });
      }
      write(env["SG_REPORT"]!, {
        suites: [
          {
            file: "x.spec.ts",
            specs: tests.map((t) => ({
              title: t.title,
              tests: [
                {
                  projectName: project,
                  status: t.status,
                  results: [t.status === "unexpected" ? { error: { message: "axe says no" } } : {}],
                },
              ],
            })),
          },
        ],
      });
      return {
        code: tests.some((t) => t.status === "unexpected") ? 1 : 0,
        stdout: "",
        stderr: "",
        ms: 1,
      };
    }
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  };
  return { runner, calls };
}

const deps = (over: Partial<VerifyDeps> = {}): Partial<VerifyDeps> => ({
  checkScenarios: async (root, game) => ({
    ok: true,
    manifest: await emitManifest(root, gameTarget(root, game)),
    renders: [{ scenario: "intro", role: "stage", ok: true, errors: [] }],
    problems: [],
  }),
  streamSimRound: async () => ["a.jpg"],
  contactSheetsForRound: async () => ["s.png"],
  chunkGzipKB: async () => 2.1,
  startScenarioServer: async () => ({ url: "http://localhost:1", stop: async () => undefined }),
  ...over,
});

describe("verifyGame (DOD §2 gates)", () => {
  it("runs every G-gate and writes the DOD-format report; G8b may be skipped no-gpu, G10 is red until the server exists", async () => {
    const { runner, calls } = fakeRunner();
    const logs: string[] = [];
    const report = await verifyGame({
      root: ROOT,
      game: "tictactoe",
      round: "7",
      runner,
      deps: deps(),
      out: "artifacts/tmp/verify/test-tictactoe.json",
      log: (l) => logs.push(l),
      now: () => new Date("2026-09-25T00:00:00.123Z"),
    });
    expect(Object.keys(report.gates)).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
      "G8a",
      "G8b",
      "G9",
      "G10",
      "G11",
      "G13",
      "G14",
    ]);
    expect(report.at).toBe("2026-09-25T00:00:00Z");
    expect(report.gates["G3"]).toMatchObject({ ok: true, coverage: 95 });
    expect(report.gates["G5"]).toMatchObject({ ok: true, games: 1000 });
    expect(report.gates["G7"]).toMatchObject({ ok: true, clips: 2, stream: 1 });
    expect(report.gates["G8a"]).toMatchObject({
      ok: true,
      draws: 6,
      stageKB: 2.1,
      controllerKB: 2.1,
    });
    expect(report.gates["G8b"]).toMatchObject({ skipped: "no-gpu" });
    expect(report.gates["G8b"]!.ok).toBeUndefined();
    expect(report.gates["G10"]).toMatchObject({ ok: false });
    expect(report.gates["G14"]).toMatchObject({
      ok: true,
      medianMin: 2,
      p90Min: 3,
      audIdleMaxS: 9,
      playerIdleMaxS: 12,
    });
    expect(report.checks["determinism"]).toMatchObject({ ok: true, scenarios: 1 });
    expect(report.ok).toBe(false); // G10
    expect(
      JSON.parse(readFileSync(join(ROOT, "artifacts/tmp/verify/test-tictactoe.json"), "utf8")).id,
    ).toBe("tictactoe");
    expect(calls.some((c) => c.includes("--project") && c.includes("gpu"))).toBe(true);
    expect(logs.at(-1)).toMatch(/wrote artifacts\/tmp\/verify\/test-tictactoe.json/);
  });

  it("reports failing gates with their reasons and supports --only shots / perf", async () => {
    const { runner } = fakeRunner({ failTsc: true, failG9: true, gpu: "pass" });
    const report = await verifyGame({
      root: ROOT,
      game: "tictactoe",
      round: "7",
      runner,
      deps: deps({ chunkGzipKB: async () => 99 }),
      out: "artifacts/tmp/verify/test-tictactoe.json",
      log: () => undefined,
    });
    expect(report.gates["G1"]).toMatchObject({ ok: false, note: "error TS1" });
    expect(report.gates["G9"]).toMatchObject({
      ok: false,
      note: expect.stringMatching(/axe says no/),
    });
    expect(report.gates["G8a"]).toMatchObject({
      ok: false,
      note: expect.stringMatching(/stage chunk 99 KB gz > 60 KB/),
    });
    expect(report.gates["G8b"]).toMatchObject({ ok: true, p95Low: 9 });

    const shots = await verifyGame({
      root: ROOT,
      game: "tictactoe",
      round: "7",
      only: "shots",
      runner: fakeRunner().runner,
      deps: deps({
        checkScenarios: async (root, game) => ({
          ok: false,
          manifest: await emitManifest(root, gameTarget(root, game)),
          renders: [],
          problems: ["x failed"],
        }),
        streamSimRound: async () => {
          throw new Error("no shots");
        },
      }),
      out: "artifacts/tmp/verify/test-tictactoe.json",
      log: () => undefined,
    });
    expect(Object.keys(shots.gates)).toEqual(["G6", "G7"]);
    expect(shots.gates["G6"]).toMatchObject({ ok: false, note: "x failed" });
    expect(shots.gates["G7"]).toMatchObject({
      ok: false,
      note: expect.stringMatching(/stream-sim\/contact sheets: no shots/),
    });

    const perf = await verifyGame({
      root: ROOT,
      game: "tictactoe",
      round: "7",
      only: "perf",
      baseUrl: "http://localhost:1",
      runner: fakeRunner().runner,
      deps: deps(),
      out: "artifacts/tmp/verify/test-tictactoe.json",
      log: () => undefined,
    });
    expect(Object.keys(perf.gates)).toEqual(["G8a", "G8b"]);
  });

  it("a launch game with no tests yet fails its logic gates instead of passing by omission", async () => {
    await expect(
      verifyGame({
        root: ROOT,
        game: "ludo",
        round: "1",
        runner: fakeRunner().runner,
        deps: deps(),
        out: "artifacts/tmp/verify/test-ludo.json",
        log: () => undefined,
      }),
    ).rejects.toThrow(/does not export `scenarios`/);
    rmSync(join(ROOT, "artifacts/tmp/verify/test-ludo.json"), { force: true });
  });
});

describe("verify-item (DOD §1)", () => {
  it("M0-05 lists every Accept bullet with a command", () => {
    const spec = readItemSpec(ROOT, "M0-05");
    expect(spec.accept.length).toBeGreaterThanOrEqual(3);
    expect(spec.coverage.length).toBeGreaterThan(0);
    expect(isVisualItem(ROOT, "M0-05")).toBe(false);
    expect(isVisualItem(ROOT, "M1-07")).toBe(true);
    expect(isVisualItem(tmp(), "M1-07")).toBe(false);
  });

  it("validates item files", () => {
    const root = tmp();
    expect(() => readItemSpec(root, "M9-99")).toThrow(/no tools\/harness\/items\/M9-99.json/);
    write(join(root, "tools/harness/items/M9-99.json"), {
      id: "M9-98",
      coverage: "x",
      accept: [{ criterion: "", cmd: "" }],
    });
    expect(() => readItemSpec(root, "M9-99")).toThrow(
      /id is M9-98, not M9-99; coverage must be an array of globs; accept\[0\] has no criterion; accept\[0\] has no cmd/,
    );
    write(join(root, "tools/harness/items/M9-99.json"), { id: "M9-99", coverage: [], accept: [] });
    expect(() => readItemSpec(root, "M9-99")).toThrow(/at least one check/);
  });

  it("runs P1–P7 and the accept commands, and writes the verify JSON", async () => {
    const root = tmp();
    write(join(root, "progress.json"), { items: [{ id: "M9-99", visual: false }] });
    write(join(root, "tools/harness/items/M9-99.json"), {
      id: "M9-99",
      coverage: ["src/**"],
      accept: [
        { criterion: "it works", cmd: "check-a" },
        { criterion: "it is fast", cmd: "check-b" },
      ],
    });
    const runner: CommandRunner = async (cmd, args) => {
      const out = args.find((a) => a.startsWith("--outputFile="))?.slice("--outputFile=".length);
      if (out !== undefined) {
        write(out, {
          testResults: [
            {
              name: "a",
              status: "passed",
              assertionResults: [{ fullName: "t", status: "passed" }],
            },
          ],
        });
        const cov = args.find((a) => a.startsWith("--coverage.reportsDirectory="))!.split("=")[1]!;
        write(join(cov, "coverage-summary.json"), {
          total: { lines: { pct: 90 }, branches: { pct: 80 } },
        });
      }
      if (cmd === "check-b") return { code: 1, stdout: "too slow", stderr: "", ms: 1500 };
      return { code: 0, stdout: "", stderr: "", ms: 10 };
    };
    const r = await verifyItem({
      root,
      id: "M9-99",
      runner,
      log: () => undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(Object.keys(r.gates)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "format"]);
    expect(r.gates["P3"]).toMatchObject({
      ok: true,
      tests: 1,
      coverage: { lines: 90, branches: 80 },
    });
    expect(r.gates["P4"]).toMatchObject({
      ok: false,
      note: "1/2 Accept criteria green; see accept[]",
    });
    expect(r.gates["P6"]).toEqual({ ok: true, skipped: "not-a-visual-item" });
    expect(r.accept[1]).toMatchObject({ ok: false, note: "too slow", seconds: 1.5 });
    expect(r.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "artifacts/verify/M9-99.json"), "utf8")).id).toBe(
      "M9-99",
    );

    const lowCov: CommandRunner = async (cmd, args) => {
      const res = await runner(cmd, args, { cwd: root });
      const cov = args.find((a) => a.startsWith("--coverage.reportsDirectory="));
      if (cov !== undefined)
        write(join(cov.split("=")[1]!, "coverage-summary.json"), { total: { lines: { pct: 40 } } });
      return res;
    };
    const skip = await verifyItem({
      root,
      id: "M9-99",
      runner: lowCov,
      skipAccept: true,
      log: () => undefined,
    });
    expect(skip.gates["P3"]).toMatchObject({ ok: false, note: "new-code line coverage 40% < 85%" });
    expect(skip.gates["P4"]).toMatchObject({
      ok: false,
      note: "accept commands skipped (--skip-accept)",
    });
    write(join(root, "progress.json"), { items: [{ id: "M9-99", visual: true }] });
    const noReport: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "crash", ms: 1 });
    const visual = await verifyItem({
      root,
      id: "M9-99",
      runner: noReport,
      skipAccept: true,
      log: () => undefined,
    });
    expect(visual.gates["P6"]).toBeUndefined();
    expect(visual.gates["P3"]!.note).toMatch(/no test report: crash.*no coverage summary/);
  });
});

describe("evidence completeness (M0-05 Accept 1)", () => {
  it("lists what a verify run left missing or stale", () => {
    const root = tmp();
    expect(checkOutputs(root, "tictactoe", "1", "abc1234")).toEqual([
      "missing artifacts/verify/tictactoe.json",
    ]);
    write(join(root, "artifacts/verify/tictactoe.json"), {
      id: "x",
      commit: "old",
      round: "2",
      gates: { G1: {} },
    });
    const m = {
      game: "tictactoe",
      spec: "s",
      perfScript: [],
      problems: [],
      notes: [],
      scenarios: [
        {
          id: "intro",
          description: "",
          anim: { name: "pop", durationMs: 1 },
          roles: ["stage", "player"],
          critic: "",
          variants: {},
          inSpec: true,
          registered: true,
        },
      ],
    };
    write(join(root, "artifacts/scenarios/tictactoe.json"), m);
    const problems = checkOutputs(root, "tictactoe", "1", "abc1234");
    expect(problems).toEqual(
      expect.arrayContaining([
        "artifacts/verify/tictactoe.json is for x",
        "artifacts/verify/tictactoe.json is from commit old, HEAD is abc1234",
        "artifacts/verify/tictactoe.json is for round 2, not 1",
        "artifacts/verify/tictactoe.json has no gate G14",
        "artifacts/verify/tictactoe.json has no determinism check",
        "missing artifacts/screenshots/tictactoe/round-1/intro__day__360x800.png",
        "missing artifacts/screenshots/tictactoe/round-1/stream/intro__dusk__stream.jpg",
        "missing artifacts/screenshots/tictactoe/round-1/clips/intro__dusk__1280x720.webm",
        "missing artifacts/screenshots/tictactoe/round-1/sheets/stage-rain.png",
        "missing artifacts/screenshots/tictactoe/round-1/sheets/controller.png",
        "missing artifacts/screenshots/tictactoe/round-1/sheets/snow.png",
        "missing artifacts/perf/tictactoe.json",
        "missing artifacts/perf/tictactoe-gpu.json",
      ]),
    );
  });
});
