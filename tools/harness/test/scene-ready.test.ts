/**
 * M0-05 Accept: "the route waits on `__SCENE_READY__` and never on a timeout". Static checks over
 * the harness specs, the shared browser helper and the route, plus the Playwright projects.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../../playwright.config.ts";
import { baseUrl, gpuArgs, SWIFTSHADER_ARGS } from "../src/browser.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const SPECS = ["screenshots", "clips", "perf", "a11y"].map((s) => `tools/harness/${s}.spec.ts`);
/** Timer waits. Playwright's `test.setTimeout(ms)` sets a per-test limit and is not a wait. */
const NO_TIMERS =
  /\bwaitForTimeout\s*\(|(?<!test\.)\bsetTimeout\s*\(|\bsetInterval\s*\(|\bsleep\s*\(/;

describe("scenes are awaited on __SCENE_READY__, never on a timer", () => {
  it("every spec and check-scenarios open scenarios through openScenario, and use no timers", () => {
    for (const file of [...SPECS, "tools/harness/check-scenarios.ts"]) {
      const src = read(file);
      expect(src, file).toMatch(/openScenario\(/);
      expect(src, file).not.toMatch(NO_TIMERS);
      expect(src, file).not.toMatch(/page\.goto\(/); // only openScenario navigates
    }
  });

  it("openScenario waits on the route's flags with no timeout", () => {
    const src = read("tools/harness/src/browser.ts");
    const body = src.slice(src.indexOf("export async function openScenario"));
    expect(body).toMatch(/__SCENE_READY__ === true/);
    expect(body).toMatch(/__SCENE_ERROR__/);
    expect(body).toMatch(/timeout: 0, polling: "raf"/);
    expect(src).not.toMatch(NO_TIMERS);
  });

  it("the route sets __SCENE_READY__ only after fonts and two composited frames, never after a timer", () => {
    const src = read("apps/client/src/dev/scenario.tsx");
    expect(src).not.toMatch(NO_TIMERS);
    expect(src).toMatch(
      /async function stable\(\)[\s\S]*fonts[\s\S]*await nextFrame\(\);\s*await nextFrame\(\);/,
    );
    const ready = src.lastIndexOf("window.__SCENE_READY__ = true");
    expect(ready).toBeGreaterThan(0);
    expect(src.lastIndexOf("await mountStage", ready)).toBeGreaterThan(0);
    const stage = src.slice(src.indexOf("async function mountStage"));
    expect(stage.slice(0, stage.indexOf("\n  return {"))).toMatch(/await stable\(\)/);
    for (const f of ["placeholder-shell.ts", "motion.ts", "scenario-controller.tsx"])
      expect(read(`apps/client/src/dev/${f}`), f).not.toMatch(NO_TIMERS);
  });
});

describe("playwright projects", () => {
  it("has a swiftshader project for CI/determinism and a gpu project for the frame-time gate", () => {
    const projects = config.projects ?? [];
    expect(projects.map((p) => p.name)).toEqual(["swiftshader", "gpu"]);
    const [sw, gpu] = projects;
    expect(sw?.use?.launchOptions?.args).toEqual([...SWIFTSHADER_ARGS]);
    expect(SWIFTSHADER_ARGS).toEqual(
      expect.arrayContaining(["--use-gl=angle", "--use-angle=swiftshader"]),
    );
    expect(String(sw?.grepInvert)).toBe(String(/@gpu/));
    expect(String(gpu?.grep)).toBe(String(/@gpu/));
    expect(gpu?.use?.launchOptions?.args).toEqual(gpuArgs());
    expect(gpuArgs("win32")).toEqual(expect.arrayContaining(["--enable-gpu", "--use-angle=d3d11"]));
    expect(gpuArgs("linux")).toEqual(expect.arrayContaining(["--enable-gpu", "--use-angle=gl"]));
    expect(gpuArgs("darwin")).not.toContain("--use-angle=d3d11");
    expect(config.testDir).toBe("tools/harness");
    expect(baseUrl({ SG_BASE_URL: "http://x:1" })).toBe("http://x:1");
    expect(baseUrl({ SG_PORT: "5210" })).toBe("http://localhost:5210");
    expect(baseUrl({})).toBe("http://localhost:4173");
  });
});
