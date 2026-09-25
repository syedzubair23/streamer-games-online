/**
 * Odd One Out reducers (`docs/specs/odd-one-out.md` "Rules" and "State machine"):
 *
 * ```
 * intro → [round]{deal → reveal → clues(pass p, player i)… → discuss → vote → (revote)?
 *   → accuse-reveal(pace 4000) → (last-guess)? → round-result(pace 6000)} ×rounds → final → end
 * ```
 *
 * Every reducer works on a copy of the (frozen) state and returns it with its effects; illegal
 * input returns the original state and an `illegal` fx (SPEC §9.3 rule 6). The one module timer
 * (`phase`) always ends the current phase or clue turn; `deadline` mirrors it (null when no timer
 * runs, i.e. an input phase at timerScale 0).
 *
 * @module
 */
import type { ActionCtx, Ctx, Effect, GameResult, PollResult, Step } from "@sg/engine";
import { filterText, type PlayerId } from "@sg/shared";
import { dealDeck } from "./content.ts";
import { resolveRoomSettings, type SetupContextWithRoom } from "./room.ts";
import {
  checkClue,
  clueKey,
  clueOrder,
  mastersOfDisguise,
  oddCountFor,
  passesFor,
  ranking,
  says,
  scoreRound,
  tally,
} from "./rules.ts";
import {
  CHAT_KEEP,
  INPUT,
  PACE,
  PASS_CLUE,
  QUICK_COOLDOWN_MS,
  ROUND_PHASES,
  TALK_PHASES,
  TIMER,
  type OooAction,
  type OooCard,
  type OooOptions,
  type OooRoomSettings,
  type OooRoundResult,
  type OooState,
  type Outcome,
  type Phase,
} from "./types.ts";

/** One reducer call in progress: the draft state, the effects so far and the context. */
interface Tx {
  s: OooState;
  fx: Effect[];
  ctx: Ctx;
}

/** Starts a reducer call on a deep copy of the (frozen) state. */
const begin = (state: OooState, ctx: Ctx): Tx => ({ s: structuredClone(state), fx: [], ctx });

const done = (tx: Tx): Step<OooState> => {
  tx.s.clock = tx.ctx.now;
  return tx.fx.length > 0 ? { state: tx.s, effects: tx.fx } : { state: tx.s };
};

/** The illegal-action result: state unchanged plus an `illegal` fx (SPEC §9.3). */
export const illegal = (state: OooState): Step<OooState> => ({
  state,
  effects: [{ type: "fx", name: "illegal" }],
});

// ---- Queries -----------------------------------------------------------------------------------

/** Whether `id` holds a seat in this game. */
export const isPlayer = (s: OooState, id: PlayerId): boolean => s.players.some((p) => p.id === id);

/** Whether a player is an odd one this round. */
export const isOdd = (s: OooState, id: PlayerId): boolean => s.hidden.odd.includes(id);

/** Whether a round is in progress (deal … round-result). */
export const inRound = (s: Pick<OooState, "phase">): boolean => ROUND_PHASES.includes(s.phase);

/** The player whose clue turn it is, or null outside the clues phase. */
export function currentGiver(s: OooState): PlayerId | null {
  return s.phase === "clues" ? (s.order[s.turn.idx] ?? null) : null;
}

/** Connected seats, in seat order. */
export const connected = (s: OooState): PlayerId[] =>
  s.players.filter((p) => !s.away.includes(p.id)).map((p) => p.id);

/** R5: whether a player may send a quick-chat line at game time `now`. */
export function quickReady(s: OooState, player: PlayerId, now: number): boolean {
  const last = s.quickAt[player];
  return last === undefined || now - last >= QUICK_COOLDOWN_MS;
}

/** The legal targets of a vote or revote for `voter` (R6: never yourself; revote: tied only). */
export function voteTargets(s: OooState, voter: PlayerId): PlayerId[] {
  const pool = s.phase === "revote" ? (s.tied ?? []) : s.players.map((p) => p.id);
  return pool.filter((id) => id !== voter);
}

/**
 * Whether a player's own content is part of what is on screen (G14 player idle): their role
 * card during deal/reveal, and their vote string and points from the accusation to the result.
 */
export function involves(s: OooState, player: PlayerId): boolean {
  if (!isPlayer(s, player)) return false;
  switch (s.phase) {
    case "deal":
    case "reveal":
    case "accuse-reveal":
    case "last-guess":
    case "round-result":
      return true;
    default:
      return false;
  }
}

// ---- Phase plumbing ----------------------------------------------------------------------------

function setTimer(tx: Tx, atMs: number): void {
  tx.s.deadline = atMs;
  tx.fx.push({ type: "timer.set", id: TIMER.phase, atMs });
}

/** Enters a paced phase: its timer (and deadline) after `timing.pace(ms)`. */
function pace(tx: Tx, phase: Phase, ms: number): void {
  tx.s.phase = phase;
  setTimer(tx, tx.ctx.now + tx.ctx.timing.pace(ms));
}

/** Enters an input phase with `timing.input(baseMs)`; no deadline or timer at timerScale 0. */
function input(tx: Tx, phase: Phase, baseMs: number): void {
  tx.s.phase = phase;
  const window = tx.ctx.timing.input(baseMs);
  if (window === null) {
    tx.s.deadline = null;
    tx.fx.push({ type: "timer.clear", id: TIMER.phase });
  } else {
    setTimer(tx, tx.ctx.now + window);
  }
}

// ---- Setup -------------------------------------------------------------------------------------

/**
 * `setup`: seats, the deck of round cards (R1), then the intro. With too little content the game
 * stays in `intro` with `error` set and no timer: the host sees the message and `forceAdvance`
 * ends the match unplayed (empty ranking).
 */
export function setupGame(
  ctx: SetupContextWithRoom<OooOptions>,
  roomOverride: Partial<OooRoomSettings> = {},
): Step<OooState> {
  const room = resolveRoomSettings(ctx, roomOverride);
  const options: OooOptions = { ...ctx.options, packs: [...ctx.options.packs] };
  const players = [...ctx.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({ id: p.id, name: p.name, seat: p.seat, colorSlot: p.colorSlot }));
  const zero = (): Record<PlayerId, number> => Object.fromEntries(players.map((p) => [p.id, 0]));
  const s: OooState = {
    phase: "intro",
    round: 0,
    rounds: options.rounds,
    deadline: null,
    variant: options.variant,
    options,
    room,
    players,
    away: [],
    oddCount: oddCountFor(players.length, options.oddCount),
    passes: passesFor(players.length, options.clueRounds),
    category: null,
    order: [],
    turn: { pass: 0, idx: 0 },
    clues: [],
    ready: [],
    points: Object.fromEntries(players.map((p) => [p.id, null])),
    chat: [],
    quickAt: {},
    clock: ctx.now,
    voted: [],
    hidden: { secret: "", odd: [], votes: {}, used: [], bank: [], generic: [], deck: [] },
    history: [],
    predict: null,
    scores: zero(),
    oddPoints: zero(),
    error: null,
  };
  const dealt = dealDeck(ctx.content, options, options.rounds, ctx.rng);
  if (!dealt.ok) {
    s.error = dealt.error;
    return { state: s };
  }
  s.hidden.deck = dealt.deck;
  const tx: Tx = { s, fx: [], ctx };
  pace(tx, "intro", PACE.intro);
  return { state: tx.s, effects: tx.fx };
}

// ---- Round flow ----------------------------------------------------------------------------------

/** R1: the next card, the odd ones, the clue order; then the deal. */
function startRound(tx: Tx): void {
  const { s, ctx } = tx;
  // Setup deals exactly `rounds` cards, and rounds stop there.
  const card = s.hidden.deck.shift() as OooCard;
  s.round += 1;
  s.category = card.category;
  const ids = s.players.map((p) => p.id);
  const picked = new Set(ctx.rng.shuffle(ids).slice(0, s.oddCount));
  s.order = clueOrder(s.players, ctx.rng.int(s.players.length));
  s.turn = { pass: 0, idx: 0 };
  s.clues = [];
  s.ready = [];
  s.points = Object.fromEntries(ids.map((id) => [id, null]));
  s.chat = [];
  s.quickAt = {};
  s.voted = [];
  s.predict = null;
  delete s.revealedVotes;
  delete s.accused;
  delete s.tied;
  delete s.roundResult;
  s.hidden = {
    secret: card.secret,
    odd: ids.filter((id) => picked.has(id)),
    votes: {},
    used: [
      ...s.hidden.used,
      card.category.id,
      card.secret,
      ...(card.pairKey ? [card.pairKey] : []),
    ],
    bank: card.bank,
    generic: card.generic,
    deck: s.hidden.deck,
    ...(card.decoy !== undefined ? { decoy: card.decoy } : {}),
  };
  pace(tx, "deal", PACE.deal);
  tx.fx.push({ type: "fx", name: "deal", data: { round: s.round } });
}

/** R2: the role reveal. */
function startReveal(tx: Tx): void {
  tx.s.ready = [];
  pace(tx, "reveal", PACE.reveal);
}

/** R3: the clue passes start, and with them the audience bet (Audience hooks). */
function startClues(tx: Tx): void {
  const { s, ctx } = tx;
  s.ready = [];
  s.turn = { pass: 0, idx: 0 };
  const turns = s.order.length * s.passes;
  const turnMs = ctx.timing.input(s.options.clueSec * 1000) ?? s.options.clueSec * 1000;
  const discussMs = ctx.timing.input(s.options.discussSec * 1000) ?? s.options.discussSec * 1000;
  const pollId = `predict-r${s.round}`;
  s.predict = { pollId, open: true, tallies: null, total: 0 };
  tx.fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "predict",
      prompt: "Who's the Odd One?",
      options: s.players.map((p) => ({ id: p.id, label: p.name })),
      // Closed by the game when the vote starts; this is only the latest it can run.
      closesAtMs: ctx.now + turns * turnMs + discussMs,
    },
  });
  input(tx, "clues", s.options.clueSec * 1000);
}

/** R3: the next clue turn, or the discussion once every pass is done. */
function nextTurn(tx: Tx): void {
  const { s } = tx;
  let { pass, idx } = s.turn;
  idx += 1;
  if (idx >= s.order.length) {
    idx = 0;
    pass += 1;
  }
  s.turn = { pass, idx };
  if (pass >= s.passes) startDiscuss(tx);
  else input(tx, "clues", s.options.clueSec * 1000);
}

/** R3 / R4: a clue goes on the table; saying the word ends the round at once. */
function placeClue(tx: Tx, by: PlayerId, text: string, flagged: boolean): void {
  const { s } = tx;
  s.clues.push({ by, text, pass: s.turn.pass, ...(flagged ? { flagged: true as const } : {}) });
  tx.fx.push({ type: "fx", name: "lantern", data: { by, pass: s.turn.pass } });
  if (text !== PASS_CLUE && says(text, s.hidden.secret)) {
    const odd = isOdd(s, by);
    // Undercover: an odd one saying their own (similar) word never counts (R4).
    const ownWord = odd && s.hidden.decoy !== undefined && says(text, s.hidden.decoy);
    if (!ownWord) return finishRound(tx, odd ? "odd-said-word" : "said-word", { saidBy: by });
  }
  nextTurn(tx);
}

/** R5: the discussion. */
function startDiscuss(tx: Tx): void {
  tx.s.ready = [];
  input(tx, "discuss", tx.s.options.discussSec * 1000);
}

/** Closes the round's audience bet (it closes when the vote starts). */
function closePredict(tx: Tx): void {
  const p = tx.s.predict;
  if (p === null || !p.open) return;
  p.open = false;
  tx.fx.push({ type: "audience.close", pollId: p.pollId });
}

/** R6 (and R10: a still-disconnected odd one voids the round). */
function startVote(tx: Tx): void {
  const { s } = tx;
  if (s.hidden.odd.some((o) => s.away.includes(o))) return finishRound(tx, "void", {});
  closePredict(tx);
  s.ready = [];
  s.voted = [];
  s.hidden.votes = {};
  input(tx, "vote", INPUT.vote);
}

/** R6: votes are revealed together; a plurality accuses, a tie goes to the revote. */
function endVote(tx: Tx): void {
  const { s } = tx;
  s.revealedVotes = { ...s.hidden.votes };
  const result = tally(
    s.hidden.votes,
    s.players.map((p) => p.id),
  );
  tx.fx.push({ type: "fx", name: "votes", data: { revote: false } });
  if ("accused" in result) return accuse(tx, result.accused);
  s.tied = result.tied;
  s.voted = [];
  s.hidden.votes = {};
  input(tx, "revote", INPUT.revote);
}

/** R6: the revote decides, or a second tie hands the round to the odd ones. */
function endRevote(tx: Tx): void {
  const { s } = tx;
  s.revealedVotes = { ...s.hidden.votes };
  tx.fx.push({ type: "fx", name: "votes", data: { revote: true } });
  const result = tally(s.hidden.votes, s.tied ?? []);
  if ("accused" in result) return accuse(tx, result.accused);
  finishRound(tx, "tie-twice", {});
}

function accuse(tx: Tx, accused: PlayerId): void {
  tx.s.accused = accused;
  tx.s.voted = [];
  pace(tx, "accuse-reveal", PACE.accuseReveal);
  tx.fx.push({ type: "fx", name: "strings", data: { accused } });
}

/** R7 / R8: after the accusation. */
function afterAccuse(tx: Tx): void {
  const { s } = tx;
  const accused = s.accused as PlayerId;
  if (!isOdd(s, accused)) return finishRound(tx, "innocent-accused", {});
  if (s.variant === "undercover") return finishRound(tx, "caught", {});
  input(tx, "last-guess", INPUT.lastGuess);
}

/** R7: the last guess (null when time ran out). */
function resolveGuess(tx: Tx, option: string | null): void {
  const { s } = tx;
  if (option !== null) s.hidden.guess = option;
  const stole = option !== null && clueKey(option) === clueKey(s.hidden.secret);
  finishRound(tx, stole ? "caught-stole" : "caught-wrong-guess", { guess: option });
}

/** Scores the round (R4–R8, R10), resolves the audience bet and shows the result card. */
function finishRound(
  tx: Tx,
  outcome: Outcome,
  extra: { saidBy?: PlayerId; guess?: string | null },
): void {
  const { s } = tx;
  const odd = [...s.hidden.odd];
  const points = scoreRound(outcome, {
    players: s.players.map((p) => p.id),
    odd,
    ...(extra.saidBy !== undefined ? { saidBy: extra.saidBy } : {}),
    ...(s.revealedVotes !== undefined ? { votes: s.revealedVotes } : {}),
  });
  const result: OooRoundResult = {
    round: s.round,
    word: s.hidden.secret,
    odd,
    outcome,
    points,
    ...(s.hidden.decoy !== undefined ? { decoy: s.hidden.decoy } : {}),
    ...(s.accused !== undefined && outcome !== "void" ? { accused: s.accused } : {}),
    ...(extra.guess !== undefined ? { guess: extra.guess } : {}),
    ...(extra.saidBy !== undefined ? { saidBy: extra.saidBy } : {}),
  };
  s.roundResult = result;
  s.history.push(result);
  const deltas: Record<PlayerId, number> = {};
  for (const [id, n] of Object.entries(points)) {
    if (n === 0) continue;
    deltas[id] = n;
    s.scores[id] = (s.scores[id] ?? 0) + n;
    if (odd.includes(id)) s.oddPoints[id] = (s.oddPoints[id] ?? 0) + n;
  }
  if (Object.keys(deltas).length > 0) tx.fx.push({ type: "score", deltas });
  // Audience hooks: resolve with the accused odd one, else the first odd one; a void refunds.
  const p = s.predict;
  if (p !== null) {
    closePredict(tx);
    const correct =
      outcome === "void"
        ? undefined
        : s.accused !== undefined && odd.includes(s.accused)
          ? s.accused
          : odd[0];
    tx.fx.push({
      type: "audience.resolve",
      pollId: p.pollId,
      ...(correct !== undefined ? { correct } : {}),
    });
  }
  s.ready = [];
  s.voted = [];
  pace(tx, "round-result", PACE.roundResult);
  tx.fx.push({ type: "fx", name: outcome, data: { odd } });
}

/** R9: the podium. */
function startFinal(tx: Tx): void {
  tx.s.ready = [];
  pace(tx, "final", PACE.final);
  tx.fx.push({ type: "fx", name: "win" });
}

/** R9: the final ranking (ties share the place) and the Master of Disguise highlight. */
export function gameResult(s: OooState): GameResult {
  const highlights = mastersOfDisguise(s.players, s.oddPoints).map((id) => ({
    label: "Master of Disguise",
    playerId: id,
  }));
  return {
    ranking: ranking(s.players, s.scores),
    ...(highlights.length > 0 ? { highlights } : {}),
  };
}

function endGame(tx: Tx, result: GameResult): void {
  tx.s.deadline = null;
  tx.fx.push({ type: "end", result });
}

/** What the phase timer (or the host's forceAdvance) does in each phase. */
function advancePhase(tx: Tx): void {
  const { s } = tx;
  switch (s.phase) {
    case "intro":
      if (s.error !== null) return endGame(tx, { ranking: [] });
      return startRound(tx);
    case "deal":
      return startReveal(tx);
    case "reveal":
      return startClues(tx);
    case "clues": {
      // R3: a missing clue becomes "…" (a pass).
      const by = currentGiver(s) as PlayerId;
      return placeClue(tx, by, PASS_CLUE, false);
    }
    case "discuss":
      return startVote(tx);
    case "vote":
      return endVote(tx);
    case "revote":
      return endRevote(tx);
    case "accuse-reveal":
      return afterAccuse(tx);
    case "last-guess":
      return resolveGuess(tx, null);
    case "round-result":
      return s.round < s.rounds ? startRound(tx) : startFinal(tx);
    case "final":
      return endGame(tx, gameResult(s));
  }
}

/** Phase ends early once every connected player has acted (reveal, discuss, vote, revote). */
function checkEarly(tx: Tx): void {
  const { s } = tx;
  const everyone = connected(s);
  switch (s.phase) {
    case "reveal":
      if (everyone.every((id) => s.ready.includes(id))) startClues(tx);
      return;
    case "discuss":
      if (everyone.every((id) => s.ready.includes(id))) startVote(tx);
      return;
    case "vote":
      if (everyone.every((id) => s.voted.includes(id))) endVote(tx);
      return;
    case "revote":
      if (everyone.every((id) => s.voted.includes(id))) endRevote(tx);
      return;
    default:
      return;
  }
}

// ---- Hooks ---------------------------------------------------------------------------------------

/** `onTimer`: the phase timer ends the current phase or clue turn. */
export function onTimer(state: OooState, timerId: string, ctx: Ctx): Step<OooState> {
  if (timerId !== TIMER.phase) return { state };
  const tx = begin(state, ctx);
  advancePhase(tx);
  return done(tx);
}

/** `onHostCommand`: `forceAdvance` does what the phase timer would; `skipItem` is not used. */
export function onHostCommand(
  state: OooState,
  cmd: { c: "forceAdvance" } | { c: "skipItem"; itemId: string },
  ctx: Ctx,
): Step<OooState> {
  if (cmd.c !== "forceAdvance") return { state };
  const tx = begin(state, ctx);
  advancePhase(tx);
  return done(tx);
}

/** `onAudienceResult`: the bet's final tallies freeze the sus meter. */
export function onAudienceResult(state: OooState, r: PollResult, ctx: Ctx): Step<OooState> {
  const p = state.predict;
  if (p === null || p.pollId !== r.pollId || p.tallies !== null) return { state };
  const tx = begin(state, ctx);
  const next = tx.s.predict as NonNullable<OooState["predict"]>;
  next.tallies = { ...r.tallies };
  next.total = r.total;
  next.open = false;
  return done(tx);
}

/** `onPlayerLeave` (R10): the seat is away; phases stop waiting for it. */
export function onPlayerLeave(state: OooState, id: PlayerId, ctx: Ctx): Step<OooState> {
  if (!isPlayer(state, id) || state.away.includes(id)) return { state };
  const tx = begin(state, ctx);
  tx.s.away.push(id);
  checkEarly(tx);
  return done(tx);
}

/** `onPlayerRejoin` (R10): back before the vote keeps the round alive. */
export function onPlayerRejoin(state: OooState, id: PlayerId, ctx: Ctx): Step<OooState> {
  if (!state.away.includes(id)) return { state };
  const tx = begin(state, ctx);
  tx.s.away = tx.s.away.filter((a) => a !== id);
  return done(tx);
}

/** A clue refused for its text: state unchanged, a private "try another" cue, `illegal` fx. */
const refuseClue = (state: OooState, to: PlayerId, reason: string): Step<OooState> => ({
  state,
  effects: [
    { type: "private", to, name: "clue-rejected", data: { reason } },
    { type: "fx", name: "illegal" },
  ],
});

/** `onAction`: every player action (spec Types); anything out of place is illegal. */
export function onAction(state: OooState, action: OooAction, ctx: ActionCtx): Step<OooState> {
  const me = ctx.actor.id;
  if (ctx.actor.role !== "player" || !isPlayer(state, me)) return illegal(state);
  const s = state;
  switch (action.type) {
    case "gotIt": {
      if (s.phase !== "reveal" || s.ready.includes(me)) return illegal(state);
      const tx = begin(state, ctx);
      tx.s.ready.push(me);
      checkEarly(tx);
      return done(tx);
    }
    case "clue": {
      if (currentGiver(s) !== me) return illegal(state);
      const check = checkClue(action.text);
      if (!check.ok) return refuseClue(state, me, check.reason);
      const filtered = filterText(check.text, s.room.contentFilter);
      if (filtered.flagged && s.room.contentFilter === "family") {
        return refuseClue(state, me, "filtered");
      }
      const tx = begin(state, ctx);
      placeClue(tx, me, check.text, filtered.flagged);
      return done(tx);
    }
    case "ready": {
      if (s.phase !== "discuss" || s.ready.includes(me)) return illegal(state);
      const tx = begin(state, ctx);
      tx.s.ready.push(me);
      checkEarly(tx);
      return done(tx);
    }
    case "vote": {
      if (s.phase !== "vote" && s.phase !== "revote") return illegal(state);
      if (s.voted.includes(me) || !voteTargets(s, me).includes(action.target)) {
        return illegal(state);
      }
      const tx = begin(state, ctx);
      tx.s.hidden.votes[me] = action.target;
      tx.s.voted.push(me);
      checkEarly(tx);
      return done(tx);
    }
    case "guess": {
      if (s.phase !== "last-guess" || s.accused !== me) return illegal(state);
      const option = s.category?.options.find((o) => o === action.option);
      if (option === undefined) return illegal(state);
      const tx = begin(state, ctx);
      resolveGuess(tx, option);
      return done(tx);
    }
    case "point": {
      if (!TALK_PHASES.includes(s.phase)) return illegal(state);
      const { target } = action;
      if (target !== null && (target === me || !isPlayer(s, target))) return illegal(state);
      if ((s.points[me] ?? null) === target) return illegal(state);
      const tx = begin(state, ctx);
      tx.s.points[me] = target;
      return done(tx);
    }
    case "quick": {
      if (!TALK_PHASES.includes(s.phase) || !quickReady(s, me, ctx.now)) return illegal(state);
      const tx = begin(state, ctx);
      tx.s.chat = [...tx.s.chat, { by: me, line: action.line, at: ctx.now }].slice(-CHAT_KEEP);
      tx.s.quickAt[me] = ctx.now;
      tx.fx.push({ type: "fx", name: "bubble", data: { by: me, line: action.line } });
      return done(tx);
    }
  }
}
