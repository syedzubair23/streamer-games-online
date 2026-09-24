/**
 * Reading, validating and writing `progress.json`, with a lock file so agents running
 * `pnpm progress set` at the same time never lose each other's updates.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  MAX_NOTE_LINE_LENGTH,
  MAX_NOTE_LINES,
  PROGRESS_COMMENT,
  isStatus,
  type ProgressFile,
  type ProgressItem,
} from "./model.ts";

export const PROGRESS_JSON = "progress.json";
export const PROGRESS_MD = "PROGRESS.md";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates notes against the research 05 §B.10 cap. Returns a problem or `null`. */
export function notesProblem(notes: string): string | null {
  const lines = notes.split("\n");
  if (lines.length > MAX_NOTE_LINES) return `notes are capped at ${MAX_NOTE_LINES} lines`;
  const long = lines.find((l) => l.length > MAX_NOTE_LINE_LENGTH);
  if (long !== undefined) return `each notes line is capped at ${MAX_NOTE_LINE_LENGTH} characters`;
  return null;
}

/** Throws a descriptive error unless `value` is a well-formed progress document. */
export function validateProgress(value: unknown): ProgressFile {
  const problems: string[] = [];
  if (!isRecord(value)) throw new Error("progress.json: not a JSON object");
  if (value["version"] !== 1) problems.push("version must be 1");
  const items = value["items"];
  if (!Array.isArray(items)) throw new Error("progress.json: items must be an array");
  const seen = new Set<string>();
  items.forEach((raw: unknown, i) => {
    const at = `items[${i}]`;
    if (!isRecord(raw)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const id = raw["id"];
    const where = typeof id === "string" ? `${at} (${id})` : at;
    const str = (k: string): boolean => typeof raw[k] === "string";
    const strOrNull = (k: string): boolean => raw[k] === null || typeof raw[k] === "string";
    if (typeof id !== "string" || id === "") problems.push(`${at}.id must be a non-empty string`);
    else if (seen.has(id)) problems.push(`${where}: duplicate id`);
    else seen.add(id);
    if (!str("title")) problems.push(`${where}.title must be a string`);
    if (!str("milestone")) problems.push(`${where}.milestone must be a string`);
    if (raw["kind"] !== "platform" && raw["kind"] !== "game")
      problems.push(`${where}.kind must be platform|game`);
    if (!strOrNull("game")) problems.push(`${where}.game must be a string or null`);
    if (typeof raw["visual"] !== "boolean") problems.push(`${where}.visual must be a boolean`);
    if (!isStatus(raw["status"]))
      problems.push(`${where}.status ${JSON.stringify(raw["status"])} is not a status`);
    if (!strOrNull("owner")) problems.push(`${where}.owner must be a string or null`);
    for (const k of ["criticRound", "maxRounds"]) {
      const n = raw[k];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
        problems.push(`${where}.${k} must be a non-negative integer`);
    }
    if (!strOrNull("blockedReason"))
      problems.push(`${where}.blockedReason must be a string or null`);
    if (raw["status"] === "blocked" && !raw["blockedReason"])
      problems.push(`${where}: blocked without blockedReason`);
    if (!str("notes")) problems.push(`${where}.notes must be a string`);
    else {
      const p = notesProblem(raw["notes"] as string);
      if (p) problems.push(`${where}: ${p}`);
    }
    if (!strOrNull("updated")) problems.push(`${where}.updated must be a string or null`);
    const ev = raw["evidence"];
    if (!isRecord(ev)) problems.push(`${where}.evidence must be an object`);
    else {
      if (typeof ev["handoff"] !== "string")
        problems.push(`${where}.evidence.handoff must be a string`);
      if (typeof ev["verify"] !== "string")
        problems.push(`${where}.evidence.verify must be a string`);
      if (ev["critic"] !== null && typeof ev["critic"] !== "string")
        problems.push(`${where}.evidence.critic must be a string or null`);
      if (raw["visual"] === true && typeof ev["critic"] !== "string")
        problems.push(`${where}: visual item without evidence.critic`);
      if (!Array.isArray(ev["gates"]) || !ev["gates"].every((g) => typeof g === "string"))
        problems.push(`${where}.evidence.gates must be an array of strings`);
    }
  });
  if (problems.length) throw new Error(`progress.json is invalid:\n  - ${problems.join("\n  - ")}`);
  return value as unknown as ProgressFile;
}

export function readProgress(root: string): ProgressFile {
  const path = join(root, PROGRESS_JSON);
  if (!existsSync(path))
    throw new Error(`no ${PROGRESS_JSON} in ${root} (run \`pnpm progress sync\`)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `${PROGRESS_JSON} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return validateProgress(parsed);
}

/** Serializes with a fixed key order so the file diffs cleanly and round-trips byte-for-byte. */
export function serializeProgress(file: ProgressFile): string {
  const items = file.items.map((i): ProgressItem => ({
    id: i.id,
    title: i.title,
    milestone: i.milestone,
    kind: i.kind,
    game: i.game,
    visual: i.visual,
    status: i.status,
    owner: i.owner,
    criticRound: i.criticRound,
    maxRounds: i.maxRounds,
    blockedReason: i.blockedReason,
    notes: i.notes,
    updated: i.updated,
    evidence: {
      handoff: i.evidence.handoff,
      verify: i.evidence.verify,
      critic: i.evidence.critic,
      gates: [...i.evidence.gates],
    },
  }));
  return `${JSON.stringify({ $comment: PROGRESS_COMMENT, version: 1, items }, null, 2)}\n`;
}

/** Writes `path` via a temp file + rename so readers never see a half-written file. */
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      // Windows can refuse the rename while another process briefly has the file open.
      if (attempt >= 20) {
        rmSync(tmp, { force: true });
        throw err;
      }
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* short spin between retries */
      }
    }
  }
}

const LOCK_STALE_MS = 30_000;

/**
 * Runs `fn` while holding `progress.json.lock`. Waits up to `timeoutMs` for another holder;
 * a lock older than 30 s is treated as abandoned (its process crashed) and removed.
 */
export async function withLock<T>(root: string, fn: () => T, timeoutMs = 10_000): Promise<T> {
  const lock = join(root, `${PROGRESS_JSON}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      if (!(isRecord(err) && err["code"] === "EEXIST")) throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // the holder released it between our open and stat
      }
      if (Date.now() > deadline)
        throw new Error(`${PROGRESS_JSON} is locked by another process (${lock})`, { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
