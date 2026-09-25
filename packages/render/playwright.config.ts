/**
 * Playwright config for the `@sg/render` browser specs (`test/browser/*.spec.ts`): real WebGL2
 * and a real 2D canvas on SwiftShader (deterministic, no GPU needed), one worker so the CPU
 * throttled timings are not disturbed by parallel tests. The page is served from a routed
 * origin (`serve.ts`), so no port or dev server is used.
 *
 * Run: `pnpm --filter @sg/render test:browser` (or `pnpm exec playwright test -c
 * packages/render/playwright.config.ts` from the root).
 */
import { defineConfig } from "@playwright/test";

/** SwiftShader flags (the same set as the harness's deterministic project). */
const SWIFTSHADER_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--disable-gpu-rasterization",
  "--hide-scrollbars",
];

export default defineConfig({
  testDir: "test/browser",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "../../test-results/render",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: SWIFTSHADER_ARGS },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
