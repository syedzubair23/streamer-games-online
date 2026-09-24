/**
 * Entry point for `pnpm progress …` (root package.json). See `src/progress/cli.ts` for the
 * commands and docs/DOD.md §8 for the lifecycle and evidence rules it enforces.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./src/progress/cli.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.exitCode = await runCli(process.argv.slice(2), { root });
