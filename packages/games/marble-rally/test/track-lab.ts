/**
 * Track tools for M9-00b, run in a plain Node process (the solver is ~3× slower under Vitest's
 * module transform). From the package directory:
 *
 *   node --import tsx test/track-lab.ts preview [dir]
 *       write an SVG preview of every track (tray filled with 500 slots) to `dir`
 *       (default: artifacts/tracks at the repo root)
 *   node --import tsx test/track-lab.ts sample <id> <races> <entrants> [seed] [--nudges]
 *       tuning: run a few races and print their statistics as JSON
 *   node --import tsx test/track-lab.ts check [races] [--only <id>] [--out <file>] [--svg <dir>]
 *                                            [--cache]
 *       the Accept check: `races` (default 200) simulated races per track plus 200 stuck-spot
 *       probes; prints one JSON report line and exits 1 unless every track passes. With
 *       `--cache` and an `--out` report whose fingerprint (a hash of every input: the track
 *       JSON, the solver, the tracks module and these tools) matches, the stored result is
 *       re-judged instead of re-simulated: the simulation is deterministic, so identical inputs
 *       give identical races.
 *   node --import tsx test/track-lab.ts snapshot <id> <entrants> <tick> [file]
 *       SVG of a race at a tick (marbles overlaid), for reviewing the flow
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRng } from "@sg/shared";
import { TICK_HZ } from "../src/logic/physics/index.ts";
import {
  getCourse,
  PROGRESS_MAX,
  TRACK_IDS,
  TRACKS,
  isTrackId,
  type Course,
  type TrackId,
} from "../src/logic/tracks/index.ts";
import { renderTrackPreview } from "../src/preview/track-preview.ts";
import { DEV_PALETTE } from "./dev-palette.ts";
import { runRace, runSolo, type RaceResult } from "./race-sim.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");

/**
 * A hash of every input of the track check: the track JSON and the logic it runs on (solver,
 * tracks module) plus the race runner and this file. Any change means a re-run.
 */
export function checkFingerprint(races: number, ids: readonly string[]): string {
  const h = createHash("sha256");
  h.update(`races=${races};ids=${ids.join(",")};`);
  const dirs = [resolve(HERE, "../src/logic/physics"), resolve(HERE, "../src/logic/tracks")];
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => /\.(ts|json)$/.test(f))
      .sort()
      .map((f) => join(d, f)),
  );
  files.push(resolve(HERE, "race-sim.ts"), resolve(HERE, "track-lab.ts"));
  const base = resolve(HERE, "..").length;
  for (const f of files) {
    h.update(f.slice(base).split("\\").join("/"));
    h.update(readFileSync(f, "utf8").split("\r\n").join("\n"));
  }
  return h.digest("hex");
}

/** Pass bar for a track (docs/specs/marble-rally.md "Content"). */
export const TRACK_BAR = {
  /** A typical race lasts 60–100 s: the median race and at least 80% of races in range. */
  minSec: 60,
  maxSec: 100,
  inRangeShare: 0.8,
  /** At least 60% of marbles finish, in every race. */
  minFinishShare: 0.6,
  /** Every solo drop probe along the path reaches the finish. */
  soloProbes: 200,
} as const;

const q = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Statistics of a set of races. */
export function summarize(results: readonly RaceResult[]): Record<string, number> {
  const secs = results.map((r) => r.endTick / TICK_HZ).sort((a, b) => a - b);
  const share = results.map((r) => r.finished / r.entrants).sort((a, b) => a - b);
  const win = results
    .map((r) => Math.min(...r.finishTick.filter((t) => t >= 0)) / TICK_HZ)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const inRange = secs.filter((s) => s >= TRACK_BAR.minSec && s <= TRACK_BAR.maxSec).length;
  return {
    races: results.length,
    medianSec: r1(q(secs, 0.5)),
    p10Sec: r1(q(secs, 0.1)),
    p90Sec: r1(q(secs, 0.9)),
    minSec: r1(secs[0] ?? 0),
    maxSec: r1(secs[secs.length - 1] ?? 0),
    inRangeShare: r1((inRange / results.length) * 100) / 100,
    medianWinnerSec: r1(q(win, 0.5)),
    minFinishShare: Math.round((share[0] ?? 0) * 1000) / 1000,
    medianFinishShare: Math.round(q(share, 0.5) * 1000) / 1000,
    kicksPerRace: r1(results.reduce((a, r) => a + r.kicks, 0) / results.length),
    gateSkips: results.reduce((a, r) => a + r.gateSkips, 0),
    outOfWorld: results.reduce((a, r) => a + r.outOfWorld, 0),
    maxProgressDrop: Math.max(...results.map((r) => r.maxProgressDrop)),
  };
}

/** The field size of race `i` of a check: a seeded spread over typical rooms (50–500). */
export function fieldSize(seed: string, i: number): number {
  return 200 + createRng(`${seed}:${i}`).int(301);
}

/** Points along the centreline for the solo probes, with the checkpoint reached before each. */
export function probePoints(c: Course, count: number): { x: number; y: number; cp: number }[] {
  const out: { x: number; y: number; cp: number }[] = [];
  const cl = c.def.centerline;
  for (let k = 0; k < count; k++) {
    // Probe at progress in (0, finish): evenly spaced, skipping the very start.
    const target = Math.floor(((k + 0.5) * c.finishProgress) / count);
    const s = (target * c.length) / PROGRESS_MAX;
    let i = 0;
    while (i + 2 < cl.length && c.cls[i + 1]! < s) i++;
    const t = (s - c.cls[i]!) / Math.max(1, c.cls[i + 1]! - c.cls[i]!);
    const x = Math.round(cl[i]![0] + (cl[i + 1]![0] - cl[i]![0]) * t);
    const y = Math.round(cl[i]![1] + (cl[i + 1]![1] - cl[i]![1]) * t);
    const cp = c.gateProgress.filter((g) => g <= target).length;
    out.push({ x, y, cp });
  }
  return out;
}

/** The full Accept check for one track. */
export function checkTrack(
  id: TrackId,
  races: number,
): {
  id: TrackId;
  ok: boolean;
  stats: Record<string, number>;
  soloFails: [number, number][];
  dnfSpots: [number, number][];
  failures: string[];
} {
  const c = getCourse(id);
  const results: RaceResult[] = [];
  for (let i = 0; i < races; i++)
    results.push(
      runRace(c, {
        entrants: fieldSize(`check:${id}`, i),
        seed: `check:${id}:${i}`,
        nudges: i % 2 === 1,
      }),
    );
  const stats = summarize(results);
  const soloFails: [number, number][] = [];
  probePoints(c, TRACK_BAR.soloProbes).forEach((p, k) => {
    const r = runSolo(c, p.x, p.y, p.cp, `solo:${id}:${k}`);
    if (!r.finished) soloFails.push([p.x, p.y]);
  });
  const failures: string[] = [];
  if (stats.medianSec! < TRACK_BAR.minSec || stats.medianSec! > TRACK_BAR.maxSec)
    failures.push(
      `median race ${stats.medianSec} s outside ${TRACK_BAR.minSec}-${TRACK_BAR.maxSec} s`,
    );
  if (stats.inRangeShare! < TRACK_BAR.inRangeShare)
    failures.push(
      `only ${stats.inRangeShare! * 100}% of races last ${TRACK_BAR.minSec}-${TRACK_BAR.maxSec} s`,
    );
  if (stats.minFinishShare! < TRACK_BAR.minFinishShare)
    failures.push(`a race finished only ${stats.minFinishShare! * 100}% of its marbles`);
  if (soloFails.length > 0) failures.push(`${soloFails.length} solo probes never finished`);
  if (stats.gateSkips! > 0) failures.push(`${stats.gateSkips} finishes skipped a gate`);
  if (stats.outOfWorld! > 0) failures.push(`${stats.outOfWorld} marble-ticks outside the world`);
  const dnfSpots = results.flatMap((r) => r.dnfAt);
  return { id, ok: failures.length === 0, stats, soloFails, dnfSpots, failures };
}

function preview(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const id of TRACK_IDS) {
    const svg = renderTrackPreview(TRACKS[id], { palette: DEV_PALETTE, traySlots: 500 });
    writeFileSync(join(dir, `${id}.svg`), svg);
    console.log(`wrote ${join(dir, `${id}.svg`)}`);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "preview") preview(rest[0] ?? join(ROOT, "artifacts/tracks"));
  else if (cmd === "sample") {
    const [id, races = "3", n = "500", seed = "lab"] = rest;
    if (!isTrackId(id)) throw new Error(`unknown track ${id}`);
    const c = getCourse(id);
    const res: RaceResult[] = [];
    for (let i = 0; i < Number(races); i++) {
      const r = runRace(c, {
        entrants: Number(n),
        seed: `${seed}:${i}`,
        nudges: rest.includes("--nudges"),
      });
      res.push(r);
      const fin = r.finishTick.filter((t) => t >= 0).sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          race: i,
          endSec: r1(r.endTick / TICK_HZ),
          winSec: r1((fin[0] ?? 0) / TICK_HZ),
          p50Sec: r1(q(fin, 0.5) / TICK_HZ),
          p90Sec: r1(q(fin, 0.9) / TICK_HZ),
          lastFinishSec: r1((fin[fin.length - 1] ?? 0) / TICK_HZ),
          lastDnf: r.dnfTick
            .map((t, j) => [r1(t / TICK_HZ), ...r.dnfAt[j]!] as const)
            .sort((a, b2) => b2[0] - a[0])
            .slice(0, 4),
          finished: r.finished,
          dnf: r.dnf,
          kicks: r.kicks,
        }),
      );
    }
    console.log(JSON.stringify(summarize(res)));
  } else if (cmd === "snapshot") {
    const [id, n = "500", at = "600", file] = rest;
    if (!isTrackId(id)) throw new Error(`unknown track ${id}`);
    const c = getCourse(id);
    let svg = "";
    runRace(c, {
      entrants: Number(n),
      seed: "snapshot",
      onTick: (tick, b) => {
        if (tick === Number(at))
          svg = renderTrackPreview(TRACKS[id], {
            palette: DEV_PALETTE,
            marbles: b,
            notes: [`tick ${tick} (${r1(tick / TICK_HZ)} s), ${n} marbles`],
          });
      },
    });
    const out = file ?? join(ROOT, "artifacts/tracks", `${id}-t${at}.svg`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, svg);
    console.log(`wrote ${out}`);
  } else if (cmd === "check") {
    const races = Number(rest.find((a) => /^\d+$/.test(a)) ?? 200);
    const only = flag("--only");
    const ids = only !== undefined && isTrackId(only) ? [only] : [...TRACK_IDS];
    const fingerprint = checkFingerprint(races, ids);
    const out = flag("--out");
    if (rest.includes("--cache") && out !== undefined && existsSync(out)) {
      const prev = JSON.parse(readFileSync(out, "utf8")) as {
        fingerprint?: string;
        ok?: boolean;
        tracks?: { id: string; ok: boolean; failures: string[] }[];
      };
      if (prev.fingerprint === fingerprint && Array.isArray(prev.tracks)) {
        for (const t of prev.tracks)
          console.error(
            `${t.id}: ${t.ok ? "ok" : "FAIL"} (cached, inputs unchanged) ${t.failures.join("; ")}`,
          );
        console.log(JSON.stringify({ cached: true, fingerprint, ok: prev.ok === true }));
        process.exitCode = prev.ok === true ? 0 : 1;
        process.exit();
      }
    }
    const report = ids.map((id) => {
      const t0 = performance.now();
      const r = checkTrack(id, races);
      console.error(
        `${id}: ${r.ok ? "ok" : "FAIL"} ${JSON.stringify(r.stats)} ${r.failures.join("; ")} (${r1((performance.now() - t0) / 1000)} s)`,
      );
      return r;
    });
    const svgDir = flag("--svg");
    if (svgDir !== undefined) {
      mkdirSync(svgDir, { recursive: true });
      for (const r of report)
        writeFileSync(
          join(svgDir, `${r.id}-check.svg`),
          renderTrackPreview(TRACKS[r.id], {
            palette: DEV_PALETTE,
            spots: [...r.dnfSpots.slice(0, 400), ...r.soloFails],
            notes: [
              `${r.stats.races} races: median ${r.stats.medianSec} s, winner ${r.stats.medianWinnerSec} s`,
              `finish share min ${r.stats.minFinishShare}, median ${r.stats.medianFinishShare}`,
            ],
          }),
        );
    }
    const summary = {
      races,
      fingerprint,
      ok: report.every((r) => r.ok),
      bar: TRACK_BAR,
      setup:
        "typical audience races: 200-500 entrants (seeded), every other race with R5 nudges, R6 kicks and DNFs, eliminations and chaos off; probes: a marble at rest at 200 points along the path must reach the finish within 120 s",
      tracks: report.map((r) => ({
        id: r.id,
        ok: r.ok,
        stats: r.stats,
        soloProbes: TRACK_BAR.soloProbes,
        soloFails: r.soloFails,
        dnfSpotsSample: r.dnfSpots.slice(0, 20),
        failures: r.failures,
      })),
    };
    if (out !== undefined) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
    }
    console.log(JSON.stringify(summary));
    process.exitCode = summary.ok ? 0 : 1;
  } else {
    console.error("usage: track-lab.ts preview|sample|snapshot|check …");
    process.exitCode = 2;
  }
}
