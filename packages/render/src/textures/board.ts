/**
 * `board`: painted-wood board art (research 03 §6). Rounded-rect tiles with a soft inner shadow
 * and a light top edge, painted over the wood texture at 92% opacity so the grain shows through
 * ("painted wood"), inside a darker frame.
 *
 * Variants: `checker-N` (default `checker-8`: alternating light/dark tiles, the light tone is the
 * tint and the dark tone is derived from it) and `grid-N` (N × N tiles of the tint). Games with
 * bespoke art (Ludo tracks, Snakes & Ladders) overpaint the mat through `mats.setMat(kind, painter)`.
 *
 * @module
 */
import { mixRGB, rgba, scaleRGB, toRGB, type RGB } from "../color.ts";
import { roundRectPath, roundRectSubPath } from "./canvas.ts";
import type { TextureRecipe } from "./recipe.ts";

/** A parsed board variant. */
export interface BoardLayout {
  kind: "checker" | "grid";
  n: number;
}

/** Parses `checker-N` / `grid-N` (N clamped to 2..16; anything else is `checker-8`). */
export function parseBoardVariant(variant: string | undefined): BoardLayout {
  const m = /^(checker|grid)-(\d{1,2})$/.exec(variant ?? "");
  if (m === null) return { kind: "checker", n: 8 };
  return {
    kind: m[1] as BoardLayout["kind"],
    n: Math.min(16, Math.max(2, Number(m[2]))),
  };
}

/** The board's frame width as a fraction of its size. */
export const BOARD_FRAME = 0.045;
/** Paint opacity over the wood (research 03 §6). */
export const BOARD_PAINT_ALPHA = 0.92;

export const boardRecipe: TextureRecipe = {
  name: "board",
  size: (tier) => (tier === "low" ? 512 : 1024),
  aspect: 1,
  colorSpace: "srgb",
  wrap: "clamp",
  tint: () => "#F1E6D2",
  paint({ ctx, w, h, seed, tint, variant, palette, source, scratch }) {
    const layout = parseBoardVariant(variant);
    // Wood underneath, tiled at its own 2:1 aspect (it repeats seamlessly) so grain is not stretched.
    const wood = source("wood", { seed });
    const rows = Math.max(1, Math.round(h / (w / 2)));
    for (let i = 0; i < rows; i++) ctx.drawImage(wood, 0, (i * h) / rows, w, h / rows);
    const ink: RGB = toRGB(palette.ink);
    const light = tint;
    // The dark squares are the tint stained toward the wood: warm, never grey.
    const dark = mixRGB(scaleRGB(tint, 0.86), toRGB(palette.wood), 0.5);
    const frame = Math.round(w * BOARD_FRAME);
    // Frame: a darker painted band around the playing field.
    ctx.fillStyle = rgba(ink, 0.2);
    ctx.fillRect(0, 0, w, frame);
    ctx.fillRect(0, h - frame, w, frame);
    ctx.fillRect(0, frame, frame, h - 2 * frame);
    ctx.fillRect(w - frame, frame, frame, h - 2 * frame);
    const inner = w - 2 * frame;
    const cell = inner / layout.n;
    const gap = Math.max(1, cell * 0.06);
    const radius = cell * 0.16;
    const soft = Math.max(1, cell * 0.12);
    const s = cell - gap;
    // The inset shading is the same for every tile: paint it once (clipped to the rounded
    // tile) and blit it. Gradients, not canvas shadows (slow, and they misbehave under clips on
    // some rasterisers): a soft shade inside the top and left edges, a light catch inside the
    // bottom and right edges (the key light comes from the upper left).
    const size = Math.ceil(s);
    const inset = scratch(size, size);
    const t = inset.ctx;
    t.save();
    roundRectPath(t, 0, 0, s, s, radius);
    t.clip();
    const band = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      rgb: RGB,
      a: number,
      rx: number,
      ry: number,
      rw: number,
      rh: number,
    ): void => {
      const g = t.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, rgba(rgb, a));
      g.addColorStop(1, rgba(rgb, 0));
      t.fillStyle = g;
      t.fillRect(rx, ry, rw, rh);
    };
    const lightRGB: RGB = [255, 250, 240];
    band(0, 0, 0, soft, ink, 0.22, 0, 0, s, soft);
    band(0, 0, soft, 0, ink, 0.16, 0, 0, soft, s);
    band(0, s, 0, s - soft * 0.6, lightRGB, 0.3, 0, s - soft * 0.6, s, soft * 0.6);
    band(s, 0, s - soft * 0.6, 0, lightRGB, 0.2, s - soft * 0.6, 0, soft * 0.6, s);
    t.restore();
    for (const tone of layout.kind === "checker" ? [light, dark] : [light]) {
      ctx.fillStyle = rgba(tone, BOARD_PAINT_ALPHA);
      ctx.beginPath();
      for (let r = 0; r < layout.n; r++)
        for (let c = 0; c < layout.n; c++) {
          const isDark = layout.kind === "checker" && (r + c) % 2 === 1;
          if ((tone === dark) !== isDark) continue;
          roundRectSubPath(
            ctx,
            frame + c * cell + gap / 2,
            frame + r * cell + gap / 2,
            s,
            s,
            radius,
          );
        }
      ctx.fill();
    }
    for (let r = 0; r < layout.n; r++)
      for (let c = 0; c < layout.n; c++)
        ctx.drawImage(inset.canvas, frame + c * cell + gap / 2, frame + r * cell + gap / 2);
  },
};
