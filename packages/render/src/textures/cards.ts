/**
 * `cards`: the card-face atlas (research 03 §6). An 8 × 4 grid of 5:7 cells (128 × 179 at the
 * 1024 px atlas of low/mid, 256 × 358 at 2048 on high). Each card is a rounded rectangle of
 * paper stock (the `paper` texture as a pattern) with a `ui-line` border.
 *
 * Variants:
 * - `numbers` (default): big corner numerals in Fredoka (cell `i` shows `i + 1`) and a centre
 *   diamond in the accent colour;
 * - `blank`: stock and border only (games print on top);
 * - `back`: the shared card back (accent field, inset border, diamond lattice).
 *
 * Numerals need the display font loaded: the shell generates textures after
 * `document.fonts.ready` (during the Iris load), so the atlas is deterministic.
 *
 * @module
 */
import { mixRGB, rgba, rgbHex, toRGB, type RGB } from "../color.ts";
import { roundRectPath, type Canvas2D, type Ctx2D } from "./canvas.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Atlas layout: 8 columns × 4 rows of 5:7 cards. */
export const CARD_ATLAS = Object.freeze({ cols: 8, rows: 4, aspect: 7 / 5 });

/** Cell size (px) of an atlas `w` px wide. */
export function cardCell(w: number): { w: number; h: number } {
  const cw = Math.floor(w / CARD_ATLAS.cols);
  return { w: cw, h: Math.floor(cw * CARD_ATLAS.aspect) };
}

/** UV rectangle `[u0, v0, u1, v1]` (three.js UVs, v up) of card `index` in an atlas of `w` px. */
export function cardUV(index: number, w: number): [number, number, number, number] {
  const cell = cardCell(w);
  const h = cell.h * CARD_ATLAS.rows;
  const i = Math.min(CARD_ATLAS.cols * CARD_ATLAS.rows - 1, Math.max(0, Math.floor(index)));
  const c = i % CARD_ATLAS.cols;
  const r = Math.floor(i / CARD_ATLAS.cols);
  return [
    (c * cell.w) / w,
    1 - ((r + 1) * cell.h) / h,
    ((c + 1) * cell.w) / w,
    1 - (r * cell.h) / h,
  ];
}

/** The display font stack for numerals (SPEC §13.4). */
export const CARD_FONT = '"Fredoka", "Nunito", system-ui, sans-serif';

/** Adds a diamond sub-path (call `beginPath` first; several diamonds can share one fill). */
function diamond(ctx: Ctx2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.moveTo(cx, cy - ry);
  ctx.lineTo(cx + rx, cy);
  ctx.lineTo(cx, cy + ry);
  ctx.lineTo(cx - rx, cy);
  ctx.closePath();
}

/** Pixels of transparent padding around each glyph cell (overhangs, antialiasing). */
const GLYPH_PAD = 4;

/** A strip of the ten digit glyphs, rendered once and blitted for every numeral. */
interface DigitGlyphs {
  /**
   * Draws `label` (digits only) with its top-left at `(x, y)`, or, `rotated`, turned 180°
   * about `(x, y)` (reading upside down from the opposite corner), exactly like
   * `fillText(label)` with `textBaseline = "top"` under that transform, snapped to whole pixels.
   */
  draw(ctx: Ctx2D, label: string, x: number, y: number, rotated: boolean): void;
}

/**
 * Renders the digits 0–9 once (ten `fillText` calls instead of two per card: text shaping is
 * the dominant cost of the atlas on the cold boot path) into an upright strip and a 180°
 * copy; numerals are composed from their advances (digits carry no kerning pairs).
 */
function digitGlyphs(
  scratch: (w: number, h: number) => Canvas2D,
  px: number,
  fill: string,
  avoid: Canvas2D,
): DigitGlyphs {
  const font = `600 ${px}px ${CARD_FONT}`;
  const cellH = Math.ceil(px * 1.5) + 2 * GLYPH_PAD;
  const probe = avoid.ctx;
  probe.save();
  probe.font = font;
  const adv: number[] = [];
  for (let d = 0; d < 10; d++) adv.push(probe.measureText(String(d)).width);
  probe.restore();
  const cellW = Math.ceil(Math.max(...adv)) + 2 * GLYPH_PAD;
  // Scratch canvases are pooled by size: keep the strips distinct from the card template.
  let stripW = cellW * 10;
  if (stripW === avoid.canvas.width && cellH === avoid.canvas.height) stripW++;
  const up = scratch(stripW, cellH);
  up.ctx.font = font;
  up.ctx.fillStyle = fill;
  up.ctx.textBaseline = "top";
  up.ctx.textAlign = "left";
  for (let d = 0; d < 10; d++) up.ctx.fillText(String(d), d * cellW + GLYPH_PAD, GLYPH_PAD);
  const down = scratch(stripW + 1, cellH);
  down.ctx.save();
  down.ctx.translate(stripW, cellH);
  down.ctx.rotate(Math.PI);
  down.ctx.drawImage(up.canvas, 0, 0);
  down.ctx.restore();
  return {
    draw(ctx, label, x, y, rotated) {
      const X = Math.round(x);
      const Y = Math.round(y);
      let ox = 0;
      for (let i = 0; i < label.length; i++) {
        const d = label.charCodeAt(i) - 48;
        const a = adv[d];
        if (a === undefined) continue;
        const gx = Math.round(ox);
        if (!rotated)
          ctx.drawImage(
            up.canvas,
            d * cellW,
            0,
            cellW,
            cellH,
            X + gx - GLYPH_PAD,
            Y - GLYPH_PAD,
            cellW,
            cellH,
          );
        // In the 180° strip, digit d's cell starts at stripW - (d + 1) * cellW; label offset ox
        // maps to X - ox, so the cell lands to the left of and above the anchor.
        else
          ctx.drawImage(
            down.canvas,
            stripW - (d + 1) * cellW,
            0,
            cellW,
            cellH,
            X - gx - cellW + GLYPH_PAD,
            Y - cellH + GLYPH_PAD,
            cellW,
            cellH,
          );
        ox += a;
      }
    },
  };
}

export const cardsRecipe: TextureRecipe = {
  name: "cards",
  size: (tier) => (tier === "high" ? 2048 : 1024),
  aspect: (CARD_ATLAS.rows * CARD_ATLAS.aspect) / CARD_ATLAS.cols,
  colorSpace: "srgb",
  wrap: "clamp",
  tint: (p) => p.paper,
  paint({ ctx, w, h, seed, tint, variant, palette, source, scratch }) {
    const cell = cardCell(w);
    const k = cell.w / 128;
    const ink: RGB = toRGB(palette.ink);
    const line: RGB = toRGB(palette.line);
    const accent: RGB = toRGB(palette.accent);
    const mode = variant === "blank" || variant === "back" ? variant : "numbers";
    const pad = 3 * k;
    const radius = 10 * k;
    const border = 6 * k;
    const cw = cell.w - 2 * pad;
    const ch = cell.h - 2 * pad;
    // Every card shares one template (stock, border, and the back design or the centre
    // diamond), painted once and blitted 32 times; only the numerals differ per card.
    const tpl = scratch(Math.ceil(cw), Math.ceil(ch));
    const t = tpl.ctx;
    const stock = t.createPattern(source("paper", { seed, tint: rgbHex(tint) }), "repeat");
    roundRectPath(t, 0, 0, cw, ch, radius);
    t.fillStyle = stock ?? rgba(tint, 1);
    t.fill();
    t.lineWidth = border;
    t.strokeStyle = rgba(mode === "back" ? mixRGB(accent, ink, 0.25) : line, 1);
    roundRectPath(t, border / 2, border / 2, cw - border, ch - border, radius - border / 2);
    t.stroke();
    if (mode === "back") {
      const inset = border * 2;
      roundRectPath(t, inset, inset, cw - 2 * inset, ch - 2 * inset, radius * 0.6);
      t.fillStyle = rgba(accent, 1);
      t.fill();
      t.save();
      t.clip();
      t.fillStyle = rgba(mixRGB(accent, [255, 255, 255], 0.28), 1);
      const step = 14 * k;
      t.beginPath();
      for (let yy = inset, row = 0; yy < ch; yy += step, row++)
        for (let xx = inset + ((row % 2) * step) / 2; xx < cw; xx += step)
          diamond(t, xx, yy, 3.2 * k, 4.4 * k);
      t.fill();
      t.restore();
    } else if (mode === "numbers") {
      t.fillStyle = rgba(accent, 1);
      t.beginPath();
      diamond(t, cw / 2, ch / 2, 16 * k, 22 * k);
      t.fill();
      t.fillStyle = rgba(mixRGB(accent, [255, 255, 255], 0.45), 0.9);
      t.beginPath();
      diamond(t, cw / 2 - 3 * k, ch / 2 - 5 * k, 5 * k, 7 * k);
      t.fill();
    }
    ctx.clearRect(0, 0, w, h);
    const glyphs =
      mode === "numbers" ? digitGlyphs(scratch, Math.round(30 * k), rgba(ink, 1), tpl) : null;
    for (let r = 0; r < CARD_ATLAS.rows; r++)
      for (let c = 0; c < CARD_ATLAS.cols; c++) {
        const x = c * cell.w + pad;
        const y = r * cell.h + pad;
        if (y + ch > h) continue;
        ctx.drawImage(tpl.canvas, x, y);
        if (glyphs === null) continue;
        const label = String(r * CARD_ATLAS.cols + c + 1);
        // Top-left numeral, and the same numeral rotated 180° in the bottom-right corner.
        glyphs.draw(ctx, label, x + 12 * k, y + 10 * k, false);
        glyphs.draw(ctx, label, x + cw - 12 * k, y + ch - 10 * k, true);
      }
  },
};
