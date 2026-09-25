/**
 * Colour helpers shared by the material and texture factories. Colours arrive as CSS strings
 * (token values) or three.js `Color`s ({@link ColorLike}); painters work in 8-bit sRGB.
 *
 * @module
 */
import { Color, SRGBColorSpace } from "three";
import type { ColorLike } from "./types.ts";

const scratch = new Color();
const rgbScratch = { r: 0, g: 0, b: 0 };

/** An 8-bit sRGB triple. */
export type RGB = [number, number, number];

/** Writes `c` into `out` (a three.js `Color`, linear working space). `undefined` leaves `out`. */
export function toColor(c: ColorLike | undefined, out: Color): Color {
  if (c === undefined) return out;
  if (typeof c === "string") return out.set(c);
  return out.copy(c);
}

/** A colour as an 8-bit sRGB triple (painters work in display space). */
export function toRGB(c: ColorLike): RGB {
  toColor(c, scratch).getRGB(rgbScratch, SRGBColorSpace);
  return [
    Math.round(clamp01(rgbScratch.r) * 255),
    Math.round(clamp01(rgbScratch.g) * 255),
    Math.round(clamp01(rgbScratch.b) * 255),
  ];
}

/** A colour as a `#rrggbb` string (for cache keys and canvas fill styles). */
export function toCss(c: ColorLike): string {
  const [r, g, b] = toRGB(c);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** `#rrggbb` from an sRGB triple. */
export function rgbHex(rgb: Readonly<RGB>): string {
  return `#${((1 << 24) | (clampByte(rgb[0]) << 16) | (clampByte(rgb[1]) << 8) | clampByte(rgb[2])).toString(16).slice(1)}`;
}

/** `rgba(r,g,b,a)` from an sRGB triple. */
export function rgba(rgb: Readonly<RGB>, a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.round(clamp01(a) * 1000) / 1000})`;
}

/** Linear mix of two sRGB triples (`t = 0` → `a`). */
export function mixRGB(a: Readonly<RGB>, b: Readonly<RGB>, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Multiplies each channel by `k` (clamped to 0..255). */
export function scaleRGB(a: Readonly<RGB>, k: number): RGB {
  return [clampByte(a[0] * k), clampByte(a[1] * k), clampByte(a[2] * k)];
}

/** Clamps to `[0, 1]`. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Rounds and clamps to a byte. */
export function clampByte(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}

/** Hermite smoothstep. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
