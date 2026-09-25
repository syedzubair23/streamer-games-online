/**
 * Doodle Guess mode reducers (`docs/specs/doodle.md` R1–R8, "State machine", "Edge cases"):
 *
 * ```
 * intro → [turn]{ word-pick (audience tier vote or drawer) → draw → reveal (pace 4000) } × turns → final → end
 * ```
 *
 * Every reducer is pure: it copies what it changes (the runner deep-freezes state in dev) and
 * returns the original state object, plus an `illegal` fx, for anything it refuses.
 *
 * @module
 */
import { cleanUserText, filterText, type PlayerId, type TeamId } from "@sg/shared";
import type {
  ActionCtx,
  Ctx,
  Effect,
  GameHostCommand,
  GameResult,
  PollResult,
  Step,
} from "@sg/engine";
import { RAW_TEXT_MAX } from "./parse.ts";
import { resolveRoomSettings, type SetupContextWithRoom } from "./room.ts";
import {
  applyStroke,
  bestArtist,
  buildTeams,
  clearDrawing,
  drawerPoints,
  emptyDrawing,
  guesserPoints,
  ranking,
  roundsFor,
  teamPoints,
  turnOrder,
  undoStroke,
} from "./rules.ts";
import {
  FEED_MAX,
  FINAL_MS,
  GALLERY_MAX,
  GUESS_INTERVAL_MS,
  GUESS_MAX,
  INTRO_MS,
  PICK_MS,
  POLL_GRACE_MS,
  REVEAL_MS,
  STEAL_AT,
  TIER_LABELS,
  TIER_VOTE_MS,
  type DoodleAction,
  type DoodleOptions,
  type DoodlePlayer,
  type DoodleRoomSettings,
  type DoodleState,
  type FeedEntry,
  type GalleryEntry,
  type TurnEnd,
} from "./types.ts";
import {
  buildDeck,
  containsAnswer,
  drawChoices,
  drawCustomChoices,
  hintSchedule,
  hintString,
  letterPositions,
  matchGuess,
  nextHintPosition,
  pollAccept,
} from "./words.ts";

type Fx = Effect[];

/** A reducer transaction: the working copy, its effects and the context. */
interface Tx {
  s: DoodleState;
  fx: Fx;
  ctx: Ctx;
}

/** Timer ids. `phase` is re-armed per phase (a new `timer.set` replaces the old one). */
export const TIMER = Object.freeze({
  phase: "phase",
  hint: "hint",
  tier: "tier",
  steal: "steal",
});

/** In `customWords: "mix"`, the share of turns that offer three custom words. */
export const CUSTOM_TURN_SHARE = 0.5;

// ---- Helpers ------------------------------------------------------------------------------------

/** A working copy: every container a reducer may change is copied; drawings are replaced. */
function clone(state: DoodleState): DoodleState {
  const d = state.hidden.deck;
  return {
    ...state,
    feed: [...state.feed],
    correct: { ...state.correct },
    reports: [...state.reports],
    scores: { ...state.scores },
    votes: { ...state.votes },
    hidden: {
      ...state.hidden,
      usedWords: [...state.hidden.usedWords],
      deck: [[...d[0]], [...d[1]], [...d[2]], [...d[3]]],
    },
    players: state.players.map((p) => ({ ...p })),
    hintShown: [...state.hintShown],
    lastGuessAt: { ...state.lastGuessAt },
    pendingGuess: state.pendingGuess.map((p) => ({ ...p })),
    artist: { ...state.artist },
    history: [...state.history],
    gallery: [...state.gallery],
    winners: [...state.winners],
  };
}

function begin(state: DoodleState, ctx: Ctx): Tx {
  const s = clone(state);
  s.clock = ctx.now;
  return { s, fx: [], ctx };
}

function done(tx: Tx): Step<DoodleState> {
  return tx.fx.length > 0 ? { state: tx.s, effects: tx.fx } : { state: tx.s };
}

/** Refuses an action: the state is unchanged and an `illegal` fx says why. */
function illegal(state: DoodleState, reason: string): Step<DoodleState> {
  return { state, effects: [{ type: "fx", name: "illegal", data: { reason } }] };
}

/** Absolute deadline for an input window, or null at timerScale 0. */
function inputDeadline(ctx: Ctx, baseMs: number): number | null {
  const window = ctx.timing.input(baseMs);
  return window === null ? null : ctx.now + window;
}

function setTimer(tx: Tx, id: string, atMs: number): void {
  tx.fx.push({ type: "timer.set", id, atMs });
}

function clearTimer(tx: Tx, id: string): void {
  tx.fx.push({ type: "timer.clear", id });
}

function nextPollId(s: DoodleState, kind: string): string {
  s.pollSeq += 1;
  return `dd-${s.turn}-${kind}-${s.pollSeq}`;
}

function playerOf(s: DoodleState, id: PlayerId): DoodlePlayer | undefined {
  return s.players.find((p) => p.id === id);
}

/** Team Doodle is on. */
export function teamMode(s: DoodleState): boolean {
  return s.teams.length > 0;
}

/** The players who guess this turn: every connected player except the drawer. */
export function connectedGuessers(s: DoodleState): DoodlePlayer[] {
  return s.players.filter((p) => p.connected && p.id !== s.drawer);
}

/** Whether `id` may guess right now (R4, R7). Correct guessers "guess" as insider chat. */
export function mayGuess(s: DoodleState, id: PlayerId): boolean {
  if (s.phase !== "draw" || id === s.drawer) return false;
  const p = playerOf(s, id);
  if (p === undefined) return false;
  if (!teamMode(s)) return true;
  return p.teamId === s.teamTurn || s.stealOpen;
}

/** Whether `id` may report this turn's drawing (R6): any non-drawer seat, once per turn. */
export function mayReport(s: DoodleState, id: PlayerId): boolean {
  return (
    s.phase === "draw" &&
    id !== s.drawer &&
    playerOf(s, id) !== undefined &&
    !s.reports.includes(id)
  );
}

/** Remaining draw time for scoring (ms); uses the nominal window when there is no deadline. */
function remaining(s: DoodleState, now: number): number {
  return s.deadline !== null ? s.deadline - now : s.drawTotal - (now - s.drawStart);
}

function pushFeed(s: DoodleState, entry: FeedEntry): void {
  s.feed.push(entry);
  if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);
}

function addScore(tx: Tx, id: string, points: number): void {
  if (points === 0) return;
  tx.s.scores[id] = (tx.s.scores[id] ?? 0) + points;
  tx.fx.push({ type: "score", deltas: { [id]: points } });
}

// ---- Setup ----------------------------------------------------------------------------------------

/** Clamps options that do not come through `resolveOptions` (direct `setup` calls). */
function sanitizeOptions(o: Partial<DoodleOptions>): DoodleOptions {
  const drawSec = typeof o.drawSec === "number" && Number.isFinite(o.drawSec) ? o.drawSec : 70;
  return {
    mode: "guess",
    packs: Array.isArray(o.packs) && o.packs.length > 0 ? [...o.packs] : ["doodle-core"],
    customWords: o.customWords === "mix" || o.customWords === "only" ? o.customWords : "off",
    rounds: o.rounds === "1" || o.rounds === "2" || o.rounds === "3" ? o.rounds : "auto",
    drawSec: Math.min(150, Math.max(40, Math.round(drawSec))),
    hints: o.hints !== false,
    audiencePicksTier: o.audiencePicksTier !== false,
  };
}

/** `setup`: seats, teams, turn order, the word deck and the intro. */
export function setupGame(
  ctx: SetupContextWithRoom<DoodleOptions>,
  override: Partial<DoodleRoomSettings> = {},
): Step<DoodleState> {
  const room = resolveRoomSettings(ctx, override);
  const options = sanitizeOptions(ctx.options);
  const players: DoodlePlayer[] = [...ctx.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      colorSlot: p.colorSlot,
      ...(p.teamId !== undefined ? { teamId: p.teamId } : {}),
      connected: true,
    }));
  const teams = buildTeams(players, ctx.teams);
  const rounds = roundsFor(options.rounds, players.length);
  const { order, teamOrder, perRound } = turnOrder(players, teams, rounds);
  const deck = buildDeck(
    ctx.content,
    {
      packs: options.packs,
      customWords: options.customWords,
      family: room.contentFilter === "family",
      perTier: options.customWords === "only" ? 0 : order.length + 2,
      custom: options.customWords === "off" ? 0 : order.length * 3 + 3,
    },
    ctx.rng,
  );
  const scoreIds = teams.length > 0 ? teams.map((t) => t.id) : players.map((p) => p.id);
  const deadline = ctx.now + ctx.timing.pace(INTRO_MS);
  const state: DoodleState = {
    mode: "guess",
    phase: "intro",
    deadline,
    round: 0,
    turn: -1,
    drawing: emptyDrawing(),
    feed: [],
    correct: {},
    reports: [],
    hidden: { usedWords: [], deck },
    scores: Object.fromEntries(scoreIds.map((id) => [id, 0])),
    votes: {},
    options,
    room,
    players,
    teams,
    order,
    teamOrder,
    rounds,
    turnsPerRound: perRound,
    clock: ctx.now,
    picker: null,
    tierPoll: null,
    guessPoll: null,
    tier: null,
    drawStart: 0,
    drawTotal: 0,
    hintShown: [],
    lastGuessAt: {},
    firstCorrectAt: null,
    teamTurn: null,
    stealAt: null,
    stealOpen: false,
    pendingGuess: [],
    reveal: null,
    crowd: null,
    artist: Object.fromEntries(players.map((p) => [p.id, 0])),
    history: [],
    gallery: [],
    winners: [],
    pollSeq: 0,
  };
  return { state, effects: [{ type: "timer.set", id: TIMER.phase, atMs: deadline }] };
}

// ---- Turn flow ------------------------------------------------------------------------------------

/** Resets the per-turn fields. */
function resetTurn(s: DoodleState): void {
  s.drawing = emptyDrawing();
  s.feed = [];
  s.correct = {};
  s.reports = [];
  s.tier = null;
  s.reveal = null;
  s.picker = null;
  s.tierPoll = null;
  s.guessPoll = null;
  s.hintShown = [];
  s.lastGuessAt = {};
  s.firstCorrectAt = null;
  s.stealAt = null;
  s.stealOpen = false;
  s.drawStart = 0;
  s.drawTotal = 0;
  delete s.hint;
  delete s.hidden.word;
  delete s.hidden.wordChoices;
}

/**
 * Starts turn `index` (R1). A drawer who is disconnected at the start of their turn is skipped
 * (a bot drawing would be meaningless); past the last turn comes the final.
 */
function startTurn(tx: Tx, index: number): void {
  const { s, ctx } = tx;
  clearTimer(tx, TIMER.hint);
  clearTimer(tx, TIMER.tier);
  clearTimer(tx, TIMER.steal);
  resetTurn(s);
  let i = index;
  while (i < s.order.length && playerOf(s, s.order[i] as PlayerId)?.connected !== true) i++;
  if (i >= s.order.length) {
    enterFinal(tx);
    return;
  }
  const drawer = s.order[i] as PlayerId;
  s.turn = i;
  s.round = Math.floor(i / s.turnsPerRound) + 1;
  s.drawer = drawer;
  s.teamTurn = s.teamOrder[i] ?? null;
  s.phase = "word-pick";

  // R2: three words, or three custom words (no tier, so no tier vote).
  const mode = s.options.customWords;
  const custom =
    mode === "only" ||
    (mode === "mix" && s.hidden.deck[0].length >= 3 && ctx.rng.bool(CUSTOM_TURN_SHARE))
      ? drawCustomChoices(s.hidden.deck)
      : null;
  const words = custom ?? drawChoices(s.hidden.deck, s.hidden.usedWords, ctx.rng);
  s.hidden.wordChoices = { owner: drawer, words };
  tx.fx.push({ type: "fx", name: "turn", data: { turn: i, drawer } });

  if (custom === null && s.options.audiencePicksTier && ctx.audienceCount >= s.room.audienceMin) {
    openTierVote(tx);
  } else {
    drawerPick(tx);
  }
}

/** R2: the audience votes the difficulty tier ("Easy 🌱 / Medium 🌿 / HARD 🌵"). */
function openTierVote(tx: Tx): void {
  const { s, ctx } = tx;
  const deadline = inputDeadline(ctx, TIER_VOTE_MS);
  const closesAtMs = deadline ?? ctx.now + TIER_VOTE_MS;
  const pollId = nextPollId(s, "tier");
  s.picker = "audience";
  s.tierPoll = pollId;
  s.deadline = deadline;
  tx.fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "vote",
      prompt: "Pick the drawer's difficulty!",
      options: ([1, 2, 3] as const).map((t) => ({ id: String(t), label: TIER_LABELS[t] })),
      closesAtMs,
    },
  });
  clearTimer(tx, TIMER.phase);
  setTimer(tx, TIMER.tier, closesAtMs + POLL_GRACE_MS);
}

/** R2: the drawer picks within 12 s; at the timeout a random word is chosen. */
function drawerPick(tx: Tx): void {
  const { s, ctx } = tx;
  s.picker = "drawer";
  s.tierPoll = null;
  s.deadline = inputDeadline(ctx, PICK_MS);
  if (s.deadline !== null) setTimer(tx, TIMER.phase, s.deadline);
  else clearTimer(tx, TIMER.phase);
}

/** Fixes the turn's word and starts the draw phase. */
function chooseWord(
  tx: Tx,
  idx: number,
  by: "audience" | "drawer" | "random",
  hard: boolean,
): void {
  const { s } = tx;
  const choices = s.hidden.wordChoices;
  const drawer = s.drawer;
  if (choices === undefined || drawer === undefined) return;
  const word = choices.words[idx] ?? choices.words[0];
  if (word === undefined) return;
  s.hidden.word = { owner: drawer, w: word.w, alt: [...word.alt], tier: word.tier };
  for (const other of choices.words) if (other !== word) s.hidden.usedWords.push(other.w);
  delete s.hidden.wordChoices;
  s.tier = { tier: word.tier, by, hard };
  s.picker = null;
  clearTimer(tx, TIMER.tier);
  tx.fx.push({ type: "fx", name: "wordChosen", data: { tier: word.tier, by, hard } });
  startDraw(tx);
}

/** R3: the draw phase, its hints, the Team Doodle steal window and the audience guess poll. */
function startDraw(tx: Tx): void {
  const { s, ctx } = tx;
  const word = s.hidden.word;
  if (word === undefined) return;
  const window = ctx.timing.input(s.options.drawSec * 1000);
  s.phase = "draw";
  s.deadline = window === null ? null : ctx.now + window;
  s.drawStart = ctx.now;
  s.drawTotal = window ?? s.options.drawSec * 1000;
  s.hintShown = [];
  s.hint = hintString(word.w, []);
  if (s.deadline !== null) setTimer(tx, TIMER.phase, s.deadline);
  else clearTimer(tx, TIMER.phase);
  scheduleHint(tx);
  if (teamMode(s)) {
    s.stealAt = ctx.now + Math.round(STEAL_AT * s.drawTotal);
    s.stealOpen = false;
    setTimer(tx, TIMER.steal, s.stealAt);
  }
  const pollId = nextPollId(s, "guess");
  s.guessPoll = pollId;
  tx.fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "guess",
      prompt: "Guess the drawing!",
      closesAtMs: s.deadline ?? ctx.now + s.drawTotal,
      accept: pollAccept(word),
    },
  });
}

/** Arms the next hint timer (R3: 50% and 75%, or only 75% for words of 3 letters or fewer). */
function scheduleHint(tx: Tx): void {
  const { s } = tx;
  const word = s.hidden.word;
  if (!s.options.hints || word === undefined) return;
  const schedule = hintSchedule(letterPositions(word.w).length);
  const next = schedule[s.hintShown.length];
  if (next === undefined) return;
  setTimer(tx, TIMER.hint, s.drawStart + Math.round(next * s.drawTotal));
}

/** Reveals one more letter (rng position, never a space or hyphen). */
function revealHint(tx: Tx): void {
  const { s, ctx } = tx;
  const word = s.hidden.word;
  if (word === undefined) return;
  const pos = nextHintPosition(word.w, s.hintShown, ctx.rng);
  if (pos === null) return;
  s.hintShown.push(pos);
  s.hint = hintString(word.w, s.hintShown);
  tx.fx.push({ type: "fx", name: "hint", data: { hint: s.hint } });
  scheduleHint(tx);
}

/** Ends the turn (R5, R6, R7, edge cases) and shows the reveal (pace 4000). */
function endTurn(tx: Tx, reason: TurnEnd): void {
  const { s, ctx } = tx;
  const word = s.hidden.word;
  const drawer = s.drawer;
  if (word === undefined || drawer === undefined) return;
  clearTimer(tx, TIMER.hint);
  clearTimer(tx, TIMER.steal);
  const skipped = reason === "report" || reason === "host-skip";
  const nCorrect = Object.keys(s.correct).length;
  const points: Record<string, number> = {};
  if (teamMode(s)) {
    for (const [id, pts] of Object.entries(s.correct)) {
      const team = playerOf(s, id)?.teamId;
      if (team !== undefined) points[team] = (points[team] ?? 0) + pts;
    }
  } else {
    Object.assign(points, s.correct);
    const drawerPts = skipped ? 0 : drawerPoints(nCorrect, s.tier?.hard === true);
    if (drawerPts > 0) {
      addScore(tx, drawer, drawerPts);
      points[drawer] = drawerPts;
    }
  }
  if (!skipped) s.artist[drawer] = (s.artist[drawer] ?? 0) + nCorrect;
  s.history.push({ turn: s.turn, drawer, word: word.w, correct: nCorrect, skipped });
  if (!skipped && s.drawing.strokes.length > 0)
    addToGallery(s, {
      turn: s.turn,
      drawer,
      word: word.w,
      correct: nCorrect,
      drawing: s.drawing,
    });
  if (s.guessPoll !== null) {
    tx.fx.push({ type: "audience.close", pollId: s.guessPoll });
    s.pendingGuess.push({ pollId: s.guessPoll, turn: s.turn, firstCorrectAt: s.firstCorrectAt });
    s.guessPoll = null;
  }
  s.hidden.usedWords.push(word.w);
  delete s.hidden.word;
  delete s.hint;
  if (skipped) s.drawing = { strokes: [], points: 0, skipped: true };
  s.reveal = { word: word.w, alt: [...word.alt], reason, skipped, points };
  s.phase = "reveal";
  s.stealOpen = false;
  s.deadline = ctx.now + ctx.timing.pace(REVEAL_MS);
  setTimer(tx, TIMER.phase, s.deadline);
  tx.fx.push({ type: "fx", name: skipped ? "skipped" : "reveal", data: { word: word.w, reason } });
}

/** Keeps the best-guessed drawings (then the earliest), shown in turn order. */
function addToGallery(s: DoodleState, entry: GalleryEntry): void {
  const all = [...s.gallery, entry].sort((a, b) => b.correct - a.correct || a.turn - b.turn);
  s.gallery = all.slice(0, GALLERY_MAX).sort((a, b) => a.turn - b.turn);
}

/** Leaves the word-pick phase without a word (drawer left, host skipped). */
function abandonPick(tx: Tx): void {
  const { s } = tx;
  if (s.tierPoll !== null) tx.fx.push({ type: "audience.close", pollId: s.tierPoll });
  for (const w of s.hidden.wordChoices?.words ?? []) s.hidden.usedWords.push(w.w);
  tx.fx.push({ type: "fx", name: "skipped", data: { turn: s.turn } });
  startTurn(tx, s.turn + 1);
}

/** The ranking ids: players in seat order (FFA) or teams in team order. */
function rankIds(s: DoodleState): string[] {
  return teamMode(s) ? s.teams.map((t) => t.id) : s.players.map((p) => p.id);
}

/** R8: the final ranking and the "Best Artist" highlight. */
export function gameResult(s: DoodleState): GameResult {
  const result: GameResult = { ranking: ranking(rankIds(s), s.scores) };
  const artist = bestArtist(s.players, s.artist, s.scores);
  if (artist !== null) result.highlights = [{ label: "Best Artist", playerId: artist }];
  return result;
}

function enterFinal(tx: Tx): void {
  const { s, ctx } = tx;
  resetTurn(s);
  delete s.drawer;
  s.teamTurn = null;
  s.phase = "final";
  s.deadline = ctx.now + ctx.timing.pace(FINAL_MS);
  s.winners = gameResult(s)
    .ranking.filter((r) => r.place === 1)
    .map((r) => r.id);
  setTimer(tx, TIMER.phase, s.deadline);
  tx.fx.push({ type: "fx", name: "win", data: { winners: s.winners } });
}

function finish(tx: Tx): void {
  tx.s.deadline = null;
  tx.fx.push({ type: "end", result: gameResult(tx.s) });
}

/** FFA: the turn ends when every connected guesser is correct. */
function allGuessed(s: DoodleState): boolean {
  const guessers = connectedGuessers(s);
  return guessers.length > 0 && guessers.every((g) => Object.hasOwn(s.correct, g.id));
}

/** R6: 50% or more of the connected guessers reported. */
function reportThresholdMet(s: DoodleState): boolean {
  const guessers = connectedGuessers(s);
  if (guessers.length === 0) return false;
  const reporting = guessers.filter((g) => s.reports.includes(g.id)).length;
  return reporting * 2 >= guessers.length;
}

// ---- onAction ---------------------------------------------------------------------------------------

/** `onAction`. */
export function onAction(
  state: DoodleState,
  action: DoodleAction,
  ctx: ActionCtx,
): Step<DoodleState> {
  const actor = ctx.actor;
  if (actor.role !== "player" || playerOf(state, actor.id) === undefined) {
    return illegal(state, "not-seated");
  }
  switch (action.type) {
    case "pickWord":
      if (state.phase !== "word-pick" || state.picker !== "drawer" || actor.id !== state.drawer) {
        return illegal(state, "not-your-pick");
      }
      {
        const tx = begin(state, ctx);
        chooseWord(tx, action.idx, "drawer", false);
        return done(tx);
      }
    case "stroke":
    case "undo":
    case "clear":
      return onDraw(state, action, ctx);
    case "guess":
      return onGuess(state, action.text, ctx);
    case "report":
      return onReport(state, ctx);
  }
}

function onDraw(
  state: DoodleState,
  action: Extract<DoodleAction, { type: "stroke" | "undo" | "clear" }>,
  ctx: ActionCtx,
): Step<DoodleState> {
  if (state.phase !== "draw" || ctx.actor.id !== state.drawer) return illegal(state, "not-drawing");
  if (action.type === "stroke") {
    const res = applyStroke(state.drawing, action);
    if ("error" in res) return illegal(state, res.error);
    return { state: { ...state, drawing: res.drawing, clock: ctx.now } };
  }
  const next = action.type === "undo" ? undoStroke(state.drawing) : clearDrawing(state.drawing);
  if (next === null) return illegal(state, "nothing-to-" + action.type);
  return { state: { ...state, drawing: next, clock: ctx.now } };
}

function onGuess(state: DoodleState, raw: string, ctx: ActionCtx): Step<DoodleState> {
  const id = ctx.actor.id;
  const word = state.hidden.word;
  if (word === undefined || !mayGuess(state, id)) return illegal(state, "not-guessing");
  const text = cleanUserText(raw, RAW_TEXT_MAX);
  if (text.length === 0) return illegal(state, "empty");
  if (cleanUserText(text, GUESS_MAX) !== text) return illegal(state, "too-long");
  const last = state.lastGuessAt[id];
  if (last !== undefined && ctx.now - last < GUESS_INTERVAL_MS) return illegal(state, "too-fast");

  const tx = begin(state, ctx);
  const { s } = tx;
  s.lastGuessAt[id] = ctx.now;
  const filtered = filterText(text, s.room.contentFilter);
  const flag =
    filtered.flagged && s.room.contentFilter === "standard" ? { flagged: true as const } : {};

  // A player who already guessed chats with the other correct guessers and the drawer.
  if (Object.hasOwn(s.correct, id)) {
    if (containsAnswer(text, word)) {
      tx.fx.push({ type: "private", to: id, name: "hidden" });
    } else {
      pushFeed(s, { by: id, text: filtered.text, insider: true, ...flag });
    }
    return done(tx);
  }

  const verdict = matchGuess(text, word);
  if (verdict === "correct") {
    scoreCorrect(tx, id);
    return done(tx);
  }
  if (verdict === "close") {
    tx.fx.push({ type: "private", to: id, name: "close", data: { text } });
  } else if (containsAnswer(text, word)) {
    // Contains the word but is not correct (e.g. a spam list): never printed on stream.
    tx.fx.push({ type: "private", to: id, name: "hidden" });
  } else {
    pushFeed(s, { by: id, text: filtered.text, ...flag });
  }
  return done(tx);
}

/** A correct guess (R5 FFA scoring, R7 team scoring). */
function scoreCorrect(tx: Tx, id: PlayerId): void {
  const { s, ctx } = tx;
  const hard = s.tier?.hard === true;
  const left = remaining(s, ctx.now);
  const first = Object.keys(s.correct).length === 0;
  s.firstCorrectAt ??= ctx.now;
  pushFeed(s, { by: id, correct: true });
  if (teamMode(s)) {
    const team = playerOf(s, id)?.teamId as TeamId;
    const pts = teamPoints(left, s.drawTotal, hard);
    s.correct[id] = pts;
    addScore(tx, team, pts);
    tx.fx.push({
      type: "fx",
      name: "correct",
      data: { by: id, team, points: pts, steal: team !== s.teamTurn },
    });
    endTurn(tx, "team-scored");
    return;
  }
  const pts = guesserPoints(left, s.drawTotal, first, hard);
  s.correct[id] = pts;
  addScore(tx, id, pts);
  tx.fx.push({ type: "fx", name: "correct", data: { by: id, points: pts, first } });
  if (allGuessed(s)) endTurn(tx, "all-correct");
}

function onReport(state: DoodleState, ctx: ActionCtx): Step<DoodleState> {
  if (!mayReport(state, ctx.actor.id)) return illegal(state, "cannot-report");
  const tx = begin(state, ctx);
  tx.s.reports.push(ctx.actor.id);
  tx.fx.push({ type: "fx", name: "report", data: { count: tx.s.reports.length } });
  if (reportThresholdMet(tx.s)) endTurn(tx, "report");
  return done(tx);
}

// ---- Timers, audience, host, presence ----------------------------------------------------------------

/** `onTimer`. Timers that do not match the current phase are ignored. */
export function onTimer(state: DoodleState, timerId: string, ctx: Ctx): Step<DoodleState> {
  switch (timerId) {
    case TIMER.phase:
      return onPhaseTimer(state, ctx);
    case TIMER.hint: {
      if (state.phase !== "draw") return { state };
      const tx = begin(state, ctx);
      revealHint(tx);
      return done(tx);
    }
    case TIMER.tier: {
      if (state.phase !== "word-pick" || state.tierPoll === null) return { state };
      // The tier vote result never arrived: pick a random word (no HARD bonus).
      const tx = begin(state, ctx);
      tx.fx.push({ type: "audience.close", pollId: state.tierPoll });
      tx.s.tierPoll = null;
      chooseWord(tx, ctx.rng.int(3), "random", false);
      return done(tx);
    }
    case TIMER.steal: {
      if (state.phase !== "draw" || !teamMode(state) || state.stealOpen) return { state };
      const tx = begin(state, ctx);
      tx.s.stealOpen = true;
      tx.fx.push({ type: "fx", name: "steal", data: { team: state.teamTurn } });
      return done(tx);
    }
    default:
      return { state };
  }
}

function onPhaseTimer(state: DoodleState, ctx: Ctx): Step<DoodleState> {
  const tx = begin(state, ctx);
  switch (state.phase) {
    case "intro":
      startTurn(tx, 0);
      break;
    case "word-pick":
      if (state.picker !== "drawer") return { state };
      chooseWord(tx, ctx.rng.int(3), "random", false);
      break;
    case "draw":
      endTurn(tx, "time");
      break;
    case "reveal":
      startTurn(tx, state.turn + 1);
      break;
    case "final":
      if (state.deadline === null) return { state };
      finish(tx);
      break;
  }
  return done(tx);
}

/** `onAudienceResult`: the tier vote (R2, T12) and the per-turn guess poll. */
export function onAudienceResult(state: DoodleState, r: PollResult, ctx: Ctx): Step<DoodleState> {
  if (r.pollId === state.tierPoll && state.phase === "word-pick") {
    const tx = begin(state, ctx);
    tx.s.tierPoll = null;
    clearTimer(tx, TIMER.tier);
    if (r.total < state.room.audienceMin) {
      // Below audienceMin the vote is shown but does not count: the drawer picks.
      tx.fx.push({ type: "fx", name: "tierVoid", data: { total: r.total } });
      drawerPick(tx);
      return done(tx);
    }
    const counts = ([1, 2, 3] as const).map((t) => ({ t, n: r.tallies[String(t)] ?? 0 }));
    const top = Math.max(...counts.map((c) => c.n));
    const tier = ctx.rng.pick(counts.filter((c) => c.n === top)).t;
    chooseWord(tx, tier - 1, "audience", tier === 3);
    return done(tx);
  }
  const pending = state.pendingGuess.find((p) => p.pollId === r.pollId);
  const live =
    r.pollId === state.guessPoll
      ? { turn: state.turn, firstCorrectAt: state.firstCorrectAt }
      : null;
  const source = pending ?? live;
  if (source === undefined || source === null || r.kind !== "guess") return { state };
  const tx = begin(state, ctx);
  const { s } = tx;
  if (pending !== undefined) s.pendingGuess = s.pendingGuess.filter((p) => p.pollId !== r.pollId);
  else s.guessPoll = null;
  const correct = r.tallies["correct"] ?? 0;
  const firstChat = r.firstCorrect?.[0] as { atMs?: unknown } | undefined;
  let beat: boolean | null = null;
  if (correct === 0) beat = false;
  else if (source.firstCorrectAt === null) beat = true;
  else if (typeof firstChat?.atMs === "number") beat = firstChat.atMs < source.firstCorrectAt;
  s.crowd = {
    turn: source.turn,
    correct,
    first: (r.firstCorrect ?? []).slice(0, 3).map((f) => f.name),
    beat,
  };
  tx.fx.push({ type: "fx", name: "crowd", data: s.crowd });
  return done(tx);
}

/** `onHostCommand`: `forceAdvance` moves the phase on; `skipItem` skips the turn (R6). */
export function onHostCommand(
  state: DoodleState,
  cmd: GameHostCommand,
  ctx: Ctx,
): Step<DoodleState> {
  if (cmd.c === "skipItem") {
    if (cmd.itemId !== `turn-${state.turn}`) return { state };
    if (state.phase === "word-pick") {
      const tx = begin(state, ctx);
      abandonPick(tx);
      return done(tx);
    }
    if (state.phase !== "draw") return { state };
    const tx = begin(state, ctx);
    endTurn(tx, "host-skip");
    return done(tx);
  }
  const tx = begin(state, ctx);
  switch (state.phase) {
    case "intro":
      startTurn(tx, 0);
      break;
    case "word-pick":
      if (state.tierPoll !== null) tx.fx.push({ type: "audience.close", pollId: state.tierPoll });
      tx.s.tierPoll = null;
      chooseWord(tx, ctx.rng.int(3), "random", false);
      break;
    case "draw":
      endTurn(tx, "host");
      break;
    case "reveal":
      startTurn(tx, state.turn + 1);
      break;
    case "final":
      if (state.deadline === null) return { state };
      finish(tx);
      break;
  }
  return done(tx);
}

/**
 * `onPlayerLeave`. The drawer leaving ends the turn (correct guessers keep their points; the
 * drawer's bot does not draw); a guesser leaving may complete "everyone guessed" or the report
 * threshold.
 */
export function onPlayerLeave(state: DoodleState, id: PlayerId, ctx: Ctx): Step<DoodleState> {
  const p = playerOf(state, id);
  if (p === undefined || !p.connected) return { state };
  const tx = begin(state, ctx);
  const { s } = tx;
  const me = playerOf(s, id);
  if (me !== undefined) me.connected = false;
  if (id === s.drawer) {
    if (s.phase === "word-pick") abandonPick(tx);
    else if (s.phase === "draw") endTurn(tx, "drawer-left");
  } else if (s.phase === "draw") {
    if (reportThresholdMet(s)) endTurn(tx, "report");
    else if (!teamMode(s) && allGuessed(s)) endTurn(tx, "all-correct");
  }
  return done(tx);
}

/** `onPlayerRejoin`: the seat is connected again (it draws again from its next turn). */
export function onPlayerRejoin(state: DoodleState, id: PlayerId, ctx: Ctx): Step<DoodleState> {
  const p = playerOf(state, id);
  if (p === undefined || p.connected) return { state };
  const tx = begin(state, ctx);
  const me = playerOf(tx.s, id);
  if (me !== undefined) me.connected = true;
  return done(tx);
}
