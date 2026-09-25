/**
 * T11 benchmark body (docs/specs/marble-rally.md T11): run by `physics.test.ts` in a plain
 * Node process (`node --import tsx`), so the solver runs with native ES-module linking as it
 * does on the server. Under Vitest's module transform every imported binding becomes a
 * property read on a module object, which slows hot loops ~3× and would measure the harness
 * rather than the solver.
 *
 * Usage: `node --import tsx test/physics-bench.ts <race|pile> [runs] [steps]`; prints one JSON
 * line: an array of `{ mean, p50, p95, p99, max }` in ms per step, one entry per run.
 */
import { pathToFileURL } from "node:url";
import {
  addMarble,
  compileTrack,
  createBodies,
  createSolver,
  FP,
  step,
  type Bodies,
  type TrackPhysicsDef,
} from "../src/logic/physics/index.ts";
import { packTray, TEST_TRACK } from "./physics-fixtures.ts";

/** Per-run step-time statistics in milliseconds. */
export interface BenchRun {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const PILE: TrackPhysicsDef = {
  segments: [
    [1200, 100, 2900, 100, 16],
    [1200, 100, 1200, 8100, 16],
    [2900, 100, 2900, 8100, 16],
  ],
};

function makePile(): Bodies {
  const pile = createBodies(500);
  for (let i = 0; i < 500; i++)
    addMarble(pile, (1300 + (i % 16) * 100) * FP, (300 + Math.floor(i / 16) * 100) * FP);
  return pile;
}

/** One run: warm up, then time `steps` steps of 500 marbles. */
export function benchRun(scene: "race" | "pile", steps: number): BenchRun {
  const b = scene === "race" ? packTray(500) : makePile();
  const s = createSolver(compileTrack(scene === "race" ? TEST_TRACK : PILE), 500);
  const warm = scene === "race" ? 300 : 600;
  for (let t = 0; t < warm; t++) step(s, b);
  const times: number[] = [];
  for (let t = 0; t < steps; t++) {
    const t0 = performance.now();
    step(s, b);
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((x, y) => x - y);
  const at = (q: number): number => sorted[Math.min(steps - 1, Math.floor(steps * q))]!;
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    mean: r(times.reduce((a, v) => a + v, 0) / steps),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    max: r(sorted[steps - 1]!),
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
const [scene, runs = "3", steps = "1200"] = process.argv.slice(2);
if (isMain && (scene === "race" || scene === "pile")) {
  const out: BenchRun[] = [];
  for (let i = 0; i < Number(runs); i++) out.push(benchRun(scene, Number(steps)));
  console.log(JSON.stringify(out));
}
