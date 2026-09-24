/**
 * PNG helpers for the harness: the blank-canvas check (G7), exact pixel diffs (M0-05
 * determinism, the ROADMAP ">2% of pixels changed" re-critic rule) and directory comparisons.
 *
 * @module
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** A decoded RGBA image. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decodes a PNG file or buffer. */
export function readPng(src: string | Buffer): Rgba {
  const png = PNG.sync.read(typeof src === "string" ? readFileSync(src) : src);
  return { width: png.width, height: png.height, data: png.data };
}

/** Encodes RGBA pixels as a PNG buffer. */
export function writePng(img: Rgba): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  return PNG.sync.write(png);
}

/**
 * Standard deviation of Rec. 709 luma (0–255) over every pixel. DOD G7: a frame with a
 * deviation of 4 or less is blank.
 */
export function luminanceStdDev(img: Rgba): number {
  const n = img.width * img.height;
  if (n === 0) return 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const y =
      0.2126 * (img.data[i] ?? 0) +
      0.7152 * (img.data[i + 1] ?? 0) +
      0.0722 * (img.data[i + 2] ?? 0);
    sum += y;
    sq += y * y;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/** The G7 blank threshold. */
export const BLANK_STDDEV = 4;

/** Result of an exact pixel comparison. */
export interface PixelDiff {
  width: number;
  height: number;
  /** Pixels that differ at all (pixelmatch, threshold 0, anti-aliasing counted). */
  diffPixels: number;
  /** `diffPixels / (width × height)`, 0..1 (1 when the sizes differ). */
  ratio: number;
  sameSize: boolean;
}

/** Compares two images exactly (pixelmatch with threshold 0). */
export function diffImages(a: Rgba, b: Rgba): PixelDiff {
  if (a.width !== b.width || a.height !== b.height)
    return {
      width: a.width,
      height: a.height,
      diffPixels: Math.max(a.width * a.height, b.width * b.height),
      ratio: 1,
      sameSize: false,
    };
  const diffPixels = pixelmatch(a.data, b.data, undefined, a.width, a.height, {
    threshold: 0,
    includeAA: true,
  });
  return {
    width: a.width,
    height: a.height,
    diffPixels,
    ratio: diffPixels / (a.width * a.height),
    sameSize: true,
  };
}

/** One file of a directory comparison. */
export interface FileDiff extends Partial<PixelDiff> {
  file: string;
  /** `missing-a` / `missing-b` when the file exists on one side only. */
  status: "same" | "different" | "missing-a" | "missing-b";
}

/** Compares every PNG in two directories (non-recursive). */
export function compareDirs(dirA: string, dirB: string): FileDiff[] {
  const list = (d: string): string[] =>
    existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".png")) : [];
  const a = new Set(list(dirA));
  const b = new Set(list(dirB));
  const files = [...new Set([...a, ...b])].sort();
  return files.map((file): FileDiff => {
    if (!a.has(file)) return { file, status: "missing-a" };
    if (!b.has(file)) return { file, status: "missing-b" };
    const d = diffImages(readPng(join(dirA, file)), readPng(join(dirB, file)));
    return { file, status: d.diffPixels === 0 ? "same" : "different", ...d };
  });
}
