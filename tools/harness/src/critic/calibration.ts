/**
 * Critic calibration (ROADMAP M0-06, research 05 §B.9 "Critic calibration"): before any critic
 * round counts, fresh blind critics score the house-style reference images and a deliberately
 * rough "grey default three.js" fixture with the real rubric. The references must land at 9–10
 * and the fixture at 4–6; if not, the rubric anchors are revised and the run repeated.
 *
 * Protocol, mirroring a real round (DOD §4.3, §7):
 *  - every subject is scored in isolation by `critics` (default 2) fresh critics, each in its own
 *    workspace holding only `shot.png`, RUBRIC.md and report.schema.json — no file names, no
 *    other images, no hint of which subjects are references;
 *  - the reply must validate against report.schema.json (an invalid reply is re-spawned once);
 *  - the critics are merged per §4.3 (★ = min, others = mean; a third critic and the median
 *    when two disagree by more than 1.5), and the subject's score is the merged group mean.
 */
import { createHash, randomInt } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import sharp from "sharp";
import type { CriticRunner } from "./critic-runner.ts";
import { FIXTURE_PNG } from "./fixture.ts";
import { type ReferenceManifest, referencePath } from "./references.ts";
import {
  SCHEMA_PATH,
  type CriticReport,
  type GroupScores,
  createReportValidator,
  DEDUCTION,
  deductionProblems,
  extractJson,
  groupMean,
  mergeGroup,
  needsThirdCritic,
} from "./report.ts";
import { RUBRIC_PATH, type Rubric, loadRubric } from "./rubric.ts";

export type SubjectKind = "reference" | "fixture";

/** Target score band per subject kind (ROADMAP M0-06 Accept). Inclusive. */
export const EXPECTED: Record<SubjectKind, { min: number; max: number }> = {
  reference: { min: 9, max: 10 },
  fixture: { min: 4, max: 6 },
};

/** The single group every calibration shot is scored as. It carries no hint of the source. */
export const CALIBRATION_GROUP = "calib/1280x720";
export const CALIBRATION_DIR = "artifacts/critic/_calibration";

export interface CalibrationSubject {
  kind: SubjectKind;
  /** Human label, e.g. `_style/tiny-glade-02.png`. Never shown to a critic. */
  label: string;
  /** Path relative to the repo root. */
  source: string;
}

export interface BlindSubject extends CalibrationSubject {
  /** Anonymous id used in logs and workspaces, e.g. `S07`. */
  blindId: string;
}

/** The `_style` references plus the grey fixture. */
export function calibrationSubjects(
  root: string,
  manifest: ReferenceManifest,
): CalibrationSubject[] {
  const refs = manifest.entries
    .filter((e) => e.set === "_style")
    .map((e): CalibrationSubject => ({
      kind: "reference",
      label: `${e.set}/${e.file}`,
      source: relative(root, referencePath(root, e)).replaceAll("\\", "/"),
    }));
  return [...refs, { kind: "fixture", label: "grey-default-threejs", source: FIXTURE_PNG }];
}

/** Deterministic PRNG (mulberry32) so a blind order can be reproduced from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffles the subjects (Fisher–Yates, seeded) and gives each an anonymous id. */
export function blindOrder(subjects: CalibrationSubject[], seed: number): BlindSubject[] {
  const rand = mulberry32(seed);
  const a = [...subjects];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as CalibrationSubject, a[i] as CalibrationSubject];
  }
  return a.map((s, i) => ({ ...s, blindId: `S${String(i + 1).padStart(2, "0")}` }));
}

/** RUBRIC §4.1: an item below the reference anchor has at least one issue saying what cost it. */
export const ISSUE_BELOW = DEDUCTION.anchor;

/** RUBRIC §4.1 / DOD §5: an item below the reference band has a major (★ < 8.5: blocker) issue. */
export const MAJOR_BELOW = DEDUCTION.bandFloor;

/**
 * The calibration critic prompt: DOD §6.2 narrowed to one blind still. The house-specific items
 * are read "in principle" because there is no golden yet (DOD §7, "Calibration first").
 */
export function calibrationPrompt(rubric: Rubric, criticId: string): string {
  const stars = rubric.items.filter((i) => i.star).map((i) => i.id);
  const nulls = rubric.items.filter((i) => i.clip || i.phone).map((i) => i.id);
  const all = rubric.items.map((i) => i.id);
  return `You are a ruthless visual and UX critic for a cozy, lofi, AAA-polish streamer party game.
This is a CALIBRATION round. You score ONE screenshot, ./shot.png (a 1280x720 desktop still).
You know nothing about where it came from and must not guess its origin, search for it, or let a
recognised title change your score: judge only the pixels against the rubric.
Inputs, only (open nothing else, list no directories): ./shot.png, ./board.png, ./RUBRIC.md,
./report.schema.json. ./board.png is a contact sheet of the house-style reference board
(docs/references/_style/, the bar the anchors put at 9–10); it never contains ./shot.png.

Step 1: read ./RUBRIC.md fully, look at ./board.png, then look at ./shot.png.
Step 2 SCORE every rubric item 1–10 using the §4.1 anchors and the "10 looks like" / "≤ 5 looks
 like" columns. One decimal allowed. Follow the rubric section "How to apply the anchors" exactly,
 item by item: first choose the item's band by comparing ./shot.png with ./board.png, then place
 the score inside that band from its anchor. Don't round up; if unsure between two bands, take the
 lower. There is no style golden yet (DOD §7), so read the house-specific items in principle:
 - Item 1: does every element read as ONE deliberate, cohesive, handcrafted art direction of
   premium cozy-indie calibre? Default engine materials, stock widgets or mixed styles are ≤ 5.
 - Items 3, 8, 11: palette discipline, typographic craft and accessibility judged in principle
   (there are no token hexes or font files to check). Browser-default fonts are ≤ 5 on item 8.
 - Items 13 and 17: score them only if the frame shows a moment (reveal, win) or audience/stream
   UI (room code, poll, timer, odds); otherwise null.
 - Items ${nulls.join(", ")} are null: they are clip-only or phone-only and this is one desktop still.
 - Any other item may be null only if nothing in the frame can be judged against it.
   The ★ items ${stars.join(", ")} must always be scored.
Step 3 ISSUES (RUBRIC §4.1 step 2: every deduction is named, and the score follows from the
 issues). Every scored item < ${ISSUE_BELOW.toFixed(1)} needs ≥ 1 issue for that item saying what cost it, with
 id (pattern CAL-R1-NN), item, severity, files ["shot.png"], region, violated rule (cite the
 rubric item/anchor), and a concrete fix. Severity: an item < ${MAJOR_BELOW.toFixed(1)} needs a major issue
 naming its glance-visible shortfall (a ★ item < ${DEDUCTION.blockerBelow.toFixed(1)}: a blocker); inside the
 reference band the issues are minor, and an item whose issues are all minor scores at least
 ${ISSUE_BELOW.toFixed(1)} minus ${DEDUCTION.perMinor.toFixed(1)} per issue, never below ${MAJOR_BELOW.toFixed(1)}. No vague notes. A reply that breaks
 these rules is rejected.

Output ONLY JSON valid against ./report.schema.json, with: "game": "calibration", "round": 1,
"critic": "${criticId}", "ab": [], "scores": { "${CALIBRATION_GROUP}": { one key per item ${all.join(", ")}
as a string, value a number or null } }, "clipScores": {}, "minScore" = your lowest non-null score,
"pass" = RUBRIC §4.3 bar 1 applied to your single group, and "issues".`;
}

/**
 * The prompt for a re-spawned critic (DOD §7): the same task plus what the validator rejected in
 * the previous reply. The problems are about the reply's shape, never about the subject.
 */
export function retryPrompt(prompt: string, problems: string[]): string {
  const list = problems.length ? problems.slice(0, 10) : ["no valid JSON report"];
  return `${prompt}

A previous reply to this exact task was rejected by the report validator:
${list.map((p) => ` - ${p}`).join("\n")}
Score the shot afresh by the rubric and make sure your reply does not have these problems.`;
}

/** Contact-sheet geometry for the reference board a calibration critic compares against. */
export const BOARD = { columns: 5, tileWidth: 320, tileHeight: 180, gap: 8 } as const;

/**
 * Tiles the given reference subjects into one PNG (DOD §3: critics get contact sheets, not
 * dozens of files). The order is shuffled with `seed` so it carries no source grouping.
 */
export async function boardSheet(
  root: string,
  refs: CalibrationSubject[],
  seed: number,
): Promise<Buffer> {
  if (refs.length === 0) throw new Error("boardSheet needs at least one reference");
  const order = blindOrder(refs, seed);
  const { columns, tileWidth: w, tileHeight: h, gap } = BOARD;
  const rows = Math.ceil(order.length / columns);
  const tiles = await Promise.all(
    order.map(async (s, i) => ({
      input: await sharp(join(root, s.source)).resize(w, h, { fit: "cover" }).png().toBuffer(),
      left: gap + (i % columns) * (w + gap),
      top: gap + Math.floor(i / columns) * (h + gap),
    })),
  );
  return sharp({
    create: {
      width: gap + columns * (w + gap),
      height: gap + rows * (h + gap),
      channels: 3,
      background: { r: 40, g: 36, b: 44 },
    },
  })
    .composite(tiles)
    .png()
    .toBuffer();
}

/** Problems with a schema-valid report that would make it useless for calibration. */
export function calibrationReportProblems(report: CriticReport, rubric: Rubric): string[] {
  const problems: string[] = [];
  const group = report.scores[CALIBRATION_GROUP];
  if (!group) return [`scores has no "${CALIBRATION_GROUP}" group`];
  for (const item of rubric.items) {
    const k = String(item.id);
    if (!(k in group)) problems.push(`item ${k} is missing (use null for n/a)`);
    else if (item.star && typeof group[k] !== "number") problems.push(`★ item ${k} must be scored`);
  }
  const scored = Object.values(group).filter((v) => typeof v === "number");
  if (scored.length === 0) problems.push("no item is scored");
  problems.push(...deductionProblems(stillScores(group, rubric), report.issues, rubric));
  return problems;
}

/** Keeps only the items a desktop still can be judged on (clip and phone items → null). */
export function stillScores(group: GroupScores, rubric: Rubric): GroupScores {
  const out: GroupScores = {};
  for (const item of rubric.items) {
    const v = group[String(item.id)];
    out[String(item.id)] = item.clip || item.phone || typeof v !== "number" ? null : v;
  }
  return out;
}

export interface CriticRun {
  critic: string;
  attempts: number;
  model?: string;
  costUsd?: number;
  mean: number;
  scores: GroupScores;
  report: CriticReport;
}

export interface SubjectResult extends BlindSubject {
  /** sha256 of the exact image bytes the critics scored (`--check` flags a changed image). */
  sha256: string;
  expected: { min: number; max: number };
  critics: CriticRun[];
  thirdCritic: boolean;
  merged: GroupScores;
  /** Merged group mean over the scored items: the subject's calibration score. */
  mean: number;
  /** Lowest merged ★ item. */
  starMin: number;
  inRange: boolean;
}

export interface CalibrationResult {
  id: "M0-06-calibration";
  runId: string;
  at: string;
  seed: number;
  criticsPerSubject: number;
  rubricSha256: string;
  schemaSha256: string;
  /**
   * sha256 of the critic protocol: the calibration prompt, the deduction rules the replies are
   * validated against, and the score bands (see {@link protocolSha256}).
   */
  protocolSha256?: string;
  expected: typeof EXPECTED;
  subjects: SubjectResult[];
  summary: {
    references: { count: number; inRange: number; min: number; max: number; mean: number };
    fixture: { count: number; inRange: number; min: number; max: number; mean: number };
    totalCostUsd: number;
    models: string[];
  };
  pass: boolean;
  failures: string[];
}

export interface CalibrationOptions {
  root: string;
  rubric: Rubric;
  subjects: CalibrationSubject[];
  runner: CriticRunner;
  /** Fresh critics per subject (DOD §4.3 uses 2; a 3rd is added on disagreement). */
  critics?: number;
  /** Subjects scored in parallel. */
  concurrency?: number;
  seed?: number;
  /** Where the per-critic workspaces go; defaults to the OS temp dir. Removed afterwards. */
  workDir?: string;
  keepWorkspaces?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Fingerprint of the critic protocol a run used: the calibration prompt, the RUBRIC §4.1
 * deduction thresholds replies are validated against, and the expected bands. A run scored under
 * a different protocol does not count towards the Accept.
 */
export function protocolSha256(rubric: Rubric): string {
  return createHash("sha256")
    .update(JSON.stringify([calibrationPrompt(rubric, "critic-1"), DEDUCTION, EXPECTED]))
    .digest("hex");
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Runs `fn` over `items` with at most `limit` in flight. Every task runs to completion even when
 * another fails (so no critic process is orphaned mid-run); failures are thrown together at the end.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const errors: string[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  });
  await Promise.all(workers);
  if (errors.length) throw new Error(`${errors.length} task(s) failed:\n  ${errors.join("\n  ")}`);
  return out;
}

/** Awaits every promise; throws all rejections together only after all have settled. */
async function settleAll<R>(promises: Promise<R>[]): Promise<R[]> {
  const settled = await Promise.allSettled(promises);
  const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed.length) {
    throw new Error(
      failed
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join("; "),
    );
  }
  return settled.map((s) => (s as PromiseFulfilledResult<R>).value);
}

function stats(xs: number[]): { min: number; max: number; mean: number } {
  if (xs.length === 0) return { min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  return {
    min: round2(Math.min(...xs)),
    max: round2(Math.max(...xs)),
    mean: round2(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

/** Runs the whole calibration and returns the result (it does not write artifacts). */
export async function runCalibration(opts: CalibrationOptions): Promise<CalibrationResult> {
  const { root, rubric, runner } = opts;
  const critics = opts.critics ?? 2;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const seed = opts.seed ?? randomInt(1, 2 ** 31 - 1);
  const startedAt = now();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const schemaPath = join(root, SCHEMA_PATH);
  const rubricPath = join(root, RUBRIC_PATH);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const validate = createReportValidator(schema);
  const base = join(opts.workDir ?? tmpdir(), `sg-critic-calibration-${runId}`);
  const blind = blindOrder(opts.subjects, seed);

  const runCritic = async (subject: BlindSubject, n: number): Promise<CriticRun> => {
    const critic = `critic-${n}`;
    const workspace = join(base, `${subject.blindId}-c${n}`);
    mkdirSync(workspace, { recursive: true });
    copyFileSync(join(root, subject.source), join(workspace, "shot.png"));
    // Leave-one-out board: every reference except the subject itself, like the reference
    // images a real critic gets (DOD §6.2), in a seeded order.
    const others = opts.subjects.filter(
      (s) => s.kind === "reference" && s.source !== subject.source,
    );
    writeFileSync(join(workspace, "board.png"), await boardSheet(root, others, seed));
    copyFileSync(rubricPath, join(workspace, "RUBRIC.md"));
    copyFileSync(schemaPath, join(workspace, "report.schema.json"));
    const basePrompt = calibrationPrompt(rubric, critic);
    let lastProblems: string[] = [];
    // DOD §7: an invalid report re-spawns that critic once (a fresh session each time). The
    // re-spawned critic is told what the validator rejected; it learns nothing about the subject.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = attempt === 1 ? basePrompt : retryPrompt(basePrompt, lastProblems);
      try {
        const res = await runner({ workspace, prompt, schema });
        const value = typeof res.output === "string" ? extractJson(res.output) : res.output;
        const checked = validate(value);
        lastProblems = checked.ok
          ? calibrationReportProblems(checked.report, rubric)
          : checked.errors;
        if (checked.ok && lastProblems.length === 0) {
          const scores = stillScores(
            checked.report.scores[CALIBRATION_GROUP] as GroupScores,
            rubric,
          );
          const run: CriticRun = {
            critic,
            attempts: attempt,
            mean: round2(groupMean(scores)),
            scores,
            report: checked.report,
          };
          if (res.model !== undefined) run.model = res.model;
          if (res.costUsd !== undefined) run.costUsd = res.costUsd;
          log(`${subject.blindId} ${critic}: mean ${run.mean.toFixed(2)}`);
          return run;
        }
      } catch (err) {
        lastProblems = [err instanceof Error ? err.message : String(err)];
      }
      log(
        `${subject.blindId} ${critic}: invalid reply (attempt ${attempt}): ${lastProblems.slice(0, 3).join("; ")}`,
      );
    }
    throw new Error(
      `${subject.blindId} ${critic} produced no valid report: ${lastProblems.join("; ")}`,
    );
  };

  try {
    const subjects = await pool(
      blind,
      opts.concurrency ?? 3,
      async (subject): Promise<SubjectResult> => {
        const runs = await settleAll(
          Array.from({ length: critics }, (_, i) => runCritic(subject, i + 1)),
        );
        const thirdCritic = critics === 2 && needsThirdCritic([runs.map((r) => r.scores)], rubric);
        if (thirdCritic) {
          log(`${subject.blindId}: critics disagree by > 1.5, spawning a third`);
          runs.push(await runCritic(subject, 3));
        }
        const merged = mergeGroup(
          runs.map((r) => r.scores),
          rubric,
        );
        const mean = round2(groupMean(merged));
        const starVals = rubric.items
          .filter((i) => i.star)
          .map((i) => merged[String(i.id)])
          .filter((v): v is number => typeof v === "number");
        const expected = EXPECTED[subject.kind];
        return {
          ...subject,
          sha256: sha256(join(root, subject.source)),
          expected,
          critics: runs,
          thirdCritic,
          merged,
          mean,
          starMin: round2(Math.min(...starVals)),
          inRange: mean >= expected.min && mean <= expected.max,
        };
      },
    );
    return summarise({
      runId,
      at: startedAt.toISOString(),
      seed,
      criticsPerSubject: critics,
      rubricSha256: sha256(rubricPath),
      schemaSha256: sha256(schemaPath),
      protocolSha256: protocolSha256(rubric),
      subjects,
    });
  } finally {
    if (!opts.keepWorkspaces) {
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        log(`could not remove ${base}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** Computes the summary, the verdict and the failure list from scored subjects. */
export function summarise(
  partial: Pick<
    CalibrationResult,
    "runId" | "at" | "seed" | "criticsPerSubject" | "rubricSha256" | "schemaSha256" | "subjects"
  > &
    Partial<Pick<CalibrationResult, "protocolSha256">>,
): CalibrationResult {
  const refs = partial.subjects.filter((s) => s.kind === "reference");
  const fixtures = partial.subjects.filter((s) => s.kind === "fixture");
  const failures: string[] = [];
  if (refs.length === 0) failures.push("no reference images were scored");
  if (fixtures.length === 0) failures.push("no rough fixture was scored");
  for (const s of partial.subjects) {
    if (!s.inRange) {
      failures.push(
        `${s.label} (${s.kind}) scored ${s.mean.toFixed(2)}; expected ${s.expected.min}–${s.expected.max}`,
      );
    }
  }
  const allRuns = partial.subjects.flatMap((s) => s.critics);
  return {
    id: "M0-06-calibration",
    ...partial,
    expected: EXPECTED,
    summary: {
      references: {
        count: refs.length,
        inRange: refs.filter((s) => s.inRange).length,
        ...stats(refs.map((s) => s.mean)),
      },
      fixture: {
        count: fixtures.length,
        inRange: fixtures.filter((s) => s.inRange).length,
        ...stats(fixtures.map((s) => s.mean)),
      },
      totalCostUsd: round2(allRuns.reduce((a, r) => a + (r.costUsd ?? 0), 0)),
      models: [...new Set(allRuns.map((r) => r.model).filter((m): m is string => !!m))].sort(),
    },
    pass: failures.length === 0,
    failures,
  };
}

/** Writes `<runId>.json` and `latest.json` under artifacts/critic/_calibration/. */
export function writeCalibration(
  root: string,
  result: CalibrationResult,
): { run: string; latest: string } {
  const dir = join(root, CALIBRATION_DIR);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  const run = join(dir, `${result.runId}.json`);
  const latest = join(dir, "latest.json");
  writeFileSync(run, body);
  writeFileSync(latest, body);
  return { run, latest };
}

/** A compact, human-readable table of a result for the terminal. */
export function formatCalibration(result: CalibrationResult): string {
  const rows = [...result.subjects]
    .sort((a, b) =>
      a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "fixture" ? 1 : -1,
    )
    .map((s) => {
      const per = s.critics.map((c) => c.mean.toFixed(2)).join(" / ");
      return `${s.inRange ? "ok  " : "FAIL"} ${s.blindId} ${s.kind.padEnd(9)} ${s.label.padEnd(40)} ${s.mean.toFixed(2)}  (critics ${per}${s.thirdCritic ? ", 3rd" : ""}; ★min ${s.starMin.toFixed(1)})`;
    });
  const r = result.summary.references;
  const f = result.summary.fixture;
  return [
    ...rows,
    `references: ${r.inRange}/${r.count} in ${EXPECTED.reference.min}–${EXPECTED.reference.max} (min ${r.min}, mean ${r.mean})`,
    `fixture:    ${f.inRange}/${f.count} in ${EXPECTED.fixture.min}–${EXPECTED.fixture.max} (mean ${f.mean})`,
    `calibration ${result.pass ? "PASSED" : "FAILED"} (seed ${result.seed}, cost $${result.summary.totalCostUsd})`,
    ...result.failures.map((x) => `  - ${x}`),
  ].join("\n");
}

export const CALIBRATION_DOC = "docs/critic/CALIBRATION.md";

/**
 * How many consecutive passing runs (with distinct seeds) the Accept needs. The number lives in
 * CALIBRATION.md as `**Required streak:** N` so the document and the check can't disagree.
 * Returns undefined when the document or the line is missing.
 */
export function requiredStreak(root: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, CALIBRATION_DOC), "utf8");
  } catch {
    return undefined;
  }
  const m = /\*\*Required streak:\*\*\s*(\d+)/.exec(text);
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Every recorded run file under artifacts/critic/_calibration/ (not latest.json), oldest first. */
export function recordedRuns(root: string): CalibrationResult[] {
  const dir = join(root, CALIBRATION_DIR);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "latest.json");
  } catch {
    return [];
  }
  const runs: CalibrationResult[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as CalibrationResult;
      if (r.id === "M0-06-calibration" && Array.isArray(r.subjects)) runs.push(r);
    } catch {
      // not a calibration run; ignore
    }
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId));
}

/** The calibration configuration a run must match to count: rubric, schema and subject images. */
export interface CalibrationConfig {
  rubricSha256: string;
  schemaSha256: string;
  protocolSha256: string;
  /** `kind:label` → sha256 of the image on disk (undefined when the file is missing). */
  images: Map<string, string | undefined>;
}

/** The current configuration: the rubric and schema on disk, the `_style` board and the fixture. */
export function currentConfig(root: string, manifest: ReferenceManifest): CalibrationConfig {
  const images = new Map<string, string | undefined>();
  for (const s of calibrationSubjects(root, manifest)) {
    const path = join(root, s.source);
    images.set(`${s.kind}:${s.label}`, existsSync(path) ? sha256(path) : undefined);
  }
  let protocol: string;
  try {
    protocol = protocolSha256(loadRubric(root));
  } catch (err) {
    // An unparseable rubric has no protocol; no recorded run can match it.
    protocol = `unparseable rubric: ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    rubricSha256: sha256(join(root, RUBRIC_PATH)),
    schemaSha256: sha256(join(root, SCHEMA_PATH)),
    protocolSha256: protocol,
    images,
  };
}

/** Why a recorded run does not belong to `config` (empty = it was scored on this configuration). */
export function staleReasons(run: CalibrationResult, config: CalibrationConfig): string[] {
  const reasons: string[] = [];
  if (run.rubricSha256 !== config.rubricSha256) reasons.push("scored against an older RUBRIC.md");
  if (run.protocolSha256 !== config.protocolSha256)
    reasons.push("scored with another critic protocol (prompt, deduction rules or bands)");
  if (run.schemaSha256 !== config.schemaSha256)
    reasons.push("scored against an older report.schema.json");
  const want = [...config.images.keys()].sort();
  const got = run.subjects.map((s) => `${s.kind}:${s.label}`).sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    reasons.push("does not cover exactly the current _style references plus the grey fixture");
    return reasons;
  }
  for (const s of run.subjects) {
    const now = config.images.get(`${s.kind}:${s.label}`);
    if (s.sha256 === undefined) reasons.push(`${s.label}: no image hash recorded`);
    else if (now !== s.sha256) reasons.push(`${s.label}: the image differs from the one scored`);
  }
  return reasons;
}

/** Why a run on the current configuration misses the Accept (empty = it passes). */
export function runProblems(run: CalibrationResult): string[] {
  const problems: string[] = [];
  for (const s of run.subjects) {
    const band = EXPECTED[s.kind];
    if (s.critics.length < 2)
      problems.push(`${s.label}: scored by ${s.critics.length} critic(s); needs ≥ 2`);
    if (!(s.mean >= band.min && s.mean <= band.max)) {
      problems.push(
        `${s.label} (${s.kind}) scored ${s.mean.toFixed(2)}; expected ${band.min}–${band.max}`,
      );
    }
  }
  return problems;
}

export interface CalibrationStatus {
  /** Empty = the ROADMAP M0-06 Accept holds. */
  problems: string[];
  /** Required consecutive passing runs, from CALIBRATION.md. */
  required: number | undefined;
  /** Runs on the current configuration, oldest first, each with its problems. */
  current: { runId: string; seed: number; pass: boolean; problems: string[] }[];
}

/**
 * ROADMAP M0-06 Accept, checked against the recorded runs (`pnpm critic:calibrate --check`).
 * A run counts only if it was scored on the current configuration: the current RUBRIC.md and
 * report.schema.json, exactly the current `_style` references plus the grey fixture, and the same
 * image bytes (sha256 per subject). The latest N such runs (N = `**Required streak:**` in
 * CALIBRATION.md) must all pass, with distinct seeds; a failed run on the current configuration
 * breaks the streak. A run passes when every subject had ≥ 2 critics, every reference scored 9–10
 * and the fixture 4–6. `latest.json` must be the newest recorded run.
 */
export function calibrationStatus(root: string, manifest: ReferenceManifest): CalibrationStatus {
  const required = requiredStreak(root);
  const problems: string[] = [];
  if (required === undefined) {
    problems.push(`${CALIBRATION_DOC} does not state the "**Required streak:** N" line`);
  }
  const config = currentConfig(root, manifest);
  const missing = [...config.images].filter(([, h]) => h === undefined).map(([k]) => k);
  if (missing.length) {
    problems.push(
      `${missing.length} subject image(s) are missing (${missing.join(", ")}); run \`pnpm refs:fetch\``,
    );
  }
  const runs = recordedRuns(root);
  let latest: CalibrationResult | undefined;
  try {
    latest = JSON.parse(
      readFileSync(join(root, CALIBRATION_DIR, "latest.json"), "utf8"),
    ) as CalibrationResult;
  } catch {
    latest = undefined;
  }
  if (!latest || runs.length === 0) {
    problems.push(
      `no readable calibration run under ${CALIBRATION_DIR}/; run \`pnpm critic:calibrate\``,
    );
    return { problems, required, current: [] };
  }
  if (latest.runId !== runs[runs.length - 1]?.runId) {
    problems.push("latest.json is not the newest recorded run");
  }
  const current = runs
    .filter((r) => staleReasons(r, config).length === 0)
    .map((r) => {
      const p = runProblems(r);
      return { runId: r.runId, seed: r.seed, pass: p.length === 0, problems: p };
    });
  if (current.length === 0) {
    const why = staleReasons(latest, config);
    problems.push(
      `no recorded run matches the current rubric, schema and images (latest: ${why.slice(0, 3).join("; ")}); re-run \`pnpm critic:calibrate\``,
    );
    return { problems, required, current };
  }
  const n = required ?? 1;
  const streak = current.slice(-n);
  if (streak.length < n) {
    problems.push(
      `only ${streak.length} run(s) on the current configuration; the Accept needs ${n} consecutive passing runs`,
    );
  }
  for (const r of streak) {
    for (const p of r.problems) problems.push(`run ${r.runId}: ${p}`);
  }
  const seeds = new Set(streak.map((r) => r.seed));
  if (seeds.size !== streak.length)
    problems.push("the streak's runs do not all have distinct seeds");
  return { problems, required, current };
}

/** The problems of {@link calibrationStatus} (empty = accepted). */
export function checkRecordedCalibration(root: string, manifest: ReferenceManifest): string[] {
  return calibrationStatus(root, manifest).problems;
}
