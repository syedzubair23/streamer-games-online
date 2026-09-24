/**
 * Critic reports: schema validation against `docs/critic/report.schema.json` (DOD §5) and the
 * two/three-critic merge from DOD §4.3 ("★ items use the minimum, all other items use the mean;
 * a third critic and the median when the two disagree by more than 1.5").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { Rubric } from "./rubric.ts";

export const SCHEMA_PATH = "docs/critic/report.schema.json";

/** Per-group scores: item number (as a string key) → score, or null when not applicable. */
export type GroupScores = Record<string, number | null>;

export interface CriticReport {
  game: string;
  round: number;
  critic: string;
  pass: boolean;
  ab: { pair: string; choice: "A" | "B" | "tie"; why: string }[];
  scores: Record<string, GroupScores>;
  clipScores: { "12"?: number; "16"?: number };
  minScore: number;
  issues: {
    id: string;
    item: number;
    severity: "blocker" | "major" | "minor";
    files: string[];
    region: string;
    problem: string;
    rule: string;
    fix: string;
    regressionOf?: string;
  }[];
}

export function loadReportSchema(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, SCHEMA_PATH), "utf8")) as Record<string, unknown>;
}

export type ReportValidator = (
  value: unknown,
) => { ok: true; report: CriticReport } | { ok: false; errors: string[] };

/** Compiles the DOD §5 schema once; the returned function validates one parsed report. */
export function createReportValidator(schema: Record<string, unknown>): ReportValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return (value) => {
    if (validate(value)) return { ok: true, report: value as CriticReport };
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
    );
    return { ok: false, errors };
  };
}

/**
 * Pulls the JSON object out of a critic's reply: the whole text if it parses, otherwise the
 * contents of a ```json fence, otherwise the outermost `{…}` span. Throws if none parses.
 */
export function extractJson(text: string): unknown {
  const attempts: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) attempts.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`critic reply contains no parseable JSON object: ${text.slice(0, 200)}`);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** Mean of the non-null scores of a group (NaN when every item is null). */
export function groupMean(scores: GroupScores): number {
  const xs = Object.values(scores).filter((v): v is number => typeof v === "number");
  return xs.length ? mean(xs) : Number.NaN;
}

/**
 * Whether a set of critics disagrees enough to need a third one (DOD §4.3): more than 1.5 apart
 * on any ★ item in any group, or overall means more than 1.5 apart.
 */
export function needsThirdCritic(
  groups: GroupScores[][],
  rubric: Rubric,
  threshold = 1.5,
): boolean {
  const stars = rubric.items.filter((i) => i.star).map((i) => String(i.id));
  const overall: number[][] = [];
  for (const perCritic of groups) {
    const [a, b] = perCritic;
    if (!a || !b) continue;
    for (const s of stars) {
      const x = a[s];
      const y = b[s];
      if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) > threshold)
        return true;
    }
    perCritic.forEach((g, i) => {
      for (const v of Object.values(g)) if (typeof v === "number") (overall[i] ??= []).push(v);
    });
  }
  const [oa, ob] = overall;
  return !!oa?.length && !!ob?.length && Math.abs(mean(oa) - mean(ob)) > threshold;
}

/**
 * Merges one group's scores from 2 critics (★ = min, others = mean) or from 3 critics (median of
 * every item), per DOD §4.3. An item null for every critic stays null; otherwise nulls are skipped.
 */
export function mergeGroup(perCritic: GroupScores[], rubric: Rubric): GroupScores {
  if (perCritic.length < 1) throw new Error("mergeGroup needs at least one critic");
  const out: GroupScores = {};
  for (const item of rubric.items) {
    const k = String(item.id);
    const xs = perCritic.map((g) => g[k]).filter((v): v is number => typeof v === "number");
    if (xs.length === 0) out[k] = null;
    else if (perCritic.length >= 3) out[k] = median(xs);
    else out[k] = item.star ? Math.min(...xs) : mean(xs);
  }
  return out;
}

/** RUBRIC §4.1 thresholds that tie an item's score to the issues it carries. */
export const DEDUCTION = {
  /** The reference anchor: an item below it has at least one issue saying what cost it. */
  anchor: 9.5,
  /** The floor of the reference band: an item below it has a major (★ < 8.5: blocker) issue. */
  bandFloor: 9,
  /** Most a single minor issue can cost inside the reference band. */
  perMinor: 0.2,
  /** DOD §5: a ★ item below this needs a blocker issue. */
  blockerBelow: 8.5,
} as const;

const SEVERITY_RANK = { minor: 0, major: 1, blocker: 2 } as const;

/**
 * RUBRIC §4.1 step 2 ("every deduction is named, and the score follows from the issues") and
 * DOD §5 severity, checked for one group's scores against the report's issues:
 *  - an item below 9.5 has at least one issue;
 *  - an item below 9.0 has a major issue (a ★ item below 8.5: a blocker);
 *  - an item whose issues are all minor scores at least 9.5 − 0.2 per issue, never below 9.0.
 * Items that are null are skipped. Returns human-readable problems (empty = consistent).
 */
export function deductionProblems(
  scores: GroupScores,
  issues: CriticReport["issues"],
  rubric: Rubric,
): string[] {
  const problems: string[] = [];
  const eps = 1e-9;
  for (const item of rubric.items) {
    const v = scores[String(item.id)];
    if (typeof v !== "number" || v >= DEDUCTION.anchor - eps) continue;
    const own = issues.filter((i) => i.item === item.id);
    if (own.length === 0) {
      problems.push(
        `item ${item.id} is scored ${v} (< ${DEDUCTION.anchor}) with no issue saying what cost it (RUBRIC §4.1 step 2)`,
      );
      continue;
    }
    const worst = Math.max(...own.map((i) => SEVERITY_RANK[i.severity]));
    if (v < DEDUCTION.bandFloor - eps) {
      const need = item.star && v < DEDUCTION.blockerBelow - eps ? "blocker" : "major";
      if (worst < SEVERITY_RANK[need]) {
        problems.push(
          `item ${item.id} is scored ${v} (< ${DEDUCTION.bandFloor}) but has no ${need} issue naming the shortfall (RUBRIC §4.1, DOD §5)`,
        );
      }
    } else if (worst === SEVERITY_RANK.minor) {
      const floor = Math.max(
        DEDUCTION.bandFloor,
        DEDUCTION.anchor - DEDUCTION.perMinor * own.length,
      );
      if (v < floor - eps) {
        problems.push(
          `item ${item.id} is scored ${v} with ${own.length} minor issue(s), which cost at most ${round1(DEDUCTION.anchor - floor)}: score it ≥ ${round1(floor)} or name a major shortfall (RUBRIC §4.1 step 2)`,
        );
      }
    }
  }
  return problems;
}

const round1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
