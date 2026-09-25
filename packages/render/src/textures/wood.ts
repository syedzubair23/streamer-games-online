/**
 * `wood`: painted table wood (research 03 §6). Grain rings run along the long (x) axis, warped
 * by low-frequency fBm, and bend around 2–3 knots; fine fibres are stretched noise; a faint
 * speckle breaks up flat areas. The shade mixes between `wood` and about `wood × 0.82`, and the
 * mode tint happens in the material colour, not here. `variant: "table"` bakes the soft darker
 * ellipse where the mat sits. Tiles seamlessly (2:1).
 *
 * Structure is computed on coarse periodic fields (rings on a 64² grid, fibres at ¹⁄₁₆ × ½)
 * and upscaled natively; knot eyes are drawn natively, and the grain tile adds per-pixel
 * speckle (see `drawPeriodicField`).
 *
 * @module
 */
import { rgba, rgbHex, scaleRGB } from "../color.ts";
import { ALPHA_SHIFT, drawPeriodicField, overlayTile, packRGBA } from "./canvas.ts";
import { createTileNoise } from "./noise.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Ring count across the texture height. */
const RINGS = 7;
/** The grain colour: the base darkened to 80%; alpha sets how much (research 03 §6: × 0.82). */
const GRAIN_TONE = 0.8;

interface Knot {
  x: number;
  y: number;
  r: number;
  k: number;
}

export const woodRecipe: TextureRecipe = {
  name: "wood",
  size: (tier) => (tier === "high" ? 1024 : 512),
  aspect: 0.5,
  colorSpace: "srgb",
  wrap: (variant) => (variant === "table" ? "clamp" : "repeat"),
  tint: (p) => p.wood,
  paint({ ctx, w, h, rng, seed, tint, tinted, variant, scratch, source }) {
    const dark = scaleRGB(tint, GRAIN_TONE);
    if (variant === "table") {
      // The table is the plain wood of the same seed plus the baked soft darker ellipse where
      // the mat sits (reusing the cached wood instead of repainting it).
      ctx.drawImage(
        source("wood", { w, seed, ...(tinted ? { tint: rgbHex(tint) } : {}) }),
        0,
        0,
        w,
        h,
      );
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(1, (0.4 * h) / (0.34 * w));
      const rx = 0.34 * w * 1.25;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, rgba(dark, 0.55));
      g.addColorStop(0.5, rgba(dark, 0.45));
      g.addColorStop(1, rgba(dark, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-w, -w, 2 * w, 2 * w);
      ctx.restore();
      return;
    }
    const warp = createTileNoise(rng, 3, 2, 2);
    const fibre = createTileNoise(rng, 4, 32, 1);
    const knots: Knot[] = [];
    const nk = 2 + rng.int(2);
    for (let i = 0; i < nk; i++)
      knots.push({
        x: rng.float(),
        y: rng.float(),
        r: 0.035 + rng.float() * 0.03,
        k: 0.9 + rng.float() * 0.8,
      });
    ctx.fillStyle = rgba(tint, 1);
    ctx.fillRect(0, 0, w, h);
    // Rings: dark line at the ring edge fading across the ring, knots bend them. Computed on a
    // field of at most 64 × 64 (the rings run along x, so x can be coarser than y); the knot
    // eyes, which need detail, are drawn natively afterwards.
    const fw = Math.min(64, Math.max(8, w >> 3));
    const fh = Math.min(64, Math.max(4, h >> 2));
    const aspect = w / h;
    const warpField = warp.grid(new Float64Array(fw * fh), fw, fh, { offset: 0.5 });
    const darkPx = packRGBA(dark[0], dark[1], dark[2], 0);
    const nk2 = knots.length;
    drawPeriodicField(ctx, scratch, w, h, fw, fh, (_d, _fw, _fh, px) => {
      for (let y = 0, i = 0; y < fh; y++) {
        const v = (y + 0.5) / fh;
        const vRings = v * RINGS;
        for (let x = 0; x < fw; x++, i++) {
          const u = (x + 0.5) / fw;
          let t = vRings + ((warpField[i] as number) - 0.5) * 2.4;
          let core = 0;
          for (let k = 0; k < nk2; k++) {
            const kn = knots[k] as Knot;
            let dx = u > kn.x ? u - kn.x : kn.x - u;
            let dy = v > kn.y ? v - kn.y : kn.y - v;
            if (dx > 0.5) dx = 1 - dx;
            if (dy > 0.5) dy = 1 - dy;
            dx *= aspect;
            const dd = (dx * dx + dy * dy) / (kn.r * kn.r);
            if (dd < 9) {
              // Rational falloff ≈ exp(-dd), cheaper and smooth.
              const f = 1 / (1 + dd + 0.5 * dd * dd);
              t += kn.k * f;
              if (f * f > core) core = f * f;
            }
          }
          // Ring profile: a dark line at the ring edge (smoothstep up over 0..0.12), fading
          // across the ring (smoothstep down over 0.12..1), inlined for the cold boot path.
          const ring = t - Math.floor(t);
          let grain: number;
          if (ring < 0.12) {
            const q = ring / 0.12;
            grain = q * q * (3 - 2 * q);
          } else {
            const q = (ring - 0.12) / 0.88;
            grain = 1 - q * q * (3 - 2 * q);
          }
          const alpha = 0.85 * grain + 0.35 * core;
          px[i] = (darkPx | (((alpha >= 1 ? 1 : alpha) * 255) << ALPHA_SHIFT)) >>> 0;
        }
      }
    });
    // Fibres: streaks along the grain (coarse in x, fine in y).
    const bw = Math.max(4, w >> 4);
    const bh = Math.max(4, h >> 1);
    const fibreField = fibre.grid(new Float64Array(bw * bh), bw, bh, { offset: 0.5, octave: 0 });
    drawPeriodicField(ctx, scratch, w, h, bw, bh, (_d, _fw, _fh, px) => {
      for (let i = 0; i < px.length; i++) {
        const f = fibreField[i] as number;
        if (f <= 0.4) continue;
        const q = f >= 0.95 ? 1 : (f - 0.4) / 0.55;
        px[i] = (darkPx | ((q * q * (3 - 2 * q) * 0.35 * 255) << ALPHA_SHIFT)) >>> 0;
      }
    });
    // Knot eyes: a dark core and two soft rings, drawn at full resolution (wrapped copies near
    // the edges keep the tile seamless).
    for (const kn of knots) {
      // Knots are stretched along the grain.
      const rx = kn.r * h * 1.2;
      const ry = kn.r * h * 0.6;
      for (let ox = -w; ox <= w; ox += w)
        for (let oy = -h; oy <= h; oy += h) {
          const cx = kn.x * w + ox;
          const cy = kn.y * h + oy;
          if (cx < -rx * 3 || cx > w + rx * 3 || cy < -ry * 3 || cy > h + ry * 3) continue;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
          g.addColorStop(0, rgba(scaleRGB(dark, 0.78), 0.9));
          g.addColorStop(0.6, rgba(dark, 0.55));
          g.addColorStop(1, rgba(dark, 0));
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(1, ry / rx);
          ctx.translate(-cx, -cy);
          ctx.fillStyle = g;
          ctx.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);
          ctx.strokeStyle = rgba(dark, 0.45);
          ctx.lineWidth = Math.max(1, rx * 0.09);
          for (const k of [1.35, 1.8]) {
            ctx.beginPath();
            ctx.arc(cx, cy, rx * k, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
    }
    // Per-pixel speckle from the shared grain tile.
    overlayTile(ctx, source("grain"), w, h, 0.07);
  },
};
