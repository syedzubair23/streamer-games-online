/**
 * G7 screenshots (DOD §3): the full still matrix of a game, each capture checked for console
 * errors and a blank canvas (luma standard deviation above 4). Every capture waits on the
 * route's `__SCENE_READY__`, never on a timer.
 *
 * Also the M0-05 determinism check: every stage scenario rendered twice in fresh browser
 * contexts is pixel-identical (pixelmatch diff = 0 on swiftshader).
 *
 * Output: `artifacts/screenshots/<id>/round-<r>/<state>__<mode>__<vp|role>.png`, plus
 * `meta/<file>.json` (console errors, luma deviation, scene info) per capture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { collectErrors, openScenario } from "./src/browser.ts";
import { BLANK_STDDEV, diffImages, luminanceStdDev, readPng } from "./src/image.ts";
import {
  roundDir,
  scenarioPath,
  screenshotMatrix,
  shotPath,
  STAGE_VIEWPORTS,
  type Shot,
  type Viewport,
} from "./src/matrix.ts";
import { ROOT, specEnv, writeJson } from "./src/spec-env.ts";

const { game, round, manifest } = specEnv();
const dir = roundDir(game, round);

async function capture(browser: Browser, vp: Viewport, path: string) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    reducedMotion: "no-preference",
  });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    await openScenario(page, path);
    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    const info = await page.evaluate(() => (globalThis as { __SCENE_INFO__?: unknown }).__SCENE_INFO__);
    return { png, errors, info };
  } finally {
    await context.close();
  }
}

test.describe(`G7 stills: ${game}`, () => {
  for (const shot of screenshotMatrix(manifest)) {
    test(`G7 ${shot.set}: ${shot.file}`, async ({ browser }) => {
      const { png, errors, info } = await capture(browser, shot.viewport, shotPath(game, shot));
      const file = join(ROOT, dir, shot.file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
      const stddev = luminanceStdDev(readPng(png));
      writeJson(`${dir}/meta/${shot.file}.json`, {
        file: shot.file,
        set: shot.set,
        state: shot.state,
        mode: shot.mode,
        role: shot.role,
        viewport: shot.viewport.label,
        errors,
        lumaStdDev: Math.round(stddev * 100) / 100,
        info,
      } satisfies Record<string, unknown> & Pick<Shot, "file">);
      expect(errors, `console errors in ${shot.file}`).toEqual([]);
      expect(stddev, `${shot.file} is blank (luma std dev ${stddev.toFixed(2)})`).toBeGreaterThan(
        BLANK_STDDEV,
      );
    });
  }
});

test.describe(`M0-05 determinism: ${game}`, () => {
  const vp = STAGE_VIEWPORTS[1] as Viewport;
  const states = manifest.scenarios
    .filter((s) => s.inSpec && s.registered && s.roles.includes("stage"))
    .map((s) => s.id);
  for (const state of states) {
    test(`determinism: ${state} renders pixel-identical twice`, async ({ browser }) => {
      const path = scenarioPath({ game, state, mode: "dusk", quality: vp.tier, vp: vp.label, role: "stage" });
      const a = await capture(browser, vp, path);
      const b = await capture(browser, vp, path);
      const d = diffImages(readPng(a.png), readPng(b.png));
      expect(d.sameSize).toBe(true);
      expect(d.diffPixels, `${state}: ${d.diffPixels} pixels differ between two renders`).toBe(0);
    });
  }
});
