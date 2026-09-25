/**
 * `felt`: the card-table mat (research 03 §6). The `felt` base, fine noise at about ±4%
 * luminance (the shared grain tile in `overlay` mode) over soft mottling (a coarse periodic
 * field), and 200 short 1 px fibre streaks at 5% opacity (scaled with the area). Tiles
 * seamlessly: fibres that cross an edge are drawn again on the opposite side.
 *
 * @module
 */
import { rgba } from "../color.ts";
import { drawPeriodicField, GREY, OPAQUE, overlayTile } from "./canvas.ts";
import { createTileNoise } from "./noise.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Fibre streaks on a 256² tile (research 03 §6). */
export const FELT_FIBRES = 200;

export const feltRecipe: TextureRecipe = {
  name: "felt",
  size: (tier) => (tier === "high" ? 512 : 256),
  aspect: 1,
  colorSpace: "srgb",
  wrap: "repeat",
  tint: (p) => p.felt,
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
          px[i] = (((128 + ((mottle[i] as number) - 0.5) * 40) | 0) * GREY + OPAQUE) >>> 0;
      },
      { op: "overlay", alpha: 0.32 },
    );
    overlayTile(ctx, source("grain"), w, h, 0.22);
    // Fibres: one path per shade (two strokes in total, however many fibres).
    const fibres = Math.round((FELT_FIBRES * (w * h)) / (256 * 256));
    ctx.lineWidth = Math.max(1, w / 256);
    ctx.lineCap = "round";
    const paths: [number[], number[]] = [[], []];
    for (let f = 0; f < fibres; f++) {
      const x = rng.float() * w;
      const y = rng.float() * h;
      const a = rng.float() * Math.PI * 2;
      const len = (3 + rng.float() * 7) * (w / 256);
      const dx = Math.cos(a) * len;
      const dy = Math.sin(a) * len;
      const segs = paths[rng.bool(0.5) ? 0 : 1];
      for (let ox = -w; ox <= w; ox += w)
        for (let oy = -h; oy <= h; oy += h) {
          const x0 = x + ox;
          const y0 = y + oy;
          if (Math.max(x0, x0 + dx) < 0 || Math.min(x0, x0 + dx) > w) continue;
          if (Math.max(y0, y0 + dy) < 0 || Math.min(y0, y0 + dy) > h) continue;
          segs.push(x0, y0, x0 + dx, y0 + dy);
        }
    }
    const shades = [rgba([255, 250, 240], 0.05), rgba([20, 30, 30], 0.05)];
    for (let p = 0; p < 2; p++) {
      const segs = paths[p] as number[];
      ctx.beginPath();
      for (let i = 0; i < segs.length; i += 4) {
        ctx.moveTo(segs[i] as number, segs[i + 1] as number);
        ctx.lineTo(segs[i + 2] as number, segs[i + 3] as number);
      }
      ctx.strokeStyle = shades[p] as string;
      ctx.stroke();
    }
  },
};
