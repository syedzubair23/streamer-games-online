/**
 * Readers for the machine reports the gates are decided from: Vitest's JSON reporter, V8
 * coverage summaries and Playwright's JSON reporter.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";

/** Terminal colour codes (ESC [ … m). */
const ANSI = new RegExp(`${String.fromCharCode(27)}${String.raw`\[`}[0-9;]*m`, "g");
/** Removes terminal colour codes. */
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One test from a Vitest JSON report. */
export interface VitestTest {
  name: string;
  status: string;
}

/** A Vitest JSON report reduced to what the gates need. */
export interface VitestSummary {
  passed: number;
  failed: number;
  skipped: number;
  tests: VitestTest[];
  /** Test files that failed to load or run. */
  fileErrors: string[];
}

/** Parses a Vitest `--reporter=json` output file. */
export function readVitestJson(path: string): VitestSummary | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const tests: VitestTest[] = [];
  const fileErrors: string[] = [];
  const files = Array.isArray(raw["testResults"]) ? raw["testResults"] : [];
  for (const f of files) {
    if (!isRecord(f)) continue;
    if (f["status"] === "failed" && typeof f["message"] === "string" && f["message"] !== "")
      fileErrors.push(`${String(f["name"])}: ${f["message"]}`);
    for (const a of Array.isArray(f["assertionResults"]) ? f["assertionResults"] : []) {
      if (!isRecord(a)) continue;
      tests.push({
        name: String(a["fullName"] ?? a["title"] ?? ""),
        status: String(a["status"] ?? ""),
      });
    }
  }
  return {
    passed: tests.filter((t) => t.status === "passed").length,
    failed: tests.filter((t) => t.status === "failed").length,
    skipped: tests.filter(
      (t) => t.status === "skipped" || t.status === "pending" || t.status === "todo",
    ).length,
    tests,
    fileErrors,
  };
}

/** Reads `total.<metric>.pct` from a V8 `coverage-summary.json`. */
export function readCoveragePct(
  path: string,
  metric: "lines" | "branches" | "functions" | "statements",
): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      total?: Record<string, { pct?: unknown }>;
    };
    const pct = raw.total?.[metric]?.pct;
    return typeof pct === "number" ? pct : null;
  } catch {
    return null;
  }
}

/** One test of a Playwright JSON report. */
export interface PwTest {
  file: string;
  title: string;
  project: string;
  /** `expected`, `unexpected`, `skipped` or `flaky`. */
  status: string;
  error?: string;
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: {
    title?: string;
    file?: string;
    tests?: {
      projectName?: string;
      status?: string;
      results?: { error?: { message?: string } }[];
    }[];
  }[];
  suites?: PwSuite[];
}

/** Flattens a Playwright `--reporter=json` output file into tests. */
export function readPlaywrightJson(path: string): { tests: PwTest[]; errors: string[] } | null {
  if (!existsSync(path)) return null;
  let raw: { suites?: PwSuite[]; errors?: { message?: string }[] };
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
  } catch {
    return null;
  }
  const tests: PwTest[] = [];
  const walk = (suite: PwSuite, file: string): void => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const error = (t.results ?? []).map((r) => r.error?.message).find((m) => m !== undefined);
        tests.push({
          file: spec.file ?? f,
          title: spec.title ?? "",
          project: t.projectName ?? "",
          status: t.status ?? "",
          ...(error !== undefined ? { error: stripAnsi(error).slice(0, 400) } : {}),
        });
      }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of raw.suites ?? []) walk(s, s.file ?? "");
  return { tests, errors: (raw.errors ?? []).map((e) => e.message ?? "").filter((m) => m !== "") };
}

/** Summary of the Playwright tests whose title starts with `prefix`. */
export function pwGate(
  tests: readonly PwTest[],
  prefix: string,
): { total: number; passed: number; failed: PwTest[]; skipped: number } {
  const mine = tests.filter((t) => t.title.startsWith(prefix));
  return {
    total: mine.length,
    passed: mine.filter((t) => t.status === "expected" || t.status === "flaky").length,
    failed: mine.filter((t) => t.status === "unexpected"),
    skipped: mine.filter((t) => t.status === "skipped").length,
  };
}
