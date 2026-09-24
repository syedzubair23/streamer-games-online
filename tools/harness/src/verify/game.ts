/**
 * `pnpm verify:game <id>`: runs every G-gate automation of DOD §2 (G1–G11, G13, G14; G12 is the
 * critic) and writes `artifacts/verify/<id>.json` in the DOD format.
 *
 * Order: the node gates (G1–G5, G11, G13, G14) run first, a few at a time; then the client is
 * built in `scenario` mode and served, G6 renders every scenario × role, and the Playwright
 * specs capture the §3 matrix (G7), measure performance (G8a on swiftshader, G8b on the GPU)
 * and check accessibility (G9). Stream-sim JPEGs and contact sheets are derived from the shots.
 *
 * A gate whose automation cannot run is reported **not ok** with the reason (for example G10
 * before the server and bot swarm exist), never skipped silently; the only allowed skip is G8b
 * `"no-gpu"` (DOD §2).
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { streamSimRound } from "../../stream-sim.ts";
import { contactSheetsForRound } from "../../contact-sheet.ts";
import { checkScenarios } from "../../check-scenarios.ts";
import { gameTarget, type GameTarget, type TestRun } from "../games.ts";
import { clipScenarios, matrixCounts, roundDir } from "../matrix.ts";
import { emitManifest } from "../scenarios/manifest.ts";
import { missingNumberedTests, parseGameSpec, section, type GameSpec } from "../scenarios/spec.ts";
import { startScenarioServer, type ScenarioServer } from "../server.ts";
import { chunkGzipKB } from "./chunks.ts";
import { pwGate, readCoveragePct, readPlaywrightJson, readVitestJson, type PwTest } from "./reports.ts";
import { formatCmd, spawnRunner, tailLines, type CommandRunner } from "./run.ts";

/** One gate's entry in the verify JSON. */
export interface GateResult {
  /** Absent only for G8b recorded as `skipped: "no-gpu"` (DOD §2). */
  ok?: boolean;
  skipped?: string;
  cmd?: string;
  note?: string;
  [metric: string]: unknown;
}

/** `artifacts/verify/<id>.json` (DOD §2 format, plus `ok` and extra checks). */
export interface VerifyGameReport {
  id: string;
  commit: string;
  at: string;
  ok: boolean;
  round: string;
  gates: Record<string, GateResult>;
  checks: Record<string, GateResult>;
  artifacts: Record<string, string | string[]>;
}

/** What to run. */
export type Only = "all" | "shots" | "perf";

/** Options of {@link verifyGame}. */
export interface VerifyGameOptions {
  root: string;
  game: string;
  round?: string;
  port?: number;
  only?: Only;
  skipBuild?: boolean;
  workers?: number;
  /** An already running scenario server (skips build and preview). */
  baseUrl?: string;
  runner?: CommandRunner;
  log?: (line: string) => void;
  now?: () => Date;
  /** Test seams: the browser/image steps (defaults: the real implementations). */
  deps?: Partial<VerifyDeps>;
}

/** The side-effecting steps {@link verifyGame} composes (injectable for tests). */
export interface VerifyDeps {
  checkScenarios: typeof checkScenarios;
  streamSimRound: typeof streamSimRound;
  contactSheetsForRound: typeof contactSheetsForRound;
  chunkGzipKB: typeof chunkGzipKB;
  startScenarioServer: typeof startScenarioServer;
}

/**
 * Scratch directory for machine reports (outside `test-results/`, which Playwright empties at
 * the start of every run).
 */
export const VERIFY_TMP = "artifacts/tmp/verify";

/** DOD G3 branch-coverage floor on `logic/**`. */
export const G3_BRANCH_MIN = 90;
/** DOD G13 limits. */
export const G13 = Object.freeze({ notesMax: 20, handoffMax: 40 });

/** Forward slashes, for commands and globs on every platform. */
const toPosix = (p: string): string => p.split("\\").join("/");
const rel = (root: string, p: string): string => toPosix(relative(root, p));

/** The short sha of HEAD, or "unknown" outside git. */
export function headCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function vitestGate(
  o: Required<Pick<VerifyGameOptions, "root" | "runner">>,
  id: string,
  gate: string,
  run: TestRun,
  extra: string[] = [],
  /** Run inside this package directory (its own vitest config) instead of as a root project. */
  inPackage?: string,
): Promise<{ result: GateResult; tests: string[] }> {
  const out = join(o.root, VERIFY_TMP, `${id}-${gate}.json`);
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  const files =
    inPackage === undefined
      ? run.files
      : run.files.map((f) => toPosix(relative(join(o.root, inPackage), join(o.root, f))));
  const args = [
    "exec",
    "vitest",
    "run",
    ...(inPackage === undefined ? ["--project", run.project] : []),
    ...files,
    ...(run.filter !== undefined ? ["-t", run.filter] : []),
    "--reporter=json",
    `--outputFile=${out}`,
    ...extra,
  ];
  const res = await o.runner("pnpm", args, { cwd: inPackage === undefined ? o.root : join(o.root, inPackage) });
  const summary = readVitestJson(out);
  const shown = args.filter((a) => !a.startsWith("--outputFile") && a !== "--reporter=json" && !a.startsWith("--coverage.reportsDirectory"));
  const cmd = inPackage === undefined ? formatCmd("pnpm", shown) : `cd ${inPackage} && ${formatCmd("pnpm", shown)}`;
  if (summary === null)
    return { result: { ok: false, cmd, note: `no test report: ${tailLines(res)}` }, tests: [] };
  const ok = res.code === 0 && summary.failed === 0 && summary.passed > 0 && summary.fileErrors.length === 0;
  const failedNames = summary.tests.filter((t) => t.status === "failed").map((t) => t.name);
  return {
    result: {
      ok,
      cmd,
      tests: summary.passed,
      ...(ok
        ? {}
        : {
            note:
              summary.passed === 0 && summary.failed === 0
                ? "no tests ran"
                : [...summary.fileErrors, ...failedNames.slice(0, 5)].join("; ") || tailLines(res),
          }),
    },
    tests: summary.tests.map((t) => t.name),
  };
}

const missing = (gate: string, what: string): GateResult => ({ ok: false, note: `${gate}: ${what}` });

/** G3: rule tests pass, every R#/T# of the spec has a named test, logic branch coverage ≥ 90%. */
async function gateG3(
  o: Required<Pick<VerifyGameOptions, "root" | "runner">>,
  t: GameTarget,
  spec: GameSpec,
): Promise<GateResult> {
  if (t.tests.G3 === null) return missing("G3", `${t.pkgDir}/test/logic.test.ts does not exist`);
  const covDir = join(o.root, VERIFY_TMP, `${t.id}-coverage`);
  rmSync(covDir, { recursive: true, force: true });
  // Run inside the package so the coverage scope is the package's own (the root config excludes
  // every **/test/** path, which would hide the fixture's logic).
  const include = toPosix(relative(join(o.root, t.pkgDir), join(o.root, t.logicCoverage)));
  const { result, tests } = await vitestGate(
    o,
    t.id,
    "G3",
    t.tests.G3,
    [
      "--coverage.enabled",
      "--coverage.provider=v8",
      `--coverage.include=${include}`,
      "--coverage.reporter=json-summary",
      `--coverage.reportsDirectory=${covDir}`,
    ],
    t.pkgDir,
  );
  const coverage = readCoveragePct(join(covDir, "coverage-summary.json"), "branches");
  const unnamed = missingNumberedTests([...spec.rules, ...spec.tests], tests);
  const problems: string[] = [];
  if (result.ok !== true) problems.push(result.note ?? "tests failed");
  if (coverage === null) problems.push("no coverage summary");
  else if (coverage < G3_BRANCH_MIN) problems.push(`logic branch coverage ${coverage}% < ${G3_BRANCH_MIN}%`);
  if (unnamed.length > 0) problems.push(`no test named for ${unnamed.join(", ")}`);
  return {
    ok: problems.length === 0,
    cmd: result.cmd,
    coverage,
    tests: result["tests"],
    rules: spec.rules.length,
    cases: spec.tests.length,
    ...(problems.length > 0 ? { note: problems.join("; ") } : {}),
  };
}

function freshJson(path: string, since: number): Record<string, unknown> | null {
  if (!existsSync(path) || statSync(path).mtimeMs < since) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** G14: the pacing test passes and writes a fresh `artifacts/verify/<id>-pacing.json`. */
async function gateG14(o: Required<Pick<VerifyGameOptions, "root" | "runner">>, t: GameTarget): Promise<GateResult> {
  if (t.tests.G14 === null) return missing("G14", `${t.pkgDir}/test/pacing.test.ts does not exist`);
  const start = Date.now() - 1000;
  const { result } = await vitestGate(o, t.id, "G14", t.tests.G14);
  const report = freshJson(join(o.root, `artifacts/verify/${t.id}-pacing.json`), start);
  if (report === null)
    return { ...result, ok: false, note: `${result.note ?? ""} artifacts/verify/${t.id}-pacing.json was not written`.trim() };
  const groups = Array.isArray(report["groups"]) ? (report["groups"] as { medianMs?: number; p90Ms?: number }[]) : [];
  const minutes = (ms: number | undefined): number => Math.round(((ms ?? 0) / 60_000) * 100) / 100;
  return {
    ...result,
    medianMin: Math.max(0, ...groups.map((g) => minutes(g.medianMs))),
    p90Min: Math.max(0, ...groups.map((g) => minutes(g.p90Ms))),
    audIdleMaxS: Math.round(Number(report["audienceIdleMaxMs"] ?? 0) / 100) / 10,
    playerIdleMaxS: Math.round(Number(report["playerIdleMaxMs"] ?? 0) / 100) / 10,
  };
}

/** Pack ids declared in the spec's Content section that exist under `content/packs/`. */
export function declaredPacks(root: string, specMd: string): string[] {
  const body = section(specMd, "Content") ?? "";
  const ids = [...body.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1] as string);
  const packsDir = join(root, "content/packs");
  const kindDirs = existsSync(packsDir) ? readdirSync(packsDir) : [];
  return [...new Set(ids)].filter((id) => kindDirs.some((k) => existsSync(join(root, "content/packs", k, `${id}.json`))));
}

/** Mean and minimum of a content quality-sample JSON (`scores[]` or `items[].score`). */
export function qualitySample(path: string): { mean: number; min: number; n: number } | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { scores?: unknown; items?: unknown };
    const scores = Array.isArray(raw.scores)
      ? raw.scores.filter((s): s is number => typeof s === "number")
      : Array.isArray(raw.items)
        ? raw.items.map((i) => (i as { score?: unknown }).score).filter((s): s is number => typeof s === "number")
        : [];
    if (scores.length === 0) return null;
    return { mean: scores.reduce((a, b) => a + b, 0) / scores.length, min: Math.min(...scores), n: scores.length };
  } catch {
    return null;
  }
}

/** G11: the content test passes and every declared pack's quality sample has mean ≥ 3.8, no item ≤ 2. */
async function gateG11(
  o: Required<Pick<VerifyGameOptions, "root" | "runner">>,
  t: GameTarget,
  specMd: string,
): Promise<GateResult> {
  const packs = t.fixture ? [] : declaredPacks(o.root, specMd);
  const contentSection = section(specMd, "Content");
  if (t.tests.G11 === null) {
    if (t.fixture || contentSection === null)
      return { ok: true, note: "the spec declares no content packs" };
    return missing("G11", `${t.pkgDir}/test/content.test.ts does not exist`);
  }
  const { result } = await vitestGate(o, t.id, "G11", t.tests.G11);
  const problems: string[] = result.ok === true ? [] : [result.note ?? "content tests failed"];
  const samples: Record<string, unknown> = {};
  for (const pack of packs) {
    const q = qualitySample(join(o.root, `artifacts/content/${pack}.json`));
    samples[pack] = q;
    if (q === null) problems.push(`no quality sample at artifacts/content/${pack}.json`);
    else if (q.mean < 3.8 || q.min <= 2) problems.push(`${pack} quality mean ${q.mean.toFixed(2)}, min ${q.min}`);
  }
  if (packs.length === 0) problems.push("no declared pack found under content/packs/");
  return { ok: problems.length === 0, cmd: result.cmd, packs, samples, ...(problems.length ? { note: problems.join("; ") } : {}) };
}

/** G13: Builder notes present and ≤ 20 lines; handoff present and ≤ 40 lines. */
export function gateG13(root: string, t: GameTarget, spec: GameSpec): GateResult {
  const problems: string[] = [];
  if (spec.builderNotes === null) problems.push(`${t.spec} has no "## Builder notes" section`);
  else if (spec.builderNotes.length > G13.notesMax)
    problems.push(`Builder notes are ${spec.builderNotes.length} lines (max ${G13.notesMax})`);
  let handoffLines: number | null = null;
  if (t.fixture) {
    // The fixture is not a roadmap item, so it has no handoff of its own.
  } else {
    const path = join(root, `artifacts/handoff/${t.id}.md`);
    if (!existsSync(path)) problems.push(`artifacts/handoff/${t.id}.md is missing`);
    else {
      handoffLines = readFileSync(path, "utf8").replace(/\n+$/, "").split(/\r?\n/).length;
      if (handoffLines > G13.handoffMax) problems.push(`handoff is ${handoffLines} lines (max ${G13.handoffMax})`);
    }
  }
  return {
    ok: problems.length === 0,
    notesLines: spec.builderNotes?.length ?? null,
    handoffLines,
    ...(t.fixture ? { note: "fixture: no roadmap item, so no handoff (Builder notes checked)" } : {}),
    ...(problems.length ? { note: problems.join("; ") } : {}),
  };
}

/** The next critic round for a game: the highest `artifacts/critic/<id>/round-<r>.json` + 1. */
export function nextRound(root: string, game: string): string {
  const dir = join(root, "artifacts/critic", game);
  if (!existsSync(dir)) return "1";
  const rounds = readdirSync(dir)
    .map((f) => /^round-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return String((rounds.length ? Math.max(...rounds) : 0) + 1);
}

/** Runs async jobs with bounded concurrency, preserving order. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        const job = jobs[i];
        if (job === undefined) return;
        out[i] = await job();
      }
    }),
  );
  return out;
}

async function playwright(
  o: Required<Pick<VerifyGameOptions, "root" | "runner" | "log">>,
  game: string,
  round: string,
  base: string,
  project: "swiftshader" | "gpu",
  specs: string[],
  workers: number,
): Promise<{ tests: PwTest[]; errors: string[]; code: number; cmd: string }> {
  const report = join(o.root, VERIFY_TMP, `${game}-pw-${project}.json`);
  mkdirSync(dirname(report), { recursive: true });
  rmSync(report, { force: true });
  const args = ["exec", "playwright", "test", ...specs, "--project", project];
  o.log(`$ ${formatCmd("pnpm", args)}`);
  const res = await o.runner("pnpm", args, {
    cwd: o.root,
    env: { SG_GAME: game, SG_ROUND: round, SG_BASE_URL: base, SG_REPORT: report, SG_WORKERS: String(workers) },
    echo: true,
  });
  const parsed = readPlaywrightJson(report);
  return {
    tests: parsed?.tests ?? [],
    errors: parsed === null ? [`no Playwright report: ${tailLines(res)}`] : parsed.errors,
    code: res.code,
    cmd: `SG_GAME=${game} ${formatCmd("pnpm", args)}`,
  };
}

const failNote = (failed: PwTest[]): string =>
  failed
    .slice(0, 6)
    .map((f) => `${f.title}: ${(f.error ?? "failed").split("\n")[0]}`)
    .join("; ");

/** Runs the gates and writes the verify JSON. Returns the report. */
export async function verifyGame(opts: VerifyGameOptions): Promise<VerifyGameReport> {
  const root = opts.root;
  const runner = opts.runner ?? spawnRunner;
  const log = opts.log ?? ((l: string) => console.log(l));
  const only = opts.only ?? "all";
  const round = opts.round ?? "1";
  const deps: VerifyDeps = {
    checkScenarios,
    streamSimRound,
    contactSheetsForRound,
    chunkGzipKB,
    startScenarioServer,
    ...opts.deps,
  };
  const t = gameTarget(root, opts.game);
  const specMd = readFileSync(join(root, t.spec), "utf8");
  const spec = parseGameSpec(specMd);
  const base = { root, runner };
  const gates: Record<string, GateResult> = {};
  const checks: Record<string, GateResult> = {};
  const artifacts: Record<string, string | string[]> = {};

  if (only === "all") {
    log(`verify:game ${t.id}: node gates (G1–G5, G11, G13, G14)`);
    const g1Args = ["exec", "tsc", "--noEmit", "-p", t.tsconfig];
    const g2Args = ["exec", "eslint", "--max-warnings", "0", ...t.lint];
    const [g1, g2, g3, g4, g5, g11, g14] = await pool<GateResult>(
      [
        async () => {
          const r = await runner("pnpm", g1Args, { cwd: root });
          return { ok: r.code === 0, cmd: formatCmd("pnpm", g1Args), ...(r.code ? { note: tailLines(r) } : {}) };
        },
        async () => {
          const r = await runner("pnpm", g2Args, { cwd: root });
          return { ok: r.code === 0, cmd: formatCmd("pnpm", g2Args), ...(r.code ? { note: tailLines(r) } : {}) };
        },
        () => gateG3(base, t, spec),
        async () => (t.tests.G4 === null ? missing("G4", `${t.pkgDir}/test/contract.test.ts does not exist`) : (await vitestGate(base, t.id, "G4", t.tests.G4)).result),
        async () => {
          if (t.tests.G5 === null) return missing("G5", `${t.pkgDir}/test/sim.test.ts does not exist`);
          const start = Date.now() - 1000;
          const r = (await vitestGate(base, t.id, "G5", t.tests.G5)).result;
          const sim = freshJson(join(root, `artifacts/verify/${t.id}-sim.json`), start);
          return sim === null ? r : { ...r, ...sim, ok: r.ok === true && sim["ok"] !== false };
        },
        () => gateG11(base, t, specMd),
        () => gateG14(base, t),
      ],
      3,
    );
    Object.assign(gates, { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5, G11: g11 });
    gates["G13"] = gateG13(root, t, spec);
    gates["G14"] = g14 as GateResult;
  }

  // ---- Browser gates -----------------------------------------------------------------------
  let server: ScenarioServer | null = null;
  try {
    let url = opts.baseUrl;
    if (url === undefined) {
      log(`verify:game ${t.id}: building and serving the scenario client on port ${opts.port ?? 4173}`);
      server = await deps.startScenarioServer(root, opts.port ?? 4173, { skipBuild: opts.skipBuild === true });
      url = server.url;
    }
    const manifest = await emitManifest(root, t);
    artifacts["scenarios"] = `artifacts/scenarios/${t.id}.json`;

    if (only === "all" || only === "shots") {
      const g6 = await deps.checkScenarios(root, t.id, url);
      gates["G6"] = {
        ok: g6.ok,
        cmd: `tsx tools/harness/check-scenarios.ts ${t.id}`,
        renders: g6.renders.length,
        scenarios: manifest.scenarios.filter((s) => s.inSpec).length,
        ...(g6.ok ? {} : { note: g6.problems.slice(0, 8).join("; ") }),
      };
    }

    const workers = opts.workers ?? 4;
    const specs =
      only === "shots"
        ? ["tools/harness/screenshots.spec.ts", "tools/harness/clips.spec.ts"]
        : only === "perf"
          ? ["tools/harness/perf.spec.ts"]
          : ["tools/harness/screenshots.spec.ts", "tools/harness/clips.spec.ts", "tools/harness/perf.spec.ts", "tools/harness/a11y.spec.ts"];
    const sw = await playwright({ root, runner, log }, t.id, round, url, "swiftshader", specs, workers);
    const expected = matrixCounts(manifest);

    if (only !== "perf") {
      const stills = pwGate(sw.tests, "G7 stage").total + pwGate(sw.tests, "G7 controller").total + pwGate(sw.tests, "G7 snow").total;
      const g7 = pwGate(sw.tests, "G7 ");
      const problems: string[] = [...sw.errors];
      if (g7.failed.length > 0) problems.push(failNote(g7.failed));
      if (stills !== expected.stills) problems.push(`${stills} stills ran, the matrix has ${expected.stills}`);
      const clips = pwGate(sw.tests, "G7 clip").total;
      if (clips !== expected.clips) problems.push(`${clips} clips ran, expected ${expected.clips}`);
      let stream: string[] = [];
      let sheets: string[] = [];
      try {
        const states = manifest.scenarios.filter((s) => s.inSpec && s.registered && s.roles.includes("stage")).map((s) => s.id);
        stream = await deps.streamSimRound(root, t.id, round, states);
        sheets = await deps.contactSheetsForRound(root, manifest, round);
      } catch (err) {
        problems.push(`stream-sim/contact sheets: ${err instanceof Error ? err.message : String(err)}`);
      }
      gates["G7"] = {
        ok: problems.length === 0 && g7.total > 0,
        cmd: sw.cmd,
        shots: stills,
        clips,
        stream: stream.length,
        ...(problems.length ? { note: problems.join("; ") } : {}),
      };
      artifacts["screenshots"] = roundDir(t.id, round);
      artifacts["sheets"] = sheets;
      artifacts["clips"] = clipScenarios(manifest).map((s) => `${roundDir(t.id, round)}/clips/${s.id}__dusk__1280x720.webm`);
      const det = pwGate(sw.tests, "determinism:");
      checks["determinism"] = {
        ok: det.total > 0 && det.failed.length === 0,
        scenarios: det.total,
        note: det.failed.length ? failNote(det.failed) : "every stage scenario rendered twice is pixel-identical (pixelmatch diff = 0)",
      };
    }

    if (only !== "shots") {
      const g8a = pwGate(sw.tests, "G8a:");
      const perf = freshJson(join(root, `artifacts/perf/${t.id}.json`), 0);
      const m = (perf?.["g8a"] ?? {}) as Record<string, unknown>;
      const problems: string[] = [];
      if (g8a.total === 0) problems.push("the G8a test did not run");
      if (g8a.failed.length) problems.push(failNote(g8a.failed));
      const chunk = async (entry: string | null, limit: number, name: string): Promise<number | null> => {
        if (entry === null) {
          problems.push(`no ${name} entry`);
          return null;
        }
        const kb = await deps.chunkGzipKB(root, entry);
        if (kb > limit) problems.push(`${name} chunk ${kb} KB gz > ${limit} KB`);
        return kb;
      };
      const stageKB = await chunk(t.chunks.stage, t.chunkLimitsKB.stage, "stage");
      const controllerKB = await chunk(t.chunks.controller, t.chunkLimitsKB.controller, "controller");
      gates["G8a"] = {
        ok: problems.length === 0,
        cmd: `${sw.cmd} (perf.spec.ts G8a) + esbuild chunk sizes`,
        draws: m["draws"],
        tris: m["tris"],
        programs: m["programs"],
        texMB: m["texMB"],
        idleRendersPerSec: m["idleRendersPerSec"],
        leakedGeometries: m["leakedGeometries"],
        leakedTextures: m["leakedTextures"],
        stageKB,
        controllerKB,
        ...(problems.length ? { note: problems.join("; ") } : {}),
      };
      artifacts["perf"] = `artifacts/perf/${t.id}.json`;

      const gpu = await playwright({ root, runner, log }, t.id, round, url, "gpu", ["tools/harness/perf.spec.ts"], 1);
      const g8b = pwGate(gpu.tests, "G8b:");
      const gp = freshJson(join(root, `artifacts/perf/${t.id}-gpu.json`), 0);
      const r = (gp?.["g8b"] ?? {}) as Record<string, unknown>;
      if (r["skipped"] === "no-gpu" && g8b.failed.length === 0)
        gates["G8b"] = { skipped: "no-gpu", cmd: gpu.cmd, note: `renderer: ${String(r["renderer"])}` };
      else
        gates["G8b"] = {
          ok: g8b.total > 0 && g8b.failed.length === 0 && g8b.passed > 0,
          cmd: gpu.cmd,
          p95Low: r["p95Low"],
          p95High: r["p95High"],
          heapGrowthMB: r["heapGrowthMB"],
          ...(g8b.failed.length || gpu.errors.length ? { note: [...gpu.errors, failNote(g8b.failed)].filter(Boolean).join("; ") } : {}),
        };
      artifacts["perfGpu"] = `artifacts/perf/${t.id}-gpu.json`;
    }

    if (only === "all") {
      const g9 = pwGate(sw.tests, "G9 ");
      gates["G9"] = {
        ok: g9.total > 0 && g9.failed.length === 0,
        cmd: `${sw.cmd} (a11y.spec.ts)`,
        checks: g9.total,
        ...(g9.failed.length ? { note: failNote(g9.failed) } : {}),
      };
      const smoke = "tools/harness/smoke.spec.ts";
      if (existsSync(join(root, smoke))) {
        const s = await playwright({ root, runner, log }, t.id, round, url, "swiftshader", [smoke], 1);
        const g10 = pwGate(s.tests, "G10");
        gates["G10"] = {
          ok: g10.total >= 2 && g10.failed.length === 0,
          cmd: s.cmd,
          runs: g10.total,
          ...(g10.failed.length || g10.total < 2 ? { note: failNote(g10.failed) || "expected a minPlayers and a maxPlayers run" } : {}),
        };
      } else {
        gates["G10"] = {
          ok: false,
          note: "multiplayer smoke needs the real server (M1-01..M1-04) and the bot swarm (M1-10); tools/harness/smoke.spec.ts does not exist yet",
        };
      }
    }
  } finally {
    await server?.stop();
  }

  const order = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8a", "G8b", "G9", "G10", "G11", "G13", "G14"];
  const sorted = Object.fromEntries(order.filter((g) => g in gates).map((g) => [g, gates[g] as GateResult]));
  const green = (name: string, g: GateResult): boolean =>
    g.ok === true || (name === "G8b" && g.ok === undefined && g.skipped === "no-gpu");
  const report: VerifyGameReport = {
    id: t.id,
    commit: headCommit(root),
    at: (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ok: Object.entries(sorted).every(([n, g]) => green(n, g)) && Object.values(checks).every((c) => c.ok === true),
    round,
    gates: sorted,
    checks,
    artifacts,
  };
  const out = only === "all" ? `artifacts/verify/${t.id}.json` : `artifacts/verify/${t.id}-${only}.json`;
  mkdirSync(dirname(join(root, out)), { recursive: true });
  writeFileSync(join(root, out), `${JSON.stringify(report, null, 2)}\n`);
  log(`verify:game ${t.id}: wrote ${rel(root, join(root, out))} (ok: ${report.ok})`);
  return report;
}
