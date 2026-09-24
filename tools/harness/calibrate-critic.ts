/**
 * `pnpm critic:calibrate`: calibrates the visual critic before any critic round counts
 * (ROADMAP M0-06; DOD §7 "Calibration first"). See `src/critic/calibration.ts` for the protocol.
 *
 * Options:
 *   --render-fixture     re-render the grey three.js fixture PNG first (it is rendered when missing)
 *   --fixture-only       only render the fixture, then exit
 *   --critics <n>        fresh critics per subject (default 2, per DOD §4.3)
 *   --concurrency <n>    subjects scored in parallel (default 3)
 *   --seed <n>           blind-order seed (default random; recorded in the result)
 *   --model <id>         critic model passed to the CLI (default: the CLI's default)
 *   --max-budget <usd>   spend cap per critic call (default 3)
 *   --keep               keep the per-critic workspaces for inspection
 *   --dry-run            print the blind order and the critic prompt; spawn no critic
 *   --check              spawn nothing; check the recorded runs against the Accept: the latest N
 *                        runs on the current rubric, schema and images all pass (N is the
 *                        "Required streak" in docs/critic/CALIBRATION.md)
 * Environment: SG_CRITIC_CLI overrides the critic executable (default: Claude Code CLI).
 * Exit code: 0 when the calibration passes, 1 when it fails, 2 on a setup error.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  blindOrder,
  calibrationPrompt,
  calibrationStatus,
  calibrationSubjects,
  formatCalibration,
  runCalibration,
  writeCalibration,
} from "./src/critic/calibration.ts";
import { claudeCliRunner } from "./src/critic/critic-runner.ts";
import { FIXTURE_PNG, renderGreyFixture } from "./src/critic/fixture.ts";
import {
  gameIds,
  loadManifest,
  missingReferences,
  validateManifest,
} from "./src/critic/references.ts";
import { loadRubric } from "./src/critic/rubric.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values } = parseArgs({
  options: {
    "render-fixture": { type: "boolean", default: false },
    "fixture-only": { type: "boolean", default: false },
    critics: { type: "string", default: "2" },
    concurrency: { type: "string", default: "3" },
    seed: { type: "string" },
    model: { type: "string" },
    "max-budget": { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  },
});

const positiveInt = (name: string, raw: string | undefined): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${name} must be a positive integer (got ${raw})`);
    process.exit(2);
  }
  return n;
};

async function main(): Promise<number> {
  if (values.check) {
    const status = calibrationStatus(root, loadManifest(root));
    console.log(
      `runs on the current rubric, schema and images: ${status.current.length} (required streak: ${status.required ?? "?"})`,
    );
    for (const r of status.current)
      console.log(`  ${r.pass ? "pass" : "FAIL"} ${r.runId} (seed ${r.seed})`);
    console.log(
      status.problems.length
        ? `calibration NOT accepted:\n  ${status.problems.join("\n  ")}`
        : "calibration accepted",
    );
    return status.problems.length ? 1 : 0;
  }
  if (values["render-fixture"] || values["fixture-only"] || !existsSync(join(root, FIXTURE_PNG))) {
    console.log(`rendered ${await renderGreyFixture(root)}`);
    if (values["fixture-only"]) return 0;
  }
  const manifest = loadManifest(root);
  const problems = validateManifest(manifest, gameIds(root));
  if (problems.length) {
    console.error(`reference manifest is invalid:\n  ${problems.join("\n  ")}`);
    return 2;
  }
  const missing = missingReferences(root, manifest).filter((e) => e.set === "_style");
  if (missing.length) {
    console.error(
      `${missing.length} _style reference images are missing; run \`pnpm refs:fetch\` first`,
    );
    return 2;
  }
  const rubric = loadRubric(root);
  const subjects = calibrationSubjects(root, manifest);
  const seed = values.seed !== undefined ? positiveInt("seed", values.seed) : undefined;

  if (values["dry-run"]) {
    for (const s of blindOrder(subjects, seed ?? 1))
      console.log(`${s.blindId}  ${s.kind.padEnd(9)} ${s.label}`);
    console.log(`\n--- critic prompt ---\n${calibrationPrompt(rubric, "critic-1")}`);
    return 0;
  }

  const runnerOpts: Parameters<typeof claudeCliRunner>[0] = {
    maxBudgetUsd: Number(values["max-budget"]),
  };
  if (values.model) runnerOpts.model = values.model;
  const calOpts: Parameters<typeof runCalibration>[0] = {
    root,
    rubric,
    subjects,
    runner: claudeCliRunner(runnerOpts),
    critics: positiveInt("critics", values.critics),
    concurrency: positiveInt("concurrency", values.concurrency),
    keepWorkspaces: values.keep,
    log: (l) => console.log(l),
  };
  if (seed !== undefined) calOpts.seed = seed;
  console.log(`calibrating: ${subjects.length} subjects × ${calOpts.critics} blind critics`);
  const result = await runCalibration(calOpts);
  const { run } = writeCalibration(root, result);
  console.log(`\n${formatCalibration(result)}\nwrote ${run}`);
  return result.pass ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
