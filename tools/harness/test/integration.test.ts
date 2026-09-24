/**
 * End to end: build the client in scenario mode, serve it, render every tictactoe scenario ×
 * role through `/dev/scenario` in SwiftShader Chromium (G6), and check that a production build
 * has no scenario page (SPEC §14). Uses port 5210 (`SG_TEST_PORT` overrides).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkScenarios, renderAll } from "../check-scenarios.ts";
import { collectErrors, openScenario, SWIFTSHADER_ARGS } from "../src/browser.ts";
import { scenarioPath } from "../src/matrix.ts";
import { startScenarioServer, type ScenarioServer } from "../src/server.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PORT = Number(process.env["SG_TEST_PORT"] ?? 5210);
let server: ScenarioServer;

beforeAll(async () => {
  server = await startScenarioServer(ROOT, PORT);
}, 300_000);
afterAll(async () => {
  await server?.stop();
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("scenario client end to end", () => {
  it("G6: every tictactoe scenario renders for each role it lists, with no console errors", async () => {
    const res = await checkScenarios(ROOT, "tictactoe", server.url);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.renders.map((r) => `${r.scenario}/${r.role}`)).toEqual([
      "draw/stage",
      "intro/audience",
      "intro/stage",
      "midgame/audience",
      "midgame/player",
      "midgame/stage",
      "win/player",
      "win/stage",
    ]);
  }, 300_000);

  it("reports a broken scenario as a render failure", async () => {
    const browser = await chromium.launch({ args: [...SWIFTSHADER_ARGS] });
    try {
      const manifest = {
        game: "tictactoe",
        spec: "x",
        perfScript: [],
        problems: [],
        notes: [],
        scenarios: [
          {
            id: "nope",
            description: "",
            anim: null,
            roles: ["stage" as const],
            critic: "",
            variants: {},
            inSpec: true,
            registered: true,
          },
        ],
      };
      const [r] = await renderAll(browser, server.url, manifest, 1);
      expect(r).toMatchObject({ scenario: "nope", role: "stage", ok: false });
      expect(r!.errors.join("\n")).toMatch(/no scenario "nope"/);

      const page = await browser.newPage({ baseURL: server.url });
      const errors = collectErrors(page);
      await openScenario(
        page,
        scenarioPath({
          game: "tictactoe",
          state: "win",
          mode: "night",
          quality: "low",
          role: "stage",
        }),
      );
      const info = await page.evaluate(
        () => (globalThis as { __SCENE_INFO__?: { drawCalls: number } }).__SCENE_INFO__,
      );
      expect(info!.drawCalls).toBeGreaterThan(3);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 300_000);

  it("a production build contains no /dev/scenario page or code", () => {
    const out = mkdtempSync(join(tmpdir(), "sg-prod-"));
    const res = spawnSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      [
        "exec",
        "vite",
        "build",
        "--mode",
        "production",
        "--outDir",
        out,
        "--emptyOutDir",
        "--logLevel",
        "error",
      ],
      {
        cwd: join(ROOT, "apps/client"),
        shell: process.platform === "win32",
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(existsSync(join(out, "dev/scenario.html"))).toBe(false);
    for (const f of walk(out).filter((p) => p.endsWith(".js") || p.endsWith(".html")))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/__SCENE_READY__/);
  }, 300_000);
});
