/**
 * G6 scenario coverage (DOD §2): every scenario in the game spec's Scenarios table is
 * registered in `scenarios.ts` (with the same hero animation) and renders through
 * `/dev/scenario` with no console errors for **each role it lists**. Also emits the scenario
 * manifest `artifacts/scenarios/<id>.json` the other specs read.
 *
 * Usage: `tsx tools/harness/check-scenarios.ts <game> [--base-url <url>] [--port <n>] [--skip-build]`
 * (without `--base-url` it builds and serves the client itself).
 *
 * @module
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "@playwright/test";
import { collectErrors, openScenario, SWIFTSHADER_ARGS } from "./src/browser.ts";
import { gameTarget } from "./src/games.ts";
import { HARNESS_SEED, PHONE, scenarioPath, STAGE_VIEWPORTS } from "./src/matrix.ts";
import { emitManifest, type ScenarioManifest } from "./src/scenarios/manifest.ts";
import type { Role } from "./src/scenarios/spec.ts";
import { startScenarioServer } from "./src/server.ts";

/** One scenario × role render. */
export interface RenderCheck {
  scenario: string;
  role: Role;
  ok: boolean;
  errors: string[];
}

/** The G6 result. */
export interface ScenarioCheck {
  ok: boolean;
  manifest: ScenarioManifest;
  renders: RenderCheck[];
  problems: string[];
}

/** Renders every listed scenario × role once; returns one check per render. */
export async function renderAll(
  browser: Browser,
  base: string,
  manifest: ScenarioManifest,
  concurrency = 4,
): Promise<RenderCheck[]> {
  const jobs = manifest.scenarios
    .filter((s) => s.inSpec && s.registered)
    .flatMap((s) => s.roles.map((role) => ({ scenario: s.id, role })));
  const out: RenderCheck[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      const phone = job.role === "player" || job.role === "audience";
      const vp = phone ? PHONE : (STAGE_VIEWPORTS[1] as (typeof STAGE_VIEWPORTS)[number]);
      const context = await browser.newContext({
        baseURL: base,
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
      });
      const page = await context.newPage();
      const errors = collectErrors(page);
      try {
        await openScenario(
          page,
          scenarioPath({
            game: manifest.game,
            state: job.scenario,
            role: job.role,
            mode: "dusk",
            quality: vp.tier,
            seed: HARNESS_SEED,
          }),
        );
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      } finally {
        await context.close();
      }
      out.push({ ...job, ok: errors.length === 0, errors });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out.sort((a, b) => `${a.scenario}/${a.role}`.localeCompare(`${b.scenario}/${b.role}`));
}

/** Runs G6 for a game against a running scenario server at `base`. */
export async function checkScenarios(root: string, game: string, base: string): Promise<ScenarioCheck> {
  const manifest = await emitManifest(root, gameTarget(root, game));
  const browser = await chromium.launch({ args: [...SWIFTSHADER_ARGS] });
  try {
    const renders = await renderAll(browser, base, manifest);
    const problems = [
      ...manifest.problems,
      ...renders
        .filter((r) => !r.ok)
        .map((r) => `${r.scenario} (${r.role}): ${r.errors.join(" | ")}`),
    ];
    if (renders.length === 0) problems.push("no scenario renders were checked");
    return { ok: problems.length === 0, manifest, renders, problems };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      port: { type: "string", default: "4173" },
      "skip-build": { type: "boolean", default: false },
    },
  });
  const game = positionals[0];
  if (game === undefined) throw new Error("usage: check-scenarios.ts <game> [--base-url <url>]");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server =
    values["base-url"] === undefined
      ? await startScenarioServer(root, Number(values.port), { skipBuild: values["skip-build"] })
      : null;
  try {
    const res = await checkScenarios(root, game, values["base-url"] ?? server!.url);
    for (const r of res.renders) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.scenario} (${r.role})`);
    for (const n of res.manifest.notes) console.log(`note: ${n}`);
    for (const p of res.problems) console.error(`problem: ${p}`);
    console.log(res.ok ? "G6: ok" : "G6: FAILED");
    process.exitCode = res.ok ? 0 : 1;
  } finally {
    await server?.stop();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
