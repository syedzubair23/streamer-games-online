/**
 * A minimal 2D canvas for Node tests: pixel buffers are real (`createImageData`,
 * `putImageData`, `getImageData`, same-size `drawImage` copies), path and text calls are
 * recorded no-ops. Real rasterisation is covered by the Playwright specs in `test/browser/`.
 */
import type { Canvas2D, CanvasFactory } from "../../src/textures/canvas.ts";

export class FakeCanvas {
  readonly pixels: Uint8ClampedArray;
  readonly calls: string[] = [];
  /** Every call with its arguments (numbers rounded to 3 decimals), for call-sequence checks. */
  readonly log: string[] = [];
  /** Gradient colour stops added on this canvas's context. */
  readonly stops: string[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }
}

function makeCtx(c: FakeCanvas): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  const target = {
    canvas: c,
    createImageData(w: number, h: number) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img: { data: Uint8ClampedArray; width: number }, x: number, y: number) {
      c.calls.push("putImageData");
      c.log.push(`putImageData ${img.width} ${x} ${y}`);
      if (x === 0 && y === 0 && img.width === c.width)
        c.pixels.set(img.data.subarray(0, c.pixels.length));
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { width: w, height: h, data: c.pixels.slice(0, w * h * 4) };
    },
    drawImage(src: unknown, ...args: number[]) {
      c.calls.push("drawImage");
      c.log.push(
        `drawImage ${src instanceof FakeCanvas ? `${src.width}x${src.height}` : "?"} ${args.map((a) => Math.round(a * 1000) / 1000).join(" ")}`,
      );
      if (
        src instanceof FakeCanvas &&
        src.width === c.width &&
        src.height === c.height &&
        args.length <= 2
      )
        c.pixels.set(src.pixels);
    },
    createLinearGradient: (...a: number[]) => {
      c.calls.push("createLinearGradient");
      c.log.push(`linear ${a.map((v) => Math.round(v * 1000) / 1000).join(" ")}`);
      return { addColorStop: (t: number, col: string) => void c.stops.push(`${t}:${col}`) };
    },
    createRadialGradient: (...a: number[]) => {
      c.calls.push("createRadialGradient");
      c.log.push(`radial ${a.map((v) => Math.round(v * 1000) / 1000).join(" ")}`);
      return { addColorStop: (t: number, col: string) => void c.stops.push(`${t}:${col}`) };
    },
    // A monospace stand-in: 0.6 em per character of the current font size.
    measureText(text: string) {
      c.calls.push("measureText");
      const m = /(\d+(?:\.\d+)?)px/.exec(String(state["font"] ?? "10px"));
      return { width: text.length * 0.6 * Number(m?.[1] ?? 10) };
    },
    createPattern: (src: unknown) => {
      c.calls.push("createPattern");
      return { pattern: src };
    },
  };
  return new Proxy(target as Record<string, unknown>, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (prop in state) return state[prop];
      // Any other method is a recorded no-op (paths, fills, text, transforms).
      return (...args: unknown[]) => {
        c.calls.push(prop);
        c.log.push(
          `${prop} ${args.map((a) => (typeof a === "number" ? Math.round(a * 1000) / 1000 : String(a))).join(" ")}`,
        );
      };
    },
    set(_t, prop: string, value) {
      state[prop] = value;
      c.log.push(`${prop}=${typeof value === "object" ? "[object]" : String(value)}`);
      return true;
    },
  });
}

/** A canvas factory producing {@link FakeCanvas}es. */
export function fakeCanvasFactory(created: FakeCanvas[] = []): CanvasFactory {
  return (w, h) => {
    const canvas = new FakeCanvas(w, h);
    created.push(canvas);
    return { canvas, ctx: makeCtx(canvas) } as unknown as Canvas2D;
  };
}

/** Pixel statistics of a canvas: mean and standard deviation of luminance, mean alpha. */
export function stats(c: FakeCanvas): { mean: number; sd: number; alpha: number } {
  const n = c.width * c.height;
  let sum = 0;
  let sq = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const l =
      0.2126 * (c.pixels[i * 4] as number) +
      0.7152 * (c.pixels[i * 4 + 1] as number) +
      0.0722 * (c.pixels[i * 4 + 2] as number);
    sum += l;
    sq += l * l;
    a += c.pixels[i * 4 + 3] as number;
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)), alpha: a / n };
}

/** Mean absolute luminance difference between two columns (x1, x2) of a canvas. */
export function columnDiff(c: FakeCanvas, x1: number, x2: number): number {
  let d = 0;
  for (let y = 0; y < c.height; y++) {
    const i = (y * c.width + x1) * 4;
    const j = (y * c.width + x2) * 4;
    d +=
      Math.abs((c.pixels[i] as number) - (c.pixels[j] as number)) +
      Math.abs((c.pixels[i + 1] as number) - (c.pixels[j + 1] as number));
  }
  return d / c.height;
}

/** Mean absolute luminance difference between two rows. */
export function rowDiff(c: FakeCanvas, y1: number, y2: number): number {
  let d = 0;
  for (let x = 0; x < c.width; x++) {
    const i = (y1 * c.width + x) * 4;
    const j = (y2 * c.width + x) * 4;
    d +=
      Math.abs((c.pixels[i] as number) - (c.pixels[j] as number)) +
      Math.abs((c.pixels[i + 1] as number) - (c.pixels[j + 1] as number));
  }
  return d / c.width;
}
