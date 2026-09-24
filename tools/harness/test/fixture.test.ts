/**
 * The "grey default three.js" calibration fixture is a real three.js render (not a mock-up):
 * rendering it produces a non-blank 1280×720 frame that is overwhelmingly neutral grey.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  FIXTURE_PNG,
  FIXTURE_SIZE,
  renderGreyFixture,
  threeBuildDir,
} from "../src/critic/fixture.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function frameStats(
  path: string,
): Promise<{ width: number; height: number; lumaStd: number; greyShare: number }> {
  const { data, info } = await sharp(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let sumSq = 0;
  let grey = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    sumSq += y * y;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 12) grey++;
  }
  const mean = sum / n;
  return {
    width: info.width,
    height: info.height,
    lumaStd: Math.sqrt(sumSq / n - mean * mean),
    greyShare: grey / n,
  };
}

describe("grey default three.js fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-fixture-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves three's module build from the harness", () => {
    expect(threeBuildDir(root).replaceAll("\\", "/")).toMatch(/three\/build$/);
  });

  it("renders a non-blank, mostly grey 1280×720 frame with no page errors", async () => {
    const out = await renderGreyFixture(root, join(dir, "fixture.png"));
    const s = await frameStats(out);
    expect([s.width, s.height]).toEqual([FIXTURE_SIZE.width, FIXTURE_SIZE.height]);
    expect(s.lumaStd).toBeGreaterThan(4); // DOD G7 blank-canvas check
    expect(s.greyShare).toBeGreaterThan(0.8);
  }, 120_000);

  it("fails on a page error instead of writing a frame", async () => {
    const html = join(dir, "throws.html");
    // the error is thrown before the ready flag is set, so it is always recorded first
    writeFileSync(
      html,
      "<script>setTimeout(() => { window.__SCENE_READY__ = true; }, 50); throw new Error('boom');</script>",
    );
    await expect(renderGreyFixture(root, join(dir, "x.png"), html)).rejects.toThrow(
      /fixture page errors: .*boom/,
    );
    expect(existsSync(join(dir, "x.png"))).toBe(false);
  }, 60_000);

  it("fails when the page requests a file the fixture origin does not serve (404)", async () => {
    const html = join(dir, "missing.html");
    writeFileSync(
      html,
      '<script src="/not-served.js"></script><script>window.__SCENE_READY__ = true;</script>',
    );
    await expect(renderGreyFixture(root, join(dir, "y.png"), html)).rejects.toThrow(
      /fixture page errors: .*404/,
    );
  }, 60_000);

  it("the committed fixture PNG used by the calibration run matches that description", async () => {
    const s = await frameStats(join(root, FIXTURE_PNG));
    expect([s.width, s.height]).toEqual([FIXTURE_SIZE.width, FIXTURE_SIZE.height]);
    expect(s.lumaStd).toBeGreaterThan(4);
    expect(s.greyShare).toBeGreaterThan(0.8);
  });
});
