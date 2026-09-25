/**
 * Track authoring source for M9-00b. The three shipped tracks are designed here with a few
 * piece helpers (sawtooth pencil ramps and ruler rails, book staircases, paper-cup funnels,
 * dowel fields) and written out as the JSON the game loads (`src/logic/tracks/<id>.json`).
 * The JSON is the shipped artifact; this file is how it was made, and `tracks.test.ts` checks
 * that the two never drift apart.
 *
 * Design rule (from the fixed-point solver): gravity only speeds a marble up along slopes
 * steeper than about 27°; on shallower slopes a marble coasts, frictionless, at the speed it
 * arrived with, and one that stops stays put until the R6 kick. So every place marbles land is
 * a 32° **kicker**, and the long 7° **coasting** runs only carry marbles that are already
 * rolling; kicker teeth every 450 units restart any marble that stops on one. The twin
 * collector splits the field into two streams, and every drop gap is at least 450 wide (narrower
 * gaps let the falling stream arch and jam).
 *
 * Usage (from the package directory):
 *   node --import tsx test/author-tracks.ts          write the JSON files
 *   node --import tsx test/author-tracks.ts --check  exit 1 if a JSON file is out of date
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArcDef, BoostDef, LineDef, PegDef, SegmentDef } from "../src/logic/physics/index.ts";
import type {
  DecorDef,
  PieceDef,
  PieceKind,
  PointDef,
  TrackDef,
  TrackId,
} from "../src/logic/tracks/types.ts";

type Part = readonly [run: number, grade: number];

/** Frame: the pegboard's wooden frame; inner faces at x = 32 and x = 4064. */
const LEFT = 32;
const RIGHT = 4064;
/** Start gate height and tray top shared by every track (room for 1,000 marbles). */
const GATE_Y = 6200;
const TRAY_TOP = 8120;
/** Kicker gradient: drop = run / 1.6 (32°). */
const KICK = 1.6;
/** Coasting gradient: drop = run / 10 (5.7°). */
const COAST = 10;
/** Roll-off lip at the end of every coasting run: a short 45° drop so no marble parks on the end. */
const LIP: Part = [120, 1];
/** Height of a rolling marble's centre above a ramp's centre line (radius + half stick + air). */
const RIDE = 64;

/** Collects colliders, pieces and the centreline for one track. */
class Builder {
  segments: SegmentDef[] = [];
  funnel: SegmentDef[] = [];
  arcs: ArcDef[] = [];
  pegs: PegDef[] = [];
  pieces: PieceDef[] = [];
  gates: LineDef[] = [];
  boost: BoostDef[] = [];
  line: PointDef[] = [];
  decor: DecorDef[] = [];
  private variant = 0;

  constructor() {
    this.seg([LEFT - 8, 40, LEFT - 8, 8176, 16], "frame", 0);
    this.seg([RIGHT + 8, 40, RIGHT + 8, 8176, 16], "frame", 0);
    this.seg([LEFT - 8, 40, RIGHT + 8, 40, 16], "frame", 0);
  }

  seg(s: readonly number[], kind: PieceKind, variant = this.variant++): void {
    this.pieces.push({ kind, src: "segments", index: this.segments.length, variant });
    this.segments.push(s.map(Math.round) as unknown as SegmentDef);
  }

  wall(s: readonly number[], kind: PieceKind, variant = this.variant++): void {
    this.pieces.push({ kind, src: "funnel", index: this.funnel.length, variant });
    this.funnel.push(s.map(Math.round) as unknown as SegmentDef);
  }

  peg(x: number, y: number, r: number): void {
    this.pieces.push({ kind: "dowel", src: "pegs", index: this.pegs.length, variant: 0 });
    this.pegs.push([Math.round(x), Math.round(y), r]);
  }

  /** Adds centreline points (the marble-centre path). */
  path(...pts: (readonly [number, number])[]): void {
    for (const [x, y] of pts) {
      const p: PointDef = [Math.round(x), Math.round(y)];
      const last = this.line[this.line.length - 1];
      if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) this.line.push(p);
    }
  }

  /**
   * A ramp of straight parts from `(x0, y0)` heading `dir` (+1 right, −1 left): each part is
   * `[run, grade]` (drop = run / grade), drawn as sticks of at most `stick` run. Adds the marble
   * path along its top. Returns the end point.
   */
  profile(
    x0: number,
    y0: number,
    dir: 1 | -1,
    parts: readonly Part[],
    kind: PieceKind,
    thick: number,
    stick = 1700,
  ): [number, number] {
    let x = x0;
    let y = y0;
    for (const [run, grade] of parts) {
      const n = Math.max(1, Math.ceil(run / stick));
      for (let k = 0; k < n; k++) {
        const x1 = x + (dir * run) / n;
        const y1 = y - run / n / grade;
        this.seg([x, y, x1, y1, thick], kind);
        x = x1;
        y = y1;
      }
      this.path([x, y + RIDE]);
    }
    return [Math.round(x), Math.round(y)];
  }

  /** The height of a profile's top at `x` (for placing the path's first point on it). */
  static heightAt(x0: number, y0: number, parts: readonly Part[], x: number): number {
    let px = x0;
    let py = y0;
    for (const [run, grade] of parts) {
      const d = Math.abs(x - px);
      if (d <= run) return py - d / grade;
      px += Math.sign(x - x0) * run;
      py -= run / grade;
    }
    return py;
  }

  /**
   * A book staircase heading `dir` from `(x0, y0)`: `count` books, each a coasting tread `len`
   * long, the next starting `lap` back under the previous tread's end and `step` lower (marbles
   * arrive rolling and hop down the steps). Returns the last tread's end.
   */
  books(
    x0: number,
    y0: number,
    dir: 1 | -1,
    count: number,
    len: number,
    step: number,
    lap: number,
  ): [number, number] {
    let x = x0;
    let y = y0;
    const BEVEL = 50;
    for (let k = 0; k < count; k++) {
      const x1 = x + dir * len;
      const y1 = y - len / COAST;
      this.seg([x, y, x1, y1, 40], "book");
      // The book's bevelled front edge: a steep wedge so a slow marble tips off the tread.
      this.seg([x1, y1, x1 + dir * BEVEL, y1 - BEVEL, 24], "deflector");
      this.path([x + dir * lap, y - lap / COAST + RIDE + 8], [x1, y1 + RIDE + 8]);
      if (k < count - 1) {
        x = x1 + dir * (BEVEL - lap);
        y = y1 - BEVEL - step;
      } else {
        x = x1 + dir * BEVEL;
        y = y1 - BEVEL;
      }
    }
    return [Math.round(x), Math.round(y)];
  }

  /** A full-width checkpoint line at height `y`, authored left to right (crossed going down). */
  gate(y: number): void {
    this.gates.push([LEFT, Math.round(y), RIGHT, Math.round(y)]);
  }

  build(
    id: TrackId,
    name: string,
    blurb: string,
    finishY: number,
    train: [number, number, number, number],
    periodSec: number,
    flag: [number, number],
  ): TrackDef {
    return {
      id,
      name,
      blurb,
      start: { gate: [LEFT + 8, GATE_Y, RIGHT - 8, GATE_Y], top: TRAY_TOP },
      segments: this.segments,
      pegs: this.pegs,
      arcs: this.arcs,
      zones: {
        boost: this.boost,
        funnel: this.funnel,
        gates: this.gates,
        finish: [LEFT, finishY, RIGHT, finishY],
      },
      centerline: this.line,
      visuals: {
        pieces: this.pieces,
        train: { rail: train, periodSec },
        flag: [Math.round(flag[0]), Math.round(flag[1])],
        trapdoors: [0, 1],
        decor: this.decor,
      },
    };
  }
}

/** A staggered dowel field clipped to the region above `floor(x) + 170`. */
function dowels(
  b: Builder,
  yTop: number,
  rows: number,
  dy: number,
  dx: number,
  r: number,
  floor: (x: number) => number,
): void {
  for (let row = 0; row < rows; row++) {
    const y = yTop - row * dy;
    for (let x = LEFT + dx / 2 + (row % 2) * (dx / 2); x < RIGHT - 60; x += dx)
      if (y > floor(x) + 170) b.peg(x, y, r);
  }
}

/** Collector walls at 32°: outer walls from the frame, inner walls from the centre ridge. */
const W_GRADE = 1.6;
/** The collector's two outlets (world x ranges). */
const OUT_A = [700, 1348] as const;
const OUT_B = [2748, 3396] as const;

/**
 * The twin collector under the tray: a W of four walls at 35° over outlets {@link OUT_A} and
 * {@link OUT_B}, so the whole field splits into two streams. Returns the lowest wall end's y and
 * the height of the walls at any x (for clipping dowels).
 */
function twinCollector(
  b: Builder,
  kind: PieceKind,
  thick: number,
  asFunnel: boolean,
  grade = W_GRADE,
): { bottom: number; wallY: (x: number) => number } {
  const top = 6150;
  const walls: [number, number][] = [
    [LEFT, OUT_A[0]],
    [2048, OUT_A[1]],
    [2048, OUT_B[0]],
    [RIGHT, OUT_B[1]],
  ];
  let bottom = top;
  for (const [x0, x1] of walls) {
    const y1 = top - Math.abs(x1 - x0) / grade;
    bottom = Math.min(bottom, y1);
    if (asFunnel) b.wall([x0, top, x1, y1, thick], kind);
    else b.seg([x0, top, x1, y1, thick], kind);
  }
  const wallY = (x: number): number => {
    if (x <= OUT_A[0]) return top - (x - LEFT) / grade;
    if (x >= OUT_A[1] && x <= 2048) return top - (2048 - x) / grade;
    if (x >= 2048 && x <= OUT_B[0]) return top - (x - 2048) / grade;
    if (x >= OUT_B[1]) return top - (RIGHT - x) / grade;
    return -1e9; // over an outlet
  };
  b.path([1024, GATE_Y], [1024, Math.round(bottom) - 40]);
  return { bottom: Math.round(bottom), wallY };
}

/**
 * The first level under the twin collector, heading right: a long kicker under each outlet
 * with coasting runs and a short kicker tooth between them, ending in the lip at x = 3600 (a
 * 464-unit drop gap to the frame: narrower gaps let the falling stream arch and jam).
 */
const LEVEL1: readonly Part[] = [
  [700, KICK],
  [300, COAST],
  [200, KICK],
  [300, COAST],
  [200, KICK],
  [350, COAST],
  [700, KICK],
  [80, COAST],
  LIP,
];
const LEVEL1_X0 = 650;

/**
 * Sawtooth parts that fill `run`: a landing kicker `firstKick` long, then coasting runs of at
 * most `coast` separated by 200-unit kicker teeth (so a marble that stops on a coast is never
 * more than `coast` units from a slope that restarts it), ending in the lip.
 */
function saw(run: number, firstKick: number, coast = 450): Part[] {
  const parts: Part[] = [];
  let left = run - LIP[0];
  if (firstKick > 0) {
    parts.push([firstKick, KICK]);
    left -= firstKick;
  }
  while (left > 0) {
    const c = Math.min(coast, left);
    parts.push([c, COAST]);
    left -= c;
    if (left <= 0) break;
    const k = Math.min(200, left);
    parts.push([k, KICK]);
    left -= k;
  }
  parts.push(LIP);
  return parts;
}

/**
 * Pencil Drop: dowels over a W of pencils split the tray into two streams, then long sawtooth
 * pencil ramps zig-zag down the board.
 */
function pencilDrop(): TrackDef {
  const b = new Builder();
  const P = 28; // pencil thickness
  const w = twinCollector(b, "pencil", P, false);
  dowels(b, 6060, 2, 150, 320, 22, w.wallY);
  let y = w.bottom - 150;
  b.path([1024, Builder.heightAt(LEVEL1_X0, y, LEVEL1, 1024) + RIDE]);
  let [x1, y1] = b.profile(LEVEL1_X0, y, 1, LEVEL1, "pencil", P);
  const levels: ("left" | "right")[] = ["right", "left", "right"];
  levels.forEach((from, k) => {
    const prevDir = from === "left" ? -1 : 1;
    const dropX = x1 + prevDir * 200;
    b.path([dropX, y1 - 20]);
    b.gate(y1 - 70);
    y = y1 - 150;
    const x0 = from === "left" ? LEFT : RIGHT;
    const parts = saw(3582, 550);
    b.path([dropX, Builder.heightAt(x0, y, parts, dropX) + RIDE]);
    if (k === 1) b.boost.push([2400, Math.round(y - 100), 2400, Math.round(y - 600), 0, -1]);
    [x1, y1] = b.profile(x0, y, from === "left" ? 1 : -1, parts, "pencil", P, 700);
  });
  const finishY = 160;
  b.path([x1 - 200, y1 - 20], [x1 - 220, 100]);
  b.decor.push({ kind: "eraser", x: 3000, y: 7400, rot: -12 });
  b.decor.push({ kind: "sharpener", x: 900, y: 7600, rot: 8 });
  return b.build(
    "pencil-drop",
    "Pencil Drop",
    "Through the dowels, split by the pencil W, then down the long pencil ramps.",
    finishY,
    [1400, 110, RIGHT - 40, 110],
    14,
    [x1 - 220, finishY],
  );
}

/**
 * Cup Cascade: twin collecting cups, then sawtooth ruler ramps that pour into paper cups on
 * alternating sides of the board.
 */
function cupCascade(): TrackDef {
  const b = new Builder();
  const R = 24; // ruler thickness
  const w = twinCollector(b, "cup", 24, true, 1.2);
  dowels(b, 6060, 3, 130, 260, 20, w.wallY);
  let y = w.bottom - 150;
  b.path([1024, Builder.heightAt(LEVEL1_X0, y, LEVEL1, 1024) + RIDE]);
  let [x1, y1] = b.profile(LEVEL1_X0, y, 1, LEVEL1, "ruler", R);
  /** A paper cup against the `side` wall: one slanted wall; the frame is the other side. */
  const sideCup = (side: "left" | "right", rimY: number): number => {
    const xr = side === "right" ? 2950 : 4096 - 2950;
    const xo = side === "right" ? 3350 : 4096 - 3350;
    const bottom = rimY - 400 / 1.2;
    b.wall([xr, rimY, xo, bottom, 24], "cup");
    const mid = side === "right" ? 3720 : 4096 - 3720;
    b.path([mid, rimY - 40], [mid, bottom - 60]);
    return bottom;
  };
  let outlet = sideCup("right", y1 - 80);
  const levels: ("left" | "right")[] = ["right", "left"];
  levels.forEach((from, k) => {
    b.gate(outlet - 40);
    y = outlet - 170;
    const x0 = from === "left" ? LEFT : RIGHT;
    const parts = saw(3618, 750);
    const mid = from === "right" ? 3720 : 4096 - 3720;
    b.path([mid, Builder.heightAt(x0, y, parts, mid) + RIDE]);
    [x1, y1] = b.profile(x0, y, from === "left" ? 1 : -1, parts, "ruler", R, 800);
    if (k === 0) outlet = sideCup("left", y1 - 80);
  });
  // Gate 3 across the last ramp, halfway down it.
  b.gate(Math.round((y + y1) / 2) + RIDE);
  const finishY = 220;
  b.path([x1 + 200, y1 - 20], [x1 + 220, 100]);
  b.decor.push({ kind: "sticky-note", x: 2900, y: 7500, rot: 6 });
  b.decor.push({ kind: "crayon", x: 1100, y: 7300, rot: -20 });
  return b.build(
    "cup-cascade",
    "Cup Cascade",
    "Twin cups pour down sawtooth rulers into paper cups, left and right.",
    finishY,
    [LEFT + 40, 110, 2600, 110],
    12,
    [x1 + 220, finishY],
  );
}

/**
 * Book-Stack Switchback: book ridges split the tray into two streams; then sawtooth rulers
 * switch back and forth across the board down to the book staircase before the finish.
 */
function bookStackSwitchback(): TrackDef {
  const b = new Builder();
  const R = 24;
  const w = twinCollector(b, "book", 40, false, 1.2);
  let y = w.bottom - 150;
  b.path([1024, Builder.heightAt(LEVEL1_X0, y, LEVEL1, 1024) + RIDE]);
  let [x1, y1] = b.profile(LEVEL1_X0, y, 1, LEVEL1, "ruler", R);
  /** Turn at the end of a level: gate, and the landing kicker's first path point. */
  const turn = (from: "left" | "right"): void => {
    const dropX = from === "right" ? x1 + 200 : x1 - 200;
    b.path([dropX, y1 - 20]);
    b.gate(y1 - 70);
    y = y1 - 150;
    const x0 = from === "right" ? RIGHT : LEFT;
    b.path([dropX, Builder.heightAt(x0, y, [[650, KICK]], dropX) + RIDE]);
  };
  // L2 ← left: a sawtooth ruler.
  turn("right");
  [x1, y1] = b.profile(RIGHT, y, -1, saw(3568, 650), "ruler", R, 700);
  // L3 → right: a sawtooth ruler.
  turn("left");
  [x1, y1] = b.profile(LEFT, y, 1, saw(3568, 650), "ruler", R, 700);
  // L4 ← left: a landing kicker and the last staircase, then the drop to the finish.
  turn("right");
  [x1, y1] = b.profile(RIGHT, y, -1, [[650, KICK]], "ruler", R);
  [x1, y1] = b.books(x1, y1, -1, 4, 560, 50, 40);
  const finishY = 140;
  b.path([x1 - 200, y1 - 20], [x1 - 220, 100]);
  b.decor.push({ kind: "paperclip", x: 2600, y: 7500, rot: 30 });
  b.decor.push({ kind: "eraser", x: 1200, y: 7250, rot: -8 });
  return b.build(
    "book-stack-switchback",
    "Book-Stack Switchback",
    "Split by the book ridges, switch back down the rulers, then hop down the book stairs.",
    finishY,
    [1200, 110, RIGHT - 40, 110],
    16,
    [x1 - 220, finishY],
  );
}

/** Every track, as authored. */
export function authorTracks(): TrackDef[] {
  return [pencilDrop(), cupCascade(), bookStackSwitchback()];
}

/** Where the JSON for a track id lives. */
export function trackJsonPath(id: TrackId): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../src/logic/tracks", `${id}.json`);
}

const row = (v: readonly number[]): string => `[${v.join(", ")}]`;
const list = (items: readonly (readonly number[])[], indent: string): string =>
  items.length === 0
    ? "[]"
    : `[\n${items.map((v) => `${indent}  ${row(v)}`).join(",\n")}\n${indent}]`;
const obj = (o: object): string =>
  `{ ${Object.entries(o)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")} }`;
const objs = (items: readonly object[], indent: string): string =>
  items.length === 0
    ? "[]"
    : `[\n${items.map((o) => `${indent}  ${obj(o)}`).join(",\n")}\n${indent}]`;

/** The JSON text of a track: one collider, point or piece per line (readable diffs). */
function rawTrackJson(t: TrackDef): string {
  const z = t.zones ?? {};
  return `{
  "id": ${JSON.stringify(t.id)},
  "name": ${JSON.stringify(t.name)},
  "blurb": ${JSON.stringify(t.blurb)},
  "start": { "gate": ${row(t.start.gate)}, "top": ${t.start.top} },
  "segments": ${list(t.segments, "  ")},
  "pegs": ${list(t.pegs ?? [], "  ")},
  "arcs": ${list(t.arcs ?? [], "  ")},
  "zones": {
    "boost": ${list(z.boost ?? [], "    ")},
    "funnel": ${list(z.funnel ?? [], "    ")},
    "gates": ${list(z.gates ?? [], "    ")},
    "finish": ${row(z.finish ?? [])}
  },
  "centerline": ${list(t.centerline, "  ")},
  "visuals": {
    "pieces": ${objs(t.visuals.pieces, "    ")},
    "train": { "rail": ${row(t.visuals.train.rail)}, "periodSec": ${t.visuals.train.periodSec} },
    "flag": ${row(t.visuals.flag)},
    "trapdoors": ${row(t.visuals.trapdoors)},
    "decor": ${objs(t.visuals.decor, "    ")}
  }
}
`;
}

/**
 * The shipped JSON text of a track: {@link rawTrackJson} passed through the repo's prettier
 * config, so the files pass `pnpm format:check` exactly as written.
 */
export async function trackJson(t: TrackDef): Promise<string> {
  const prettier = await import("prettier");
  const path = trackJsonPath(t.id);
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(rawTrackJson(t), { ...config, parser: "json", filepath: path });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const t of authorTracks()) {
    const path = trackJsonPath(t.id);
    const text = await trackJson(t);
    if (check) {
      let cur = "";
      try {
        cur = readFileSync(path, "utf8");
      } catch {
        // a missing file counts as stale
      }
      if (cur !== text) {
        console.error(`stale: ${t.id}.json (run node --import tsx test/author-tracks.ts)`);
        stale++;
      }
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${t.id}.json`);
    }
  }
  process.exitCode = stale > 0 ? 1 : 0;
}
