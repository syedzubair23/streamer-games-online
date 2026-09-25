/**
 * Quip Clash reducers (`docs/specs/quip-clash.md` "Rules" and "State machine"):
 *
 * ```
 * intro(pace 6000) → r1:answer → r1:matchup[i]{show-prompt → show-answers → (review-wait)? →
 *   vote → results} ×N → r1:scores(pace 5000) → r2:… → r2:scores → r3:answer →
 *   r3:show-all(pace 3000) → (review-wait)? → r3:vote → r3:results(pace 7000) → final(pace 9000)
 *   → end
 * ```
 *
 * Every reducer works on a JSON copy of the (frozen) state and returns it with its effects;
 * illegal input returns the original state and an `illegal` fx (SPEC §9.3 rule 6).
 *
 * @module
 */
import type { ActionCtx, Ctx, Effect, GameResult, PollResult, Step } from "@sg/engine";
import type { PlayerId } from "@sg/shared";
import { resolveRoomSettings, type SetupContextWithRoom } from "./room.ts";
import {
  assignRound,
  authorOf,
  buildAuthors,
  cleanAnswer,
  isJinx,
  promptsNeeded,
  ranking,
  roundsFor,
  roundWinner,
  scoreAutoWin,
  scoreJinx,
  scoreLastQuip,
  scoreMatchup,
  selectPrompts,
  slotId,
} from "./rules.ts";
import {
  AUDIENCE_WAIT_MS,
  AWAY_SAFETY_LEAD_MS,
  LAST_QUIP_ANSWER_MS,
  LAST_QUIP_HEARTS,
  LOW_AUTHORS_MS,
  PACE,
  REVIEW_TIMEOUT_MS,
  TIMER,
  type AuthorId,
  type Phase,
  type QcAction,
  type QcAnswer,
  type QcAudiencePoll,
  type QcHighlight,
  type QcOptions,
  type QcPrompt,
  type QcResult,
  type QcRoomSettings,
  type QcState,
} from "./types.ts";

/** One reducer call in progress: the draft state, the effects so far and the context. */
interface Tx {
  s: QcState;
  fx: Effect[];
  ctx: Ctx;
}

const mapValues = <T, U>(rec: Record<string, T>, f: (v: T) => U): Record<string, U> => {
  const out: Record<string, U> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = f(v);
  return out;
};

/**
 * Starts a reducer call on a copy of the (frozen) state. Only the containers reducers mutate
 * are copied; everything else (prompts, players, authors, options, stored results, ballots,
 * answer objects) is shared and only ever replaced, never mutated. The runner deep-freezes
 * state in dev, so a stray mutation of a shared part throws in tests.
 */
const begin = (state: QcState, ctx: Ctx): Tx => ({
  s: {
    ...state,
    hidden: {
      answers: mapValues(state.hidden.answers, (byAuthor) => ({ ...byAuthor })),
      safetyPool: mapValues(state.hidden.safetyPool, (pool) => [...pool]),
    },
    revealed: mapValues(state.revealed, (r) => ({
      answers: { ...r.answers },
      flagged: [...r.flagged],
      edited: [...r.edited],
    })),
    order: [...state.order],
    votes: { ...state.votes },
    results: { ...state.results },
    scores: { ...state.scores },
    quipOuts: { ...state.quipOuts },
    safetyUsed: { ...state.safetyUsed },
    roundPoints: { ...state.roundPoints },
    modItems: { ...state.modItems },
    away: [...state.away],
    aud: state.aud === null ? null : { ...state.aud },
    predict: state.predict === null ? null : { ...state.predict },
  },
  fx: [],
  ctx,
});

const done = (tx: Tx): Step<QcState> =>
  tx.fx.length > 0 ? { state: tx.s, effects: tx.fx } : { state: tx.s };

/** The illegal-action result: state unchanged plus an `illegal` fx (SPEC §9.3). */
export const illegal = (state: QcState): Step<QcState> => ({
  state,
  effects: [{ type: "fx", name: "illegal" }],
});

// ---- Queries -----------------------------------------------------------------------------------

/** The prompts of the current round, in play order. */
export function roundPrompts(s: Pick<QcState, "prompts" | "round">): QcPrompt[] {
  return s.prompts.filter((p) => p.round === s.round);
}

/** The prompt on screen: the current matchup's, or Last Quip's in round 3. */
export function currentPrompt(s: Pick<QcState, "prompts" | "round" | "matchup">): QcPrompt {
  return roundPrompts(s)[s.round === 3 ? 0 : s.matchup] as QcPrompt;
}

/** An author's current answer to a prompt, if any. */
export function answerOf(s: QcState, promptId: string, author: AuthorId): QcAnswer | undefined {
  return s.hidden.answers[promptId]?.[author];
}

/** Whether an author has answered every one of their prompts this round. */
export function authorDone(s: QcState, author: AuthorId): boolean {
  return roundPrompts(s)
    .filter((p) => p.authors.includes(author))
    .every((p) => answerOf(s, p.id, author) !== undefined);
}

/** R3: every author has submitted all their prompts. */
export function answerComplete(s: QcState): boolean {
  return s.authors.every((a) => authorDone(s, a.id));
}

/** Whether a player may vote in the current vote (R6, R11). */
export function isEligible(s: QcState, player: PlayerId): boolean {
  const author = authorOf(s, player);
  if (author === null) return false;
  return s.round === 3 || !currentPrompt(s).authors.includes(author.id);
}

/** R6/R11: every connected eligible player has voted (or allocated all 3 hearts). */
export function voteComplete(s: QcState): boolean {
  return s.players
    .filter((p) => !s.away.includes(p.id) && isEligible(s, p.id))
    .every((p) => s.votes[p.id] !== undefined);
}

/** Whether any answer to `prompt` still waits for moderation (R13). */
export function pendingIn(s: QcState, prompt: QcPrompt): boolean {
  return prompt.authors.some((a) => answerOf(s, prompt.id, a)?.mod === "pending");
}

/** Whether a player's own content is on screen (a reveal involving them; G14 player idle). */
export function involves(s: QcState, player: PlayerId): boolean {
  const author = authorOf(s, player);
  if (author === null) return false;
  switch (s.phase) {
    case "show-prompt":
    case "show-answers":
    case "review-wait":
    case "vote":
    case "results":
      return s.round !== 3 && currentPrompt(s).authors.includes(author.id);
    default:
      return false;
  }
}

const connectedAuthors = (s: QcState): number =>
  s.authors.filter((a) => a.members.some((m) => !s.away.includes(m))).length;

// ---- Phase plumbing ----------------------------------------------------------------------------

/** Enters a paced phase: no deadline, the phase timer after `ms`. */
function pace(tx: Tx, phase: Phase, ms: number): void {
  tx.s.phase = phase;
  tx.s.deadline = null;
  tx.fx.push({ type: "timer.set", id: TIMER.phase, atMs: tx.ctx.now + tx.ctx.timing.pace(ms) });
}

/**
 * Enters an input phase with `timing.input(baseMs)` (no deadline and no timer at timerScale 0).
 * Returns when the matching audience poll should nominally close.
 */
function inputPhase(tx: Tx, phase: Phase, baseMs: number): number {
  tx.s.phase = phase;
  const window = tx.ctx.timing.input(baseMs);
  if (window === null) {
    tx.s.deadline = null;
    tx.fx.push({ type: "timer.clear", id: TIMER.phase });
    return tx.ctx.now + baseMs;
  }
  tx.s.deadline = tx.ctx.now + window;
  tx.fx.push({ type: "timer.set", id: TIMER.phase, atMs: tx.s.deadline });
  return tx.s.deadline;
}

// ---- Setup ---------------------------------------------------------------------------------------

/**
 * `setup`: authors and team mode (R1), prompt selection and the R2 assignment for every round,
 * safety pools, then the intro. With too few prompts the game stays in `intro` with `error`
 * set and no timer: the host sees the message and `forceAdvance` ends the game unplayed.
 */
export function setupGame(
  ctx: SetupContextWithRoom<QcOptions>,
  roomOverride: Partial<QcRoomSettings> = {},
): Step<QcState> {
  const room = resolveRoomSettings(ctx, roomOverride);
  const options: QcOptions = { ...ctx.options, packs: [...ctx.options.packs] };
  const { authors, teamMode, teamNote } = buildAuthors(ctx.players, ctx.teams);
  const players = [...ctx.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      colorSlot: p.colorSlot,
      ...(p.teamId !== undefined ? { teamId: p.teamId } : {}),
    }));
  const zero = (): Record<AuthorId, number> => Object.fromEntries(authors.map((a) => [a.id, 0]));
  const s: QcState = {
    phase: "intro",
    round: 1,
    matchup: 0,
    deadline: null,
    closing: false,
    players,
    authors,
    teamMode,
    teamNote,
    prompts: [],
    hidden: { answers: {}, safetyPool: {} },
    revealed: {},
    order: [],
    votes: {},
    results: {},
    scores: zero(),
    quipOuts: zero(),
    safetyUsed: {},
    roundPoints: {},
    options,
    room,
    modItems: {},
    modSeq: 0,
    away: [],
    lowSince: null,
    endPrompt: false,
    aud: null,
    predict: null,
    error: null,
    highlights: [],
  };
  const selection = selectPrompts(
    ctx.content,
    options,
    room,
    promptsNeeded(authors.length, options),
    ctx.rng,
  );
  if (!selection.ok) {
    s.error = selection.error;
    return { state: s };
  }
  const ids = authors.map((a) => a.id);
  let next = 0;
  for (const round of roundsFor(options)) {
    if (round === 3) {
      const item = selection.items[next] as (typeof selection.items)[number];
      s.prompts.push({ id: item.id, text: item.text, authors: [...ids], round });
      next += 1;
    } else {
      s.prompts.push(
        ...assignRound(ids, selection.items.slice(next, next + ids.length), round, ctx.rng),
      );
      next += ids.length;
    }
  }
  for (const item of selection.items) {
    s.hidden.answers[item.id] = {};
    s.hidden.safetyPool[item.id] = ctx.rng.shuffle(item.safety);
  }
  const tx: Tx = { s, fx: [], ctx };
  pace(tx, "intro", PACE.intro);
  return done(tx);
}

// ---- Answer phase (R3, R3a, R4, R14) ----------------------------------------------------------

function startAnswer(tx: Tx): void {
  const { s } = tx;
  s.votes = {};
  s.roundPoints = {};
  s.aud = null;
  s.closing = false;
  s.matchup = 0;
  const base = s.round === 3 ? LAST_QUIP_ANSWER_MS : s.options.answerSec * 1000;
  const closesAtMs = inputPhase(tx, "answer", base);
  const pollId = `predict-r${s.round}`;
  s.predict = { pollId, round: s.round, open: true, tallies: null, total: 0 };
  tx.fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "predict",
      prompt: s.round === 3 ? "Who wins Last Quip?" : "Who wins this round?",
      options: s.authors.map((a) => ({ id: a.id, label: a.name })),
      closesAtMs,
      closeOn: "event",
    },
  });
  if (s.deadline !== null) {
    tx.fx.push({
      type: "timer.set",
      id: TIMER.away,
      atMs: Math.max(tx.ctx.now, s.deadline - AWAY_SAFETY_LEAD_MS),
    });
  }
}

/** The distinct safety lines other authors currently hold for a prompt. */
function heldSafety(s: QcState, promptId: string, except: AuthorId): string[] {
  const out: string[] = [];
  for (const [author, ans] of Object.entries(s.hidden.answers[promptId] ?? {})) {
    if (author !== except && ans.safety && !out.includes(ans.text)) out.push(ans.text);
  }
  return out;
}

/**
 * Takes a random safety line of a prompt's pack item for `author` (R3). Each of the item's
 * lines is always either in the (shuffled) pool or held by an answer. Lines come from the pool
 * without replacement while any are left, so the two authors of a matchup never get the same
 * line (no accidental JINX). Once all are held (only in Last Quip, with more than 3 takers) the
 * line is a random one of those other authors hold, so Safety, the R13 replacement and the R14
 * fill always get a line.
 */
function takeSafety(tx: Tx, promptId: string, author: AuthorId): string {
  const pool = tx.s.hidden.safetyPool[promptId] as string[];
  const next = pool.shift();
  return next ?? tx.ctx.rng.pick(heldSafety(tx.s, promptId, author));
}

/** Returns an author's safety line to the pool, unless another author still holds it. */
function returnSafety(s: QcState, promptId: string, author: AuthorId, line: string): void {
  const pool = s.hidden.safetyPool[promptId] as string[];
  if (!pool.includes(line) && !heldSafety(s, promptId, author).includes(line)) pool.push(line);
}

/** Clears an author's answer to a prompt: returns a safety line to the pool, drops its mod item. */
function releaseAnswer(s: QcState, promptId: string, author: AuthorId): void {
  const prev = answerOf(s, promptId, author);
  if (prev?.safety === true) returnSafety(s, promptId, author, prev.text);
  for (const [id, item] of Object.entries(s.modItems)) {
    if (item.promptId === promptId && item.author === author) delete s.modItems[id];
  }
}

/** R14: fills every missing answer of a fully disconnected author with a safety quip. */
function fillAway(tx: Tx): boolean {
  const { s } = tx;
  let changed = false;
  for (const a of s.authors) {
    if (!a.members.every((m) => s.away.includes(m))) continue;
    for (const p of roundPrompts(s)) {
      if (!p.authors.includes(a.id) || answerOf(s, p.id, a.id) !== undefined) continue;
      const answer: QcAnswer = {
        text: takeSafety(tx, p.id, a.id),
        safety: true,
        mod: "ok",
        flagged: false,
        masked: false,
      };
      submitAnswer(tx, p.id, a.id, answer, a.members[0] as PlayerId);
      changed = true;
    }
  }
  return changed;
}

/**
 * Stores a submitted answer (typed, Safety Quip, or the R14 bot's safety quip). Under
 * reveal-review every submitted answer is queued for review with a `moderate` fx (R13).
 */
function submitAnswer(
  tx: Tx,
  promptId: string,
  author: AuthorId,
  answer: QcAnswer,
  ownerId: PlayerId,
): void {
  const { s } = tx;
  const review = s.room.moderation === "reveal-review";
  const stored: QcAnswer = { ...answer, mod: review ? "pending" : "ok" };
  (s.hidden.answers[promptId] as Record<AuthorId, QcAnswer>)[author] = stored;
  if (!review) return;
  s.modSeq += 1;
  const itemId = `m${s.modSeq}`;
  s.modItems[itemId] = { promptId, author };
  tx.fx.push({ type: "moderate", itemId, kind: "text", ownerId, preview: stored.text });
}

function closePredict(tx: Tx): void {
  const p = tx.s.predict;
  if (p?.open === true) {
    p.open = false;
    tx.fx.push({ type: "audience.close", pollId: p.pollId });
  }
}

function resolvePredict(tx: Tx): void {
  const p = tx.s.predict as NonNullable<QcState["predict"]>;
  const winner = roundWinner(tx.s) as AuthorId;
  tx.fx.push({ type: "audience.resolve", pollId: p.pollId, correct: winner });
}

function endAnswer(tx: Tx): void {
  fillAway(tx);
  tx.fx.push({ type: "timer.clear", id: TIMER.away });
  // R3a: the predict poll closes as the first reveal of the round starts.
  closePredict(tx);
  if (tx.s.round === 3) startShowAll(tx);
  else startMatchup(tx, 0);
}

// ---- Matchups (R5–R10, R13) ----------------------------------------------------------------------

function startMatchup(tx: Tx, from: number): void {
  const { s } = tx;
  const list = roundPrompts(s);
  for (let i = from; i < list.length; i++) {
    const p = list[i] as QcPrompt;
    // R10: both answers blank, the matchup is skipped.
    if (p.authors.every((a) => answerOf(s, p.id, a) === undefined)) continue;
    s.matchup = i;
    s.votes = {};
    s.aud = null;
    s.closing = false;
    pace(tx, "show-prompt", PACE.showPrompt);
    return;
  }
  startScores(tx);
}

/** Copies an answer into `revealed` (pending answers stay hidden; blank ones are dropped). */
function revealAnswer(s: QcState, promptId: string, author: AuthorId): void {
  const rev = (s.revealed[promptId] ??= { answers: {}, flagged: [], edited: [] });
  const ans = answerOf(s, promptId, author);
  if (ans === undefined) {
    delete rev.answers[author];
    return;
  }
  if (ans.mod === "pending") return;
  rev.answers[author] = ans.text;
  if (ans.flagged && !rev.flagged.includes(author)) rev.flagged.push(author);
  if (ans.mod === "edited" && !rev.edited.includes(author)) rev.edited.push(author);
}

function revealPrompt(s: QcState, prompt: QcPrompt): void {
  s.revealed[prompt.id] ??= { answers: {}, flagged: [], edited: [] };
  for (const a of prompt.authors) revealAnswer(s, prompt.id, a);
}

function showAnswers(tx: Tx): void {
  pace(tx, "show-answers", PACE.showAnswers);
  revealPrompt(tx.s, currentPrompt(tx.s));
}

function startShowAll(tx: Tx): void {
  const { s } = tx;
  const p = currentPrompt(s);
  s.order = tx.ctx.rng.shuffle(p.authors.filter((a) => answerOf(s, p.id, a) !== undefined));
  s.votes = {};
  s.aud = null;
  s.closing = false;
  pace(tx, "show-all", PACE.showAll);
  revealPrompt(s, p);
}

/** After the reveal: wait for moderation (R13), else go on to the vote or straight to results. */
function afterReveal(tx: Tx): void {
  if (pendingIn(tx.s, currentPrompt(tx.s))) {
    tx.s.phase = "review-wait";
    tx.s.deadline = null;
    tx.fx.push({
      type: "timer.set",
      id: TIMER.phase,
      atMs: tx.ctx.now + tx.ctx.timing.pace(REVIEW_TIMEOUT_MS),
    });
    return;
  }
  decide(tx);
}

/** R9/R10/R11: blank or JINX go straight to results; otherwise the vote opens. */
function decide(tx: Tx): void {
  const { s } = tx;
  const p = currentPrompt(s);
  if (s.round === 3) {
    s.order = s.order.filter((a) => answerOf(s, p.id, a) !== undefined);
    if (s.order.length < 2) startResults(tx);
    else startVote(tx);
    return;
  }
  const [a, b] = p.authors as [AuthorId, AuthorId];
  const ansA = answerOf(s, p.id, a);
  const ansB = answerOf(s, p.id, b);
  if (ansA === undefined || ansB === undefined || isJinx(ansA.text, ansB.text)) startResults(tx);
  else startVote(tx);
}

function startVote(tx: Tx): void {
  const { s } = tx;
  const r3 = s.round === 3;
  const p = currentPrompt(s);
  const base = r3 ? s.options.voteSec * 1.5 * 1000 : s.options.voteSec * 1000;
  const closesAtMs = inputPhase(tx, "vote", base);
  s.votes = {};
  s.closing = false;
  const pollId = r3 ? "vote-r3" : `vote-r${s.round}-m${s.matchup + 1}`;
  s.aud = { pollId, closeRequested: false, result: null };
  tx.fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "vote",
      prompt: p.text,
      options: r3
        ? s.order.map((_, i) => ({ id: slotId(i), label: `Answer ${i + 1}` }))
        : [
            { id: "A", label: "Answer A" },
            { id: "B", label: "Answer B" },
          ],
      closesAtMs,
    },
  });
  // R6/R11: no connected eligible voter is left (e.g. the only voter is away), so the players'
  // vote is already complete. The platform still holds the audience poll for its minimum window.
  if (voteComplete(s)) endVote(tx);
}

/**
 * The players' vote is over (deadline, everyone voted, or the host). Asks the platform to close
 * the audience poll (the runner holds an early close for the minimum audience window) and waits
 * for its result, at most {@link AUDIENCE_WAIT_MS}.
 */
function endVote(tx: Tx): void {
  const { s } = tx;
  const aud = s.aud as QcAudiencePoll;
  s.closing = true;
  if (aud.result !== null) {
    startResults(tx);
    return;
  }
  if (!aud.closeRequested) {
    aud.closeRequested = true;
    tx.fx.push({ type: "audience.close", pollId: aud.pollId });
  }
  tx.fx.push({
    type: "timer.set",
    id: TIMER.phase,
    atMs: tx.ctx.now + tx.ctx.timing.pace(AUDIENCE_WAIT_MS),
  });
}

function scoreCurrent(s: QcState): QcResult {
  const p = currentPrompt(s);
  const aud = s.aud?.result ?? null;
  const { audienceMin } = s.room;
  const weight = s.options.audienceWeight;
  if (s.round === 3) {
    const votes: Record<AuthorId, number> = {};
    for (const ballot of Object.values(s.votes)) {
      if (typeof ballot === "string") continue;
      for (const [slot, n] of Object.entries(ballot)) {
        const author = s.order[Number(slot.slice(1)) - 1] as AuthorId;
        votes[author] = (votes[author] ?? 0) + n;
      }
    }
    return scoreLastQuip({ shown: s.order, votes, aud, audienceMin, weight });
  }
  const [a, b] = p.authors as [AuthorId, AuthorId];
  const ansA = answerOf(s, p.id, a);
  const ansB = answerOf(s, p.id, b);
  if (ansA === undefined) return scoreAutoWin(b, a, s.round);
  if (ansB === undefined) return scoreAutoWin(a, b, s.round);
  if (isJinx(ansA.text, ansB.text)) return scoreJinx(a, b);
  const ballots = Object.values(s.votes);
  return scoreMatchup({
    a,
    b,
    votesA: ballots.filter((v) => v === "A").length,
    votesB: ballots.filter((v) => v === "B").length,
    aud,
    audienceMin,
    weight,
    round: s.round,
  });
}

function startResults(tx: Tx): void {
  const { s } = tx;
  const p = currentPrompt(s);
  const result = scoreCurrent(s);
  s.results[p.id] = result;
  const deltas: Record<AuthorId, number> = {};
  for (const [author, pts] of Object.entries(result.points)) {
    if (pts <= 0) continue;
    s.scores[author] = (s.scores[author] ?? 0) + pts;
    s.roundPoints[author] = (s.roundPoints[author] ?? 0) + pts;
    deltas[author] = pts;
  }
  if (Object.keys(deltas).length > 0) tx.fx.push({ type: "score", deltas });
  if (result.quipOut !== undefined) {
    s.quipOuts[result.quipOut] = (s.quipOuts[result.quipOut] ?? 0) + 1;
    tx.fx.push({ type: "fx", name: "quipout", data: { author: result.quipOut } });
  }
  if (result.jinx === true) tx.fx.push({ type: "fx", name: "jinx" });
  s.closing = false;
  if (s.round === 3) {
    pace(tx, "results", PACE.lastResults);
    resolvePredict(tx);
  } else {
    pace(tx, "results", PACE.results);
  }
}

function startScores(tx: Tx): void {
  const { s } = tx;
  s.aud = null;
  s.votes = {};
  pace(tx, "scores", PACE.scores);
  resolvePredict(tx);
}

// ---- Final (R12) -------------------------------------------------------------------------------

function highlights(s: QcState): QcHighlight[] {
  const out: QcHighlight[] = [];
  let fav: { author: AuthorId; share: number; text: string } | null = null;
  for (const p of s.prompts) {
    const r = s.results[p.id];
    if (r?.audShare === undefined || !r.audienceCounted) continue;
    for (const [author, share] of Object.entries(r.audShare)) {
      const text = s.revealed[p.id]?.answers[author];
      if (text !== undefined && (fav === null || share > fav.share)) fav = { author, share, text };
    }
  }
  if (fav !== null) {
    out.push({
      kind: "audience-favourite",
      label: `Audience Favourite: "${fav.text}"`,
      author: fav.author,
      text: fav.text,
    });
  }
  let king: AuthorId | null = null;
  for (const a of s.authors) {
    const n = s.quipOuts[a.id] ?? 0;
    if (n > 0 && (king === null || n > (s.quipOuts[king] ?? 0))) king = a.id;
  }
  if (king !== null) out.push({ kind: "quip-out-king", label: "Quip-Out King", author: king });
  return out;
}

function startFinal(tx: Tx): void {
  const { s } = tx;
  s.highlights = highlights(s);
  s.aud = null;
  s.votes = {};
  pace(tx, "final", PACE.final);
  tx.fx.push({ type: "fx", name: "win", data: { author: ranking(s)[0]?.id ?? null } });
}

/** The platform result: ranking plus highlights (`playerId` for solo authors). */
export function gameResult(s: QcState): GameResult {
  if (s.error !== null) return { ranking: [] };
  const solo = !s.teamMode;
  return {
    ranking: ranking(s),
    highlights: s.highlights.map((h) =>
      solo
        ? { label: h.label, playerId: h.author }
        : { label: `${h.label} (${nameOf(s, h.author)})` },
    ),
  };
}

const nameOf = (s: QcState, author: AuthorId): string =>
  (s.authors.find((a) => a.id === author) as QcState["authors"][number]).name;

function endGame(tx: Tx): void {
  tx.s.deadline = null;
  tx.s.closing = false;
  tx.fx.push({ type: "timer.clear", id: TIMER.phase });
  tx.fx.push({ type: "timer.clear", id: TIMER.away });
  tx.fx.push({ type: "timer.clear", id: TIMER.low });
  tx.fx.push({ type: "end", result: gameResult(tx.s) });
}

// ---- Moderation (R13) ---------------------------------------------------------------------------

/** A rejected (or timed-out) answer becomes a safety quip marked "edited by host" (R13). */
function rejectAnswer(tx: Tx, promptId: string, author: AuthorId): void {
  const answers = tx.s.hidden.answers[promptId] as Record<AuthorId, QcAnswer>;
  const prev = answers[author];
  // Draw first: a rejected safety line goes back afterwards, so its replacement differs.
  const text = takeSafety(tx, promptId, author);
  if (prev?.safety === true) returnSafety(tx.s, promptId, author, prev.text);
  answers[author] = { text, safety: true, mod: "edited", flagged: false, masked: false };
}

function rejectPendingCurrent(tx: Tx): void {
  const { s } = tx;
  const p = currentPrompt(s);
  for (const [id, item] of Object.entries(s.modItems)) {
    if (item.promptId !== p.id) continue;
    delete s.modItems[id];
    rejectAnswer(tx, p.id, item.author);
    revealAnswer(s, p.id, item.author);
  }
}

// ---- Advancing -----------------------------------------------------------------------------------

/** The phase timer fired, or the host forced the phase on. */
function advancePhase(tx: Tx): void {
  const { s } = tx;
  switch (s.phase) {
    case "intro":
      startAnswer(tx);
      return;
    case "answer":
      endAnswer(tx);
      return;
    case "show-prompt":
      showAnswers(tx);
      return;
    case "show-answers":
    case "show-all":
      afterReveal(tx);
      return;
    case "review-wait":
      rejectPendingCurrent(tx);
      decide(tx);
      return;
    case "vote":
      if (s.closing) startResults(tx);
      else endVote(tx);
      return;
    case "results":
      if (s.round === 3) startFinal(tx);
      else startMatchup(tx, s.matchup + 1);
      return;
    case "scores": {
      const rounds = roundsFor(s.options);
      s.round = rounds[rounds.indexOf(s.round) + 1] as QcState["round"];
      startAnswer(tx);
      return;
    }
    case "final":
      endGame(tx);
      return;
  }
}

// ---- Hooks ---------------------------------------------------------------------------------------

/** `onTimer`: the phase timer, the R14 disconnect safety fill, and the R14 low-author prompt. */
export function onTimer(state: QcState, timerId: string, ctx: Ctx): Step<QcState> {
  if (timerId === TIMER.away) {
    if (state.phase !== "answer") return { state };
    const tx = begin(state, ctx);
    if (!fillAway(tx)) return { state };
    if (answerComplete(tx.s)) endAnswer(tx);
    return done(tx);
  }
  if (timerId === TIMER.low) {
    if (state.lowSince === null || state.endPrompt) return { state };
    const tx = begin(state, ctx);
    tx.s.endPrompt = true;
    tx.fx.push({ type: "fx", name: "end-prompt" });
    return done(tx);
  }
  if (timerId !== TIMER.phase || state.error !== null) return { state };
  const tx = begin(state, ctx);
  advancePhase(tx);
  return done(tx);
}

/**
 * `onHostCommand`: `forceAdvance` moves the current phase on (in `vote` the result is computed
 * from the votes so far; in `review-wait` pending answers count as rejected). When the host was
 * prompted to end early (R14), or setup had too few prompts, it ends the game.
 */
export function onHostCommand(
  state: QcState,
  cmd: { c: "forceAdvance" } | { c: "skipItem"; itemId: string },
  ctx: Ctx,
): Step<QcState> {
  if (cmd.c !== "forceAdvance") return { state };
  const tx = begin(state, ctx);
  if (state.error !== null || state.endPrompt) endGame(tx);
  else advancePhase(tx);
  return done(tx);
}

/** `onAudienceResult`: the matchup / Last Quip vote result, or the round-winner predict tallies. */
export function onAudienceResult(state: QcState, r: PollResult, ctx: Ctx): Step<QcState> {
  const tallies: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.tallies)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) tallies[k] = v;
  }
  const total = Number.isFinite(r.total) && r.total > 0 ? r.total : 0;
  if (state.aud?.pollId === r.pollId && state.aud.result === null) {
    const tx = begin(state, ctx);
    (tx.s.aud as QcAudiencePoll).result = { total, tallies };
    if (tx.s.phase === "vote" && tx.s.closing) startResults(tx);
    return done(tx);
  }
  if (state.predict?.pollId === r.pollId && state.predict.tallies === null) {
    const tx = begin(state, ctx);
    const p = tx.s.predict as NonNullable<QcState["predict"]>;
    p.tallies = tallies;
    p.total = total;
    p.open = false;
    return done(tx);
  }
  return { state };
}

/** `onModeration` (R13): approve reveals the answer; reject swaps in a safety quip. */
export function onModeration(
  state: QcState,
  itemId: string,
  approved: boolean,
  ctx: Ctx,
): Step<QcState> {
  const item = Object.hasOwn(state.modItems, itemId) ? state.modItems[itemId] : undefined;
  if (item === undefined) return { state };
  const tx = begin(state, ctx);
  const { s } = tx;
  delete s.modItems[itemId];
  if (approved) {
    const answers = s.hidden.answers[item.promptId] as Record<AuthorId, QcAnswer>;
    answers[item.author] = { ...(answers[item.author] as QcAnswer), mod: "ok" };
  } else rejectAnswer(tx, item.promptId, item.author);
  if (s.revealed[item.promptId] !== undefined) revealAnswer(s, item.promptId, item.author);
  if (s.phase === "review-wait" && !pendingIn(s, currentPrompt(s))) decide(tx);
  return done(tx);
}

/** R14 bookkeeping: fewer than 3 connected authors starts (or a rejoin cancels) the 30 s prompt. */
function trackLow(tx: Tx): void {
  const { s } = tx;
  if (connectedAuthors(s) < 3) {
    if (s.lowSince === null) {
      s.lowSince = tx.ctx.now;
      tx.fx.push({ type: "timer.set", id: TIMER.low, atMs: tx.ctx.now + LOW_AUTHORS_MS });
    }
  } else if (s.lowSince !== null) {
    s.lowSince = null;
    s.endPrompt = false;
    tx.fx.push({ type: "timer.clear", id: TIMER.low });
  }
}

/** `onPlayerLeave` (R14). */
export function onPlayerLeave(state: QcState, id: PlayerId, ctx: Ctx): Step<QcState> {
  if (state.away.includes(id) || !state.players.some((p) => p.id === id)) return { state };
  const tx = begin(state, ctx);
  const { s } = tx;
  s.away.push(id);
  trackLow(tx);
  if (s.phase === "answer") {
    // Less than 10 s left: the safety quips go in at once (R14).
    if (s.deadline !== null && s.deadline - ctx.now <= AWAY_SAFETY_LEAD_MS) fillAway(tx);
    if (answerComplete(s)) endAnswer(tx);
  } else if (s.phase === "vote" && !s.closing && voteComplete(s)) {
    endVote(tx);
  }
  return done(tx);
}

/** `onPlayerRejoin` (R14). */
export function onPlayerRejoin(state: QcState, id: PlayerId, ctx: Ctx): Step<QcState> {
  if (!state.away.includes(id)) return { state };
  const tx = begin(state, ctx);
  tx.s.away = tx.s.away.filter((p) => p !== id);
  trackLow(tx);
  return done(tx);
}

// ---- Actions (R3, R6, R11) -----------------------------------------------------------------------

/** Validates a Last Quip allocation (R11) and returns it without zero entries, or null. */
function checkAlloc(
  s: QcState,
  author: AuthorId,
  alloc: Record<string, number>,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [slot, n] of Object.entries(alloc)) {
    const index = Number(slot.slice(1)) - 1;
    const target = s.order[index];
    if (target === undefined) return null;
    if (n === 0) continue;
    if (target === author) return null;
    out[slot] = n;
    sum += n;
  }
  return sum === LAST_QUIP_HEARTS ? out : null;
}

/** `onAction`: answers and safety quips (R3), matchup votes (R6), Last Quip hearts (R11). */
export function onAction(state: QcState, action: QcAction, ctx: ActionCtx): Step<QcState> {
  if (ctx.actor.role !== "player") return illegal(state);
  const author = authorOf(state, ctx.actor.id);
  if (author === null) return illegal(state);
  switch (action.type) {
    case "answer":
    case "safety": {
      if (state.phase !== "answer") return illegal(state);
      const prompt = roundPrompts(state).find((p) => p.id === action.promptId);
      if (prompt === undefined || !prompt.authors.includes(author.id)) return illegal(state);
      let answer: QcAnswer;
      if (action.type === "answer") {
        const clean = cleanAnswer(action.text, state.room.contentFilter);
        if (clean === null) return illegal(state);
        answer = { ...clean, safety: false, mod: "ok" };
      } else {
        if (!state.options.safetyQuip || state.safetyUsed[author.id] === state.round) {
          return illegal(state);
        }
        answer = { text: "", safety: true, mod: "ok", flagged: false, masked: false };
      }
      const tx = begin(state, ctx);
      const { s } = tx;
      releaseAnswer(s, prompt.id, author.id);
      if (answer.safety) {
        answer.text = takeSafety(tx, prompt.id, author.id);
        s.safetyUsed[author.id] = s.round;
      }
      submitAnswer(tx, prompt.id, author.id, answer, ctx.actor.id);
      if (answerComplete(s)) endAnswer(tx);
      return done(tx);
    }
    case "vote":
    case "lastVote": {
      if (state.phase !== "vote" || state.closing) return illegal(state);
      let ballot: string | Record<string, number>;
      if (action.type === "vote") {
        if (state.round === 3 || !isEligible(state, ctx.actor.id)) return illegal(state);
        if (action.choice !== "A" && action.choice !== "B") return illegal(state);
        ballot = action.choice;
      } else {
        if (state.round !== 3) return illegal(state);
        const alloc = checkAlloc(state, author.id, action.alloc);
        if (alloc === null) return illegal(state);
        ballot = alloc;
      }
      const tx = begin(state, ctx);
      tx.s.votes[ctx.actor.id] = ballot;
      if (voteComplete(tx.s)) endVote(tx);
      return done(tx);
    }
  }
}
