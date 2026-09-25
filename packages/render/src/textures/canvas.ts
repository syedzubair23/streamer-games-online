/**
 * The 2D canvas abstraction the texture painters draw into: an `OffscreenCanvas` when the
 * browser has one (no DOM work on the main thread), a `<canvas>` otherwise, or an injected
 * factory (tests). Painters use only the API both canvases share.
 *
 * @module
 */

/** The 2D context painters draw with (both canvas kinds implement it). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas and its 2D context. */
export interface Canvas2D {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
}

/** Creates a `w × h` canvas. */
export type CanvasFactory = (w: number, h: number) => Canvas2D;

/** The default factory: `OffscreenCanvas` if available, else `document.createElement`. */
export function defaultCanvasFactory(): CanvasFactory {
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  if (g.OffscreenCanvas !== undefined) {
    const Offscreen = g.OffscreenCanvas;
    return (w, h) => {
      const canvas = new Offscreen(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: false });
      if (ctx === null) throw new Error("textures: no 2D context on OffscreenCanvas");
      return { canvas, ctx };
    };
  }
  const doc = g.document;
  if (doc === undefined) throw new Error("textures: no canvas available; pass a canvas factory");
  return (w, h) => {
    const canvas = doc.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("textures: no 2D canvas context");
    return { canvas, ctx };
  };
}

/**
 * Runs `fn` over a fresh RGBA pixel buffer of the whole canvas and writes it back. Per-pixel
 * painting is deterministic across GPUs and browsers (no anti-aliasing differences).
 */
export function paintPixels(
  ctx: Ctx2D,
  w: number,
  h: number,
  fn: (data: Uint8ClampedArray, w: number, h: number) => void,
): void {
  const img = ctx.createImageData(w, h);
  fn(img.data, w, h);
  ctx.putImageData(img, 0, 0);
}

/** Traces a rounded rectangle as a new path (does not fill or stroke). */
export function roundRectPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  roundRectSubPath(ctx, x, y, w, h, r);
}

/** Adds a rounded rectangle sub-path to the current path (many shapes, one fill). */
export function roundRectSubPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Whether this platform stores a `Uint32Array` little-endian (every shipping browser does). */
export const LITTLE_ENDIAN: boolean = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Bit position of the alpha byte in a texel read through a `Uint32Array` view of RGBA bytes:
 * `packRGBA(r, g, b, 0) | (a << ALPHA_SHIFT)` sets a texel's alpha.
 */
export const ALPHA_SHIFT: number = LITTLE_ENDIAN ? 24 : 0;

/**
 * One RGBA texel as a 32-bit word for a `Uint32Array` view of an RGBA byte buffer (so a painter
 * writes one word per texel instead of four clamped bytes). Channels are truncated to bytes.
 */
export function packRGBA(r: number, g: number, b: number, a: number): number {
  const R = r & 255;
  const G = g & 255;
  const B = b & 255;
  const A = a & 255;
  return LITTLE_ENDIAN
    ? ((A << 24) | (B << 16) | (G << 8) | R) >>> 0
    : ((R << 24) | (G << 16) | (B << 8) | A) >>> 0;
}

/** Multiplier turning a grey byte `v` into an opaque grey texel: `v * GREY + OPAQUE`. */
export const GREY: number = LITTLE_ENDIAN ? 0x010101 : 0x01010100;
/** The opaque alpha bits of a packed texel (see {@link GREY}). */
export const OPAQUE: number = LITTLE_ENDIAN ? 0xff000000 : 0xff;

/** Options of {@link drawPeriodicField}. */
export interface FieldOptions {
  /** Bilinear upscaling (default true); false keeps hard texels (speckles). */
  smooth?: boolean;
  /** Global alpha of the draw (default 1). */
  alpha?: number;
  /** Composite operation (default `source-over`; `overlay` for ±luminance fields). */
  op?: GlobalCompositeOperation;
}

/**
 * Paints a small **periodic** RGBA field (`fw × fh` texels, filled by `fill` through either the
 * byte view or the packed {@link packRGBA} word view of the same buffer) and draws it upscaled
 * over the whole `w × h` canvas.
 *
 * This is how the painters stay inside the SPEC §13.6 boot budget: structure (grain rings,
 * mottling, fibres) is computed on a coarse grid in JS, and the browser's native bilinear
 * upscaling and compositing do the per-pixel work (research 03 §6: "a value-noise / fBm
 * function on a small grid, upscaled with bilinear filtering"). The field is padded with one
 * wrapped texel on every side (native row copies) and drawn so the padding lands just outside
 * the canvas, so bilinear filtering at the edges reads the wrapped neighbours and repeating
 * textures stay seamless.
 */
export function drawPeriodicField(
  ctx: Ctx2D,
  scratch: (w: number, h: number) => Canvas2D,
  w: number,
  h: number,
  fw: number,
  fh: number,
  fill: (data: Uint8ClampedArray, fw: number, fh: number, px: Uint32Array) => void,
  o: FieldOptions = {},
): void {
  const pw = fw + 2;
  const ph = fh + 2;
  const c = scratch(pw, ph);
  const inner = new Uint8ClampedArray(fw * fh * 4);
  const src = new Uint32Array(inner.buffer);
  fill(inner, fw, fh, src);
  // Build the padded field with native row copies: row y of the inner field lands in padded
  // row y + 1 at column 1, with the wrapped edge texels on either side; the first and last
  // padded rows are the last and first inner rows.
  const img = c.ctx.createImageData(pw, ph);
  const dst = new Uint32Array(img.data.buffer);
  for (let y = 0; y < ph; y++) {
    const sy = y === 0 ? fh - 1 : y === ph - 1 ? 0 : y - 1;
    const row = sy * fw;
    const out = y * pw;
    dst.set(src.subarray(row, row + fw), out + 1);
    dst[out] = src[row + fw - 1] as number;
    dst[out + pw - 1] = src[row] as number;
  }
  c.ctx.putImageData(img, 0, 0);
  const sx = w / fw;
  const sy = h / fh;
  ctx.save();
  ctx.imageSmoothingEnabled = o.smooth !== false;
  ctx.globalAlpha = o.alpha ?? 1;
  ctx.globalCompositeOperation = o.op ?? "source-over";
  ctx.drawImage(c.canvas, 0, 0, pw, ph, -sx, -sy, w + 2 * sx, h + 2 * sy);
  ctx.restore();
}

/** Tiles a source canvas over the whole canvas (`repeat` pattern) with a composite and alpha. */
export function overlayTile(
  ctx: Ctx2D,
  tile: Canvas2D["canvas"],
  w: number,
  h: number,
  alpha: number,
  op: GlobalCompositeOperation = "overlay",
): void {
  const pattern = ctx.createPattern(tile, "repeat");
  if (pattern === null) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
