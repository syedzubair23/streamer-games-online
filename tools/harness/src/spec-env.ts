/**
 * What every harness spec reads from the environment: the game (`SG_GAME`), the round
 * (`SG_ROUND`, default 1), the repo root and the game's scenario manifest.
 *
 * @module
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, type ScenarioManifest } from "./scenarios/manifest.ts";

/** The repo root (this file is `tools/harness/src/spec-env.ts`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The spec run's game, round and manifest. */
export interface SpecEnv {
  game: string;
  round: string;
  manifest: ScenarioManifest;
}

/** Reads `SG_GAME` / `SG_ROUND` and the manifest; throws when `SG_GAME` is missing. */
export function specEnv(env: NodeJS.ProcessEnv = process.env, root = ROOT): SpecEnv {
  const game = env["SG_GAME"];
  if (game === undefined || game === "")
    throw new Error("set SG_GAME=<game id> (pnpm verify:game <id> does this)");
  const round = env["SG_ROUND"] ?? "1";
  if (!/^[\w-]+$/.test(round)) throw new Error(`bad SG_ROUND ${round}`);
  return { game, round, manifest: readManifest(root, game) };
}

/** Writes a JSON artifact (repo-relative path), creating directories. */
export function writeJson(rel: string, value: unknown, root = ROOT): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
