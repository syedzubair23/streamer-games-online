/**
 * Heap probe for the zero-allocation test in `tween.test.ts`, run in a fresh
 * `node --expose-gc` process (a Vitest worker shares its JIT with the rest of the suite and runs
 * modules through a transform, which makes steady-state measurements noisy). Prints JSON.
 */
import { createTweens } from "../../src/tween.ts";

const t = createTweens();
const objs = Array.from({ length: 50 }, () => ({ x: 0, y: 0 }));
for (const o of objs) {
  t.to(o, { x: 1 }, { durationMs: 1e9 });
  t.spring(o, { y: 1e6 }, { stiffness: 0.0001, damping: 0.0001 });
}
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("run with --expose-gc");
const rounds: number[] = [];
for (let round = 0; round < 6; round++) {
  for (let i = 0; i < 3000; i++) t.step(1000 / 60);
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 5000; i++) t.step(1000 / 60);
  rounds.push(process.memoryUsage().heapUsed - before);
}
process.stdout.write(JSON.stringify({ rounds, active: t.active }));
