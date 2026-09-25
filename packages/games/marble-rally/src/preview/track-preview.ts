/**
 * The track preview renderer (ROADMAP M9-00b): draws an authored track as a standalone SVG
 * document, straight from the same JSON the solver compiles. It is used to author and review
 * tracks (`pnpm --filter @sg/game-marble-rally tracks:preview`, which also overlays simulated
 * races: marble positions, finish-time stats and DNF spots) and can serve as a track-picker
 * thumbnail, since it needs no DOM, WebGL or three.js.
 *
 * Output is deterministic: the same track and options always give byte-identical SVG. Colours
 * are never hard-coded here; the caller passes a {@link PreviewPalette} (the Stage and
 * controllers build one from `@sg/ui` tokens; the authoring CLI has its own dev palette).
 *
 * @module
 */
import { FP, MARBLE_RADIUS_UNITS, WORLD_H_UNITS, WORLD_W_UNITS } from "../logic/physics/index.ts";
import { traySlots } from "../logic/tracks/course.ts";
import type { PieceDef, PieceKind, PieceSource, TrackDef } from "../logic/tracks/types.ts";

/** Colours of a preview, as CSS colour strings. Lists are indexed by piece variant (wrapping). */
export interface PreviewPalette {
  /** The window/sky behind the board. */
  background: string;
  /** The pegboard. */
  board: string;
  /** The board's pegboard hole dots. */
  holes: string;
  /** Solid pieces by kind; each list is indexed by `variant % length`. */
  pieces: Record<PieceKind, readonly string[]>;
  gate: string;
  trapdoor: string;
  finish: string;
  boost: string;
  centerline: string;
  tray: string;
  train: string;
  decor: string;
  /** Marble colours, indexed by marble id (wrapping). */
  marbles: readonly string[];
  /** Highlight for flagged spots (DNF, stuck). */
  alert: string;
  text: string;
}

/** Marble positions to overlay, in solver fixed units (1/16 world unit). */
export interface PreviewMarbles {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  count: number;
  /** Optional per-marble flag: 0 draws the marble dimmed (finished, DNF). */
  alive?: ArrayLike<number>;
}

/** Options for {@link renderTrackPreview}. */
export interface PreviewOptions {
  palette: PreviewPalette;
  /** Output width in pixels (height is twice that, the world's aspect). Default 512. */
  width?: number;
  /** Overlay marbles (e.g. a simulated race at some tick). */
  marbles?: PreviewMarbles;
  /** Draw the first `n` start-tray slots as outlines (shows the tray fill). Default 0. */
  traySlots?: number;
  /** Flagged spots in world units, drawn as alert rings (e.g. where marbles were DNF'd). */
  spots?: readonly (readonly [number, number])[];
  /** Draw the progress centreline with a tick every 1000 progress. Default true. */
  centerline?: boolean;
  /** Draw gate, finish and boost labels and the title block. Default true. */
  labels?: boolean;
  /** Extra text lines under the title (e.g. simulation statistics). */
  notes?: readonly string[];
}

const W = WORLD_W_UNITS;
const H = WORLD_H_UNITS;

/** Formats a number for SVG: integers as-is, others to 1 decimal (stable across runs). */
const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pick = (list: readonly string[], i: number): string => list[i % list.length] ?? "none";

/** Visual stroke width of a collider: its thickness, but never thinner than 10 units. */
const strokeOf = (thick: number): number => Math.max(10, thick);

/** SVG path for an arc `[cx, cy, r, ax, ay, bx, by]` swept counter-clockwise from a to b. */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): string | null {
  const a0 = Math.atan2(ay, ax);
  let a1 = Math.atan2(by, bx);
  const full = ax * by - ay * bx === 0 && ax * bx + ay * by > 0;
  if (full) return null;
  while (a1 <= a0) a1 += 2 * Math.PI;
  const sweep = a1 - a0;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  // In the flipped (y-up) group, sweep-flag 1 is counter-clockwise in world terms.
  return `M${n(x0)} ${n(y0)}A${n(r)} ${n(r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${n(x1)} ${n(y1)}`;
}

function pieceColor(p: PieceDef | undefined, palette: PreviewPalette): string {
  if (p === undefined) return pick(palette.pieces.frame, 0);
  return pick(palette.pieces[p.kind], p.variant);
}

/**
 * Renders `track` to a standalone SVG document string: the pegboard, every collider coloured by
 * its visual piece, the start tray, gates (trapdoors marked), the finish, boosts, the
 * centreline, the train rail and props, and any overlays from `opts`.
 */
export function renderTrackPreview(track: TrackDef, opts: PreviewOptions): string {
  const pal = opts.palette;
  const width = opts.width ?? 512;
  const height = width * 2;
  const labels = opts.labels ?? true;
  const pieceOf = new Map<string, PieceDef>();
  for (const p of track.visuals.pieces) pieceOf.set(`${p.src}[${p.index}]`, p);
  const piece = (src: PieceSource, i: number): PieceDef | undefined => pieceOf.get(`${src}[${i}]`);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W} ${H}" data-track="${esc(track.id)}">`,
    `<title>${esc(track.name)}</title>`,
    `<rect width="${W}" height="${H}" fill="${pal.background}"/>`,
    `<g transform="translate(0 ${H}) scale(1 -1)">`,
    `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="48" fill="${pal.board}"/>`,
  );
  // Pegboard holes on a 256-unit grid (decoration only).
  out.push(`<g fill="${pal.holes}" data-layer="holes">`);
  for (let y = 128; y < H; y += 256)
    for (let x = 128; x < W; x += 256) out.push(`<circle cx="${x}" cy="${y}" r="10"/>`);
  out.push(`</g>`);

  // Start tray.
  const [gx1, gy, gx2] = track.start.gate;
  out.push(
    `<rect data-layer="tray" x="${gx1}" y="${gy}" width="${gx2 - gx1}" height="${track.start.top - gy + MARBLE_RADIUS_UNITS}" fill="${pal.tray}" fill-opacity="0.35"/>`,
    `<line data-layer="start-gate" x1="${gx1}" y1="${gy}" x2="${gx2}" y2="${gy}" stroke="${pal.gate}" stroke-width="12" stroke-dasharray="48 24"/>`,
  );
  const nSlots = opts.traySlots ?? 0;
  if (nSlots > 0) {
    const slots = traySlots(track);
    out.push(`<g data-layer="slots" fill="none" stroke="${pal.tray}" stroke-width="6">`);
    for (let i = 0; i < Math.min(nSlots, slots.length / 2); i++)
      out.push(
        `<circle cx="${n(slots[2 * i]! / FP)}" cy="${n(slots[2 * i + 1]! / FP)}" r="${MARBLE_RADIUS_UNITS}"/>`,
      );
    out.push(`</g>`);
  }

  // Train rail (cosmetic).
  const [tx1, ty1, tx2, ty2] = track.visuals.train.rail;
  out.push(
    `<line data-layer="train" x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="${pal.train}" stroke-width="14" stroke-dasharray="20 20"/>`,
  );
  for (const d of track.visuals.decor)
    out.push(
      `<rect data-layer="decor" data-kind="${d.kind}" x="-60" y="-30" width="120" height="60" rx="16" fill="${pal.decor}" transform="translate(${d.x} ${d.y}) rotate(${d.rot})"/>`,
    );

  // Solid geometry.
  out.push(`<g data-layer="solids" fill="none" stroke-linecap="round">`);
  const seg = (s: readonly number[], src: PieceSource, i: number): void => {
    const [x1, y1, x2, y2, thick] = s as [number, number, number, number, number];
    const p = piece(src, i);
    out.push(
      `<line data-piece="${p?.kind ?? "frame"}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${pieceColor(p, pal)}" stroke-width="${strokeOf(thick)}"/>`,
    );
  };
  track.segments.forEach((s, i) => seg(s, "segments", i));
  (track.zones?.funnel ?? []).forEach((s, i) => seg(s, "funnel", i));
  (track.arcs ?? []).forEach((a, i) => {
    const [cx, cy, r, ax, ay, bx, by, thick] = a;
    const p = piece("arcs", i);
    const color = pieceColor(p, pal);
    const d = arcPath(cx, cy, r, ax, ay, bx, by);
    out.push(
      d === null
        ? `<circle data-piece="${p?.kind ?? "frame"}" cx="${cx}" cy="${cy}" r="${r}" stroke="${color}" stroke-width="${strokeOf(thick)}"/>`
        : `<path data-piece="${p?.kind ?? "frame"}" d="${d}" stroke="${color}" stroke-width="${strokeOf(thick)}"/>`,
    );
  });
  out.push(`</g>`);
  out.push(`<g data-layer="pegs">`);
  (track.pegs ?? []).forEach(([x, y, r], i) =>
    out.push(
      `<circle data-piece="${piece("pegs", i)?.kind ?? "dowel"}" cx="${x}" cy="${y}" r="${Math.max(r, 8)}" fill="${pieceColor(piece("pegs", i), pal)}"/>`,
    ),
  );
  out.push(`</g>`);

  // Zones.
  const zones = track.zones ?? {};
  (zones.gates ?? []).forEach(([x1, y1, x2, y2], i) => {
    const trap = track.visuals.trapdoors.includes(i);
    out.push(
      `<line data-layer="gate" data-gate="${i}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${trap ? pal.trapdoor : pal.gate}" stroke-width="10" stroke-dasharray="${trap ? "64 16" : "32 32"}"/>`,
    );
  });
  if (zones.finish) {
    const [x1, y1, x2, y2] = zones.finish;
    out.push(
      `<line data-layer="finish" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${pal.finish}" stroke-width="24" stroke-dasharray="48 48"/>`,
    );
    const [fx, fy] = track.visuals.flag;
    out.push(
      `<path data-layer="flag" d="M${fx} ${fy}V${fy + 260}l160 -60l-160 -60" fill="${pal.finish}" stroke="${pal.finish}" stroke-width="12"/>`,
    );
  }
  (zones.boost ?? []).forEach(([x1, y1, x2, y2, vx, vy]) => {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.hypot(vx, vy) || 1;
    out.push(
      `<g data-layer="boost"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${pal.boost}" stroke-width="16"/>` +
        `<line x1="${n(mx)}" y1="${n(my)}" x2="${n(mx + (vx / len) * 160)}" y2="${n(my + (vy / len) * 160)}" stroke="${pal.boost}" stroke-width="12"/></g>`,
    );
  });

  // Centreline with a tick every 10% of its length.
  if (opts.centerline ?? true) {
    const pts = track.centerline;
    out.push(
      `<polyline data-layer="centerline" points="${pts.map(([x, y]) => `${x},${y}`).join(" ")}" fill="none" stroke="${pal.centerline}" stroke-width="6" stroke-dasharray="24 16"/>`,
    );
    let total = 0;
    for (let i = 1; i < pts.length; i++)
      total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    out.push(`<g data-layer="progress-ticks" fill="${pal.centerline}">`);
    let acc = 0;
    let next = total / 10;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      while (next <= acc + len && next < total) {
        const t = (next - acc) / len;
        out.push(`<circle cx="${n(x0 + (x1 - x0) * t)}" cy="${n(y0 + (y1 - y0) * t)}" r="18"/>`);
        next += total / 10;
      }
      acc += len;
    }
    out.push(`</g>`);
  }

  // Overlays.
  const m = opts.marbles;
  if (m !== undefined) {
    out.push(`<g data-layer="marbles">`);
    for (let i = 0; i < m.count; i++) {
      const dim = m.alive !== undefined && m.alive[i] === 0;
      out.push(
        `<circle cx="${n(m.x[i]! / FP)}" cy="${n(m.y[i]! / FP)}" r="${MARBLE_RADIUS_UNITS}" fill="${pick(pal.marbles, i)}"${dim ? ` fill-opacity="0.3"` : ""}/>`,
      );
    }
    out.push(`</g>`);
  }
  if (opts.spots !== undefined && opts.spots.length > 0) {
    out.push(`<g data-layer="spots" fill="none" stroke="${pal.alert}" stroke-width="10">`);
    for (const [x, y] of opts.spots) out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="70"/>`);
    out.push(`</g>`);
  }
  out.push(`</g>`);

  // Labels (unflipped, so text reads upright).
  if (labels) {
    const t = (x: number, y: number, s: string, size = 96, anchor = "start"): string =>
      `<text x="${n(x)}" y="${n(H - y)}" font-family="sans-serif" font-size="${size}" font-weight="700" fill="${pal.text}" text-anchor="${anchor}">${esc(s)}</text>`;
    out.push(`<g data-layer="labels">`);
    out.push(t(W / 2, H - 160, track.name, 160, "middle"));
    (opts.notes ?? []).forEach((line, i) =>
      out.push(t(W / 2, H - 300 - i * 110, line, 80, "middle")),
    );
    (zones.gates ?? []).forEach(([x1, y1], i) => out.push(t(x1 + 40, y1 + 30, `G${i + 1}`, 80)));
    if (zones.finish) out.push(t(zones.finish[0] + 40, zones.finish[1] + 40, "FINISH", 80));
    out.push(`</g>`);
  }
  out.push(`</svg>`);
  return out.join("\n");
}
