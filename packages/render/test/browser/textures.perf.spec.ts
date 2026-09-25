/**
 * ROADMAP M1-06 Accept: **all procedural textures generate in 150 ms or less under a 4× CPU
 * throttle** (SPEC §13.6: "generated at boot in under 150 ms on a Chromebook").
 *
 * For each tier the whole boot set (`TextureKit.generateBoot()`: every texture kind, both
 * matcaps, the table wood, board art and the card atlas) is painted **cold**: a fresh browser
 * context (its own renderer process, so no JIT or compilation cache is shared), no IndexedDB
 * store, the CPU throttled 4× with the Chrome DevTools Protocol. The time covers canvas
 * creation, painting and texture creation.
 *
 * Throttling is relative to the host CPU, and a shared build machine adds noise that only ever
 * makes a run slower, so each tier runs five cold trials and the budget applies to the best
 * one (all trials are recorded). A fixed workload is timed before and after throttling in every
 * trial; a trial only counts if it ran at least 2.5× slower (the throttle demonstrably applied),
 * and at least four of the five must count. Results go to `artifacts/perf/render-textures.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { openHarness } from "./serve.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** SPEC §13.6 budget for the whole boot set. */
const BUDGET_MS = 150;
/** CDP CPU throttle (ROADMAP M1-06: "under a 4× CPU throttle"). */
const THROTTLE = 4;
/** Cold trials per tier (fresh context each). */
const TRIALS = 5;

interface Trial {
  totalMs: number;
  count: number;
  entries: Record<string, number>;
  /** Measured slowdown of a fixed workload after throttling (proves the throttle applied). */
  throttleRatio: number;
}

/** A fixed CPU workload (ms) run in the page, to verify the throttle is in effect. */
async function calibrate(page: Page): Promise<number> {
  return page.evaluate(() => {
    const run = (): number => {
      const t0 = performance.now();
      let x = 0;
      for (let i = 0; i < 3_000_000; i++) x = (x + i * 7) % 1_000_003;
      const dt = performance.now() - t0;
      return x < 0 ? -1 : dt;
    };
    run();
    return Math.min(run(), run(), run());
  });
}
/** The throttle counts as applied when the workload is at least this much slower. */
const MIN_THROTTLE_RATIO = 2.5;
const results: Record<string, { bestMs: number; trials: Trial[] }> = {};

for (const tier of ["low", "mid", "high"] as const) {
  test(`${tier}: the boot texture set paints in ≤ ${BUDGET_MS} ms at ${THROTTLE}× CPU throttle`, async ({
    browser,
  }) => {
    const trials: Trial[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openHarness(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const base = await calibrate(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
      // The throttler engages asynchronously: wait (by measuring, never by sleeping) until the
      // fixed workload runs at least MIN_THROTTLE_RATIO× slower, or give up after 20 probes.
      let throttled = await calibrate(page);
      for (let probe = 0; probe < 20 && throttled / base < MIN_THROTTLE_RATIO; probe++)
        throttled = await calibrate(page);
      const r = await page.evaluate((t) => {
        const { R } = window.__sg;
        const kit = R.createTextureKit({ tier: t });
        const boot = kit.generateBoot();
        const count = kit.all().length;
        kit.dispose();
        return { totalMs: boot.total, entries: boot.entries, count };
      }, tier);
      await context.close();
      trials.push({ ...r, throttleRatio: Math.round((throttled / base) * 100) / 100 });
    }
    // Only trials where the throttle demonstrably applied count.
    const valid = trials.filter((t) => t.throttleRatio >= MIN_THROTTLE_RATIO);
    expect(valid.length, JSON.stringify(trials.map((t) => t.throttleRatio))).toBeGreaterThanOrEqual(
      4,
    );
    const best = Math.min(...valid.map((t) => t.totalMs));
    results[tier] = { bestMs: Math.round(best * 10) / 10, trials };
    const out = resolve(ROOT, "artifacts/perf");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      resolve(out, "render-textures.json"),
      `${JSON.stringify({ budgetMs: BUDGET_MS, cpuThrottle: THROTTLE, trialsPerTier: TRIALS, tiers: results }, null, 2)}\n`,
    );
    console.log(
      `${tier}: best ${best.toFixed(1)} ms of [${trials.map((t) => `${t.totalMs.toFixed(1)} (×${t.throttleRatio})`).join(", ")}]`,
    );
    for (const t of valid)
      console.log(
        `  ${Object.entries(t.entries)
          .map(([k, v]) => `${k}=${v.toFixed(1)}`)
          .join(" ")}`,
      );
    for (const t of trials) expect(t.count).toBeGreaterThanOrEqual(13);
    expect(best).toBeLessThanOrEqual(BUDGET_MS);
  });
}
