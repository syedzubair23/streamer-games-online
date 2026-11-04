/**
 * Doodle scenarios (SPEC §14, `docs/specs/doodle.md` "Scenarios"): every visible Guess mode
 * state as a named, deterministic scenario for `/dev/scenario`. States are reached by **driving
 * the real module** on a {@link GameRunner} (setup, timers, actions, audience results), never by
 * hand-writing state, so every scenario is a state the game can actually be in.
 *
 * Audience tallies are platform data (SPEC §4), not game state; scenarios that show them pass
 * a `tally` fx (`{ pollId, kind, total, tallies? }`) for the Stage to replay.
 *
 * The Telephone scenarios (`tel-*`) arrive with Telephone mode (ROADMAP M5-01b).
 *
 * @module
 */
import type { DoodleWord, PlayerId } from "@sg/shared";
import {
  GameRunner,
  type ContentAccess,
  type PackInfo,
  type PollResult,
  type ScenarioRegistry,
  type Seat,
  type ViewerKey,
} from "@sg/engine";
import {
  CANVAS_H,
  CANVAS_W,
  MAX_BATCH_POINTS,
  createDoodle,
  type DoodleAction,
  type DoodleModule,
  type DoodleOptions,
  type DoodleRoomSettings,
  type DoodleState,
  type DoodleView,
} from "./logic/index.ts";

export { GAME_ID } from "./logic/index.ts";

/** Scenario clock origin (server ms). */
export const SCENARIO_NOW = 1_000_000;

/** Seat names used by the scenarios (display names are at most 16 characters). */
export const SCENARIO_NAMES: readonly string[] = Object.freeze([
  "Maple",
  "Juniper",
  "Clover",
  "Basil",
  "Hazel",
  "Rowan",
  "Willow",
  "Sorrel",
  "Fennel",
  "Aster",
  "Linden",
  "Poppy",
]);

/** `n` scenario seats; with `teams`, seats alternate between the given team ids. */
export function scenarioSeats(n: number, teams: readonly string[] = []): Seat[] {
  return Array.from({ length: n }, (_, i) => {
    const seat: Seat = {
      id: `p${i + 1}`,
      name: SCENARIO_NAMES[i] ?? `Player ${i + 1}`,
      seat: i,
      colorSlot: i % 8,
    };
    const team = teams.length > 0 ? teams[i % teams.length] : undefined;
    if (team !== undefined) seat.teamId = team;
    return seat;
  });
}

/**
 * A small in-memory `doodle-words` pack for scenarios and tests (the client has no packs). With
 * fewer words than a game needs, the pack's words come first in each tier, in pack order, and
 * the built-in fallback words follow, so the first turns offer exactly these words.
 */
export function scenarioContent(
  words: readonly DoodleWord[],
  used: readonly string[] = [],
): ContentAccess {
  const info: PackInfo = {
    id: "doodle-core",
    kind: "doodle-words",
    name: "Scenario words",
    rating: "all",
    count: words.length,
  };
  return {
    packs: (kind) => (kind === "doodle-words" ? [info] : []),
    items: ((kind: string, ids: readonly string[]) =>
      kind === "doodle-words" && ids.includes("doodle-core")
        ? [...words]
        : []) as ContentAccess["items"],
    isUsed: (kind, key) => kind === "doodle-words" && used.includes(key),
  };
}

/** Options for {@link DoodleDriver}. */
export interface DriverOptions {
  seed: number;
  /** A seat count (see {@link scenarioSeats}) or explicit seats. */
  players: number | readonly Seat[];
  options?: Partial<DoodleOptions>;
  /** Audience size the runner reports to the game. Default 800. */
  audience?: number;
  content?: ContentAccess;
  room?: Partial<DoodleRoomSettings>;
  timerScale?: 0 | 0.75 | 1 | 1.5 | 2;
  streamDelaySec?: number;
}

/** A stroke to draw: palette index, size index and flat points. */
export interface ShapeStroke {
  c: number;
  s: number;
  pts: number[];
}

/**
 * Drives a real Doodle game on a {@link GameRunner} with a virtual clock. Used by the scenarios
 * and by the tests. Every step throws if the game refuses it, so a scenario can never silently
 * build an unreachable state.
 */
export class DoodleDriver {
  readonly module: DoodleModule;
  readonly runner: GameRunner<DoodleState, DoodleAction, DoodleOptions, DoodleView>;
  now: number;
  #stroke = 0;

  constructor(opts: DriverOptions) {
    this.now = SCENARIO_NOW;
    this.module = createDoodle(opts.room ?? {});
    this.runner = new GameRunner(this.module, {
      players:
        typeof opts.players === "number"
          ? scenarioSeats(opts.players)
          : opts.players.map((p) => ({ ...p })),
      seed: opts.seed,
      now: this.now,
      ...(opts.options !== undefined ? { options: opts.options } : {}),
      timerScale: opts.timerScale ?? 1,
      streamDelaySec: opts.streamDelaySec ?? 3,
      ...(opts.content !== undefined ? { content: opts.content } : {}),
      audienceCount: opts.audience ?? 800,
      botDelayMs: 0,
    });
  }

  /** The current state. */
  get state(): DoodleState {
    return this.runner.state;
  }

  /** Advances the virtual clock by `ms`, firing due timers. */
  wait(ms: number): this {
    this.now += ms;
    this.runner.advance(this.now);
    return this;
  }

  /** Advances to the current phase's deadline (plus `extra` ms). */
  toDeadline(extra = 0): this {
    const d = this.state.deadline;
    if (d === null) throw new Error(`doodle driver: no deadline in ${this.state.phase}`);
    return this.wait(Math.max(0, d - this.now) + extra);
  }

  /** Advances to `share` (0..1) of the draw time. */
  toDrawShare(share: number): this {
    const s = this.state;
    if (s.phase !== "draw") throw new Error(`doodle driver: not drawing (${s.phase})`);
    return this.wait(Math.max(0, s.drawStart + Math.round(share * s.drawTotal) - this.now));
  }

  /** A seat action, `gapMs` after the previous event. Throws when refused. */
  act(id: PlayerId, action: DoodleAction, gapMs = 900): this {
    this.now += gapMs;
    const res = this.runner.act(id, action, this.now);
    if (!res.ok) {
      throw new Error(
        `doodle driver: ${id} ${JSON.stringify(action).slice(0, 80)} refused (${res.err ?? "?"}) in ${this.state.phase}`,
      );
    }
    return this;
  }

  /** Delivers an audience result. */
  audience(result: Omit<PollResult, "pollId"> & { pollId: string | null }): this {
    if (result.pollId === null) throw new Error("doodle driver: no such poll open");
    this.runner.audienceResult({ ...result, pollId: result.pollId }, this.now);
    return this;
  }

  /** Ends the intro. */
  skipIntro(): this {
    if (this.state.phase !== "intro") throw new Error("doodle driver: not in intro");
    return this.toDeadline();
  }

  /** The audience tier vote closes with these counts (easy, medium, hard). */
  voteTier(counts: [number, number, number], afterMs = 4_000): this {
    this.wait(afterMs);
    return this.audience({
      pollId: this.state.tierPoll,
      kind: "vote",
      total: counts[0] + counts[1] + counts[2],
      tallies: { "1": counts[0], "2": counts[1], "3": counts[2] },
    });
  }

  /** The drawer picks choice `idx`. */
  pick(idx: 0 | 1 | 2 = 0): this {
    const drawer = this.state.drawer;
    if (drawer === undefined) throw new Error("doodle driver: no drawer");
    return this.act(drawer, { type: "pickWord", idx }, 2_500);
  }

  /** The drawer draws `strokes`, each sent in batches of at most 128 points. */
  draw(strokes: readonly ShapeStroke[], gapMs = 300): this {
    const drawer = this.state.drawer;
    if (drawer === undefined) throw new Error("doodle driver: no drawer");
    for (const st of strokes) {
      const id = `s${this.#stroke++}`;
      for (let i = 0; i < st.pts.length; i += MAX_BATCH_POINTS * 2) {
        const pts = st.pts.slice(i, i + MAX_BATCH_POINTS * 2);
        const done = i + MAX_BATCH_POINTS * 2 >= st.pts.length;
        this.act(drawer, { type: "stroke", id, c: st.c, s: st.s, pts, done }, gapMs);
      }
    }
    return this;
  }

  /** A guess from `id`. */
  guess(id: PlayerId, text: string, gapMs = 1_100): this {
    return this.act(id, { type: "guess", text }, gapMs);
  }

  /** The current word (driver-side only; never part of a non-drawer view). */
  get word(): string {
    const w = this.state.hidden.word?.w;
    if (w === undefined) throw new Error("doodle driver: no word yet");
    return w;
  }
}

// ---- Shapes -------------------------------------------------------------------------------------

const clampX = (x: number): number => Math.min(CANVAS_W - 1, Math.max(0, Math.round(x)));
const clampY = (y: number): number => Math.min(CANVAS_H - 1, Math.max(0, Math.round(y)));

/** A closed ellipse as flat points. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, n = 36): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(clampX(cx + Math.cos(a) * rx), clampY(cy + Math.sin(a) * ry));
  }
  return pts;
}

/** A polyline as flat points. */
export function line(...xy: number[]): number[] {
  return xy.map((v, i) => (i % 2 === 0 ? clampX(v) : clampY(v)));
}

/** A quadratic curve from `(x0, y0)` through control `(cx, cy)` to `(x1, y1)`. */
export function curve(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  n = 16,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push(
      clampX(u * u * x0 + 2 * u * t * cx + t * t * x1),
      clampY(u * u * y0 + 2 * u * t * cy + t * t * y1),
    );
  }
  return pts;
}

/** Palette index 0 is ink. */
const INK = 0;

function sunRays(): ShapeStroke[] {
  return Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return {
      c: 3,
      s: 1,
      pts: line(
        512 + Math.cos(a) * 140,
        384 + Math.sin(a) * 140,
        512 + Math.cos(a) * 200,
        384 + Math.sin(a) * 200,
      ),
    };
  });
}

/** Scenario drawings by word: simple, readable doodles on the 1024×768 page. */
export const SHAPES: Readonly<Record<string, readonly ShapeStroke[]>> = Object.freeze({
  kitten: [
    { c: INK, s: 1, pts: ellipse(512, 300, 120, 110) },
    { c: INK, s: 1, pts: line(420, 235, 430, 120, 488, 196) },
    { c: INK, s: 1, pts: line(536, 196, 594, 120, 604, 235) },
    { c: INK, s: 2, pts: ellipse(466, 285, 10, 12, 12) },
    { c: INK, s: 2, pts: ellipse(558, 285, 10, 12, 12) },
    { c: 1, s: 1, pts: line(498, 330, 526, 330, 512, 346, 498, 330) },
    { c: INK, s: 0, pts: curve(512, 346, 505, 368, 488, 366) },
    { c: INK, s: 0, pts: curve(512, 346, 519, 368, 536, 366) },
    { c: INK, s: 0, pts: line(466, 340, 372, 322) },
    { c: INK, s: 0, pts: line(466, 352, 372, 360) },
    { c: INK, s: 0, pts: line(558, 340, 652, 322) },
    { c: INK, s: 0, pts: line(558, 352, 652, 360) },
    { c: INK, s: 1, pts: ellipse(512, 560, 150, 130, 44) },
  ],
  "kitten-tail": [{ c: INK, s: 1, pts: curve(655, 610, 800, 560, 730, 420, 20) }],
  house: [
    { c: INK, s: 1, pts: line(380, 380, 640, 380, 640, 640, 380, 640, 380, 380) },
    { c: 1, s: 2, pts: line(350, 395, 510, 230, 670, 395) },
    { c: 9, s: 1, pts: line(480, 640, 480, 530, 540, 530, 540, 640) },
    { c: 2, s: 1, pts: line(410, 420, 460, 420, 460, 470, 410, 470, 410, 420) },
    { c: 2, s: 1, pts: line(560, 420, 610, 420, 610, 470, 560, 470, 560, 420) },
  ],
  sun: [{ c: 3, s: 2, pts: ellipse(512, 384, 110, 110) }, ...sunRays()],
  fish: [
    { c: 2, s: 1, pts: ellipse(470, 384, 170, 95) },
    { c: 2, s: 1, pts: line(630, 384, 760, 290, 760, 478, 630, 384) },
    { c: INK, s: 2, pts: ellipse(380, 360, 12, 12, 12) },
    { c: INK, s: 0, pts: curve(330, 410, 350, 425, 370, 412) },
  ],
  tree: [
    { c: 9, s: 2, pts: line(490, 660, 490, 470, 534, 470, 534, 660) },
    { c: 4, s: 2, pts: ellipse(512, 360, 150, 130) },
    { c: 4, s: 1, pts: ellipse(450, 330, 60, 50, 20) },
    { c: 4, s: 1, pts: ellipse(575, 390, 60, 50, 20) },
  ],
});

/** The scenario word list: the first turn offers these, one per tier. */
export const SCENARIO_WORDS: readonly DoodleWord[] = Object.freeze([
  { w: "kitten", alt: ["cat", "kitty"], d: 1 },
  { w: "penguin", d: 2 },
  { w: "haunted house", d: 3 },
]);

/** Words of the `final` scenario's five turns (all easy, each with a shape). */
const FINAL_WORDS: readonly DoodleWord[] = Object.freeze(
  (["kitten", "house", "sun", "fish", "tree"] as const).map((w) => ({ w, d: 1 as const })),
);

function tally(
  pollId: string | null,
  kind: string,
  total: number,
  extra: Record<string, unknown> = {},
): { name: string; data: unknown } {
  return { name: "tally", data: { pollId, kind, total, ...extra } };
}

const player = (id: PlayerId): ViewerKey => ({ role: "player", id });

/**
 * The `drawing` state: 5 seats, Maple (p1) draws "kitten" (chat chose Easy), 76% into the draw
 * time so both hints are out (the spec's "45% … 2 hints" cannot both hold; see Builder notes),
 * with misses and two correct guesses in the feed.
 */
export function drawingState(seed: number): DoodleDriver {
  const d = new DoodleDriver({ seed, players: 5, content: scenarioContent(SCENARIO_WORDS) })
    .skipIntro()
    .voteTier([180, 140, 80]);
  d.draw(SHAPES["kitten"] ?? [], 350);
  d.guess("p3", "a mouse?").guess("p5", "owl").guess("p2", d.word);
  d.guess("p4", "lion?").guess("p5", "bunny");
  d.toDrawShare(0.7);
  d.guess("p4", "kitty");
  d.toDrawShare(0.76);
  return d;
}

/** The Doodle scenario registry. */
export const scenarios: ScenarioRegistry<DoodleState> = {
  "word-pick": {
    id: "word-pick",
    description: "Audience tier vote 20/35/45",
    build: ({ seed }) => {
      const d = new DoodleDriver({ seed, players: 5, content: scenarioContent(SCENARIO_WORDS) })
        .skipIntro()
        .wait(3_000);
      return {
        state: d.state,
        viewer: player(d.state.drawer ?? "p1"),
        fx: [tally(d.state.tierPoll, "vote", 400, { tallies: { "1": 80, "2": 140, "3": 180 } })],
      };
    },
  },
  drawing: {
    id: "drawing",
    description: "76% into a kitten drawing, 2 hints revealed, feed with misses and 2 correct",
    build: ({ seed }) => {
      const d = drawingState(seed);
      return {
        state: d.state,
        viewer: player(d.state.drawer ?? "p1"),
        fx: [tally(d.state.guessPoll, "guess", 640, { tallies: { correct: 214 } })],
      };
    },
    anim: { name: "pencil", durationMs: 1500 },
  },
  "drawing-guesser": {
    id: "drawing-guesser",
    description: "The drawing scenario as a guesser who has not got it yet (player variant)",
    build: ({ seed }) => {
      const d = drawingState(seed);
      return {
        state: d.state,
        viewer: player("p3"),
        fx: [tally(d.state.guessPoll, "guess", 640, { tallies: { correct: 214 } })],
      };
    },
  },
  "correct-guess": {
    id: "correct-guess",
    description: "Moment of a correct guess",
    build: ({ seed }) => {
      const d = drawingState(seed).guess("p3", "Kitten!", 600);
      const points = d.state.correct["p3"] ?? 0;
      return {
        state: d.state,
        fx: [{ name: "correct", data: { by: "p3", points, first: false } }],
      };
    },
    anim: { name: "correct", durationMs: 900 },
  },
  reveal: {
    id: "reveal",
    description: "Word banner unroll + points",
    build: ({ seed }) => {
      const d = drawingState(seed);
      d.draw(SHAPES["kitten-tail"] ?? [], 300);
      d.guess("p3", "a cat", 700);
      d.toDeadline();
      const reveal = d.state.reveal;
      return {
        state: d.state,
        fx: [
          {
            name: "reveal",
            data: { word: reveal?.word ?? "", reason: reveal?.reason ?? "time" },
          },
        ],
      };
    },
    anim: { name: "reveal", durationMs: 1200 },
  },
  final: {
    id: "final",
    description: "Podium + Best Artist + gallery strip",
    build: ({ seed }) => {
      const d = new DoodleDriver({
        seed,
        players: 5,
        options: { rounds: "1" },
        content: scenarioContent(FINAL_WORDS),
      }).skipIntro();
      // Each drawer draws their word; a different number of guessers gets it each turn.
      let turn = 0;
      while (d.state.phase === "word-pick") {
        d.voteTier([300, 60, 40]);
        d.draw(SHAPES[d.word] ?? SHAPES["kitten"] ?? [], 250);
        const drawer = d.state.drawer;
        const guessers = d.state.players.filter((p) => p.id !== drawer).map((p) => p.id);
        const solvers = guessers.slice(0, 1 + ((turn * 3 + seed) % guessers.length));
        for (const g of solvers) d.guess(g, d.word, 2_000);
        if (d.runner.state.phase !== "reveal") d.toDeadline();
        d.toDeadline(); // reveal → next turn (or the final)
        turn++;
      }
      return { state: d.state, fx: [{ name: "win", data: { winners: d.state.winners } }] };
    },
    anim: { name: "win", durationMs: 2000 },
  },
  midgame: {
    id: "midgame",
    description: "G8a perf scene: the drawing scenario on the Stage",
    build: ({ seed }) => ({ state: drawingState(seed).state }),
  },
};
