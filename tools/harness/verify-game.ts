/**
 * `pnpm verify:game <id>`: every G-gate automation of DOD §2 for one game, written to
 * `artifacts/verify/<id>.json`. See `src/verify/game.ts` for the gates and their order.
 *
 * Options:
 *   --round <r>      screenshot round (default: the next critic round, i.e. latest round-*.json + 1)
 *   --port <n>       port of the scenario preview server (default 4173; SG_PORT also works)
 *   --base-url <u>   use an already running scenario server instead of building one
 *   --skip-build     reuse the last scenario build (artifacts/tmp/scenario-client)
 *   --workers <n>    Playwright workers (default 4)
 *   --only <what>    `shots` (G6 + G7) or `perf` (G8a + G8b); writes artifacts/verify/<id>-<what>.json
 *   --allow-red      exit 0 when the run completed, even with red gates (evidence runs)
 *   --check-outputs  run nothing: check the last run left its whole evidence set for HEAD and --round
 * Exit code: 0 when every gate is green (G8b may be skipped "no-gpu"), 1 otherwise, 2 on a setup error.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nextRound, verifyGame, type Only } from "./src/verify/game.ts";
import { checkOutputs } from "./src/verify/outputs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      round: { type: "string" },
      port: { type: "string" },
      "base-url": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      workers: { type: "string" },
      only: { type: "string", default: "all" },
      "allow-red": { type: "boolean", default: false },
      "check-outputs": { type: "boolean", default: false },
    },
  });
  const game = positionals[0];
  if (game === undefined)
    throw new Error("usage: pnpm verify:game <id> [--round r] [--port n] [--only shots|perf]");
  if (values["check-outputs"]) {
    const round = values.round ?? "1";
    const problems = checkOutputs(root, game, round);
    for (const p of problems) console.error(`missing/stale: ${p}`);
    console.log(
      problems.length === 0
        ? `verify:game ${game}: round ${round} evidence complete for HEAD`
        : "verify:game: evidence incomplete",
    );
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const only = values.only as Only;
  if (!["all", "shots", "perf"].includes(only))
    throw new Error(`--only must be shots or perf, not ${only}`);
  const report = await verifyGame({
    root,
    game,
    round: values.round ?? nextRound(root, game),
    port: Number(values.port ?? process.env["SG_PORT"] ?? 4173),
    only,
    skipBuild: values["skip-build"],
    ...(values["base-url"] !== undefined ? { baseUrl: values["base-url"] } : {}),
    ...(values.workers !== undefined ? { workers: Number(values.workers) } : {}),
  });
  for (const [name, g] of Object.entries(report.gates))
    console.log(
      `${g.ok === true ? "ok  " : g.skipped !== undefined ? "skip" : "FAIL"} ${name}${g.note !== undefined ? `  ${String(g.note).split("\n")[0]}` : ""}`,
    );
  for (const [name, c] of Object.entries(report.checks))
    console.log(`${c.ok === true ? "ok  " : "FAIL"} ${name}`);
  process.exitCode = report.ok || values["allow-red"] ? 0 : 1;
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 2;
}
