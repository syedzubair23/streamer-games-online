/**
 * M9-00b track tests (ROADMAP M9-00b, docs/specs/marble-rally.md "Content"): the three shipped
 * tracks, their validation, the start tray, the progress metric (R4), the authoring source, the
 * preview renderer and a real-race smoke test per track.
 *
 * The full Accept check (200 simulated races per track plus 200 stuck-spot probes) runs in a
 * plain Node process: `node --import tsx test/track-lab.ts check` (see test/track-lab.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileTrack,
  createBodies,
  addMarble,
  createSolver,
  FP,
  MARBLE_R,
  MAX_MARBLES,
  step,
  TrackError,
  WORLD_H_UNITS,
  WORLD_W_UNITS,
} from "../src/logic/physics/index.ts";
import {
  compileCourse,
  DNF_TICKS,
  getCourse,
  isTrackId,
  KICK_MIN,
  KICK_SPREAD,
  NUDGE_TICKS,
  NUDGE_X,
  NUDGE_Y,
  parseTrackDef,
  PROGRESS_MAX,
  PROGRESS_WINDOW,
  STUCK_MIN_RISE,
  STUCK_TICKS,
  TRACK_IDS,
  TRACKS,
  trackProgress,
  traySlots,
  type TrackDef,
} from "../src/logic/tracks/index.ts";
import { renderTrackPreview, type PreviewPalette } from "../src/preview/track-preview.ts";
import { authorTracks, trackJson, trackJsonPath } from "./author-tracks.ts";
import { DEV_PALETTE } from "./dev-palette.ts";
import { runRace, runSolo } from "./race-sim.ts";
import { fieldSize, probePoints, summarize, TRACK_BAR } from "./track-lab.ts";

const clone = (t: TrackDef): TrackDef => JSON.parse(JSON.stringify(t)) as TrackDef;
const mutable = (t: TrackDef): Record<string, unknown> => t as unknown as Record<string, unknown>;

describe("shipped tracks", () => {
  it("are exactly pencil-drop, cup-cascade and book-stack-switchback (spec host option `tracks`)", () => {
    expect([...TRACK_IDS]).toEqual(["pencil-drop", "cup-cascade", "book-stack-switchback"]);
    expect(Object.keys(TRACKS).sort()).toEqual([...TRACK_IDS].sort());
    for (const id of TRACK_IDS) {
      expect(TRACKS[id].id).toBe(id);
      expect(TRACKS[id].name.length).toBeGreaterThan(3);
      expect(TRACKS[id].blurb.length).toBeGreaterThan(10);
    }
    expect(isTrackId("cup-cascade")).toBe(true);
    expect(isTrackId("rotate")).toBe(false);
    expect(isTrackId(3)).toBe(false);
  });

  it("are JSON segment lists that match their authoring source byte for byte", async () => {
    const authored = authorTracks();
    expect(authored.map((t) => t.id)).toEqual([...TRACK_IDS]);
    for (const t of authored) {
      expect(readFileSync(trackJsonPath(t.id), "utf8")).toBe(await trackJson(t));
      expect(TRACKS[t.id]).toEqual(t);
    }
  });

  it.each(TRACK_IDS)(
    "%s compiles: 3 gates in order, a finish near the bottom, integer geometry inside the world",
    (id) => {
      const c = getCourse(id);
      expect(getCourse(id)).toBe(c); // cached
      const t = TRACKS[id];
      expect(t.zones?.gates).toHaveLength(3);
      expect(c.gateProgress).toHaveLength(3);
      expect(c.gateProgress[0]!).toBeGreaterThan(0);
      expect(c.gateProgress[1]!).toBeGreaterThan(c.gateProgress[0]!);
      expect(c.gateProgress[2]!).toBeGreaterThan(c.gateProgress[1]!);
      expect(c.finishProgress).toBeGreaterThan(c.gateProgress[2]!);
      expect(c.finishProgress).toBeLessThanOrEqual(PROGRESS_MAX);
      const finish = t.zones!.finish!;
      expect(finish[1]).toBeLessThanOrEqual(300); // spec: finish line near the bottom (y ≈ 200)
      expect(t.start.gate[1]).toBeGreaterThanOrEqual(6000); // the start gate at the top
      const nums = [
        ...t.segments.flat(),
        ...(t.pegs ?? []).flat(),
        ...(t.zones?.funnel ?? []).flat(),
        ...(t.zones?.gates ?? []).flat(),
        ...(t.zones?.boost ?? []).flat(),
        ...finish,
        ...t.centerline.flat(),
      ];
      expect(nums.every(Number.isInteger)).toBe(true);
      for (const s of [...t.segments, ...(t.zones?.funnel ?? [])])
        for (const [x, y] of [
          [s[0], s[1]],
          [s[2], s[3]],
        ] as const) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(WORLD_W_UNITS);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(WORLD_H_UNITS);
        }
      // Every solid except the frame's floor sits above the finish line, so every marble
      // crosses it before it can come to rest.
      for (const s of [...t.segments.slice(3), ...(t.zones?.funnel ?? [])])
        expect(Math.min(s[1], s[3])).toBeGreaterThan(finish[1]);
    },
  );

  it.each(TRACK_IDS)(
    "%s follows the design rules: kickers are 30° or steeper, coasting runs 600 or shorter, drop gaps 450 or wider",
    (id) => {
      const t = TRACKS[id];
      const pieceOf = new Map(t.visuals.pieces.map((p) => [`${p.src}[${p.index}]`, p.kind]));
      t.segments.forEach((s, i) => {
        if (pieceOf.get(`segments[${i}]`) === "frame") return;
        const run = Math.abs(s[2] - s[0]);
        const drop = Math.abs(s[3] - s[1]);
        const deg = (Math.atan2(drop, run) * 180) / Math.PI;
        // Either steep enough for gravity to restart a marble, or a coasting run short enough
        // that a stopped marble is never far from the next kicker.
        if (deg < 30) expect(run, `${id} segments[${i}] coasts ${run}`).toBeLessThanOrEqual(600);
      });
      // Level ends (lips) leave at least 450 units to the frame.
      const ends = t.segments
        .map((s, i) => ({ s, kind: pieceOf.get(`segments[${i}]`) }))
        .filter(
          ({ s, kind }) => kind !== "frame" && Math.abs(s[2] - s[0]) === Math.abs(s[3] - s[1]),
        );
      for (const { s } of ends) {
        const x = s[2];
        expect(Math.min(x - 32, 4064 - x)).toBeGreaterThanOrEqual(400);
      }
    },
  );
});

describe("start tray (R2)", () => {
  it.each(TRACK_IDS)(
    "%s: 1,000 hexagonal slots between the frame walls, touching nothing",
    (id) => {
      const c = getCourse(id);
      expect(c.trayCapacity).toBeGreaterThanOrEqual(MAX_MARBLES);
      // Neighbours never overlap.
      const n = MAX_MARBLES;
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < Math.min(n, i + 50); j++) {
          const dx = c.slots[2 * i]! - c.slots[2 * j]!;
          const dy = c.slots[2 * i + 1]! - c.slots[2 * j + 1]!;
          expect(dx * dx + dy * dy).toBeGreaterThan(4 * MARBLE_R * MARBLE_R);
        }
      // No slot touches the track: one zero-gravity step moves nothing.
      const solver = createSolver(c.physics, n);
      const b = createBodies(n);
      for (let i = 0; i < n; i++) addMarble(b, c.slots[2 * i]!, c.slots[2 * i + 1]!);
      step(solver, b, { gravity: 0 });
      for (let i = 0; i < n; i++) {
        expect(b.x[i]).toBe(c.slots[2 * i]);
        expect(b.y[i]).toBe(c.slots[2 * i + 1]);
      }
      // The bottom row rests on the start gate, filled left to right.
      const gateY = TRACKS[id].start.gate[1] * FP;
      expect(c.slots[1]! - gateY).toBeLessThan(MARBLE_R + 4 * FP);
      expect(c.slots[2]!).toBeGreaterThan(c.slots[0]!);
    },
  );

  it("stops at the tray top", () => {
    const t = clone(TRACKS["pencil-drop"]);
    t.start = { gate: t.start.gate, top: t.start.gate[1] + 100 };
    const slots = traySlots(t);
    expect(slots.length / 2).toBeGreaterThan(0);
    for (let i = 1; i < slots.length; i += 2)
      expect(slots[i]!).toBeLessThanOrEqual((t.start.gate[1] + 100) * FP);
  });
});

describe("compileCourse validation", () => {
  const base = (): TrackDef => clone(TRACKS["cup-cascade"]);
  const bad = (edit: (t: TrackDef) => void, msg: RegExp): void => {
    const t = base();
    edit(t);
    expect(() => compileCourse(t)).toThrow(TrackError);
    expect(() => compileCourse(t)).toThrow(msg);
  };

  it("accepts the shipped tracks", () => {
    for (const id of TRACK_IDS) expect(() => compileCourse(TRACKS[id])).not.toThrow();
  });
  it("rejects unknown ids and empty names", () => {
    bad((t) => (mutable(t).id = "moon-base"), /unknown track id/);
    bad((t) => (t.name = "  "), /empty name/);
  });
  it("needs exactly 3 gates (R4) and a finish", () => {
    bad((t) => (t.zones!.gates = t.zones!.gates!.slice(0, 2)), /needs 3 gates/);
    bad((t) => delete t.zones!.finish, /no finish line/);
  });
  it("checks the start tray", () => {
    bad((t) => (t.start = { gate: [40, 6200, 4056, 6210], top: 8120 }), /left to right/);
    bad((t) => (t.start = { gate: [40, 6200, 4056, 6200], top: 9000 }), /outside the world/);
    bad((t) => (t.start = { gate: [40, 6200, 4056, 6200], top: 7000 }), /tray holds/);
    bad((t) => (t.start = { gate: [40, 6200.5, 4056, 6200.5], top: 8120 }), /not an integer/);
  });
  it("checks the centreline", () => {
    bad((t) => (t.centerline = [t.centerline[0]!]), /2 or more points/);
    bad(
      (t) => (t.centerline = [[1000, 6100], ...t.centerline.slice(1)]),
      /start on the start gate/,
    );
    bad(
      (t) => (t.centerline = [...t.centerline.slice(0, 2), [9000, 10], ...t.centerline.slice(2)]),
      /outside the world/,
    );
    bad(
      (t) => (t.centerline = [t.centerline[0]!, t.centerline[0]!, ...t.centerline.slice(1)]),
      /repeats a point/,
    );
    bad((t) => (t.centerline = [[1.5, 6200], ...t.centerline.slice(1)]), /not an integer/);
    // Swapped gates: gate 0 is then crossed after gate 1.
    bad((t) => {
      const g = t.zones!.gates!;
      t.zones!.gates = [g[1]!, g[0]!, g[2]!];
    }, /out of order/);
    // A gate authored right to left is crossed backward.
    bad((t) => {
      const [x1, y1, x2, y2] = t.zones!.gates![0]!;
      t.zones!.gates = [[x2, y2, x1, y1], ...t.zones!.gates!.slice(1)];
    }, /cross gate 0 once, forward/);
    // The finish moved above gate 3.
    bad((t) => {
      const y = t.zones!.gates![0]![1] + 20;
      t.zones!.finish = [32, y, 4064, y];
    }, /finish once, after the gates/);
  });
  it("checks that every collider is drawn exactly once", () => {
    bad((t) => (t.visuals.pieces = t.visuals.pieces.slice(1)), /is not drawn/);
    bad((t) => (t.visuals.pieces = [...t.visuals.pieces, t.visuals.pieces[0]!]), /drawn twice/);
    bad(
      (t) =>
        (t.visuals.pieces = [
          ...t.visuals.pieces,
          { kind: "cup", src: "arcs", index: 0, variant: 0 },
        ]),
      /has no collider/,
    );
    bad(
      (t) =>
        (t.visuals.pieces = [
          { ...t.visuals.pieces[0]!, variant: -1 },
          ...t.visuals.pieces.slice(1),
        ]),
      /bad variant/,
    );
    bad((t) => (t.visuals.trapdoors = [3]), /trapdoor 3 is not a gate/);
    bad((t) => (t.visuals.flag = [10.5, 3]), /not an integer/);
    bad(
      (t) => (t.visuals.train = { rail: t.visuals.train.rail, periodSec: 0 }),
      /bad train period/,
    );
  });
  it("passes solver geometry errors through (compileTrack)", () => {
    bad((t) => (t.segments = [[10, 10, 10, 10, 8], ...t.segments.slice(1)]), /zero-length segment/);
  });
});

describe("parseTrackDef (shape check at load)", () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(TRACKS["book-stack-switchback"])) as Record<string, unknown>;
  const zonesOf = (j: Record<string, unknown>): Record<string, unknown> =>
    j.zones as Record<string, unknown>;
  const visualsOf = (j: Record<string, unknown>): Record<string, unknown> =>
    j.visuals as Record<string, unknown>;
  const cases: [string, (j: Record<string, unknown>) => void, RegExp][] = [
    ["not an object", (j) => Object.keys(j).forEach((k) => delete j[k]), /unknown track id/],
    ["unknown id", (j) => (j.id = "x"), /unknown track id/],
    ["name type", (j) => (j.name = 3), /name and blurb/],
    ["start type", (j) => (j.start = 1), /start must be an object/],
    ["start.gate", (j) => ((j.start as Record<string, unknown>).gate = [1, 2, 3]), /start\.gate/],
    ["start.top", (j) => ((j.start as Record<string, unknown>).top = "8120"), /start\.top/],
    ["segments tuple", (j) => (j.segments = [[1, 2, 3, 4]]), /segments\[0\] must be 5 numbers/],
    ["segments array", (j) => (j.segments = {}), /segments must be an array/],
    ["pegs tuple", (j) => (j.pegs = [[1, 2]]), /pegs\[0\]/],
    ["arcs tuple", (j) => (j.arcs = [[1, 2, 3]]), /arcs\[0\]/],
    ["zones type", (j) => (j.zones = []), /zones must be an object/],
    ["boost tuple", (j) => (zonesOf(j).boost = [[1, 2, 3, 4]]), /zones\.boost\[0\]/],
    ["funnel tuple", (j) => (zonesOf(j).funnel = [[1]]), /zones\.funnel\[0\]/],
    ["gates tuple", (j) => (zonesOf(j).gates = [[1, 2, 3]]), /zones\.gates\[0\]/],
    ["finish tuple", (j) => (zonesOf(j).finish = [1, 2]), /zones\.finish/],
    ["centerline tuple", (j) => (j.centerline = [[1, 2, 3]]), /centerline\[0\]/],
    ["visuals type", (j) => (j.visuals = null), /visuals must be an object/],
    ["pieces type", (j) => (visualsOf(j).pieces = [1]), /pieces must be objects/],
    [
      "piece kind",
      (j) => (visualsOf(j).pieces = [{ kind: "laser", src: "segments", index: 0, variant: 0 }]),
      /bad piece/,
    ],
    ["train", (j) => (visualsOf(j).train = { rail: [1, 2, 3, 4] }), /periodSec/],
    ["train rail", (j) => (visualsOf(j).train = { rail: [1], periodSec: 3 }), /train\.rail/],
    ["flag", (j) => (visualsOf(j).flag = [1]), /visuals\.flag/],
    ["trapdoors", (j) => (visualsOf(j).trapdoors = ["a"]), /trapdoors/],
    [
      "decor",
      (j) => (visualsOf(j).decor = [{ kind: "ufo", x: 1, y: 1, rot: 0 }]),
      /bad visuals\.decor/,
    ],
  ];
  it.each(cases)("rejects a bad %s", (_name, edit, msg) => {
    const j = good();
    edit(j);
    expect(() => parseTrackDef(j)).toThrow(msg);
  });
  it("rejects non-objects and accepts the shipped JSON", () => {
    expect(() => parseTrackDef(null)).toThrow(/must be an object/);
    expect(() => parseTrackDef([1])).toThrow(/must be an object/);
    expect(parseTrackDef(good())).toEqual(TRACKS["book-stack-switchback"]);
  });
});

describe("trackProgress (R4)", () => {
  it.each(TRACK_IDS)("%s: 0 at the start gate, rising along the centreline to the finish", (id) => {
    const c = getCourse(id);
    const cl = TRACKS[id].centerline;
    expect(trackProgress(c, cl[0]![0] * FP, cl[0]![1] * FP, 0)).toBe(0);
    let prev = 0;
    for (let i = 0; i + 1 < cl.length; i++)
      for (let k = 0; k < 8; k++) {
        const x = Math.round((cl[i]![0] + ((cl[i + 1]![0] - cl[i]![0]) * k) / 8) * FP);
        const y = Math.round((cl[i]![1] + ((cl[i + 1]![1] - cl[i]![1]) * k) / 8) * FP);
        const p = trackProgress(c, x, y, prev);
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    const end = cl[cl.length - 1]!;
    expect(trackProgress(c, end[0] * FP, end[1] * FP, prev)).toBe(PROGRESS_MAX);
    expect(trackProgress(c, end[0] * FP, end[1] * FP)).toBe(PROGRESS_MAX);
  });

  it("with a previous value only searches its window, so a marble never snaps to a later level", () => {
    const c = getCourse("pencil-drop");
    // A point on the last level, seen from a marble whose progress is still 1000.
    const cl = TRACKS["pencil-drop"].centerline;
    const late = cl[cl.length - 3]!;
    const global = trackProgress(c, late[0] * FP, late[1] * FP);
    expect(global).toBeGreaterThan(8000);
    const windowed = trackProgress(c, late[0] * FP, late[1] * FP, 1000);
    const maxStep = Math.ceil((PROGRESS_WINDOW * PROGRESS_MAX) / c.length) + 1;
    expect(windowed - 1000).toBeLessThanOrEqual(maxStep);
    expect(windowed).toBeGreaterThanOrEqual(1000);
  });

  it("is an integer in [0, 10000] anywhere in the world, and deterministic", () => {
    const c = getCourse("cup-cascade");
    for (let k = 0; k < 200; k++) {
      const x = ((k * 7919) % WORLD_W_UNITS) * FP;
      const y = ((k * 104729) % WORLD_H_UNITS) * FP;
      const p = trackProgress(c, x, y);
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(PROGRESS_MAX);
      expect(trackProgress(c, x, y)).toBe(p);
      const q = trackProgress(c, x, y, p);
      expect(q).toBe(trackProgress(c, x, y, p));
    }
  });
});

describe("race tuning constants (R5, R6)", () => {
  it("match the spec where it fixes them", () => {
    expect(STUCK_TICKS).toBe(4 * 60); // 4 s
    expect(STUCK_MIN_RISE).toBe(16);
    expect(DNF_TICKS).toBe(12 * 60); // 12 s
    expect([NUDGE_X, NUDGE_Y, NUDGE_TICKS]).toEqual([24, 8, 6]); // (±24, +8) for 6 ticks
    expect(KICK_MIN).toBeGreaterThan(0);
    expect(KICK_MIN + KICK_SPREAD - 1).toBeLessThan(96); // under the speed cap
  });
});

describe("track check harness", () => {
  it("picks typical audience field sizes (200–500) deterministically", () => {
    const sizes = Array.from({ length: 200 }, (_, i) => fieldSize("check:x", i));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect(fieldSize("check:x", 7)).toBe(sizes[7]);
  });
  it("places probes along the path with the gates already passed", () => {
    const c = getCourse("book-stack-switchback");
    const pts = probePoints(c, TRACK_BAR.soloProbes);
    expect(pts).toHaveLength(200);
    expect(pts[0]!.cp).toBe(0);
    expect(pts[pts.length - 1]!.cp).toBe(3);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.cp).toBeGreaterThanOrEqual(pts[i - 1]!.cp);
  });
  it("summarizes races", () => {
    const s = summarize([
      {
        entrants: 10,
        finished: 8,
        dnf: 2,
        endTick: 4800,
        finishTick: [3000, -1],
        dnfAt: [],
        dnfTick: [],
        kicks: 3,
        gateSkips: 0,
        outOfWorld: 0,
        maxProgressDrop: 5,
      },
      {
        entrants: 10,
        finished: 10,
        dnf: 0,
        endTick: 3000,
        finishTick: [2400],
        dnfAt: [],
        dnfTick: [],
        kicks: 1,
        gateSkips: 0,
        outOfWorld: 0,
        maxProgressDrop: 9,
      },
    ]);
    expect(s.medianSec).toBe(80);
    expect(s.minFinishShare).toBe(0.8);
    expect(s.inRangeShare).toBe(0.5); // 50 s is below the 60 s bar
    expect(s.kicksPerRace).toBe(2);
    expect(s.maxProgressDrop).toBe(9);
  });
});

describe("real races (smoke; the 200-race check is test/track-lab.ts)", () => {
  it.each(TRACK_IDS)(
    "%s: 120 marbles race to the finish through all 3 gates",
    (id) => {
      const c = getCourse(id);
      const r = runRace(c, { entrants: 120, seed: `smoke:${id}`, nudges: true });
      expect(r.gateSkips).toBe(0);
      expect(r.outOfWorld).toBe(0);
      expect(r.finished / r.entrants).toBeGreaterThanOrEqual(TRACK_BAR.minFinishShare);
      expect(r.endTick).toBeLessThanOrEqual(120 * 60);
      expect(r.finished + r.dnf).toBe(120);
      expect(r.dnfAt).toHaveLength(r.dnf);
      // Deterministic: the same seed gives the same race.
      const again = runRace(c, { entrants: 120, seed: `smoke:${id}`, nudges: true });
      expect(again.finishTick).toEqual(r.finishTick);
    },
    120_000,
  );

  it("a marble resting mid-course is kicked free and finishes (no trap)", () => {
    const c = getCourse("pencil-drop");
    const p = probePoints(c, 10)[5]!;
    const r = runSolo(c, p.x, p.y, p.cp, "solo-test");
    expect(r.finished).toBe(true);
    // A marble sealed in a box can never progress: with the DNF timer on it is stopped after
    // 12 s; without it, it runs out the clock unfinished.
    const t = clone(TRACKS["pencil-drop"]);
    const box: [number, number, number, number, number][] = [
      [2900, 7500, 3100, 7500, 16],
      [2900, 7700, 3100, 7700, 16],
      [2900, 7500, 2900, 7700, 16],
      [3100, 7500, 3100, 7700, 16],
    ];
    t.visuals.pieces = [
      ...t.visuals.pieces,
      ...box.map((_, k) => ({
        kind: "frame" as const,
        src: "segments" as const,
        index: t.segments.length + k,
        variant: 0,
      })),
    ];
    t.segments = [...t.segments, ...box];
    const sealed = compileCourse(t);
    const trapped = runSolo(sealed, 3000, 7600, 0, "box", 20, true);
    expect(trapped.finished).toBe(false);
    expect(trapped.ticks).toBe(DNF_TICKS);
    expect(runSolo(sealed, 3000, 7600, 0, "box", 20)).toMatchObject({
      finished: false,
      ticks: 20 * 60,
    });
  }, 60_000);
});

describe("preview renderer", () => {
  const countOf = (svg: string, re: RegExp): number => (svg.match(re) ?? []).length;

  it.each(TRACK_IDS)(
    "%s: a standalone SVG with every collider, gate, the finish and the centreline",
    (id) => {
      const t = TRACKS[id];
      const svg = renderTrackPreview(t, { palette: DEV_PALETTE, traySlots: 500 });
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg).toContain(`data-track="${id}"`);
      expect(svg).toContain(`viewBox="0 0 ${WORLD_W_UNITS} ${WORLD_H_UNITS}"`);
      const solids =
        t.segments.length +
        (t.zones?.funnel?.length ?? 0) +
        (t.arcs?.length ?? 0) +
        (t.pegs?.length ?? 0);
      expect(countOf(svg, /data-piece="/g)).toBe(solids);
      expect(countOf(svg, /data-layer="gate"/g)).toBe(3);
      expect(countOf(svg, /data-layer="finish"/g)).toBe(1);
      expect(countOf(svg, /data-layer="centerline"/g)).toBe(1);
      expect(countOf(svg, /<circle cx="[^"]+" cy="[^"]+" r="44"\/>/g)).toBe(500); // tray slots
      expect(svg).toContain(t.name);
      // Balanced tags (well-formed enough for any SVG consumer).
      expect(countOf(svg, /<g[\s>]/g)).toBe(countOf(svg, /<\/g>/g));
    },
  );

  it("is deterministic and draws overlays: marbles, dimmed stopped marbles, spots and notes", () => {
    const t = TRACKS["cup-cascade"];
    const b = createBodies(3);
    addMarble(b, 1000 * FP, 5000 * FP);
    addMarble(b, 1100 * FP, 5000 * FP);
    addMarble(b, 1200 * FP, 5000 * FP);
    b.alive[2] = 0;
    const opts = {
      palette: DEV_PALETTE,
      marbles: b,
      spots: [[300, 400]] as const,
      notes: ["a < b & c"],
      width: 256,
    };
    const a = renderTrackPreview(t, opts);
    expect(renderTrackPreview(t, opts)).toBe(a);
    expect(a).toContain('width="256" height="512"');
    expect(countOf(a, /data-layer="marbles"/g)).toBe(1);
    expect(countOf(a, /fill-opacity="0.3"/g)).toBe(1);
    expect(a).toContain('data-layer="spots"');
    expect(a).toContain("a &lt; b &amp; c");
    const bare = renderTrackPreview(t, { palette: DEV_PALETTE, labels: false, centerline: false });
    expect(bare).not.toContain('data-layer="labels"');
    expect(bare).not.toContain('data-layer="centerline"');
  });

  it("takes every colour from the palette (no hard-coded colours)", () => {
    const tokens: string[] = [];
    const tok = (name: string): string => {
      const v = `var(--${name})`;
      tokens.push(v);
      return v;
    };
    const kinds = ["pencil", "ruler", "book", "cup", "deflector", "frame", "dowel"] as const;
    const palette: PreviewPalette = {
      background: tok("bg"),
      board: tok("board"),
      holes: tok("holes"),
      pieces: Object.fromEntries(
        kinds.map((k) => [k, [tok(`${k}-0`), tok(`${k}-1`)]]),
      ) as unknown as PreviewPalette["pieces"],
      gate: tok("gate"),
      trapdoor: tok("trapdoor"),
      finish: tok("finish"),
      boost: tok("boost"),
      centerline: tok("centerline"),
      tray: tok("tray"),
      train: tok("train"),
      decor: tok("decor"),
      marbles: [tok("m0"), tok("m1")],
      alert: tok("alert"),
      text: tok("text"),
    };
    const b = createBodies(2);
    addMarble(b, 900 * FP, 5000 * FP);
    addMarble(b, 1000 * FP, 5000 * FP);
    for (const id of TRACK_IDS) {
      const svg = renderTrackPreview(TRACKS[id], {
        palette,
        marbles: b,
        spots: [[1, 1]],
        traySlots: 3,
      });
      const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]!);
      for (const c of colours) expect(c === "none" || tokens.includes(c), `${id}: ${c}`).toBe(true);
      expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("draws arcs (partial and full rings) and boosts", () => {
    const t = clone(TRACKS["pencil-drop"]);
    t.arcs = [
      [1000, 3000, 200, 0, 1, 0, -1, 24],
      [2000, 3000, 150, 1, 0, 1, 0, 24],
      [3000, 3000, 150, 1, 1, -1, -1, 24],
    ];
    t.visuals.pieces = [
      ...t.visuals.pieces,
      { kind: "ruler", src: "arcs", index: 0, variant: 0 },
      { kind: "deflector", src: "arcs", index: 1, variant: 0 },
    ];
    expect(() => compileTrack(t)).not.toThrow();
    const svg = renderTrackPreview(t, { palette: DEV_PALETTE });
    expect(countOf(svg, /<path data-piece="ruler" d="M[^"]*A200 200 0 0 1 /g)).toBe(1);
    expect(countOf(svg, /<circle data-piece="deflector" cx="2000" cy="3000" r="150"/g)).toBe(1);
    expect(countOf(svg, /<path data-piece="frame" d="M[^"]*A150 150 0 0 1 /g)).toBe(1); // undrawn arc: frame colour
    expect(countOf(svg, /data-layer="boost"/g)).toBe(t.zones!.boost!.length);
  });
});
