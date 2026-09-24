/**
 * `pnpm verify:item <id>`: the Platform DoD (DOD §1, P1–P7) for one roadmap item, written to
 * `artifacts/verify/<id>.json`.
 *
 * | Gate | Check |
 * |---|---|
 * | P1 | `pnpm typecheck` |
 * | P2 | `pnpm lint` |
 * | P3 | `pnpm test`, plus ≥ 85% line coverage on the item's new code (`coverage` globs) |
 * | P4 | every Accept criterion's command, from `tools/harness/items/<id>.json` |
 * | P5 | `pnpm size` |
 * | P6 | visual items: the critic decides (not in the verify JSON); others: not applicable |
 * | P7 | `docs/engine-api.md` is current (`pnpm --filter @sg/engine api-docs --check`) |
 *
 * plus `format` (`pnpm format:check`). The item file lists each Accept bullet with the command
 * that proves it; an item without one fails P4 instead of passing by omission.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { headCommit, VERIFY_TMP, type GateResult } from "./game.ts";
import { readCoveragePct, readVitestJson } from "./reports.ts";
import { formatCmd, spawnRunner, tailLines, type CommandRunner } from "./run.ts";

/** One Accept bullet and the command that proves it. */
export interface AcceptCheck {
  criterion: string;
  /** A shell command run from the repo root; exit 0 means the criterion holds. */
  cmd: string;
  /** What the command demonstrates (kept in the verify JSON). */
  evidence?: string;
}

/** `tools/harness/items/<id>.json`. */
export interface ItemSpec {
  id: string;
  /** Globs of the item's new code for the P3 coverage floor. */
  coverage: string[];
  accept: AcceptCheck[];
}

/** One accept result in the verify JSON. */
export interface AcceptResult extends AcceptCheck {
  ok: boolean;
  verifiedAt: string;
  seconds: number;
  note?: string;
}

/** `artifacts/verify/<id>.json` for a platform item. */
export interface VerifyItemReport {
  id: string;
  commit: string;
  at: string;
  ok: boolean;
  gates: Record<string, GateResult>;
  accept: AcceptResult[];
}

/** DOD P3 line-coverage floor for new code. */
export const P3_LINES_MIN = 85;

/** Reads and validates an item's accept file. */
export function readItemSpec(root: string, id: string): ItemSpec {
  const path = join(root, "tools/harness/items", `${id}.json`);
  if (!existsSync(path))
    throw new Error(`no tools/harness/items/${id}.json: list the item's Accept bullets and their commands there`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ItemSpec>;
  const problems: string[] = [];
  if (raw.id !== id) problems.push(`id is ${String(raw.id)}, not ${id}`);
  if (!Array.isArray(raw.coverage) || raw.coverage.some((c) => typeof c !== "string"))
    problems.push("coverage must be an array of globs");
  if (!Array.isArray(raw.accept) || raw.accept.length === 0) problems.push("accept must list at least one check");
  else
    raw.accept.forEach((a, i) => {
      if (typeof a?.criterion !== "string" || a.criterion.trim() === "") problems.push(`accept[${i}] has no criterion`);
      if (typeof a?.cmd !== "string" || a.cmd.trim() === "") problems.push(`accept[${i}] has no cmd`);
    });
  if (problems.length > 0) throw new Error(`tools/harness/items/${id}.json: ${problems.join("; ")}`);
  return raw as ItemSpec;
}

/** Whether progress.json marks the item as visual (P6 through the critic). */
export function isVisualItem(root: string, id: string): boolean {
  try {
    const p = JSON.parse(readFileSync(join(root, "progress.json"), "utf8")) as { items?: { id: string; visual?: boolean }[] };
    return p.items?.find((i) => i.id === id)?.visual === true;
  } catch {
    return false;
  }
}

/** Options of {@link verifyItem}. */
export interface VerifyItemOptions {
  root: string;
  id: string;
  runner?: CommandRunner;
  log?: (line: string) => void;
  now?: () => Date;
  /** Skip the accept commands (P4 then fails): for quick P1–P3/P5/P7 checks. */
  skipAccept?: boolean;
}

async function simple(runner: CommandRunner, root: string, args: string[]): Promise<GateResult> {
  const r = await runner("pnpm", args, { cwd: root });
  return { ok: r.code === 0, cmd: formatCmd("pnpm", args), ...(r.code !== 0 ? { note: tailLines(r) } : {}) };
}

/** Runs the P-gates and accept commands; writes and returns the verify JSON. */
export async function verifyItem(o: VerifyItemOptions): Promise<VerifyItemReport> {
  const runner = o.runner ?? spawnRunner;
  const log = o.log ?? ((l: string) => console.log(l));
  const spec = readItemSpec(o.root, o.id);
  const commit = headCommit(o.root);
  const gates: Record<string, GateResult> = {};

  log(`verify:item ${o.id}: P1 typecheck`);
  gates["P1"] = await simple(runner, o.root, ["typecheck"]);
  log(`verify:item ${o.id}: P2 lint`);
  gates["P2"] = await simple(runner, o.root, ["lint"]);

  log(`verify:item ${o.id}: P3 tests + coverage`);
  const report = join(o.root, VERIFY_TMP, `${o.id}-p3.json`);
  const covDir = join(o.root, VERIFY_TMP, `${o.id}-coverage`);
  mkdirSync(dirname(report), { recursive: true });
  rmSync(report, { force: true });
  rmSync(covDir, { recursive: true, force: true });
  const p3Args = [
    "exec",
    "vitest",
    "run",
    "--reporter=json",
    `--outputFile=${report}`,
    "--coverage.enabled",
    "--coverage.reporter=json-summary",
    `--coverage.reportsDirectory=${covDir}`,
    ...spec.coverage.map((g) => `--coverage.include=${g}`),
  ];
  const p3 = await runner("pnpm", p3Args, { cwd: o.root });
  const tests = readVitestJson(report);
  const lines = readCoveragePct(join(covDir, "coverage-summary.json"), "lines");
  const branches = readCoveragePct(join(covDir, "coverage-summary.json"), "branches");
  const p3Problems: string[] = [];
  if (p3.code !== 0 || tests === null || tests.failed > 0 || tests.fileErrors.length > 0)
    p3Problems.push(tests === null ? `no test report: ${tailLines(p3)}` : `${tests.failed} failing tests ${tests.fileErrors.join("; ")}`.trim());
  if (lines === null) p3Problems.push("no coverage summary");
  else if (lines < P3_LINES_MIN) p3Problems.push(`new-code line coverage ${lines}% < ${P3_LINES_MIN}%`);
  gates["P3"] = {
    ok: p3Problems.length === 0,
    cmd: `pnpm test (vitest run --coverage on ${spec.coverage.join(", ")})`,
    tests: tests?.passed ?? 0,
    skippedTests: tests?.skipped ?? 0,
    coverage: { lines, branches, scope: spec.coverage },
    ...(p3Problems.length ? { note: p3Problems.join("; ") } : {}),
  };

  const accept: AcceptResult[] = [];
  if (o.skipAccept !== true)
    for (const a of spec.accept) {
      log(`verify:item ${o.id}: accept: ${a.criterion}`);
      const r = await runner(a.cmd, [], { cwd: o.root, echo: true, shell: true });
      accept.push({
        ...a,
        ok: r.code === 0,
        verifiedAt: commit,
        seconds: Math.round(r.ms / 100) / 10,
        ...(r.code !== 0 ? { note: tailLines(r) } : {}),
      });
    }
  gates["P4"] = {
    ok: accept.length === spec.accept.length && accept.every((a) => a.ok),
    note:
      o.skipAccept === true
        ? "accept commands skipped (--skip-accept)"
        : `${accept.filter((a) => a.ok).length}/${spec.accept.length} Accept criteria green; see accept[]`,
  };

  log(`verify:item ${o.id}: P5 size`);
  gates["P5"] = await simple(runner, o.root, ["size"]);
  // P6 for a visual item is the critic loop (its reports, not this file); others record n/a.
  if (!isVisualItem(o.root, o.id)) gates["P6"] = { ok: true, skipped: "not-a-visual-item" };
  log(`verify:item ${o.id}: P7 api docs`);
  gates["P7"] = await simple(runner, o.root, ["--filter", "@sg/engine", "api-docs", "--check"]);
  log(`verify:item ${o.id}: format`);
  gates["format"] = await simple(runner, o.root, ["format:check"]);

  const out: VerifyItemReport = {
    id: o.id,
    commit,
    at: (o.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ok: Object.values(gates).every((g) => g.ok === true) && accept.every((a) => a.ok),
    gates,
    accept,
  };
  const path = join(o.root, "artifacts/verify", `${o.id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  log(`verify:item ${o.id}: wrote artifacts/verify/${o.id}.json (ok: ${out.ok})`);
  return out;
}
