/**
 * Browser setup shared by `playwright.config.ts`, the specs and `check-scenarios.ts`.
 *
 * Two Chromium flavours (ROADMAP M0-05):
 * - **swiftshader**: CPU rendering through ANGLE/SwiftShader. Deterministic (pixel-identical
 *   runs), used for screenshots, clips, a11y and the CI perf gate (G8a).
 * - **gpu**: the real GPU (`--use-angle=d3d11` on Windows, `gl` elsewhere), used for the
 *   frame-time gate (G8b). When no hardware GPU is reachable the gate records
 *   `skipped: "no-gpu"` (DOD §2).
 *
 * Every wait is on the page's own `__SCENE_READY__` / `__SCENE_ERROR__` flags, never on a timer.
 *
 * @module
 */
import type { Page } from "@playwright/test";

/** Flags that make SwiftShader output reproducible run to run. */
export const SWIFTSHADER_ARGS: readonly string[] = Object.freeze([
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--disable-gpu-rasterization",
  "--hide-scrollbars",
]);

/** Flags for the GPU project on this platform. */
export function gpuArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    platform === "win32" ? "--use-angle=d3d11" : "--use-angle=gl",
    "--force-color-profile=srgb",
  ];
}

/** Renderer strings that mean "no hardware GPU". */
export const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|basic render|software/i;

/** The base URL of the scenario server (`SG_BASE_URL`, default the harness preview port). */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env["SG_BASE_URL"] ?? `http://localhost:${env["SG_PORT"] ?? "4173"}`;
}

/** Collects console errors and uncaught page errors. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/**
 * Opens a scenario and waits until the route reports ready (or failed). Never waits on a
 * timeout: the route sets `__SCENE_READY__` only after its final frame is composited.
 *
 * @throws Error with the route's message when it set `__SCENE_ERROR__`.
 */
export async function openScenario(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(
    () => {
      const w = globalThis as { __SCENE_READY__?: boolean; __SCENE_ERROR__?: string };
      return w.__SCENE_READY__ === true || typeof w.__SCENE_ERROR__ === "string";
    },
    null,
    { timeout: 0, polling: "raf" },
  );
  const error = await page.evaluate(
    () => (globalThis as { __SCENE_ERROR__?: string }).__SCENE_ERROR__,
  );
  if (typeof error === "string") throw new Error(`scenario ${path} failed: ${error}`);
}
