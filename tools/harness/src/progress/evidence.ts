/**
 * Evidence checks behind each status transition (docs/DOD.md §8):
 *
 * | Transition   | Required evidence                                                        |
 * |--------------|--------------------------------------------------------------------------|
 * | → verifying  | the handoff file exists                                                  |
 * | → critic     | the verify JSON is green (G8b may be `skipped: "no-gpu"`, except M10-07) |
 * | → done       | the verify JSON is green at a commit on the current history, and, for    |
 * |              | visual items, the latest merged critic report passes with no open blocker|
 * | → blocked    | a `blockedReason`                                                        |
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CRITIC_GATES, type ProgressItem } from "./model.ts";

/** Result of one evidence check: `ok`, plus human-readable reasons when it is not. */
export interface Check {
  ok: boolean;
  problems: string[];
  /** Extra context that does not change the verdict (e.g. "not a git repo"). */
  notes: string[];
}

const pass = (notes: string[] = []): Check => ({ ok: true, problems: [], notes });
const fail = (problems: string[], notes: string[] = []): Check => ({ ok: false, problems, notes });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(path: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The command that (re)writes an item's verify JSON. */
export function verifyCommand(item: ProgressItem): string {
  return item.game !== null && item.evidence.verify === `artifacts/verify/${item.game}.json`
    ? `pnpm verify:game ${item.game}`
    : `pnpm verify:item ${item.id}`;
}

/** → verifying: the handoff exists and is not empty. */
export function checkHandoff(root: string, item: ProgressItem): Check {
  const path = join(root, item.evidence.handoff);
  if (!existsSync(path) || !statSync(path).isFile())
    return fail([`no handoff at ${item.evidence.handoff}`]);
  if (readFileSync(path, "utf8").trim() === "")
    return fail([`handoff ${item.evidence.handoff} is empty`]);
  return pass();
}

/** Whether a gate entry counts as green for this item. */
function gateGreen(item: ProgressItem, name: string, gate: unknown): string | null {
  if (!isRecord(gate)) return `gate ${name} is not an object`;
  if (gate["ok"] === true) return null;
  // DOD §2: without a GPU runner G8b is recorded as skipped; that blocks done only for M10-07.
  if (name === "G8b" && gate["skipped"] === "no-gpu" && gate["ok"] !== false) {
    return item.id === "M10-07" ? "gate G8b is skipped (no-gpu), which blocks M10-07" : null;
  }
  return `gate ${name} is not ok`;
}

/**
 * The verify JSON exists, is about this item, and every gate and acceptance bullet in it is
 * green. Critic-owned gates (G12, P6) are ignored for visual items: the critic reports decide.
 */
export function checkVerify(root: string, item: ProgressItem): Check {
  const rel = item.evidence.verify;
  const path = join(root, rel);
  if (!existsSync(path))
    return fail([`no verify artifact at ${rel} (run \`${verifyCommand(item)}\`)`]);
  const { value, error } = readJson(path);
  if (error !== undefined) return fail([`${rel} is not valid JSON: ${error}`]);
  if (!isRecord(value)) return fail([`${rel} is not a JSON object`]);

  const problems: string[] = [];
  const id = value["id"];
  if (id !== item.id && id !== item.game)
    problems.push(`${rel} is for ${JSON.stringify(id)}, not ${item.id}`);
  if (value["ok"] === false) problems.push(`${rel} has ok: false`);

  const gates = value["gates"];
  if (!isRecord(gates)) {
    problems.push(`${rel} has no gates object`);
  } else {
    const names = Object.keys(gates).filter((g) => !(item.visual && CRITIC_GATES.includes(g)));
    if (names.length === 0) problems.push(`${rel} reports no gates`);
    for (const required of item.evidence.gates) {
      if (!(required in gates)) problems.push(`gate ${required} is missing`);
    }
    for (const name of names) {
      const problem = gateGreen(item, name, gates[name]);
      if (problem) problems.push(problem);
    }
  }

  const accept = value["accept"];
  if (accept !== undefined) {
    if (!Array.isArray(accept)) problems.push(`${rel} accept is not an array`);
    else
      accept.forEach((entry: unknown, i) => {
        if (!isRecord(entry) || entry["ok"] !== true) {
          const label =
            isRecord(entry) && typeof entry["criterion"] === "string"
              ? entry["criterion"]
              : `#${i + 1}`;
          problems.push(`acceptance criterion not ok: ${label}`);
        }
      });
  }
  return problems.length ? fail(problems) : pass();
}

/** Runs git in `root`; returns stdout, or `null` if git failed (not a repo, unknown ref…). */
function git(root: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { code: 0, out: out.trim() };
  } catch (err) {
    const status = isRecord(err) && typeof err["status"] === "number" ? err["status"] : -1;
    return { code: status, out: "" };
  }
}

/**
 * DOD §8 "still green at the current commit": the verify JSON names the commit it ran on, and
 * that commit is HEAD or an ancestor of it. Outside a git work tree the check is skipped.
 */
export function checkVerifyCommit(root: string, item: ProgressItem): Check {
  const { value } = readJson(join(root, item.evidence.verify));
  const commit = isRecord(value) ? value["commit"] : undefined;
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out !== "true")
    return pass(["not a git work tree: commit check skipped"]);
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit))
    return fail([`${item.evidence.verify} has no commit sha (re-run \`${verifyCommand(item)}\`)`]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return fail(["the repository has no HEAD commit"]);
  if (git(root, ["cat-file", "-e", `${commit}^{commit}`]).code !== 0)
    return fail([`verify commit ${commit} is not in this repository (re-run verify)`]);
  const ancestor = git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  if (ancestor.code !== 0)
    return fail([
      `verify commit ${commit} is not on the current history (HEAD ${head.out.slice(0, 7)}); re-run verify`,
    ]);
  return pass(
    head.out.startsWith(commit.toLowerCase())
      ? []
      : [`verified at ${commit}, HEAD is ${head.out.slice(0, 7)}`],
  );
}

/** One issue from a merged critic report (DOD §5), reduced to what progress needs. */
export interface CriticIssue {
  id: string;
  item: number | null;
  severity: string;
  problem: string;
  waived: boolean;
}

/** The latest merged critic round for an item, if any. */
export interface CriticRound {
  round: number;
  file: string;
  pass: boolean;
  minScore: number | null;
  issues: CriticIssue[];
  error?: string;
}

/** Finds and reads the highest `round-<r>.json` in the item's critic directory. */
export function latestCriticRound(root: string, item: ProgressItem): CriticRound | null {
  if (!item.evidence.critic) return null;
  const dir = join(root, item.evidence.critic);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const rounds = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, m: /^round-(\d+)\.json$/.exec(d.name) }))
    .filter((r): r is { name: string; m: RegExpExecArray } => r.m !== null)
    .map((r) => ({ name: r.name, round: Number(r.m[1]) }))
    .sort((a, b) => b.round - a.round);
  const latest = rounds[0];
  if (!latest) return null;
  const file = `${item.evidence.critic}/${latest.name}`;
  const { value, error } = readJson(join(dir, latest.name));
  if (error !== undefined || !isRecord(value))
    return {
      round: latest.round,
      file,
      pass: false,
      minScore: null,
      issues: [],
      error: error ?? "not a JSON object",
    };
  const issues = Array.isArray(value["issues"])
    ? value["issues"].filter(isRecord).map((i) => ({
        id: typeof i["id"] === "string" ? i["id"] : "?",
        item: typeof i["item"] === "number" ? i["item"] : null,
        severity: typeof i["severity"] === "string" ? i["severity"] : "?",
        problem: typeof i["problem"] === "string" ? i["problem"] : "",
        waived: i["waived"] === true || typeof i["waived"] === "string",
      }))
    : [];
  return {
    round: latest.round,
    file,
    pass: value["pass"] === true,
    minScore: typeof value["minScore"] === "number" ? value["minScore"] : null,
    issues,
  };
}

/** Visual items: the latest merged critic report passes and has no open (unwaived) blocker. */
export function checkCritic(root: string, item: ProgressItem): Check {
  if (!item.visual || !item.evidence.critic) return pass(["no visuals: critic not required"]);
  const latest = latestCriticRound(root, item);
  if (!latest) return fail([`no critic report at ${item.evidence.critic}/round-*.json`]);
  if (latest.error) return fail([`${latest.file} is unreadable: ${latest.error}`]);
  const problems: string[] = [];
  if (!latest.pass) problems.push(`${latest.file} has pass: false`);
  const blockers = latest.issues.filter((i) => i.severity === "blocker" && !i.waived);
  if (blockers.length)
    problems.push(`${latest.file} has open blockers: ${blockers.map((b) => b.id).join(", ")}`);
  return problems.length ? fail(problems) : pass();
}

const merge = (...checks: Check[]): Check => ({
  ok: checks.every((c) => c.ok),
  problems: checks.flatMap((c) => c.problems),
  notes: checks.flatMap((c) => c.notes),
});

/** The evidence required to move `item` into `to` (DOD §8). */
export function checkTransitionEvidence(
  root: string,
  item: ProgressItem,
  to: ProgressItem["status"],
): Check {
  switch (to) {
    case "verifying":
      return checkHandoff(root, item);
    case "critic":
      return checkVerify(root, item);
    case "done": {
      const verify = checkVerify(root, item);
      const commit = verify.ok ? checkVerifyCommit(root, item) : pass();
      return merge(verify, commit, checkCritic(root, item));
    }
    default:
      return pass();
  }
}
