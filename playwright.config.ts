/**
 * Playwright config for the harness specs in `tools/harness/*.spec.ts` (ROADMAP M0-05).
 *
 * Projects:
 * - `swiftshader`: CPU rendering, deterministic; screenshots, clips, a11y and the CI perf gate
 *   (G8a). Runs every test not tagged `@gpu`.
 * - `gpu`: the real GPU (`--use-angle=d3d11` on Windows, `gl` elsewhere) in new headless mode, for
 *   the frame-time gate (G8b). Runs only tests tagged `@gpu`.
 *
 * Environment:
 * - `SG_GAME` (required by the specs), `SG_ROUND` (default 1).
 * - `SG_BASE_URL`: an already running scenario server (verify-game starts one). Without it,
 *   Playwright builds the client in `scenario` mode and serves it with `vite preview` on
 *   `SG_PORT` (default 4173).
 * - `SG_WORKERS`: parallel workers (default 4). `SG_REPORT`: JSON report path.
 */
import { defineConfig } from "@playwright/test";
import { baseUrl, gpuArgs, SWIFTSHADER_ARGS } from "./tools/harness/src/browser.ts";

const port = process.env["SG_PORT"] ?? "4173";
const external = process.env["SG_BASE_URL"] !== undefined;
const report = process.env["SG_REPORT"];

export default defineConfig({
  testDir: "tools/harness",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: Number(process.env["SG_WORKERS"] ?? 4),
  timeout: 180_000,
  reporter: report !== undefined ? [["list"], ["json", { outputFile: report }]] : [["list"]],
  use: {
    baseURL: baseUrl(),
    trace: "off",
    screenshot: "off",
    video: "off",
    colorScheme: "light",
  },
  projects: [
    {
      name: "swiftshader",
      grepInvert: /@gpu/,
      use: { browserName: "chromium", launchOptions: { args: [...SWIFTSHADER_ARGS] } },
    },
    {
      name: "gpu",
      grep: /@gpu/,
      use: { browserName: "chromium", channel: "chromium", launchOptions: { args: gpuArgs() } },
    },
  ],
  ...(external
    ? {}
    : {
        webServer: {
          command: `pnpm --filter @sg/client exec vite build --mode scenario && pnpm --filter @sg/client exec vite preview --outDir dist/scenario --port ${port} --strictPort`,
          url: `http://localhost:${port}/dev/scenario?game=tictactoe&state=intro`,
          reuseExistingServer: true,
          timeout: 300_000,
        },
      }),
});
