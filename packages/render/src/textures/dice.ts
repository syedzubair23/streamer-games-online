/**
 * `dice`: the six-face pip atlas (research 03 §6): a 3 × 2 grid of square cells, cell `i`
 * showing face value `i + 1`. Cream (#FFF6E6) faces with `ui-ink` pips that have a soft inner
 * shadow (dark at the top-left rim, a lighter floor bottom-right: the pip reads as drilled), and
 * a faint darker border so face edges read on a rounded die. Drawn with native arcs and
 * gradients (no per-pixel work).
 *
 * `size` is the atlas width; the height is two thirds of it (`size / 3` per cell).
 *
 * @module
 */
import { mixRGB, rgba, toRGB, type RGB } from "../color.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Atlas layout: columns × rows, face value `v` at cell `v - 1` (row-major). */
export const DICE_ATLAS = Object.freeze({ cols: 3, rows: 2 });

/** Pip centres (cell units, y down) per face value, the standard layouts. */
export const PIP_LAYOUTS: Readonly<
  Record<1 | 2 | 3 | 4 | 5 | 6, readonly (readonly [number, number])[]>
> = Object.freeze({
  1: [[0.5, 0.5]],
  2: [
    [0.27, 0.27],
    [0.73, 0.73],
  ],
  3: [
    [0.27, 0.27],
    [0.5, 0.5],
    [0.73, 0.73],
  ],
  4: [
    [0.27, 0.27],
    [0.73, 0.27],
    [0.27, 0.73],
    [0.73, 0.73],
  ],
  5: [
    [0.27, 0.27],
    [0.73, 0.27],
    [0.5, 0.5],
    [0.27, 0.73],
    [0.73, 0.73],
  ],
  6: [
    [0.27, 0.25],
    [0.73, 0.25],
    [0.27, 0.5],
    [0.73, 0.5],
    [0.27, 0.75],
    [0.73, 0.75],
  ],
});

/** UV rectangle `[u0, v0, u1, v1]` (three.js UVs, v up) of a face value in the atlas. */
export function diceFaceUV(value: number): [number, number, number, number] {
  const i = Math.min(5, Math.max(0, Math.round(value) - 1));
  const c = i % DICE_ATLAS.cols;
  const r = Math.floor(i / DICE_ATLAS.cols);
  const u0 = c / DICE_ATLAS.cols;
  const u1 = (c + 1) / DICE_ATLAS.cols;
  const v1 = 1 - r / DICE_ATLAS.rows;
  const v0 = 1 - (r + 1) / DICE_ATLAS.rows;
  return [u0, v0, u1, v1];
}

/** Pip radius as a fraction of the cell. */
export const PIP_R = 0.095;

export const diceRecipe: TextureRecipe = {
  name: "dice",
  size: (tier) => (tier === "high" ? 768 : 384),
  aspect: DICE_ATLAS.rows / DICE_ATLAS.cols,
  colorSpace: "srgb",
  wrap: "clamp",
  tint: (p) => p.cream,
  paint({ ctx, w, h, tint, palette }) {
    const cell = w / DICE_ATLAS.cols;
    const ink: RGB = toRGB(palette.ink);
    const face = tint;
    const edge = mixRGB(face, ink, 0.14);
    const floor = mixRGB(ink, face, 0.3);
    const band = cell * 0.08;
    ctx.fillStyle = rgba(face, 1);
    ctx.fillRect(0, 0, w, h);
    for (let row = 0; row < DICE_ATLAS.rows; row++)
      for (let col = 0; col < DICE_ATLAS.cols; col++) {
        const x0 = col * cell;
        const y0 = row * cell;
        // A soft darker border on every side: the bevel of a rounded die.
        const sides: [number, number, number, number, number, number, number, number][] = [
          [x0, y0, x0, y0 + band, x0, y0, cell, band],
          [x0, y0 + cell, x0, y0 + cell - band, x0, y0 + cell - band, cell, band],
          [x0, y0, x0 + band, y0, x0, y0, band, cell],
          [x0 + cell, y0, x0 + cell - band, y0, x0 + cell - band, y0, band, cell],
        ];
        for (const [gx0, gy0, gx1, gy1, rx, ry, rw, rh] of sides) {
          const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
          g.addColorStop(0, rgba(edge, 0.9));
          g.addColorStop(1, rgba(edge, 0));
          ctx.fillStyle = g;
          ctx.fillRect(rx, ry, rw, rh);
        }
        const value = (row * DICE_ATLAS.cols + col + 1) as 1 | 2 | 3 | 4 | 5 | 6;
        const r = PIP_R * cell;
        for (const [px, py] of PIP_LAYOUTS[value]) {
          const cx = x0 + px * cell;
          const cy = y0 + py * cell;
          // Drilled pip: dark ink at the top-left rim, a lighter floor toward the bottom right.
          const g = ctx.createRadialGradient(cx + r * 0.35, cy + r * 0.4, r * 0.1, cx, cy, r);
          g.addColorStop(0, rgba(floor, 1));
          g.addColorStop(0.55, rgba(mixRGB(ink, floor, 0.4), 1));
          g.addColorStop(1, rgba(ink, 1));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
  },
};
