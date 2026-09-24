/// <reference lib="dom" />
/**
 * Performance gates (DOD §2, SPEC §10).
 *
 * - **G8a** (swiftshader, CI): the `midgame` scenario at low tier: draws ≤ 60 and triangles
 *   ≤ 50k for the whole frame including the environment, programs ≤ 10, texture memory
 *   ≤ 24 MB, 0 idle renders per second with ambient off, and unmounting returns
 *   `renderer.info.memory` to its pre-mount baseline. (Chunk sizes are measured by
 *   verify-game from the game's client entries.)
 * - **G8b** (`@gpu`): the spec's perf script on the real GPU: low tier at 412×915 with 4× CPU
 *   throttle p95 ≤ 33.3 ms, high tier at 1920×1080 p95 ≤ 16.7 ms, heap growth < 5 MB over a
 *   60 s loop. Without a hardware GPU the result is `skipped: "no-gpu"`.
 *
 * Output: `artifacts/perf/<id>.json` (G8a) and `artifacts/perf/<id>-gpu.json` (G8b).
 */
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, openScenario, SOFTWARE_RENDERERS } from "./src/browser.ts";
import { midgameScenario, PERF_HIGH, PERF_LOW, scenarioPath, type Viewport } from "./src/matrix.ts";
import { specEnv, writeJson } from "./src/spec-env.ts";

const { game, manifest } = specEnv();

/** SPEC §10 low-tier CI budgets. */
const G8A = Object.freeze({ draws: 60, tris: 50_000, programs: 10, texMB: 24 });
/** DOD G8b thresholds. */
const G8B = Object.freeze({ p95Low: 33.3, p95High: 16.7, heapMB: 5, throttle: 4 });

type Handle = {
  info(): { drawCalls: number; tris: number; programs: number; textures: number; geometries: number; texMB: number };
  renders(): number;
  sample(ms: number): Promise<number[]>;
  unmount(): { baseline: unknown; after: unknown; leakedGeometries: number; leakedTextures: number };
};
const scene = (page: Page) => ({
  info: () => page.evaluate(() => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.info()),
  renders: () => page.evaluate(() => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.renders()),
  sample: (ms: number) =>
    page.evaluate((t) => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.sample(t), ms),
  unmount: () => page.evaluate(() => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.unmount()),
});

/** The nearest-rank p95 of frame deltas. */
function p95(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.ceil(0.95 * sorted.length)) - 1] as number;
}

const mid = midgameScenario(manifest);

test(`G8a: ${game} midgame budgets at low tier`, async ({ browser }) => {
  expect(mid, "no stage scenario to measure").not.toBeNull();
  const vp = PERF_LOW;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    await openScenario(
      page,
      scenarioPath({ game, state: mid!.id, mode: "dusk", quality: "low", vp: vp.label, role: "stage", freeze: false, ambient: false }),
    );
    const s = scene(page);
    const info = await s.info();
    const before = await s.renders();
    await s.sample(1000);
    const idleRenders = (await s.renders()) - before;
    const leak = await s.unmount();
    const result = {
      scenario: mid!.id,
      viewport: vp.label,
      draws: info.drawCalls,
      tris: info.tris,
      programs: info.programs,
      texMB: info.texMB,
      idleRendersPerSec: idleRenders,
      leakedGeometries: leak.leakedGeometries,
      leakedTextures: leak.leakedTextures,
      memory: { baseline: leak.baseline, after: leak.after },
      errors,
    };
    writeJson(`artifacts/perf/${game}.json`, { game, g8a: result });
    expect(errors).toEqual([]);
    expect(result.draws, "draw calls (low)").toBeLessThanOrEqual(G8A.draws);
    expect(result.tris, "triangles (low)").toBeLessThanOrEqual(G8A.tris);
    expect(result.programs, "shader programs (low)").toBeLessThanOrEqual(G8A.programs);
    expect(result.texMB, "texture memory MB (low)").toBeLessThanOrEqual(G8A.texMB);
    expect(result.idleRendersPerSec, "idle renders per second with ambient off").toBe(0);
    expect(result.leakedGeometries, "geometries left after unmount").toBe(0);
    expect(result.leakedTextures, "textures left after unmount").toBe(0);
  } finally {
    await context.close();
  }
});

/** The GPU's unmasked renderer string (or "unknown"). */
async function gpuRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl === null) return "no-webgl2";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(ext !== null ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });
}

async function runPerf(page: Page, vp: Viewport, quality: "low" | "high", ms: number): Promise<number[]> {
  const script = manifest.perfScript.length > 0 ? manifest.perfScript : mid?.anim ? [mid.anim.name] : [];
  expect(script.length, "the spec has no perf script and midgame has no anim").toBeGreaterThan(0);
  await openScenario(
    page,
    scenarioPath({ game, state: mid!.id, mode: "dusk", quality, vp: vp.label, role: "stage", freeze: false, play: "perf", perf: script }),
  );
  return scene(page).sample(ms);
}

test(`G8b: ${game} perf script on the GPU @gpu`, async ({ browser }) => {
  test.setTimeout(300_000);
  expect(mid, "no stage scenario to measure").not.toBeNull();
  const probe = await browser.newPage();
  const renderer = await gpuRenderer(probe);
  await probe.close();
  if (SOFTWARE_RENDERERS.test(renderer) || renderer === "no-webgl2") {
    writeJson(`artifacts/perf/${game}-gpu.json`, { game, g8b: { skipped: "no-gpu", renderer } });
    test.skip(true, `no hardware GPU (${renderer})`);
    return;
  }

  // Low tier, phone viewport, 4x CPU throttle.
  const low = await browser.newContext({ viewport: { width: PERF_LOW.width, height: PERF_LOW.height }, isMobile: true, hasTouch: true });
  const lowPage = await low.newPage();
  const cdp = await low.newCDPSession(lowPage);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: G8B.throttle });
  const lowFrames = await runPerf(lowPage, PERF_LOW, "low", 10_000);
  await low.close();

  // High tier, 1080p, no throttle; then the 60 s heap loop on the same page.
  const high = await browser.newContext({ viewport: { width: PERF_HIGH.width, height: PERF_HIGH.height } });
  const highPage = await high.newPage();
  const hcdp = await high.newCDPSession(highPage);
  const highFrames = await runPerf(highPage, PERF_HIGH, "high", 10_000);
  await hcdp.send("HeapProfiler.enable");
  await hcdp.send("HeapProfiler.collectGarbage");
  const h0 = (await hcdp.send("Runtime.getHeapUsage")).usedSize;
  await scene(highPage).sample(60_000);
  await hcdp.send("HeapProfiler.collectGarbage");
  const h1 = (await hcdp.send("Runtime.getHeapUsage")).usedSize;
  await high.close();

  const result = {
    renderer,
    p95Low: Math.round(p95(lowFrames) * 10) / 10,
    p95High: Math.round(p95(highFrames) * 10) / 10,
    framesLow: lowFrames.length,
    framesHigh: highFrames.length,
    heapGrowthMB: Math.round(((h1 - h0) / (1024 * 1024)) * 100) / 100,
  };
  writeJson(`artifacts/perf/${game}-gpu.json`, { game, g8b: result });
  expect(result.p95Low, "p95 frame ms at low tier, 4x CPU").toBeLessThanOrEqual(G8B.p95Low);
  expect(result.p95High, "p95 frame ms at high tier, 1080p").toBeLessThanOrEqual(G8B.p95High);
  expect(result.heapGrowthMB, "heap growth over 60 s").toBeLessThan(G8B.heapMB);
});
