/**
 * `paper`: sketchbook and card stock (research 03 §6). Off-white `paper` (#FBF5EA) with
 * low-frequency fBm blotches at about ±3% (a coarse two-tone periodic field) and fine grain at
 * about ±2% (the shared grain tile, multiplied faintly). `variant: "ruled"` adds faint blue ruled
 * lines (the Doodle sketchbook). Tiles seamlessly.
 *
 * @module
 */
import { rgba, scaleRGB } from "../color.ts";
import { ALPHA_SHIFT, drawPeriodicField, overlayTile, packRGBA } from "./canvas.ts";
import { createTileNoise } from "./noise.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Strength of the multiplied grain (≈ ±2% luminance). */
export const PAPER_GRAIN_ALPHA = 0.05;
/** Ruled lines per tile for `variant: "ruled"`. */
export const PAPER_RULES = 8;
/** The ruled-line colour (a faint school-book blue). */
export const PAPER_RULE_RGB: readonly [number, number, number] = Object.freeze([150, 185, 225]);

export const paperRecipe: TextureRecipe = {
  name: "paper",
  size: (tier) => (tier === "high" ? 512 : 256),
  aspect: 1,
  colorSpace: "srgb",
  wrap: "repeat",
  tint: (p) => p.paper,
  paint({ ctx, w, h, rng, tint, variant, scratch, source }) {
    // The grain below is multiplied in at GRAIN_ALPHA, which darkens by GRAIN_ALPHA / 2 on
    // average: start that much lighter so the stock keeps its token colour.
    ctx.fillStyle = rgba(scaleRGB(tint, 1 / (1 - PAPER_GRAIN_ALPHA / 2)), 1);
    ctx.fillRect(0, 0, w, h);
    // Blotches (±3%): a coarse two-tone field, lighter or darker than the stock (contrast blend
    // modes do almost nothing on near-white paper).
    const blotch = createTileNoise(rng, 3, 3, 3).grid(new Float64Array(24 * 24), 24, 24);
    const deep = scaleRGB(tint, 0.9);
    const deepPx = packRGBA(deep[0], deep[1], deep[2], 0);
    const whitePx = packRGBA(255, 255, 255, 0);
    drawPeriodicField(ctx, scratch, w, h, 24, 24, (_d, _fw, _fh, px) => {
      for (let i = 0; i < 24 * 24; i++) {
        const n = ((blotch[i] as number) - 0.5) * 2;
        const a = (Math.min(1, n < 0 ? -n * 0.45 : n * 0.6) * 255) | 0;
        px[i] = ((n < 0 ? deepPx : whitePx) | (a << ALPHA_SHIFT)) >>> 0;
      }
    });
    // Fine grain (≈ ±2%): the shared grain tile, multiplied in faintly.
    overlayTile(ctx, source("grain"), w, h, PAPER_GRAIN_ALPHA, "multiply");
    if (variant === "ruled") {
      const rule = h / PAPER_RULES;
      const lineW = Math.max(1, Math.round(h / 256));
      ctx.fillStyle = rgba([PAPER_RULE_RGB[0], PAPER_RULE_RGB[1], PAPER_RULE_RGB[2]], 0.32);
      for (let i = 0; i < PAPER_RULES; i++)
        ctx.fillRect(0, Math.floor(i * rule + rule * 0.85), w, lineW);
    }
  },
};
