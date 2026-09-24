/**
 * Blind A/B pairs (DOD §4.3.4, §6.2): each pair puts one of our Stage shots next to a
 * reference, in a random left/right order, as `pair-NN.png` under
 * `artifacts/critic/<id>/ab-<r>/`. The answer key (which side is ours) is written **outside**
 * the critic's inputs, to `artifacts/ab-keys/<id>/ab-<r>.json`, so a critic can never read it.
 *
 * Two kinds of pairs:
 * - `golden`: against `docs/references/_style/golden/` (our own passing Quip Clash shots, from
 *   M2-06). Pass bar: ours chosen or tied in at least 50% of pairs.
 * - `external`: against the external reference board (`docs/references/_style/*.png` and
 *   `docs/references/<id>/*.png`, local only). Pass bar: at least 30% (40% for the golden game).
 *
 * Usage: `tsx tools/harness/ab-pairs.ts <game> [--round <r>] [--pairs <n>] [--seed <n>]`
 *
 * @module
 */
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";

/** One pair of the answer key. */
export interface AbKeyEntry {
  pair: string;
  kind: "golden" | "external";
  /** The side our shot is on. */
  ours: "A" | "B";
  ourFile: string;
  refFile: string;
}

/** The hidden answer key of one round. */
export interface AbKey {
  game: string;
  round: number | string;
  pairs: AbKeyEntry[];
}

/** A critic's A/B answer (DOD §5 `ab[]`). */
export interface AbChoice {
  pair: string;
  choice: "A" | "B" | "tie";
}

/** The A/B score per kind: the share of pairs where ours was chosen or tied. */
export interface AbScore {
  golden: { pairs: number; oursOrTie: number; share: number | null };
  external: { pairs: number; oursOrTie: number; share: number | null };
  /** Pairs in the key the critic did not answer. */
  unanswered: string[];
}

/** Minimum shares of DOD §4.3.4 (and §4.3.5 for the style golden). */
export const AB_BAR = Object.freeze({ golden: 0.5, external: 0.3, externalGolden: 0.4 });

/** A random integer in `[0, n)`: crypto by default, or a seeded stream for tests. */
export type Pick = (n: number) => number;

/** A small seeded generator (mulberry32) for reproducible test pairs. */
export function seededPick(seed: number): Pick {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(f * n);
  };
}

const cryptoPick: Pick = (n) => randomInt(n);

/** Fisher–Yates with the given picker. */
export function shuffle<T>(items: readonly T[], pick: Pick): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const PAIR = Object.freeze({ w: 960, h: 540, gutter: 32, label: 48, bg: "#2E2A33", ink: "#F5EDE3" });

function label(text: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAIR.w}" height="${PAIR.label}">` +
      `<text x="${PAIR.w / 2}" y="36" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="30" ` +
      `font-weight="700" fill="${PAIR.ink}" text-anchor="middle">${text}</text></svg>`,
  );
}

/** Renders one side-by-side pair image: `left` is A, `right` is B. */
export async function pairImage(left: string, right: string): Promise<Buffer> {
  const fit = (f: string) =>
    sharp(f).resize(PAIR.w, PAIR.h, { fit: "contain", background: PAIR.bg }).png().toBuffer();
  const [a, b] = await Promise.all([fit(left), fit(right)]);
  const width = PAIR.w * 2 + PAIR.gutter * 3;
  const height = PAIR.label + PAIR.h + PAIR.gutter;
  return sharp({ create: { width, height, channels: 3, background: PAIR.bg } })
    .composite([
      { input: label("A"), left: PAIR.gutter, top: 0 },
      { input: label("B"), left: PAIR.gutter * 2 + PAIR.w, top: 0 },
      { input: a, left: PAIR.gutter, top: PAIR.label },
      { input: b, left: PAIR.gutter * 2 + PAIR.w, top: PAIR.label },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** PNG/JPEG files directly inside a directory, sorted. */
export function imagesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** Options of {@link makeAbPairs}. */
export interface AbOptions {
  game: string;
  round: number | string;
  /** Our candidate shots (absolute paths). */
  ours: readonly string[];
  golden: readonly string[];
  external: readonly string[];
  /** Pairs per kind (default 6). */
  perKind?: number;
  /** Where `pair-NN.png` go. */
  outDir: string;
  /** Where the key goes (must be outside `outDir`). */
  keyFile: string;
  pick?: Pick;
}

/**
 * Builds the pairs and the hidden key. Our shots and the references are drawn without
 * repetition while they last, the side is random per pair, and pair numbers are shuffled across
 * kinds so the file order reveals nothing.
 */
export async function makeAbPairs(o: AbOptions): Promise<{ key: AbKey; files: string[]; notes: string[] }> {
  const pick = o.pick ?? cryptoPick;
  const perKind = o.perKind ?? 6;
  const notes: string[] = [];
  if (resolve(o.keyFile).startsWith(resolve(o.outDir)))
    throw new Error("ab-pairs: the answer key must not live inside the critic's input directory");
  if (o.ours.length === 0) throw new Error("ab-pairs: no shots of ours to pair");
  const plan: Omit<AbKeyEntry, "pair">[] = [];
  for (const kind of ["golden", "external"] as const) {
    const refs = kind === "golden" ? o.golden : o.external;
    if (refs.length === 0) {
      notes.push(`no ${kind} references found: ${kind} pairs skipped`);
      continue;
    }
    const oursOrder = shuffle(o.ours, pick);
    const refOrder = shuffle(refs, pick);
    for (let i = 0; i < perKind; i++)
      plan.push({
        kind,
        ours: pick(2) === 0 ? "A" : "B",
        ourFile: oursOrder[i % oursOrder.length] as string,
        refFile: refOrder[i % refOrder.length] as string,
      });
  }
  const ordered = shuffle(plan, pick);
  mkdirSync(o.outDir, { recursive: true });
  const pairs: AbKeyEntry[] = [];
  const files: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i] as Omit<AbKeyEntry, "pair">;
    const name = `pair-${String(i + 1).padStart(2, "0")}`;
    const [left, right] = p.ours === "A" ? [p.ourFile, p.refFile] : [p.refFile, p.ourFile];
    const file = join(o.outDir, `${name}.png`);
    writeFileSync(file, await pairImage(left, right));
    files.push(file);
    pairs.push({ pair: name, ...p, ourFile: basename(p.ourFile), refFile: basename(p.refFile) });
  }
  const key: AbKey = { game: o.game, round: o.round, pairs };
  mkdirSync(dirname(o.keyFile), { recursive: true });
  writeFileSync(o.keyFile, `${JSON.stringify(key, null, 2)}\n`);
  return { key, files, notes };
}

/** Scores a critic's A/B answers against the key (a tie counts for us, per DOD §4.3.4). */
export function scoreAb(key: AbKey, choices: readonly AbChoice[]): AbScore {
  const byPair = new Map(choices.map((c) => [c.pair, c.choice]));
  const unanswered: string[] = [];
  const tally = { golden: { pairs: 0, oursOrTie: 0 }, external: { pairs: 0, oursOrTie: 0 } };
  for (const p of key.pairs) {
    const choice = byPair.get(p.pair);
    if (choice === undefined) {
      unanswered.push(p.pair);
      continue;
    }
    tally[p.kind].pairs++;
    if (choice === "tie" || choice === p.ours) tally[p.kind].oursOrTie++;
  }
  const share = (t: { pairs: number; oursOrTie: number }) => ({
    ...t,
    share: t.pairs === 0 ? null : t.oursOrTie / t.pairs,
  });
  return { golden: share(tally.golden), external: share(tally.external), unanswered };
}

/** Repo-relative locations for a round's pairs and key. */
export const abPaths = (game: string, round: number | string) => ({
  outDir: `artifacts/critic/${game}/ab-${round}`,
  keyFile: `artifacts/ab-keys/${game}/ab-${round}.json`,
});

/** Our A/B candidates: the 1920×1080 Stage shots of the four critic modes. */
export function ourAbShots(root: string, game: string, round: number | string): string[] {
  const dir = join(root, `artifacts/screenshots/${game}/round-${round}`);
  return imagesIn(dir).filter((f) => /__(day|dusk|night|rain)__1920x1080\.png$/.test(f));
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      round: { type: "string", default: "1" },
      pairs: { type: "string", default: "6" },
      seed: { type: "string" },
    },
  });
  const game = positionals[0];
  if (game === undefined) throw new Error("usage: ab-pairs.ts <game> [--round <r>] [--pairs <n>]");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const round = values.round ?? "1";
  const paths = abPaths(game, round);
  const { files, notes } = await makeAbPairs({
    game,
    round,
    ours: ourAbShots(root, game, round),
    golden: imagesIn(join(root, "docs/references/_style/golden")),
    external: [
      ...imagesIn(join(root, "docs/references/_style")),
      ...imagesIn(join(root, `docs/references/${game}`)),
    ],
    perKind: Number(values.pairs),
    outDir: join(root, paths.outDir),
    keyFile: join(root, paths.keyFile),
    ...(values.seed !== undefined ? { pick: seededPick(Number(values.seed)) } : {}),
  });
  for (const n of notes) console.log(`ab-pairs: ${n}`);
  console.log(`ab-pairs: wrote ${files.length} pairs to ${paths.outDir} (key: ${paths.keyFile})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
