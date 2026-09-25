/**
 * The perf monitor (research 04 §11.1) and the boot micro-benchmark (SPEC §10), plus the colour
 * helpers the painters share.
 */
import { Color, MeshBasicMaterial } from "three";
import { describe, expect, it, vi } from "vitest";
import { median, runBootBench } from "../src/bench.ts";
import { clampByte, mixRGB, rgba, scaleRGB, smoothstep, toCss, toRGB } from "../src/color.ts";
import { createPerfMonitor, JANK_MS } from "../src/perf-hud.ts";

function fakeRenderer() {
  return {
    info: {
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 3, textures: 4 },
      programs: [1, 2] as unknown[],
    },
    getPixelRatio: () => 1.25,
  };
}

describe("perf monitor", () => {
  it("summarises percentiles, jank and peaks", () => {
    const r = fakeRenderer();
    let t = 0;
    const m = createPerfMonitor({ renderer: r, capacity: 100, now: () => t });
    for (let i = 1; i <= 100; i++) {
      r.info.render.calls = i;
      r.info.render.triangles = i * 10;
      t += 10;
      m.sample(i < 91 ? 10 : 40);
    }
    const s = m.summary();
    expect(s.frames).toBe(100);
    expect(s.p50FrameMs).toBe(10);
    expect(s.p90FrameMs).toBe(10);
    expect(s.p99FrameMs).toBe(40);
    expect(s.jankPct).toBe(10);
    expect(s.maxDrawCalls).toBe(100);
    expect(s.maxTriangles).toBe(1000);
    expect(s.lastDrawCalls).toBe(100);
    expect(s).toMatchObject({ programs: 2, geometries: 3, textures: 4, pixelRatio: 1.25 });
    expect(s.rendersPerSec).toBe(100);
    expect(JANK_MS).toBeCloseTo(33.33, 1);
  });

  it("keeps a ring buffer and dumps oldest first", () => {
    const r = fakeRenderer();
    const m = createPerfMonitor({ renderer: r, capacity: 8, now: () => 0 });
    for (let i = 0; i < 12; i++) m.sample(i);
    const d = m.dump();
    expect(d.frameMs).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(d.summary.frames).toBe(8);
    m.reset();
    expect(m.summary()).toMatchObject({ frames: 0, p90FrameMs: 0, jankPct: 0, lastDrawCalls: 0 });
    const partial = createPerfMonitor({
      renderer: {
        info: { render: { calls: 1, triangles: 2 }, memory: { geometries: 0, textures: 0 } },
      },
    });
    partial.sample(5);
    expect(partial.dump().calls).toEqual([1]);
    expect(partial.summary()).toMatchObject({ programs: 0, pixelRatio: 1 });
  });

  it("mounts a 4 Hz overlay and installs __perf", () => {
    const r = fakeRenderer();
    let t = 0;
    const m = createPerfMonitor({ renderer: r, now: () => t });
    const el = {
      style: { cssText: "" },
      dataset: {} as Record<string, string>,
      textContent: "",
      setAttribute: vi.fn(),
      remove: vi.fn(),
    };
    const parent = {
      ownerDocument: { createElement: () => el },
      appendChild: vi.fn(),
    } as unknown as HTMLElement;
    const unmount = m.mountHud(parent);
    expect(el.textContent).toContain("fps");
    const before = el.textContent;
    r.info.render.calls = 42;
    t = 100;
    m.sample(12);
    expect(el.textContent).toBe(before); // throttled to 4 Hz
    t = 400;
    m.sample(12);
    expect(el.textContent).toContain("draws 42");
    unmount();
    expect(el.remove).toHaveBeenCalled();
    t = 1000;
    m.sample(12);
    const target: { __perf?: { summary(): unknown; dump(): unknown; reset(): void } } = {};
    const uninstall = m.install(target);
    expect(target.__perf?.summary()).toMatchObject({ frames: 3 });
    expect(target.__perf?.dump()).toHaveProperty("frameMs");
    target.__perf?.reset();
    uninstall();
    expect(target.__perf).toBeUndefined();
    const u2 = m.install();
    expect((globalThis as { __perf?: unknown }).__perf).toBeDefined();
    u2();
  });
});

describe("boot bench", () => {
  it("renders warm-up + sampled frames, syncs on the GPU and reports the median", () => {
    let t = 0;
    const readPixels = vi.fn();
    const renderer = {
      render: vi.fn(() => {
        t += 4;
      }),
      getContext: () => ({ readPixels, RGBA: 1, UNSIGNED_BYTE: 2 }),
    };
    const m = new MeshBasicMaterial();
    const r = runBootBench({
      renderer,
      pieceMaterial: m,
      matMaterial: m,
      frames: 10,
      warmup: 2,
      now: () => t,
    });
    expect(renderer.render).toHaveBeenCalledTimes(12);
    expect(readPixels).toHaveBeenCalledTimes(12);
    expect(r.samples).toHaveLength(10);
    expect(r.medianMs).toBe(4);
    // Defaults and a renderer without a context.
    const r2 = runBootBench({
      renderer: { render: () => undefined },
      pieceMaterial: m,
      matMaterial: m,
      now: () => 0,
    });
    expect(r2.samples).toHaveLength(20);
  });

  it("median handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("colour helpers", () => {
  it("convert tokens to sRGB bytes and back", () => {
    expect(toRGB("#F26B5B")).toEqual([242, 107, 91]);
    expect(toCss("#F26B5B")).toBe("#f26b5b");
    expect(toCss(new Color("#5BA8F2"))).toBe("#5ba8f2");
    expect(rgba([1, 2, 3], 2)).toBe("rgba(1,2,3,1)");
    expect(mixRGB([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(scaleRGB([200, 100, 50], 2)).toEqual([255, 200, 100]);
    expect(clampByte(-3)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});
