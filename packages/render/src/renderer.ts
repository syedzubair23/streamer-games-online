/**
 * The renderer (SPEC §13.5, §10; research 04 §1): a WebGL2 `WebGLRenderer` configured once for
 * every surface, plus pixel-ratio management (tier DPR cap × dynamic scale, or the fixed 1080p
 * output of overlay / `?obs=1` mode), shader pre-warming and context-loss handling.
 *
 * - `alpha: false`, `powerPreference: "default"` (never `high-performance`: it breaks dual-GPU
 *   OBS setups), no stencil, MSAA per tier.
 * - `NeutralToneMapping` at exposure 1.0 and sRGB output.
 * - Shadow maps only on high (one 1024² directional map, `autoUpdate = false`; call
 *   {@link SgRenderer.requestShadowUpdate} on frames where a piece moved).
 * - No post-processing (SPEC §9.1): vignette and grain are CSS layers.
 *
 * @module
 */
import {
  NeutralToneMapping,
  PCFSoftShadowMap,
  SRGBColorSpace,
  WebGLRenderer,
  type Camera,
  type Object3D,
  type WebGLRendererParameters,
} from "three";
import { effectivePixelRatio, TIERS } from "./quality.ts";
import type { QualityTier } from "./types.ts";

/** The fixed internal output of overlay and `?obs=1` mode (SPEC §10: 1080p60). */
export const OBS_OUTPUT_HEIGHT = 1080;

/** The subset of `WebGLRenderer` this module drives (tests pass a fake). */
export type WebGLRendererLike = Pick<
  WebGLRenderer,
  "domElement" | "info" | "setPixelRatio" | "getPixelRatio" | "setSize" | "render" | "dispose"
> & {
  toneMapping: WebGLRenderer["toneMapping"];
  toneMappingExposure: number;
  outputColorSpace: WebGLRenderer["outputColorSpace"];
  shadowMap: { enabled: boolean; autoUpdate: boolean; needsUpdate: boolean; type: number };
  compileAsync?: WebGLRenderer["compileAsync"];
  compile?: WebGLRenderer["compile"];
  initTexture?: WebGLRenderer["initTexture"];
  forceContextLoss?: () => void;
};

/** Options of {@link createRenderer}. */
export interface RendererOptions {
  tier: QualityTier;
  /** Canvas to render into (default: a new one). */
  canvas?: HTMLCanvasElement;
  /** Keep the drawing buffer (frozen-frame screenshots only; costs bandwidth). */
  preserveDrawingBuffer?: boolean;
  /** Overlay / `?obs=1`: fixed 1080p output, dynamic resolution off. */
  fixedOutput?: boolean;
  /** The display's device pixel ratio (default `window.devicePixelRatio` or 1). */
  devicePixelRatio?: number;
  /** Creates the WebGL renderer (tests inject a fake). */
  create?: (params: WebGLRendererParameters) => WebGLRendererLike;
  /** Called when the GPU context is lost (show the Iris "reconnecting" state). */
  onContextLost?: () => void;
  /** Called when it is restored (the shell re-uploads and invalidates). */
  onContextRestored?: () => void;
}

/** A configured renderer plus the sizing controls the shell uses. */
export interface SgRenderer {
  readonly gl: WebGLRendererLike;
  readonly canvas: HTMLCanvasElement;
  readonly tier: QualityTier;
  /** Whether output is fixed at 1080p (overlay / OBS). */
  readonly fixedOutput: boolean;
  /** CSS size of the canvas. */
  readonly width: number;
  readonly height: number;
  /** The dynamic-resolution scale in effect (1 when output is fixed). */
  readonly scale: number;
  /** Resizes to a CSS size (applies the pixel ratio). */
  resize(width: number, height: number): void;
  /** Applies a dynamic-resolution scale (0.5–1). A no-op with fixed output. */
  setScale(scale: number): void;
  /** Updates the display DPR (e.g. the window moved to another monitor). */
  setDevicePixelRatio(dpr: number): void;
  /** The pixel ratio currently applied. */
  pixelRatio(): number;
  /** Compiles every material of `scene` for `camera` (the Iris load; no hitch on first frame). */
  warmup(scene: Object3D, camera: Camera): Promise<void>;
  /** High tier: re-render the shadow map on the next frame (a piece moved). */
  requestShadowUpdate(): void;
  /** Renders `scene` from `camera`. */
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
}

/** Whether this browser can create a WebGL2 context (else the shell shows the 2D fallback). */
export function isWebGL2Available(doc: Document | undefined = globalThis.document): boolean {
  if (doc === undefined) return false;
  try {
    const c = doc.createElement("canvas");
    const ctx = c.getContext("webgl2");
    const ok = ctx !== null;
    (ctx?.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/** The WebGL context parameters for a tier (exported for tests and the boot bench). */
export function rendererParams(
  tier: QualityTier,
  canvas: HTMLCanvasElement | undefined,
  preserveDrawingBuffer: boolean,
): WebGLRendererParameters {
  return {
    ...(canvas !== undefined ? { canvas } : {}),
    antialias: TIERS[tier].antialias,
    alpha: false,
    powerPreference: "default",
    stencil: false,
    depth: true,
    preserveDrawingBuffer,
  };
}

/** Creates and configures the renderer. */
export function createRenderer(o: RendererOptions): SgRenderer {
  const preset = TIERS[o.tier];
  const params = rendererParams(o.tier, o.canvas, o.preserveDrawingBuffer === true);
  const gl: WebGLRendererLike =
    o.create?.(params) ?? (new WebGLRenderer(params) as unknown as WebGLRendererLike);
  gl.toneMapping = NeutralToneMapping;
  gl.toneMappingExposure = 1;
  gl.outputColorSpace = SRGBColorSpace;
  gl.shadowMap.enabled = preset.shadows === "blob+map";
  gl.shadowMap.type = PCFSoftShadowMap;
  gl.shadowMap.autoUpdate = false;
  gl.shadowMap.needsUpdate = gl.shadowMap.enabled;

  const canvas = gl.domElement;
  const fixed = o.fixedOutput === true;
  let dpr =
    o.devicePixelRatio ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
  let scale = 1;
  let width = 1;
  let height = 1;

  const ratio = (): number =>
    fixed ? OBS_OUTPUT_HEIGHT / Math.max(1, height) : effectivePixelRatio(dpr, o.tier, scale);

  const apply = (): void => {
    gl.setPixelRatio(ratio());
    gl.setSize(width, height, false);
  };

  const onLost = (e: Event): void => {
    e.preventDefault();
    o.onContextLost?.();
  };
  const onRestored = (): void => {
    gl.shadowMap.needsUpdate = gl.shadowMap.enabled;
    o.onContextRestored?.();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const r: SgRenderer = {
    gl,
    canvas,
    tier: o.tier,
    fixedOutput: fixed,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get scale() {
      return fixed ? 1 : scale;
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      apply();
    },
    setScale(s) {
      if (fixed) return;
      const next = Math.min(1, Math.max(0.5, s));
      if (next === scale) return;
      scale = next;
      apply();
    },
    setDevicePixelRatio(d) {
      if (!(d > 0) || d === dpr) return;
      dpr = d;
      apply();
    },
    pixelRatio: () => gl.getPixelRatio(),
    async warmup(scene, camera) {
      if (gl.compileAsync !== undefined) await gl.compileAsync(scene, camera);
      else gl.compile?.(scene, camera);
    },
    requestShadowUpdate() {
      if (gl.shadowMap.enabled) gl.shadowMap.needsUpdate = true;
    },
    render(scene, camera) {
      gl.render(scene, camera);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.dispose();
    },
  };
  return r;
}
