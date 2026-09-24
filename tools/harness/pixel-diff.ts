/**
 * Compares two screenshot directories pixel by pixel (pixelmatch, threshold 0).
 *
 * - M0-05 determinism: `tsx tools/harness/pixel-diff.ts <dirA> <dirB>` exits 0 only when both
 *   hold the same PNGs and every pair is identical (diff = 0).
 * - Engine-change re-shoots (ROADMAP "Ownership rules"): `--max-ratio 0.02` lists the files whose
 *   changed-pixel share exceeds 2% and exits 1 when there are any.
 *
 * @module
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareDirs, type FileDiff } from "./src/image.ts";

/** The verdict of a directory comparison at a changed-pixel ratio. */
export function summarize(diffs: readonly FileDiff[], maxRatio: number): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = diffs.length > 0;
  if (diffs.length === 0) lines.push("no PNGs to compare");
  for (const d of diffs) {
    if (d.status === "missing-a" || d.status === "missing-b") {
      ok = false;
      lines.push(`${d.status} ${d.file}`);
      continue;
    }
    const ratio = d.ratio ?? 1;
    const bad = maxRatio === 0 ? (d.diffPixels ?? 1) > 0 : ratio > maxRatio;
    if (bad) ok = false;
    lines.push(`${bad ? "DIFF" : "same"} ${d.file}  ${d.diffPixels ?? 0} px (${(ratio * 100).toFixed(3)}%)`);
  }
  return { ok, lines };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "max-ratio": { type: "string", default: "0" } },
  });
  const [a, b] = positionals;
  if (a === undefined || b === undefined) throw new Error("usage: pixel-diff.ts <dirA> <dirB> [--max-ratio 0.02]");
  const maxRatio = Number(values["max-ratio"]);
  if (!(maxRatio >= 0 && maxRatio <= 1)) throw new Error("--max-ratio must be in 0..1");
  const { ok, lines } = summarize(compareDirs(resolve(a), resolve(b)), maxRatio);
  for (const l of lines) console.log(l);
  console.log(ok ? `pixel-diff: ok (${lines.length} files)` : "pixel-diff: DIFFERENT");
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  });
}
