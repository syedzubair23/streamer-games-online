/**
 * Renderer configuration (SPEC §13.5, §10) against a fake WebGL renderer: context parameters per
 * tier, tone mapping and colour space, pixel ratio (tier cap × dynamic scale, fixed 1080p for
 * overlay / OBS), shadows on high only, warm-up, context loss and disposal. The real WebGL path
 * is exercised by `test/browser/render-kit.spec.ts`.
 */
import {
  NeutralToneMapping,
  PCFSoftShadowMap,
  SRGBColorSpace,
  Scene,
  PerspectiveCamera,
} from "three";
import { describe, expect, it, vi } from "vitest";
import {
  createRenderer,
  isWebGL2Available,
  OBS_OUTPUT_HEIGHT,
  rendererParams,
  type WebGLRendererLike,
} from "../src/renderer.ts";
import type { QualityTier } from "../src/types.ts";

class FakeCanvas {
  listeners = new Map<string, (e: Event) => void>();
  addEventListener(t: string, cb: (e: Event) => void) {
    this.listeners.set(t, cb);
  }
  removeEventListener(t: string) {
    this.listeners.delete(t);
  }
}

function fakeGL() {
  const canvas = new FakeCanvas();
  let ratio = 1;
  const gl = {
    domElement: canvas as unknown as HTMLCanvasElement,
    info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } },
    toneMapping: 0,
    toneMappingExposure: 0,
    outputColorSpace: "",
    shadowMap: { enabled: false, autoUpdate: true, needsUpdate: false, type: 0 },
    setPixelRatio: vi.fn((r: number) => {
      ratio = r;
    }),
    getPixelRatio: () => ratio,
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    compileAsync: vi.fn(() => Promise.resolve()),
  };
  return { gl: gl as unknown as WebGLRendererLike & typeof gl, canvas };
}

function make(tier: QualityTier, extra: Partial<Parameters<typeof createRenderer>[0]> = {}) {
  const f = fakeGL();
  const params: unknown[] = [];
  const r = createRenderer({
    tier,
    devicePixelRatio: 3,
    create: (p) => {
      params.push(p);
      return f.gl;
    },
    ...extra,
  });
  return { r, ...f, params };
}

describe("createRenderer", () => {
  it("creates an opaque WebGL2 context with MSAA per tier", () => {
    expect(rendererParams("low", undefined, false)).toEqual({
      antialias: false,
      alpha: false,
      powerPreference: "default",
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    expect(rendererParams("mid", undefined, true)).toMatchObject({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    const { params } = make("high");
    expect(params[0]).toMatchObject({ antialias: true, alpha: false, powerPreference: "default" });
  });

  it("uses NeutralToneMapping at exposure 1 and sRGB output (SPEC §13.5)", () => {
    const { gl } = make("mid");
    expect(gl.toneMapping).toBe(NeutralToneMapping);
    expect(gl.toneMappingExposure).toBe(1);
    expect(gl.outputColorSpace).toBe(SRGBColorSpace);
  });

  it("enables the single on-demand shadow map on high only", () => {
    const low = make("low");
    expect(low.gl.shadowMap.enabled).toBe(false);
    low.r.requestShadowUpdate();
    expect(low.gl.shadowMap.needsUpdate).toBe(false);
    const high = make("high");
    expect(high.gl.shadowMap).toMatchObject({
      enabled: true,
      autoUpdate: false,
      type: PCFSoftShadowMap,
    });
    high.gl.shadowMap.needsUpdate = false;
    high.r.requestShadowUpdate();
    expect(high.gl.shadowMap.needsUpdate).toBe(true);
  });

  it("clamps the pixel ratio to the tier cap and applies the dynamic scale", () => {
    const { r, gl } = make("low");
    r.resize(800.4, 600.6);
    expect(gl.setPixelRatio).toHaveBeenLastCalledWith(1.25);
    expect(gl.setSize).toHaveBeenLastCalledWith(800, 601, false);
    expect([r.width, r.height]).toEqual([800, 601]);
    r.setScale(0.5);
    expect(gl.setPixelRatio).toHaveBeenLastCalledWith(0.625);
    expect(r.scale).toBe(0.5);
    const calls = gl.setPixelRatio.mock.calls.length;
    r.setScale(0.5);
    r.setScale(0.1); // clamped to 0.5: no change
    expect(gl.setPixelRatio.mock.calls.length).toBe(calls);
    r.setDevicePixelRatio(1);
    expect(gl.setPixelRatio).toHaveBeenLastCalledWith(0.5);
    r.setDevicePixelRatio(1);
    r.setDevicePixelRatio(0);
    expect(gl.setPixelRatio.mock.calls.length).toBe(calls + 1);
    expect(r.pixelRatio()).toBe(0.5);
    r.resize(0, 0);
    expect(gl.setSize).toHaveBeenLastCalledWith(1, 1, false);
  });

  it("renders a fixed 1080p output in overlay / OBS mode and ignores dynamic scale", () => {
    const { r, gl } = make("high", { fixedOutput: true });
    r.resize(1280, 720);
    expect(gl.setPixelRatio).toHaveBeenLastCalledWith(OBS_OUTPUT_HEIGHT / 720);
    r.setScale(0.5);
    expect(r.scale).toBe(1);
    expect(gl.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(r.fixedOutput).toBe(true);
  });

  it("pre-compiles with compileAsync, or compile as a fallback", async () => {
    const { r, gl } = make("mid");
    const scene = new Scene();
    const cam = new PerspectiveCamera();
    await r.warmup(scene, cam);
    expect(gl.compileAsync).toHaveBeenCalledWith(scene, cam);
    const f = fakeGL();
    const compile = vi.fn();
    const g2 = { ...f.gl, compileAsync: undefined, compile } as unknown as WebGLRendererLike;
    const r2 = createRenderer({ tier: "low", create: () => g2 });
    await r2.warmup(scene, cam);
    expect(compile).toHaveBeenCalledWith(scene, cam);
    r.render(scene, cam);
    expect(gl.render).toHaveBeenCalledWith(scene, cam);
  });

  it("handles context loss and restoration, and detaches on dispose", () => {
    const onContextLost = vi.fn();
    const onContextRestored = vi.fn();
    const { r, gl, canvas } = make("high", { onContextLost, onContextRestored });
    const ev = { preventDefault: vi.fn() } as unknown as Event;
    canvas.listeners.get("webglcontextlost")?.(ev);
    expect(
      (ev as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).toHaveBeenCalled();
    expect(onContextLost).toHaveBeenCalled();
    gl.shadowMap.needsUpdate = false;
    canvas.listeners.get("webglcontextrestored")?.({} as Event);
    expect(onContextRestored).toHaveBeenCalled();
    expect(gl.shadowMap.needsUpdate).toBe(true);
    r.dispose();
    expect(gl.dispose).toHaveBeenCalled();
    expect(canvas.listeners.size).toBe(0);
    expect(r.canvas).toBe(canvas);
    expect(r.gl).toBe(gl);
    expect(r.tier).toBe("high");
  });

  it("reads the display DPR from globalThis by default", () => {
    const g = globalThis as { devicePixelRatio?: number };
    g.devicePixelRatio = 1.1;
    try {
      const f = fakeGL();
      const r = createRenderer({ tier: "high", create: () => f.gl });
      r.resize(10, 10);
      expect(f.gl.setPixelRatio).toHaveBeenLastCalledWith(1.1);
    } finally {
      delete g.devicePixelRatio;
    }
  });

  it("detects WebGL2 support", () => {
    expect(isWebGL2Available(undefined)).toBe(false);
    const lose = vi.fn();
    const ok = {
      createElement: () => ({
        getContext: () => ({ getExtension: () => ({ loseContext: lose }) }),
      }),
    } as unknown as Document;
    expect(isWebGL2Available(ok)).toBe(true);
    expect(lose).toHaveBeenCalled();
    const none = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    expect(isWebGL2Available(none)).toBe(false);
    const broken = {
      createElement: () => {
        throw new Error("no canvas");
      },
    } as unknown as Document;
    expect(isWebGL2Available(broken)).toBe(false);
  });
});
