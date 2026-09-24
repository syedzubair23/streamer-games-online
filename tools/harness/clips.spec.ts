/**
 * G7 clips (DOD §3): one 5 s WebM at 1280×720 in dusk for every scenario with a hero animation.
 *
 * The route plays the animation (`play=anim`: fx replay, then `seek` 0→1 over its duration, hold,
 * repeat) with ambient life on, on a **manual clock**: the spec advances it one frame at a time
 * (`__SCENE__.step(40)`), screenshots each frame and encodes 25 fps VP8. The clip therefore shows
 * the real motion at a steady frame rate, independent of render speed, and is identical run to
 * run. Frames sampled across the clip must differ ("not frozen").
 *
 * Output: `artifacts/screenshots/<id>/round-<r>/clips/<state>__dusk__1280x720.webm` and
 * `clips/<state>.json`.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { collectErrors, openScenario } from "./src/browser.ts";
import { encodeJpegFrames, findFfmpeg, probeDuration } from "./src/ffmpeg.ts";
import { diffImages } from "./src/image.ts";
import { CLIP_MODE, CLIP_VIEWPORT, clipScenarios, roundDir, scenarioPath } from "./src/matrix.ts";
import { ROOT, specEnv, writeJson } from "./src/spec-env.ts";

const { game, round, manifest } = specEnv();
const dir = roundDir(game, round);
/** Clip length and frame rate (DOD §3: 4–6 s). */
const CLIP = Object.freeze({ seconds: 5, fps: 25 });

const step = (page: Page, ms: number) =>
  page.evaluate(
    (t) => (globalThis as unknown as { __SCENE__: { step(ms: number): void } }).__SCENE__.step(t),
    ms,
  );

async function rgba(jpeg: Buffer) {
  const { data, info } = await sharp(jpeg)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

test.describe(`G7 clips: ${game}`, () => {
  for (const s of clipScenarios(manifest)) {
    test(`G7 clip: ${s.id}`, async ({ browser }) => {
      test.setTimeout(600_000);
      const ffmpeg = findFfmpeg();
      expect(
        ffmpeg,
        "ffmpeg not found: run `npx playwright install ffmpeg` or set SG_FFMPEG",
      ).not.toBeNull();
      const vp = CLIP_VIEWPORT;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
      });
      const frames: Buffer[] = [];
      const errors: string[] = [];
      try {
        const page = await context.newPage();
        const pageErrors = collectErrors(page);
        page.on("close", () => errors.push(...pageErrors));
        await openScenario(
          page,
          scenarioPath({
            game,
            state: s.id,
            mode: CLIP_MODE,
            quality: vp.tier,
            vp: vp.label,
            role: "stage",
            play: "anim",
            ambient: true,
          }),
        );
        const frameMs = 1000 / CLIP.fps;
        const total = CLIP.seconds * CLIP.fps;
        for (let i = 0; i < total; i++) {
          if (i > 0) await step(page, frameMs);
          frames.push(await page.screenshot({ type: "jpeg", quality: 92 }));
        }
      } finally {
        await context.close();
      }
      const name = `${s.id}__${CLIP_MODE}__${vp.label}.webm`;
      const out = join(ROOT, dir, "clips", name);
      mkdirSync(join(ROOT, dir, "clips"), { recursive: true });
      encodeJpegFrames(ffmpeg!, frames, CLIP.fps, out);
      const duration = probeDuration(ffmpeg!, out);
      const picks = [0, Math.floor(frames.length / 2), frames.length - 1].map((i) => frames[i]!);
      const [a, b, c] = await Promise.all(picks.map(rgba));
      const diffs = [diffImages(a!, b!).diffPixels, diffImages(b!, c!).diffPixels];
      writeJson(`${dir}/clips/${s.id}.json`, {
        state: s.id,
        anim: s.anim,
        file: `clips/${name}`,
        frames: frames.length,
        fps: CLIP.fps,
        durationSec: duration,
        bytes: statSync(out).size,
        frameDiffPixels: diffs,
        errors,
      });
      expect(errors, `console errors in clip ${s.id}`).toEqual([]);
      expect(duration, `clip ${s.id} duration`).not.toBeNull();
      expect(duration!).toBeGreaterThanOrEqual(4);
      expect(duration!).toBeLessThanOrEqual(6);
      expect(Math.max(...diffs), `clip ${s.id} is frozen`).toBeGreaterThan(0);
    });
  }
});
