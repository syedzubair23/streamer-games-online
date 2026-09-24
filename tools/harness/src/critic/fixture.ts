/**
 * Renders the "grey default three.js" calibration fixture (ROADMAP M0-06) to a PNG with headless
 * Chromium on SwiftShader, so the fixture is a real three.js frame rather than a mock-up.
 * The page (`tools/harness/calibration/grey-default-threejs.html`) is served from a synthetic
 * origin; `/three/*` maps to the workspace's three build.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";

export const FIXTURE_HTML = "tools/harness/calibration/grey-default-threejs.html";
export const FIXTURE_PNG = "tools/harness/calibration/grey-default-threejs.png";
export const FIXTURE_SIZE = { width: 1280, height: 720 } as const;

const ORIGIN = "http://calibration.fixture";

/** Directory of three's ES module build, resolved from the harness package. */
export function threeBuildDir(root: string): string {
  const require = createRequire(join(root, "tools/harness/package.json"));
  return dirname(require.resolve("three"));
}

/**
 * Renders the fixture page and writes the PNG. Waits on `window.__SCENE_READY__` (never on a
 * fixed timeout) and fails on any page error, so a broken fixture can't silently calibrate.
 * `htmlPath` (relative to `root`, or absolute) exists so tests can render a deliberately broken page.
 */
export async function renderGreyFixture(
  root: string,
  outPath = join(root, FIXTURE_PNG),
  htmlPath = FIXTURE_HTML,
): Promise<string> {
  const html = readFileSync(resolve(root, htmlPath), "utf8");
  const threeDir = threeBuildDir(root);
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({ viewport: { ...FIXTURE_SIZE }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/" || path === "/index.html") {
        await route.fulfill({ contentType: "text/html", body: html });
      } else if (/^\/three\/[\w.-]+\.js$/.test(path)) {
        await route.fulfill({
          contentType: "text/javascript",
          body: readFileSync(join(threeDir, path.slice("/three/".length))),
        });
      } else {
        await route.fulfill({ status: 404, body: "not found" });
      }
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(
      () => (globalThis as { __SCENE_READY__?: boolean }).__SCENE_READY__ === true,
      null,
      {
        timeout: 60_000,
      },
    );
    if (errors.length) throw new Error(`fixture page errors: ${errors.join("; ")}`);
    mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: false });
    return outPath;
  } finally {
    await browser.close();
  }
}
