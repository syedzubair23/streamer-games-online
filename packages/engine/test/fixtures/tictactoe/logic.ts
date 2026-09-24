/**
 * Tic-tac-toe: the engine's reference game (ROADMAP M0-04). It is small, but it exercises
 * every runtime path a real game uses, so the runner, the contract suite, the sim, the server
 * (M1-02) and the harness (M0-05) can all be tested against it:
 *
 * - phases with `ctx.timing.pace` (intro, result) and `ctx.timing.input` (turn) deadlines;
 * - a turn timer that auto-plays on timeout, and host `forceAdvance` for `timerScale 0`;
 * - a round-long audience `predict` poll (resolved at the end) and a per-turn `vote` poll
 *   ("Chat's pick"), closed early when the move lands (exercising the minimum audience window);
 * - hidden information: each player's **secret line** (a bonus line) lives under `secret` and
 *   is shown only to its owner until the result reveals it;
 * - `score` effects, `end` with a ranking, and a deterministic bot.
 *
 * Rules: X moves first; a move claims an empty cell; three in a line wins (+3, and +1 when the
 * winning line is the winner's secret line); a full board is a draw (+1 each).
 */
import type { PlayerId, Rng } from "@sg/shared";
import type {
  ActionCtx,
  Ctx,
  Effect,
  GameModule,
  GameResult,
  PollResult,
  SetupContext,
  Step,
  ViewerKey,
} from "../../../src/game-module.ts";

/** The 8 lines of the board. */
export const LINES = {
  "row-top": [0, 1, 2],
  "row-mid": [3, 4, 5],
  "row-bottom": [6, 7, 8],
  "col-left": [0, 3, 6],
  "col-mid": [1, 4, 7],
  "col-right": [2, 5, 8],
  "diag-down": [0, 4, 8],
  "diag-up": [2, 4, 6],
} as const satisfies Record<string, readonly [number, number, number]>;
/** A line name. */
export type LineName = keyof typeof LINES;
const LINE_NAMES = Object.keys(LINES) as LineName[];

/** Options (host form). */
export interface TttOptions {
  turnSec: number;
  chatHints: boolean;
}

/** Mark of a seat: 0 = X, 1 = O. */
export type Mark = 0 | 1;

/** A seated player. `secret.line` is hidden information. */
export interface TttPlayer {
  id: PlayerId;
  name: string;
  colorSlot: number;
  mark: Mark;
  secret: { line: LineName };
}

/** The module state (plain JSON). */
export interface TttState {
  phase: "intro" | "turn" | "result";
  deadline: number | null;
  board: (Mark | null)[];
  players: [TttPlayer, TttPlayer];
  turn: Mark;
  moves: number;
  /** Cells in the order they were claimed. */
  history: number[];
  winner: Mark | null;
  winLine: LineName | null;
  draw: boolean;
  /** Secret lines, copied here at the result reveal. */
  revealed: Partial<Record<PlayerId, LineName>>;
  /** The open "Chat's pick" poll for this turn, if any. */
  chatPoll: string | null;
  /** The last resolved chat pick: which cell chat liked, and whether the player agreed. */
  chat: { pollId: string; cell: number | null; agreed: boolean } | null;
  /** Whether the round-winner predict poll is still open. */
  predictOpen: boolean;
  scores: Record<PlayerId, number>;
  options: TttOptions;
}

/** Actions. */
export type TttAction = { type: "move"; cell: number };

/** The public view shared by every viewer (players add `you`). */
export interface TttView {
  phase: TttState["phase"];
  deadline: number | null;
  board: (Mark | null)[];
  players: { id: PlayerId; name: string; colorSlot: number; mark: Mark }[];
  turn: Mark;
  moves: number;
  winner: Mark | null;
  winLine: LineName | null;
  draw: boolean;
  revealed: Partial<Record<PlayerId, LineName>>;
  chat: TttState["chat"];
  scores: Record<PlayerId, number>;
  you?: { id: PlayerId; mark: Mark; secretLine: LineName; yourTurn: boolean };
}

/** Pacing constants (ms). */
export const INTRO_MS = 3_000;
export const RESULT_MS = 4_000;
/** The round-winner predict poll id. */
export const PREDICT_POLL = "winner";

const MARK_LABEL = ["X", "O"] as const;

function winnerOf(board: readonly (Mark | null)[]): { mark: Mark; line: LineName } | null {
  for (const name of LINE_NAMES) {
    const [a, b, c] = LINES[name];
    const m = board[a];
    if (m !== null && m !== undefined && board[b] === m && board[c] === m) {
      return { mark: m, line: name };
    }
  }
  return null;
}

function emptyCells(board: readonly (Mark | null)[]): number[] {
  const out: number[] = [];
  board.forEach((m, i) => {
    if (m === null) out.push(i);
  });
  return out;
}

function startTurn(state: TttState, ctx: Ctx): Step<TttState> {
  const window = ctx.timing.input(state.options.turnSec * 1000);
  const deadline = window === null ? null : ctx.now + window;
  const effects: Effect[] = [];
  let chatPoll: string | null = null;
  if (state.options.chatHints) {
    chatPoll = `chat-${state.moves + 1}`;
    effects.push({
      type: "audience.open",
      poll: {
        pollId: chatPoll,
        kind: "vote",
        prompt: `Where should ${MARK_LABEL[state.turn]} play?`,
        options: emptyCells(state.board).map((c) => ({ id: String(c), label: `Cell ${c + 1}` })),
        closesAtMs: deadline ?? ctx.now + state.options.turnSec * 1000,
      },
    });
  }
  if (deadline !== null) effects.push({ type: "timer.set", id: "turn", atMs: deadline });
  return { state: { ...state, phase: "turn", deadline, chatPoll }, effects };
}

function applyMove(state: TttState, cell: number, ctx: Ctx, timedOut: boolean): Step<TttState> {
  const board = state.board.slice();
  board[cell] = state.turn;
  const moves = state.moves + 1;
  const effects: Effect[] = [
    { type: "timer.clear", id: "turn" },
    { type: "fx", name: timedOut ? "timeout" : "place", data: { cell, mark: state.turn } },
  ];
  if (state.chatPoll !== null) effects.push({ type: "audience.close", pollId: state.chatPoll });
  if (state.predictOpen) effects.push({ type: "audience.close", pollId: PREDICT_POLL });
  const win = winnerOf(board);
  const next: TttState = {
    ...state,
    board,
    moves,
    history: [...state.history, cell],
    chatPoll: null,
    predictOpen: false,
  };
  if (win === null && moves < 9) {
    const step = startTurn({ ...next, turn: state.turn === 0 ? 1 : 0 }, ctx);
    return { state: step.state, effects: [...effects, ...(step.effects ?? [])] };
  }
  const deltas: Record<PlayerId, number> = {};
  if (win !== null) {
    const winner = state.players[win.mark];
    deltas[winner.id] = 3 + (winner.secret.line === win.line ? 1 : 0);
  } else {
    for (const p of state.players) deltas[p.id] = 1;
  }
  const scores = { ...state.scores };
  for (const [id, d] of Object.entries(deltas)) scores[id] = (scores[id] ?? 0) + d;
  const revealed: Partial<Record<PlayerId, LineName>> = {};
  for (const p of state.players) revealed[p.id] = p.secret.line;
  effects.push(
    { type: "score", deltas },
    {
      type: "audience.resolve",
      pollId: PREDICT_POLL,
      correct: win ? MARK_LABEL[win.mark] : "draw",
    },
    { type: "fx", name: win ? "win" : "draw", data: win ? { line: win.line } : undefined },
    { type: "timer.set", id: "result", atMs: ctx.now + ctx.timing.pace(RESULT_MS) },
  );
  return {
    state: {
      ...next,
      phase: "result",
      deadline: null,
      winner: win?.mark ?? null,
      winLine: win?.line ?? null,
      draw: win === null,
      revealed,
      scores,
    },
    effects,
  };
}

function result(state: TttState): GameResult {
  const ranked = state.players
    .map((p) => ({ id: p.id, score: state.scores[p.id] ?? 0, seat: p.mark }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  let place = 0;
  return {
    ranking: ranked.map((r, i) => {
      if (i === 0 || r.score !== ranked[i - 1]?.score) place = i + 1;
      return { id: r.id, score: r.score, place };
    }),
    highlights:
      state.winner !== null
        ? [{ label: "Three in a row", playerId: state.players[state.winner].id }]
        : [{ label: "Stalemate" }],
  };
}

function illegal(state: TttState): Step<TttState> {
  return { state, effects: [{ type: "fx", name: "illegal" }] };
}

/** Picks the bot move: win, else block, else centre, else a random corner/edge. */
export function chooseMove(state: TttState, rng: Rng): number | null {
  const open = emptyCells(state.board);
  if (open.length === 0) return null;
  const me = state.turn;
  const them: Mark = me === 0 ? 1 : 0;
  for (const mark of [me, them]) {
    const hits = open.filter((c) => {
      const board = state.board.slice();
      board[c] = mark;
      return winnerOf(board)?.mark === mark;
    });
    if (hits.length > 0) return rng.pick(hits);
  }
  if (open.includes(4) && rng.bool(0.7)) return 4;
  return rng.pick(open);
}

/** The tictactoe game module. */
export const tictactoe: GameModule<TttState, TttAction, TttOptions, TttView> = {
  manifest: {
    // The fixture is not one of the 8 launch games; GameId is a closed union.
    id: "tictactoe" as GameModule<unknown, unknown, unknown, unknown>["manifest"]["id"],
    name: "Tic-tac-toe",
    version: "1.0.0",
    minPlayers: 2,
    maxPlayers: 2,
    teamSupport: "none",
    audience: { vote: true, predict: true },
    tickHz: 0,
    renderMode: "on-demand",
    estMinutes: [1, 3],
    tags: ["fixture", "board"],
    contentRating: "all",
    howToPlay: ["Take turns placing your mark", "Three in a row wins", "Hit your secret line: +1"],
  },
  optionSpecs: [
    { kind: "seconds", key: "turnSec", label: "Turn timer", min: 5, max: 60, default: 15 },
    { kind: "bool", key: "chatHints", label: "Chat's pick poll", default: true },
  ],

  parseAction(raw: unknown): TttAction | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r["type"] !== "move") return null;
    const cell = r["cell"];
    if (typeof cell !== "number" || !Number.isInteger(cell) || cell < 0 || cell > 8) return null;
    return { type: "move", cell };
  },

  setup(ctx: SetupContext<TttOptions>): Step<TttState> {
    const order = ctx.rng.shuffle(ctx.players.slice(0, 2));
    const lines = ctx.rng.shuffle(LINE_NAMES);
    const players = order.map((p, i) => ({
      id: p.id,
      name: p.name,
      colorSlot: p.colorSlot,
      mark: i as Mark,
      secret: { line: lines[i] as LineName },
    })) as [TttPlayer, TttPlayer];
    const scores: Record<PlayerId, number> = {};
    for (const p of players) scores[p.id] = 0;
    const introEnd = ctx.now + ctx.timing.pace(INTRO_MS);
    const firstWindow = ctx.timing.input(ctx.options.turnSec * 1000);
    return {
      state: {
        phase: "intro",
        deadline: null,
        board: Array.from({ length: 9 }, () => null),
        players,
        turn: 0,
        moves: 0,
        history: [],
        winner: null,
        winLine: null,
        draw: false,
        revealed: {},
        chatPoll: null,
        chat: null,
        predictOpen: true,
        scores,
        options: { ...ctx.options },
      },
      effects: [
        { type: "timer.set", id: "intro", atMs: introEnd },
        {
          type: "audience.open",
          poll: {
            pollId: PREDICT_POLL,
            kind: "predict",
            prompt: "Who wins?",
            options: [
              { id: "X", label: `${players[0].name} (X)` },
              { id: "O", label: `${players[1].name} (O)` },
              { id: "draw", label: "Draw" },
            ],
            closesAtMs: introEnd + (firstWindow ?? ctx.options.turnSec * 1000),
          },
        },
      ],
    };
  },

  onAction(state: TttState, action: TttAction, ctx: ActionCtx): Step<TttState> {
    if (state.phase !== "turn" || ctx.actor.role !== "player") return illegal(state);
    const current = state.players[state.turn];
    if (ctx.actor.id !== current.id || state.board[action.cell] !== null) return illegal(state);
    return applyMove(state, action.cell, ctx, false);
  },

  onTimer(state: TttState, timerId: string, ctx: Ctx): Step<TttState> {
    if (timerId === "intro" && state.phase === "intro") return startTurn(state, ctx);
    if (timerId === "turn" && state.phase === "turn") {
      const cell = ctx.rng.pick(emptyCells(state.board));
      return applyMove(state, cell, ctx, true);
    }
    if (timerId === "result" && state.phase === "result") {
      return { state, effects: [{ type: "end", result: result(state) }] };
    }
    return { state };
  },

  onAudienceResult(state: TttState, r: PollResult): Step<TttState> {
    if (!r.pollId.startsWith("chat-")) return { state };
    let cell: number | null = null;
    let best = 0;
    for (const [option, count] of Object.entries(r.tallies)) {
      if (count > best) {
        best = count;
        cell = Number(option);
      }
    }
    const moveNo = Number(r.pollId.slice("chat-".length));
    const agreed = cell !== null && state.history[moveNo - 1] === cell;
    return { state: { ...state, chat: { pollId: r.pollId, cell, agreed } } };
  },

  onHostCommand(state: TttState, cmd, ctx: Ctx): Step<TttState> {
    if (cmd.c !== "forceAdvance") return { state };
    if (state.phase === "intro") return startTurn(state, ctx);
    if (state.phase === "turn") {
      return applyMove(state, ctx.rng.pick(emptyCells(state.board)), ctx, true);
    }
    return { state, effects: [{ type: "end", result: result(state) }] };
  },

  view(state: TttState, viewer: ViewerKey): TttView {
    const view: TttView = {
      phase: state.phase,
      deadline: state.deadline,
      board: state.board.slice(),
      players: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        colorSlot: p.colorSlot,
        mark: p.mark,
      })),
      turn: state.turn,
      moves: state.moves,
      winner: state.winner,
      winLine: state.winLine,
      draw: state.draw,
      revealed: { ...state.revealed },
      chat: state.chat,
      scores: { ...state.scores },
    };
    if (viewer.role === "player") {
      const me = state.players.find((p) => p.id === viewer.id);
      if (me !== undefined) {
        view.you = {
          id: me.id,
          mark: me.mark,
          secretLine: me.secret.line,
          yourTurn: state.phase === "turn" && state.turn === me.mark,
        };
      }
    }
    return view;
  },

  legalActions(state: TttState, player: PlayerId): TttAction[] {
    if (state.phase !== "turn" || state.players[state.turn].id !== player) return [];
    return emptyCells(state.board).map((cell) => ({ type: "move", cell }));
  },

  bot(state: TttState, player: PlayerId, rng: Rng): TttAction | null {
    if (state.phase !== "turn" || state.players[state.turn].id !== player) return null;
    const cell = chooseMove(state, rng);
    return cell === null ? null : { type: "move", cell };
  },

  serialize(state: TttState): string {
    return JSON.stringify(state);
  },

  deserialize(data: string): TttState {
    return JSON.parse(data) as TttState;
  },
};
