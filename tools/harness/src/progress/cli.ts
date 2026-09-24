/**
 * `pnpm progress …`: the only sanctioned way to change `progress.json` (docs/DOD.md §8).
 *
 * ```text
 * pnpm progress show <id>                          one item, its evidence and legal next states
 * pnpm progress set <id> status=<s> [owner=<o>] [notes=<text>] [reason=<text>]
 * pnpm progress render [--check]                   regenerate PROGRESS.md (or verify it is current)
 * pnpm progress list [status]                      one line per item, optionally filtered by status
 * pnpm progress sync [--prune]                     add roadmap items missing from progress.json
 * pnpm progress check                              progress.json matches ROADMAP.md, PROGRESS.md is current
 * ```
 *
 * Exit codes: 0 success, 1 usage or data error, 2 refused (illegal transition or missing evidence).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCritic,
  checkHandoff,
  checkTransitionEvidence,
  checkVerify,
  latestCriticRound,
} from "./evidence.ts";
import {
  allowedNext,
  isStatus,
  STATUSES,
  type ProgressFile,
  type ProgressItem,
  type Status,
} from "./model.ts";
import { renderProgress } from "./render.ts";
import { newProgressItem, parseRoadmap, compareIds } from "./roadmap.ts";
import {
  notesProblem,
  PROGRESS_JSON,
  PROGRESS_MD,
  readProgress,
  serializeProgress,
  withLock,
  writeAtomic,
} from "./store.ts";

export const ROADMAP_PATH = "docs/ROADMAP.md";

export interface CliIo {
  /** Repo root that holds progress.json, PROGRESS.md, docs/ and artifacts/. */
  root: string;
  /** Clock for `updated` timestamps (injectable for tests). */
  now?: () => Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** A refusal: the request was understood but the rules forbid it (exit code 2). */
export class Refusal extends Error {}
/** A malformed request (exit code 1). */
export class UsageError extends Error {}

export const USAGE = `usage:
  pnpm progress show <id>
  pnpm progress set <id> status=<${STATUSES.join("|")}> [owner=<name>] [notes=<text>] [reason=<text>]
  pnpm progress render [--check]
  pnpm progress list [status]
  pnpm progress sync [--prune]
  pnpm progress check
options: --root <dir>  repo root (default: this checkout)`;

const SET_KEYS = new Set(["status", "owner", "notes", "reason", "blockedReason"]);

/** Parses `key=value` arguments (values may contain `=`). */
export function parseAssignments(args: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new UsageError(`expected key=value, got ${JSON.stringify(arg)}`);
    const key = arg.slice(0, eq);
    if (!SET_KEYS.has(key))
      throw new UsageError(
        `unknown field ${JSON.stringify(key)} (allowed: status, owner, notes, reason)`,
      );
    const canonical = key === "blockedReason" ? "reason" : key;
    if (fields.has(canonical)) throw new UsageError(`${canonical} given twice`);
    fields.set(canonical, arg.slice(eq + 1));
  }
  if (fields.size === 0) throw new UsageError("set needs at least one key=value");
  return fields;
}

function findItem(file: ProgressFile, id: string): ProgressItem {
  const item = file.items.find((i) => i.id === id);
  if (!item) throw new UsageError(`unknown item ${JSON.stringify(id)} (see docs/ROADMAP.md)`);
  return item;
}

/**
 * Applies a `set` to a copy of the document, enforcing the lifecycle and the evidence rules.
 * Returns the updated document and a one-line summary; throws {@link Refusal} or {@link UsageError}.
 */
export function applySet(
  file: ProgressFile,
  id: string,
  fields: Map<string, string>,
  root: string,
  now: Date,
): { file: ProgressFile; summary: string; notes: string[] } {
  const current = findItem(file, id);
  const next: ProgressItem = {
    ...current,
    evidence: { ...current.evidence, gates: [...current.evidence.gates] },
  };
  const notes: string[] = [];
  const statusArg = fields.get("status");

  if (statusArg !== undefined) {
    if (!isStatus(statusArg))
      throw new UsageError(`unknown status ${JSON.stringify(statusArg)} (${STATUSES.join(", ")})`);
    const to: Status = statusArg;
    const legal = allowedNext(current);
    if (!legal.includes(to)) {
      let why = `illegal transition ${current.status} → ${to} for ${id}`;
      if (to === "critic" && !current.visual) why += " (item has no visuals: verifying → done)";
      if (to === "done" && current.status === "verifying" && current.visual)
        why += " (visual item: it must pass the critic)";
      throw new Refusal(`${why}; allowed next: ${legal.join(", ") || "none"}`);
    }
    if (to === "critic" && current.criticRound >= current.maxRounds)
      throw new Refusal(
        `${id} already used ${current.criticRound}/${current.maxRounds} critic rounds; DOD §7 says set status=blocked`,
      );
    const evidence = checkTransitionEvidence(root, current, to);
    if (!evidence.ok)
      throw new Refusal(`cannot set ${id} to ${to}:\n  - ${evidence.problems.join("\n  - ")}`);
    notes.push(...evidence.notes);

    if (to === "blocked") {
      const reason = (fields.get("reason") ?? "").trim();
      if (!reason) throw new Refusal(`status=blocked needs reason=<why> (DOD §8)`);
      next.blockedReason = reason;
    } else {
      next.blockedReason = null;
    }
    if (to === "critic") next.criticRound = current.criticRound + 1;
    next.status = to;
  } else if (fields.has("reason")) {
    if (current.status !== "blocked")
      throw new UsageError("reason is only valid with status=blocked or on a blocked item");
    const reason = (fields.get("reason") ?? "").trim();
    if (!reason) throw new UsageError("a blocked item's reason cannot be empty");
    next.blockedReason = reason;
  }

  const owner = fields.get("owner");
  if (owner !== undefined)
    next.owner = owner.trim() === "" || owner.trim() === "-" ? null : owner.trim();

  const notesArg = fields.get("notes");
  if (notesArg !== undefined) {
    const text = notesArg.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
    const problem = notesProblem(text);
    if (problem) throw new UsageError(problem);
    next.notes = text;
  }

  next.updated = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const items = file.items.map((i) => (i.id === id ? next : i));
  const moved =
    next.status !== current.status ? `${current.status} → ${next.status}` : `status ${next.status}`;
  return { file: { ...file, items }, summary: `${id}: ${moved}`, notes };
}

function mark(ok: boolean): string {
  return ok ? "ok" : "MISSING/RED";
}

/** Human-readable detail for one item (kept short: research 05 §B.10). */
export function describeItem(root: string, item: ProgressItem): string[] {
  const lines = [
    `${item.id}  ${item.title}`,
    `  milestone  ${item.milestone}${item.game ? ` (${item.game})` : ""} · ${item.kind} · visual: ${item.visual ? "yes" : "no"}`,
    `  status     ${item.status}   (next: ${allowedNext(item).join(", ") || "none"})`,
    `  owner      ${item.owner ?? "-"}`,
  ];
  if (item.visual) lines.push(`  critic     round ${item.criticRound}/${item.maxRounds}`);
  if (item.blockedReason) lines.push(`  blocked    ${item.blockedReason}`);
  lines.push(`  notes      ${item.notes ? item.notes.replace(/\n/g, "\n             ") : "-"}`);
  lines.push(`  updated    ${item.updated ?? "-"}`);
  lines.push("  evidence");
  const handoff = checkHandoff(root, item);
  lines.push(`    handoff  ${item.evidence.handoff}  ${mark(handoff.ok)}`);
  const verify = checkVerify(root, item);
  lines.push(`    verify   ${item.evidence.verify}  ${mark(verify.ok)}`);
  for (const p of verify.problems.slice(0, 6)) lines.push(`             - ${p}`);
  if (item.visual && item.evidence.critic) {
    const critic = checkCritic(root, item);
    const latest = latestCriticRound(root, item);
    lines.push(
      `    critic   ${item.evidence.critic}/round-*.json  ${
        latest
          ? `latest round ${latest.round}: ${latest.pass ? "pass" : "fail"}${latest.minScore !== null ? `, min ${latest.minScore}` : ""}`
          : "none"
      }  ${mark(critic.ok)}`,
    );
    const open = (latest?.issues ?? []).filter((i) => !i.waived && i.severity !== "minor");
    for (const issue of open.slice(0, 8))
      lines.push(
        `             ${issue.id} [${issue.severity}] item ${issue.item ?? "?"}: ${issue.problem.slice(0, 100)}`,
      );
    if (open.length > 8) lines.push(`             … ${open.length - 8} more`);
  }
  return lines;
}

/** Roadmap/progress consistency problems (empty when consistent). */
export function consistencyProblems(root: string, file: ProgressFile): string[] {
  const roadmapPath = join(root, ROADMAP_PATH);
  if (!existsSync(roadmapPath)) return [`no ${ROADMAP_PATH}`];
  const roadmap = parseRoadmap(readFileSync(roadmapPath, "utf8"));
  const inProgress = new Set(file.items.map((i) => i.id));
  const inRoadmap = new Set(roadmap.map((i) => i.id));
  const problems: string[] = [];
  for (const r of roadmap)
    if (!inProgress.has(r.id))
      problems.push(
        `${r.id} is in ROADMAP.md but not in progress.json (run \`pnpm progress sync\`)`,
      );
  for (const i of file.items)
    if (!inRoadmap.has(i.id)) problems.push(`${i.id} is in progress.json but not in ROADMAP.md`);
  return problems;
}

/** Brings progress.json in line with ROADMAP.md, keeping every existing item's state. */
export function syncWithRoadmap(
  file: ProgressFile | null,
  roadmapMarkdown: string,
  prune: boolean,
): { file: ProgressFile; added: string[]; orphans: string[] } {
  const roadmap = parseRoadmap(roadmapMarkdown);
  const existing = new Map((file?.items ?? []).map((i) => [i.id, i]));
  const added: string[] = [];
  const items: ProgressItem[] = roadmap.map((r) => {
    const fresh = newProgressItem(r);
    const old = existing.get(r.id);
    if (!old) {
      added.push(r.id);
      return fresh;
    }
    // Derived metadata follows the roadmap; state (status, owner, rounds, notes…) is kept.
    return {
      ...old,
      title: fresh.title,
      milestone: fresh.milestone,
      kind: fresh.kind,
      game: fresh.game,
      visual: fresh.visual,
      evidence: fresh.evidence,
    };
  });
  const inRoadmap = new Set(roadmap.map((r) => r.id));
  const orphans = (file?.items ?? []).filter((i) => !inRoadmap.has(i.id));
  if (!prune) items.push(...orphans);
  items.sort((a, b) => compareIds(a.id, b.id));
  return { file: { version: 1, items }, added, orphans: orphans.map((o) => o.id) };
}

function writeBoth(root: string, file: ProgressFile): void {
  writeAtomic(join(root, PROGRESS_JSON), serializeProgress(file));
  writeAtomic(join(root, PROGRESS_MD), renderProgress(file));
}

/** Runs the CLI; resolves to the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const out = io.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = io.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = io.now ?? (() => new Date());
  const args = [...argv];
  let root = io.root;
  const rootAt = args.indexOf("--root");
  if (rootAt >= 0) {
    const value = args[rootAt + 1];
    if (!value) {
      err("--root needs a directory");
      return 1;
    }
    root = value;
    args.splice(rootAt, 2);
  }
  // `pnpm progress -- set …` forwards the `--` separator on some pnpm versions.
  if (args[0] === "--") args.shift();
  const [command, ...rest] = args;

  try {
    switch (command) {
      case "show": {
        const [id, ...extra] = rest;
        if (!id || extra.length) throw new UsageError("show takes exactly one item id");
        describeItem(root, findItem(readProgress(root), id)).forEach((l) => out(l));
        return 0;
      }
      case "set": {
        const [id, ...assignments] = rest;
        if (!id) throw new UsageError("set needs an item id");
        const fields = parseAssignments(assignments);
        return await withLock(root, () => {
          const result = applySet(readProgress(root), id, fields, root, now());
          writeBoth(root, result.file);
          out(result.summary);
          result.notes.forEach((n) => out(`  note: ${n}`));
          return 0;
        });
      }
      case "render": {
        const check = rest.includes("--check");
        if (rest.some((a) => a !== "--check")) throw new UsageError("render takes only --check");
        const expected = renderProgress(readProgress(root));
        const path = join(root, PROGRESS_MD);
        if (check) {
          const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
          if (actual !== expected) {
            err(`${PROGRESS_MD} is out of date: run \`pnpm progress render\``);
            return 1;
          }
          out(`${PROGRESS_MD} is up to date`);
          return 0;
        }
        writeAtomic(path, expected);
        out(`wrote ${PROGRESS_MD}`);
        return 0;
      }
      case "list": {
        const [status, ...extra] = rest;
        if (extra.length) throw new UsageError("list takes at most one status");
        if (status !== undefined && !isStatus(status))
          throw new UsageError(`unknown status ${JSON.stringify(status)}`);
        for (const item of readProgress(root).items) {
          if (status && item.status !== status) continue;
          out(`${item.id.padEnd(8)} ${item.status.padEnd(9)} ${item.owner ?? "-"}  ${item.title}`);
        }
        return 0;
      }
      case "sync": {
        const prune = rest.includes("--prune");
        if (rest.some((a) => a !== "--prune")) throw new UsageError("sync takes only --prune");
        const roadmapPath = join(root, ROADMAP_PATH);
        if (!existsSync(roadmapPath)) throw new UsageError(`no ${ROADMAP_PATH} in ${root}`);
        return await withLock(root, () => {
          const current = existsSync(join(root, PROGRESS_JSON)) ? readProgress(root) : null;
          const result = syncWithRoadmap(current, readFileSync(roadmapPath, "utf8"), prune);
          writeBoth(root, result.file);
          out(
            `synced ${result.file.items.length} items; added ${result.added.length}${result.added.length ? `: ${result.added.join(", ")}` : ""}`,
          );
          if (result.orphans.length)
            out(
              `${prune ? "pruned" : "kept (not in ROADMAP.md; use --prune to drop)"}: ${result.orphans.join(", ")}`,
            );
          return 0;
        });
      }
      case "check": {
        if (rest.length) throw new UsageError("check takes no arguments");
        const file = readProgress(root);
        const problems = consistencyProblems(root, file);
        const md = join(root, PROGRESS_MD);
        if (!existsSync(md) || readFileSync(md, "utf8") !== renderProgress(file))
          problems.push(`${PROGRESS_MD} is out of date: run \`pnpm progress render\``);
        if (problems.length) {
          problems.forEach((p) => err(p));
          return 1;
        }
        out(
          `progress.json matches ${ROADMAP_PATH} (${file.items.length} items); ${PROGRESS_MD} is current`,
        );
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (e) {
    if (e instanceof Refusal) {
      err(`refused: ${e.message}`);
      return 2;
    }
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof UsageError) err(USAGE);
    return 1;
  }
}
