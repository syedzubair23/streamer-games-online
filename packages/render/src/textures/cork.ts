/**
 * `cork`: the pinboard mat (research 03 §6). Tan (#D2A679) with soft mottling (a coarse field
 * in `overlay` mode), dense 2 px dark and light granules (a speckle field of at most 128² drawn
 * without smoothing) and 1 px grit (the shared grain tile at high strength). Tiles seamlessly.
 *
 * @module
 */
import { rgba, scaleRGB } from "../color.ts";
import { ALPHA_SHIFT, drawPeriodicField, GREY, OPAQUE, overlayTile, packRGBA } from "./canvas.ts";
import { createTileNoise } from "./noise.ts";
import type { TextureRecipe } from "./recipe.ts";

export const corkRecipe: TextureRecipe = {
  name: "cork",
  size: (tier) => (tier === "high" ? 512 : 256),
  aspect: 1,
  colorSpace: "srgb",
  wrap: "repeat",
  tint: (p) => p.cork,
  paint({ ctx, w, h, rng, tint, scratch, source }) {
    ctx.fillStyle = rgba(tint, 1);
    ctx.fillRect(0, 0, w, h);
    const mottle = createTileNoise(rng, 4, 4, 2).grid(new Float64Array(256), 16, 16);
    drawPeriodicField(
      ctx,
      scratch,
      w,
      h,
      16,
      16,
      (_d, _fw, _fh, px) => {
        for (let i = 0; i < 256; i++)
          px[i] = (((128 + ((mottle[i] as number) - 0.5) * 70) | 0) * GREY + OPAQUE) >>> 0;
      },
      { op: "overlay", alpha: 0.6 },
    );
    const darkRGB = scaleRGB(tint, 0.62);
    const lightRGB = scaleRGB(tint, 1.18);
    // Granules: 2 px at the 256 px default (the field is capped at 128², so larger tiers get
    // proportionally larger granules and the same look on the table).
    const fw = Math.max(2, Math.min(128, w >> 1));
    const fh = Math.max(2, Math.min(128, h >> 1));
    drawPeriodicField(
      ctx,
      scratch,
      w,
      h,
      fw,
      fh,
      (_d, _fw, _fh, px) => {
        // Inline xorshift32 seeded from the recipe's rng: a per-texel method call is the
        // dominant cost in cold (interpreted) boot code. One packed word per texel; most
        // texels are clear (the buffer starts zeroed).
        const darkPx = packRGBA(darkRGB[0], darkRGB[1], darkRGB[2], 0);
        const lightPx =
          (packRGBA(lightRGB[0], lightRGB[1], lightRGB[2], 0) | (110 << ALPHA_SHIFT)) >>> 0;
        let x = rng.next() | 1;
        for (let i = 0; i < px.length; i++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          const r = (x >>> 0) / 4294967296;
          if (r < 0.11) px[i] = (darkPx | (((150 + r * 600) | 0) << ALPHA_SHIFT)) >>> 0;
          else if (r > 0.94) px[i] = lightPx;
        }
      },
      { smooth: false },
    );
    overlayTile(ctx, source("grain"), w, h, 0.35);
  },
};
