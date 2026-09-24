/**
 * `pnpm critic:prep <game> [--round <r>]`: lays out one critic round's inputs (DOD §3, §6.2)
 * from a `verify:game` run of the same round:
 *
 * - `artifacts/critic/<id>/round-<r>/sheets/*.png`: the contact sheets (4 Stage modes, Stream-sim,
 *   Controller, snow);
 * - `artifacts/critic/<id>/round-<r>/clips/*.webm`: the hero-animation clips;
 * - `artifacts/critic/<id>/round-<r>/shots/*`: every still and stream JPEG, for drill-down;
 * - `artifacts/critic/<id>/ab-<r>/pair-NN.png`: the blind A/B pairs, whose answer key goes to
 *   `artifacts/ab-keys/<id>/ab-<r>.json` where the critic cannot read it.
 *
 * Images and clips stay out of git (`.gitignore`); only the critics' JSON reports are committed.
 *
 * @module
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { abPaths, imagesIn, makeAbPairs, ourAbShots, type Pick } from "./ab-pairs.ts";
import { roundDir } from "./src/matrix.ts";

/** What {@link criticPrep} laid out. */
export interface CriticPrep {
  dir: string;
  sheets: number;
  clips: number;
  shots: number;
  pairs: number;
  notes: string[];
}

function copyAll(from: string, to: string, filter: (f: string) => boolean): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of readdirSync(from).filter(filter)) {
    copyFileSync(join(from, f), join(to, f));
    n++;
  }
  return n;
}

/** Copies a round's evidence into the critic's input layout and builds the A/B pairs. */
export async function criticPrep(
  root: string,
  game: string,
  round: string,
  opts: { pairsPerKind?: number; pick?: Pick } = {},
): Promise<CriticPrep> {
  const src = join(root, roundDir(game, round));
  if (!existsSync(src))
    throw new Error(
      `no ${roundDir(game, round)}: run \`pnpm verify:game ${game} --round ${round}\` first`,
    );
  const rel = `artifacts/critic/${game}/round-${round}`;
  const dest = join(root, rel);
  rmSync(dest, { recursive: true, force: true });
  const sheets = copyAll(join(src, "sheets"), join(dest, "sheets"), (f) => f.endsWith(".png"));
  const clips = copyAll(join(src, "clips"), join(dest, "clips"), (f) => f.endsWith(".webm"));
  const shots =
    copyAll(src, join(dest, "shots"), (f) => f.endsWith(".png")) +
    copyAll(join(src, "stream"), join(dest, "shots"), (f) => f.endsWith(".jpg"));
  const notes: string[] = [];
  if (sheets === 0) notes.push("no contact sheets in the round (did verify:game finish?)");
  const paths = abPaths(game, round);
  rmSync(join(root, paths.outDir), { recursive: true, force: true });
  const { files, notes: abNotes } = await makeAbPairs({
    game,
    round,
    ours: ourAbShots(root, game, round),
    golden: imagesIn(join(root, "docs/references/_style/golden")),
    external: [
      ...imagesIn(join(root, "docs/references/_style")),
      ...imagesIn(join(root, `docs/references/${game}`)),
    ],
    outDir: join(root, paths.outDir),
    keyFile: join(root, paths.keyFile),
    ...(opts.pairsPerKind !== undefined ? { perKind: opts.pairsPerKind } : {}),
    ...(opts.pick !== undefined ? { pick: opts.pick } : {}),
  });
  return { dir: rel, sheets, clips, shots, pairs: files.length, notes: [...notes, ...abNotes] };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { round: { type: "string" }, pairs: { type: "string" } },
  });
  const game = positionals[0];
  if (game === undefined)
    throw new Error("usage: pnpm critic:prep <game> [--round <r>] [--pairs <n>]");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { nextRound } = await import("./src/verify/game.ts");
  const round = values.round ?? nextRound(root, game);
  const res = await criticPrep(root, game, round, {
    ...(values.pairs !== undefined ? { pairsPerKind: Number(values.pairs) } : {}),
  });
  console.log(
    `critic:prep ${game} round ${round}: ${res.sheets} sheets, ${res.clips} clips, ${res.shots} shots in ${res.dir}; ${res.pairs} A/B pairs`,
  );
  for (const n of res.notes) console.log(`note: ${n}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
