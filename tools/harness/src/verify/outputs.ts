/**
 * Checks that a `verify:game` run produced its whole evidence set (ROADMAP M0-05 Accept: "the
 * screenshots, perf JSON, contact sheets and verify JSON"), for the current commit.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GAME_GATES } from "../progress/model.ts";
import { clipScenarios, roundDir, screenshotMatrix, STAGE_MODES, STREAM_MODES } from "../matrix.ts";
import { readManifest } from "../scenarios/manifest.ts";
import { streamFile } from "../../stream-sim.ts";
import { headCommit } from "./game.ts";

/** Every problem with a game's last verify run (empty when complete and current). */
export function checkOutputs(
  root: string,
  game: string,
  round: string,
  commit = headCommit(root),
): string[] {
  const problems: string[] = [];
  const need = (rel: string): void => {
    if (!existsSync(join(root, rel))) problems.push(`missing ${rel}`);
  };
  const verifyPath = `artifacts/verify/${game}.json`;
  if (!existsSync(join(root, verifyPath))) return [`missing ${verifyPath}`];
  const report = JSON.parse(readFileSync(join(root, verifyPath), "utf8")) as {
    id?: string;
    commit?: string;
    round?: string;
    gates?: Record<string, unknown>;
    checks?: { determinism?: { ok?: boolean; note?: string } };
  };
  if (report.id !== game) problems.push(`${verifyPath} is for ${String(report.id)}`);
  if (report.commit !== commit)
    problems.push(`${verifyPath} is from commit ${String(report.commit)}, HEAD is ${commit}`);
  if (report.round !== round)
    problems.push(`${verifyPath} is for round ${String(report.round)}, not ${round}`);
  for (const g of GAME_GATES)
    if (!(g in (report.gates ?? {}))) problems.push(`${verifyPath} has no gate ${g}`);
  const det = report.checks?.determinism;
  if (det === undefined) problems.push(`${verifyPath} has no determinism check`);
  else if (det.ok !== true) problems.push(`determinism failed: ${det.note ?? "?"}`);

  const manifest = readManifest(root, game);
  const dir = roundDir(game, round);
  const stills = screenshotMatrix(manifest);
  for (const s of stills) need(`${dir}/${s.file}`);
  for (const s of stills.filter(
    (x) => x.set === "stage" && x.viewport.label === "1920x1080" && STREAM_MODES.includes(x.mode),
  ))
    need(`${dir}/stream/${streamFile(s.state, s.mode)}`);
  for (const s of clipScenarios(manifest)) need(`${dir}/clips/${s.id}__dusk__1280x720.webm`);
  if (stills.some((s) => s.set === "stage")) {
    for (const m of STAGE_MODES) need(`${dir}/sheets/stage-${m}.png`);
    need(`${dir}/sheets/stream.png`);
  }
  if (stills.some((s) => s.set === "controller")) need(`${dir}/sheets/controller.png`);
  if (stills.some((s) => s.set === "snow")) need(`${dir}/sheets/snow.png`);
  need(`artifacts/perf/${game}.json`);
  need(`artifacts/perf/${game}-gpu.json`);
  need(`artifacts/scenarios/${game}.json`);
  return problems;
}
