/**
 * Stream simulation (DOD §3 "Stream-sim"): the 1920×1080 Stage shots in dusk and night,
 * downscaled to 1280×720 and saved as JPEG at quality 60, the way a 720p stream shows them.
 * The critic judges stream readability (rubric item 2) mainly on these.
 *
 * Usage: `tsx tools/harness/stream-sim.ts <game> [--round <r>]`
 *
 * @module
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { roundDir, STREAM_MODES } from "./src/matrix.ts";

/** Output size and quality of the simulated stream. */
export const STREAM = Object.freeze({ width: 1280, height: 720, quality: 60 });

/** Downscales one 1080p PNG to a 720p JPEG at quality 60. */
export async function streamSim(input: string, output: string): Promise<void> {
  mkdirSync(dirname(output), { recursive: true });
  await sharp(input)
    .resize(STREAM.width, STREAM.height, { fit: "fill", kernel: "lanczos3" })
    .jpeg({ quality: STREAM.quality, chromaSubsampling: "4:2:0", mozjpeg: false })
    .toFile(output);
}

/** `<state>__<mode>__stream.jpg`, inside the round's `stream/` directory. */
export const streamFile = (state: string, mode: string): string => `${state}__${mode}__stream.jpg`;

/**
 * Simulates the stream for every 1920×1080 dusk/night stage shot of a round. Returns the
 * written files (repo-relative).
 */
export async function streamSimRound(
  root: string,
  game: string,
  round: number | string,
  states: readonly string[],
): Promise<string[]> {
  const dir = roundDir(game, round);
  const out: string[] = [];
  for (const state of states)
    for (const mode of STREAM_MODES) {
      const src = join(root, dir, `${state}__${mode}__1920x1080.png`);
      if (!existsSync(src)) throw new Error(`stream-sim: missing ${dir}/${state}__${mode}__1920x1080.png`);
      const rel = `${dir}/stream/${streamFile(state, mode)}`;
      await streamSim(src, join(root, rel));
      out.push(rel);
    }
  return out;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { round: { type: "string", default: "1" } },
  });
  const game = positionals[0];
  if (game === undefined) throw new Error("usage: stream-sim.ts <game> [--round <r>]");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { readManifest } = await import("./src/scenarios/manifest.ts");
  const manifest = readManifest(root, game);
  const states = manifest.scenarios
    .filter((s) => s.inSpec && s.registered && s.roles.includes("stage"))
    .map((s) => s.id);
  const files = await streamSimRound(root, game, values.round ?? "1", states);
  console.log(`stream-sim: wrote ${files.length} JPEGs`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
