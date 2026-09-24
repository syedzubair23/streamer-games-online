/**
 * M0-06 calibration: the protocol (blind isolated critics, schema validation with one re-spawn,
 * DOD §4.3 merge, score bands), and the recorded calibration run that proves the acceptance
 * criterion: references at 9–10, the grey three.js fixture at 4–6.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD,
  CALIBRATION_DIR,
  CALIBRATION_DOC,
  CALIBRATION_GROUP,
  type CalibrationSubject,
  EXPECTED,
  ISSUE_BELOW,
  MAJOR_BELOW,
  blindOrder,
  boardSheet,
  calibrationPrompt,
  calibrationReportProblems,
  calibrationStatus,
  calibrationSubjects,
  checkRecordedCalibration,
  currentConfig,
  formatCalibration,
  mulberry32,
  pool,
  protocolSha256,
  recordedRuns,
  requiredStreak,
  retryPrompt,
  runCalibration,
  runProblems,
  staleReasons,
  stillScores,
  summarise,
  writeCalibration,
} from "../src/critic/calibration.ts";
import type { CriticRequest, CriticRunner } from "../src/critic/critic-runner.ts";
import { FIXTURE_PNG } from "../src/critic/fixture.ts";
import { loadManifest } from "../src/critic/references.ts";
import { type CriticReport, DEDUCTION } from "../src/critic/report.ts";
import { loadRubric } from "../src/critic/rubric.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rubric = loadRubric(root);
const manifest = loadManifest(root);
const sha = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

/**
 * A schema-valid calibration report giving every still item `score` (★ items `star`). Like a
 * rule-following critic it names every deduction below 9.5, with DOD §5 severity, unless `bare`.
 */
function report(score: number, star = score, critic = "critic-1", bare = false): CriticReport {
  const group: Record<string, number | null> = {};
  const issues: CriticReport["issues"] = [];
  for (const it of rubric.items) {
    const v = it.clip || it.phone ? null : it.star ? star : score;
    group[String(it.id)] = v;
    if (bare || v === null || v >= ISSUE_BELOW) continue;
    // inside the reference band each minor issue costs at most 0.2 (RUBRIC §4.1 step 2)
    const n = v >= MAJOR_BELOW ? Math.ceil((ISSUE_BELOW - v) / DEDUCTION.perMinor - 1e-9) : 1;
    for (let k = 0; k < n; k++)
      issues.push({
        id: `CAL-R1-${String(issues.length + 1).padStart(2, "0")}`,
        item: it.id,
        severity: v >= MAJOR_BELOW ? "minor" : it.star && v < 8.5 ? "blocker" : "major",
        files: ["shot.png"],
        region: "centre",
        problem: "p",
        rule: `RUBRIC item ${it.id}`,
        fix: "f",
      });
  }
  return {
    game: "calibration",
    round: 1,
    critic,
    pass: false,
    ab: [],
    scores: { [CALIBRATION_GROUP]: group },
    clipScores: {},
    minScore: Math.min(score, star),
    issues,
  };
}

describe("subjects and blind order", () => {
  const subjects = calibrationSubjects(root, manifest);

  it("are the _style references plus the grey fixture", () => {
    const refs = subjects.filter((s) => s.kind === "reference");
    expect(refs).toHaveLength(manifest.entries.filter((e) => e.set === "_style").length);
    expect(refs.every((s) => s.source.startsWith("docs/references/_style/"))).toBe(true);
    expect(subjects.filter((s) => s.kind === "fixture")).toEqual([
      { kind: "fixture", label: "grey-default-threejs", source: FIXTURE_PNG },
    ]);
  });

  it("is a seeded, reproducible permutation with anonymous ids", () => {
    const a = blindOrder(subjects, 42);
    expect(blindOrder(subjects, 42)).toEqual(a);
    expect(blindOrder(subjects, 43).map((s) => s.label)).not.toEqual(a.map((s) => s.label));
    expect(a.map((s) => s.label).sort()).toEqual(subjects.map((s) => s.label).sort());
    expect(a.map((s) => s.blindId)).toEqual(
      subjects.map((_, i) => `S${String(i + 1).padStart(2, "0")}`),
    );
    const r = mulberry32(1);
    const xs = Array.from({ length: 1000 }, r);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it("the critic prompt never names a subject and pins the group and item rules", () => {
    const prompt = calibrationPrompt(rubric, "critic-9");
    for (const s of subjects) expect(prompt).not.toContain(s.label);
    expect(prompt).not.toMatch(/fixture|grey default|three.js|prototype/i);
    expect(prompt).toContain("it never contains ./shot.png");
    expect(prompt).toContain(CALIBRATION_GROUP);
    expect(prompt).toContain('"critic-9"');
    expect(prompt).toContain("Items 12, 14, 16 are null");
    expect(prompt).toContain("★ items 1, 2, 6, 15 must always be scored");
  });
});

describe("boardSheet", () => {
  const refs = calibrationSubjects(root, manifest).filter((s) => s.kind === "reference");
  it.runIf(refs.every((s) => existsSync(join(root, s.source))))(
    "tiles the references into one seeded contact sheet",
    async () => {
      const png = await boardSheet(root, refs.slice(0, 7), 5);
      const meta = await sharp(png).metadata();
      expect(meta.width).toBe(BOARD.gap + BOARD.columns * (BOARD.tileWidth + BOARD.gap));
      expect(meta.height).toBe(BOARD.gap + 2 * (BOARD.tileHeight + BOARD.gap));
      expect((await boardSheet(root, refs.slice(0, 7), 5)).equals(png)).toBe(true);
    },
  );
  it("refuses an empty board", async () => {
    await expect(boardSheet(root, [], 1)).rejects.toThrow(/at least one reference/);
  });
});

describe("report checks", () => {
  it("accepts a complete report and names what is missing", () => {
    expect(calibrationReportProblems(report(8), rubric)).toEqual([]);
    const noGroup = report(8);
    noGroup.scores = { "other/1x1": {} };
    expect(calibrationReportProblems(noGroup, rubric)).toEqual([
      `scores has no "${CALIBRATION_GROUP}" group`,
    ]);
    const holes = report(8);
    const g = holes.scores[CALIBRATION_GROUP] as Record<string, number | null>;
    delete g["3"];
    g["6"] = null;
    expect(calibrationReportProblems(holes, rubric)).toEqual([
      "item 3 is missing (use null for n/a)",
      "★ item 6 must be scored",
    ]);
    const empty = report(8);
    for (const k of Object.keys(empty.scores[CALIBRATION_GROUP] as object)) {
      (empty.scores[CALIBRATION_GROUP] as Record<string, null>)[k] = null;
    }
    expect(calibrationReportProblems(empty, rubric)).toContain("no item is scored");
  });

  it("rejects an unnamed deduction below 9.5 (RUBRIC §4.1 step 2)", () => {
    expect(calibrationReportProblems(report(9.5, 9.6, "c", true), rubric)).toEqual([]);
    const bare = calibrationReportProblems(report(9.5, 9.2, "c", true), rubric);
    expect(bare).toEqual(
      [1, 2, 6, 15].map(
        (i) =>
          `item ${i} is scored 9.2 (< 9.5) with no issue saying what cost it (RUBRIC §4.1 step 2)`,
      ),
    );
    // clip/phone items are dropped anyway and need no issue
    const clip = report(9.5, 9.5, "c", true);
    (clip.scores[CALIBRATION_GROUP] as Record<string, number | null>)["12"] = 7;
    expect(calibrationReportProblems(clip, rubric)).toEqual([]);
  });

  it("ties scores to issue severity (RUBRIC §4.1 step 2, DOD §5)", () => {
    const r = report(8, 8.2);
    expect(calibrationReportProblems(r, rubric)).toEqual([]);
    for (const i of r.issues) i.severity = "minor";
    const problems = calibrationReportProblems(r, rubric);
    expect(problems).toContain(
      "item 3 is scored 8 (< 9) but has no major issue naming the shortfall (RUBRIC §4.1, DOD §5)",
    );
    expect(problems).toContain(
      "item 1 is scored 8.2 (< 9) but has no blocker issue naming the shortfall (RUBRIC §4.1, DOD §5)",
    );
    for (const i of r.issues) i.severity = "major";
    expect(calibrationReportProblems(r, rubric).every((p) => /blocker issue/.test(p))).toBe(true);
    // a ★ item between 8.5 and 9.0 needs a major issue, not a blocker
    expect(calibrationReportProblems(report(9.5, 8.7), rubric)).toEqual([]);
    // minor issues cost at most 0.2 each inside the reference band
    const one = report(9.5, 9.3);
    expect(calibrationReportProblems(one, rubric)).toEqual([]);
    const g = one.scores[CALIBRATION_GROUP] as Record<string, number | null>;
    g["1"] = 9.2;
    expect(calibrationReportProblems(one, rubric)).toEqual([
      "item 1 is scored 9.2 with 1 minor issue(s), which cost at most 0.2: score it ≥ 9.3 or name a major shortfall (RUBRIC §4.1 step 2)",
    ]);
    const many = report(9.5, 9.0);
    expect(many.issues.filter((i) => i.item === 1)).toHaveLength(3);
    expect(calibrationReportProblems(many, rubric)).toEqual([]);
    // a major issue may carry an item that stays in the band
    const major = report(9.5, 9.2, "c", true);
    for (const id of [1, 2, 6, 15])
      major.issues.push({ ...(report(8).issues[0] as CriticReport["issues"][number]), item: id });
    expect(calibrationReportProblems(major, rubric)).toEqual([]);
  });

  it("a re-spawned critic is told what was rejected, and nothing about the subject", () => {
    const base = calibrationPrompt(rubric, "critic-1");
    const retry = retryPrompt(base, ["item 7 is scored 9 (< 9.5) with no issue"]);
    expect(retry.startsWith(base)).toBe(true);
    expect(retry).toContain(" - item 7 is scored 9 (< 9.5) with no issue");
    expect(retryPrompt(base, [])).toContain(" - no valid JSON report");
  });

  it("drops clip and phone items from a still's scores", () => {
    const g = {
      ...(report(8).scores[CALIBRATION_GROUP] as Record<string, number | null>),
      "12": 9,
      "14": 9,
      "16": 9,
    };
    const s = stillScores(g, rubric);
    expect([s["12"], s["14"], s["16"], s["1"]]).toEqual([null, null, null, 8]);
  });
});

describe("pool", () => {
  it("respects the limit and reports every failure after all tasks finish", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const task = async (n: number): Promise<number> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      done.push(n);
      if (n % 3 === 0) throw new Error(`boom ${n}`);
      return n * 2;
    };
    await expect(pool([1, 2, 3, 4, 5, 6], 2, task)).rejects.toThrow(
      /2 task\(s\) failed:\n {2}boom 3\n {2}boom 6/,
    );
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
    expect(await pool([1, 2], 5, async (n) => n + 1)).toEqual([2, 3]);
  });
});

// Image-heavy (real sharp work); 5 s default is too tight when the whole monorepo suite runs in parallel.
describe("runCalibration with a scripted critic", { timeout: 60_000 }, () => {
  let work = "";
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const fixtureHash = sha(readFileSync(join(root, FIXTURE_PNG)));
  const refs = calibrationSubjects(root, manifest)
    .filter((s) => s.kind === "reference")
    .slice(0, 2);
  const fixture = calibrationSubjects(root, manifest).filter((s) => s.kind === "fixture");
  const subjects: CalibrationSubject[] = [...refs, ...fixture];
  const hasImages = subjects.every((s) => existsSync(join(root, s.source)));

  /** A fake critic that — like a real one — only sees its workspace, and scores by image bytes. */
  function scripted(score: (isFixture: boolean, req: CriticRequest, call: number) => unknown): {
    runner: CriticRunner;
    seen: string[][];
  } {
    const seen: string[][] = [];
    let call = 0;
    const runner: CriticRunner = async (req) => {
      seen.push(readdirSync(req.workspace).sort());
      const isFixture = sha(readFileSync(join(req.workspace, "shot.png"))) === fixtureHash;
      return { output: score(isFixture, req, ++call), model: "fake-model", costUsd: 0.01 };
    };
    return { runner, seen };
  }

  it.runIf(hasImages)(
    "passes when references land at 9–10 and the fixture at 4–6; workspaces are isolated and removed",
    async () => {
      work = mkdtempSync(join(tmpdir(), "sg-cal-"));
      const { runner, seen } = scripted((isFixture) =>
        isFixture ? report(5, 4.5) : report(9.4, 9.2),
      );
      const logs: string[] = [];
      const result = await runCalibration({
        root,
        rubric,
        subjects,
        runner,
        seed: 3,
        workDir: work,
        log: (l) => logs.push(l),
      });
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
      expect(seen).toHaveLength(subjects.length * 2);
      for (const files of seen)
        expect(files).toEqual(["RUBRIC.md", "board.png", "report.schema.json", "shot.png"]);
      const fx = result.subjects.find((s) => s.kind === "fixture");
      expect(fx?.mean).toBeCloseTo((4.5 * 4 + 5 * 11) / 15, 2);
      expect(fx?.starMin).toBe(4.5);
      expect(result.summary.references).toMatchObject({ count: 2, inRange: 2 });
      expect(result.summary.totalCostUsd).toBeCloseTo(0.06, 5);
      expect(result.summary.models).toEqual(["fake-model"]);
      expect(result.rubricSha256).toBe(sha(readFileSync(join(root, "docs/critic/RUBRIC.md"))));
      expect(readdirSync(work)).toEqual([]);
      expect(logs.some((l) => /S0\d critic-1: mean/.test(l))).toBe(true);
      expect(formatCalibration(result)).toMatch(/calibration PASSED/);
    },
  );

  it.runIf(hasImages)("fails, naming each subject outside its band", async () => {
    work = mkdtempSync(join(tmpdir(), "sg-cal-"));
    const { runner } = scripted((isFixture) => (isFixture ? report(2) : report(7.8)));
    const result = await runCalibration({ root, rubric, subjects, runner, workDir: work });
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.join("\n")).toMatch(
      /grey-default-threejs \(fixture\) scored 2\.00; expected 4–6/,
    );
    expect(result.failures.join("\n")).toMatch(/\(reference\) scored 7\.80; expected 9–10/);
    expect(formatCalibration(result)).toMatch(/calibration FAILED/);
  });

  it.runIf(hasImages)(
    "re-spawns an invalid critic once, accepts fenced text, and gives up after two bad replies",
    async () => {
      work = mkdtempSync(join(tmpdir(), "sg-cal-"));
      const seenCalls = new Map<string, number>();
      const { runner } = scripted((isFixture, req) => {
        const n = (seenCalls.get(req.workspace) ?? 0) + 1;
        seenCalls.set(req.workspace, n);
        if (n === 1) return isFixture ? report(5, 5, "c", true) : { not: "a report" };
        expect(req.prompt).toContain("rejected by the report validator");
        const r = isFixture ? report(5) : report(9.5);
        return "Here you go:\n```json\n" + JSON.stringify(r) + "\n```";
      });
      const logs: string[] = [];
      const ok = await runCalibration({
        root,
        rubric,
        subjects,
        runner,
        workDir: work,
        log: (l) => logs.push(l),
      });
      expect(ok.pass).toBe(true);
      expect(ok.subjects.every((s) => s.critics.every((c) => c.attempts === 2))).toBe(true);
      expect(logs.some((l) => l.includes("invalid reply (attempt 1)"))).toBe(true);

      const bad = scripted(() => "no json at all");
      await expect(
        runCalibration({ root, rubric, subjects, runner: bad.runner, workDir: work }),
      ).rejects.toThrow(/produced no valid report/);
      const thrower: CriticRunner = async () => {
        throw new Error("CLI missing");
      };
      await expect(
        runCalibration({ root, rubric, subjects, runner: thrower, workDir: work }),
      ).rejects.toThrow(/CLI missing/);
    },
  );

  it.runIf(hasImages)(
    "spawns a third critic on a > 1.5 ★ disagreement and uses the median",
    async () => {
      work = mkdtempSync(join(tmpdir(), "sg-cal-"));
      const calls = new Map<string, number>();
      const { runner } = scripted((isFixture, req) => {
        const key = req.workspace.replace(/-c\d$/, "");
        const n = (calls.get(key) ?? 0) + 1;
        calls.set(key, n);
        if (isFixture) return report(5);
        return n === 1 ? report(9.6) : n === 2 ? report(9.4, 7) : report(9.5);
      });
      const result = await runCalibration({
        root,
        rubric,
        subjects,
        runner,
        workDir: work,
        concurrency: 1,
      });
      const ref = result.subjects.find((s) => s.kind === "reference");
      expect(ref?.thirdCritic).toBe(true);
      expect(ref?.critics).toHaveLength(3);
      expect(ref?.merged["1"]).toBe(9.5);
      expect(result.subjects.find((s) => s.kind === "fixture")?.thirdCritic).toBe(false);
    },
  );

  it("summarise flags a run with no references or no fixture", () => {
    const r = summarise({
      runId: "x",
      at: "t",
      seed: 1,
      criticsPerSubject: 2,
      rubricSha256: "a",
      schemaSha256: "b",
      subjects: [],
    });
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual(["no reference images were scored", "no rough fixture was scored"]);
    expect(Number.isNaN(r.summary.references.mean)).toBe(true);
  });

  it("writeCalibration writes the run file and latest.json", () => {
    work = mkdtempSync(join(tmpdir(), "sg-cal-"));
    const r = summarise({
      runId: "run-1",
      at: "t",
      seed: 1,
      criticsPerSubject: 2,
      rubricSha256: "a",
      schemaSha256: "b",
      subjects: [],
    });
    const { run, latest } = writeCalibration(work, r);
    expect(run).toBe(join(work, CALIBRATION_DIR, "run-1.json"));
    expect(JSON.parse(readFileSync(latest, "utf8"))).toEqual(JSON.parse(readFileSync(run, "utf8")));
  });
});

describe("calibrationStatus / checkRecordedCalibration (the ROADMAP M0-06 Accept, `pnpm critic:calibrate --check`)", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A temp repo with the real rubric and schema, a CALIBRATION.md stating the streak, a stand-in
   * file for every subject image, and no runs yet.
   */
  function repo(streak: number | null = 3): string {
    const dir = mkdtempSync(join(tmpdir(), "sg-cal-check-"));
    made.push(dir);
    mkdirSync(join(dir, "docs/critic"), { recursive: true });
    for (const f of ["docs/critic/RUBRIC.md", "docs/critic/report.schema.json"])
      copyFileSync(join(root, f), join(dir, f));
    writeFileSync(
      join(dir, CALIBRATION_DOC),
      streak === null ? "# no streak line\n" : `**Required streak:** ${streak} consecutive runs\n`,
    );
    for (const s of calibrationSubjects(root, manifest)) {
      mkdirSync(dirname(join(dir, s.source)), { recursive: true });
      writeFileSync(join(dir, s.source), `image bytes of ${s.label}`);
    }
    return dir;
  }

  let clock = 0;
  /** Records one run in `dir` whose subject means come from `means`. */
  function record(
    dir: string,
    means: (kind: "reference" | "fixture", label: string) => number,
    opts: { seed?: number; critics?: number; stale?: boolean } = {},
  ): string {
    const critics = opts.critics ?? 2;
    const subjects = calibrationSubjects(root, manifest).map((s, i) => {
      const mean = means(s.kind, s.label);
      const band = EXPECTED[s.kind];
      return {
        ...s,
        blindId: `S${i + 1}`,
        sha256: opts.stale ? "0".repeat(64) : sha(readFileSync(join(dir, s.source))),
        expected: band,
        critics: Array.from({ length: critics }, () => ({
          critic: "c",
          attempts: 1,
          mean,
          scores: {},
          report: report(mean),
        })),
        thirdCritic: false,
        merged: {},
        mean,
        starMin: mean,
        inRange: mean >= band.min && mean <= band.max,
      };
    });
    clock++;
    const at = new Date(Date.UTC(2026, 8, 24, 0, 0, clock)).toISOString();
    writeCalibration(
      dir,
      summarise({
        runId: at.replace(/[:.]/g, "-"),
        at,
        seed: opts.seed ?? clock,
        criticsPerSubject: critics,
        rubricSha256: sha(readFileSync(join(dir, "docs/critic/RUBRIC.md"))),
        schemaSha256: sha(readFileSync(join(dir, "docs/critic/report.schema.json"))),
        protocolSha256: protocolSha256(loadRubric(dir)),
        subjects,
      }),
    );
    return at.replace(/[:.]/g, "-");
  }
  const good = (k: "reference" | "fixture"): number => (k === "fixture" ? 4.2 : 9.3);

  it("reads the required streak from CALIBRATION.md, and the real document states one", () => {
    expect(requiredStreak(repo(4))).toBe(4);
    expect(requiredStreak(repo(null))).toBeUndefined();
    expect(requiredStreak(join(tmpdir(), "sg-no-such-repo"))).toBeUndefined();
    expect(requiredStreak(root)).toBeGreaterThanOrEqual(3);
  });

  it("accepts N consecutive passing runs with distinct seeds on the current configuration", () => {
    const dir = repo(3);
    record(dir, (k, l) => (k === "fixture" ? 4.2 : l.endsWith("-01.png") ? 8.9 : 9.3)); // older failure
    for (let i = 0; i < 3; i++) record(dir, good);
    const status = calibrationStatus(dir, manifest);
    expect(status.problems).toEqual([]);
    expect(status.required).toBe(3);
    expect(status.current.map((r) => r.pass)).toEqual([false, true, true, true]);
    expect(checkRecordedCalibration(dir, manifest)).toEqual([]);
  });

  it("needs the full streak, and a failed run inside it breaks the streak", () => {
    const dir = repo(3);
    record(dir, good);
    record(dir, good);
    expect(checkRecordedCalibration(dir, manifest).join("\n")).toMatch(
      /only 2 run\(s\) on the current configuration; the Accept needs 3/,
    );
    record(dir, (k, l) => (k === "fixture" ? 3.9 : l.endsWith("-01.png") ? 8.9 : 9.3));
    const problems = checkRecordedCalibration(dir, manifest).join("\n");
    expect(problems).toMatch(/grey-default-threejs \(fixture\) scored 3\.90; expected 4–6/);
    expect(problems).toMatch(/-01\.png \(reference\) scored 8\.90; expected 9–10/);
    record(dir, good, { critics: 1 });
    expect(checkRecordedCalibration(dir, manifest).join("\n")).toMatch(
      /scored by 1 critic\(s\); needs ≥ 2/,
    );
  });

  it("rejects a streak that reuses a seed", () => {
    const dir = repo(2);
    record(dir, good, { seed: 7 });
    record(dir, good, { seed: 7 });
    expect(checkRecordedCalibration(dir, manifest)).toEqual([
      "the streak's runs do not all have distinct seeds",
    ]);
  });

  it("ignores runs on another rubric, schema, board or image bytes", () => {
    const dir = repo(1);
    record(dir, good, { stale: true });
    const problems = checkRecordedCalibration(dir, manifest).join("\n");
    expect(problems).toMatch(/no recorded run matches the current rubric, schema and images/);
    expect(problems).toMatch(/the image differs from the one scored/);

    const dir2 = repo(1);
    record(dir2, good);
    expect(checkRecordedCalibration(dir2, manifest)).toEqual([]);
    const ref = calibrationSubjects(root, manifest).find((s) => s.kind === "reference");
    writeFileSync(join(dir2, ref?.source ?? ""), "re-fetched, different bytes");
    expect(checkRecordedCalibration(dir2, manifest).join("\n")).toMatch(
      /the image differs from the one scored/,
    );

    const dir3 = repo(1);
    record(dir3, good);
    writeFileSync(join(dir3, "docs/critic/RUBRIC.md"), "changed");
    writeFileSync(join(dir3, "docs/critic/report.schema.json"), "{}");
    const p3 = checkRecordedCalibration(dir3, manifest).join("\n");
    expect(p3).toMatch(/older RUBRIC\.md/);
    expect(p3).toMatch(/older report\.schema\.json/);

    const dir4 = repo(1);
    record(dir4, good);
    const fewer = {
      ...manifest,
      entries: manifest.entries.filter((e) => e.file !== "alba-01.png"),
    };
    expect(checkRecordedCalibration(dir4, fewer).join("\n")).toMatch(/does not cover exactly/);
  });

  it("flags a run recorded before image hashes existed", () => {
    const config = currentConfig(root, manifest);
    const r = JSON.parse(
      JSON.stringify(
        summarise({
          runId: "old",
          at: "t",
          seed: 1,
          criticsPerSubject: 2,
          rubricSha256: config.rubricSha256,
          schemaSha256: config.schemaSha256,
          subjects: calibrationSubjects(root, manifest).map((s) => ({
            ...s,
            blindId: "S1",
            sha256: "x",
            expected: EXPECTED[s.kind],
            critics: [],
            thirdCritic: false,
            merged: {},
            mean: 9,
            starMin: 9,
            inRange: true,
          })),
        }),
      ),
    ) as { subjects: { sha256?: string }[] };
    for (const s of r.subjects) delete s.sha256;
    expect(staleReasons(r as never, config).join("\n")).toMatch(/no image hash recorded/);
    expect(staleReasons(r as never, config).join("\n")).toMatch(/another critic protocol/);
    expect(runProblems(r as never).join("\n")).toMatch(/scored by 0 critic\(s\)/);
  });

  it("reports missing images, a missing streak line, a stale latest.json and no runs", () => {
    const dir = repo(null);
    const img = calibrationSubjects(root, manifest)[0]?.source ?? "";
    rmSync(join(dir, img));
    const none = checkRecordedCalibration(dir, manifest).join("\n");
    expect(none).toMatch(/does not state the "\*\*Required streak:\*\* N" line/);
    expect(none).toMatch(/1 subject image\(s\) are missing .*run `pnpm refs:fetch`/);
    expect(none).toMatch(/no readable calibration run/);

    const dir2 = repo(1);
    const first = record(dir2, good);
    record(dir2, good);
    copyFileSync(
      join(dir2, CALIBRATION_DIR, `${first}.json`),
      join(dir2, CALIBRATION_DIR, "latest.json"),
    );
    writeFileSync(join(dir2, CALIBRATION_DIR, "notes.json"), "not json");
    expect(checkRecordedCalibration(dir2, manifest)).toEqual([
      "latest.json is not the newest recorded run",
    ]);
    expect(recordedRuns(join(tmpdir(), "sg-no-such-repo"))).toEqual([]);
  });
});
