/**
 * `grain`: the film-grain tile (research 03 §5.4, §6): white noise around mid grey, softened by
 * a 1 px blur, neutral under `mix-blend-mode: overlay`. It is the CSS grain overlay and also the
 * high-frequency detail layer the other painters composite in `overlay` mode (so felt, paper,
 * cork and wood get per-pixel variation without per-pixel JavaScript).
 *
 * Painted as half-resolution noise and upscaled bilinearly (the upscale is the blur). Tiles
 * seamlessly.
 *
 * @module
 */
import { drawPeriodicField, GREY, OPAQUE } from "./canvas.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Contrast of the grain around mid grey (±, 0..127). */
export const GRAIN_CONTRAST = 96;

export const grainRecipe: TextureRecipe = {
  name: "grain",
  size: () => 128,
  aspect: 1,
  colorSpace: "none",
  wrap: "repeat",
  tint: (p) => p.ink,
  paint({ ctx, w, h, rng, scratch }) {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, w, h);
    const fw = Math.max(2, w >> 1);
    const fh = Math.max(2, h >> 1);
    drawPeriodicField(ctx, scratch, w, h, fw, fh, (_d, _fw, _fh, px) => {
      // Inline xorshift32 seeded from the recipe's rng (no per-texel method calls), one packed
      // word per texel.
      let x = rng.next() | 1;
      for (let i = 0; i < px.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        const v = (128 + ((x >>> 0) / 4294967296 - 0.5) * 2 * GRAIN_CONTRAST) | 0;
        px[i] = (v * GREY + OPAQUE) >>> 0;
      }
    });
  },
};
