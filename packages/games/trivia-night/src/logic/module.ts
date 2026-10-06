/**
 * Trivia Night game logic, Classic mode (`docs/specs/trivia-night.md` R1–R8, R14 `classic`):
 * Kahoot-style multiple choice with speed and streak bonuses, "The Kettle" Showdown for the
 * bottom two after questions 4 and 8, an audience 50/50 lifeline, and the audience playing
 * every question on its own leaderboard.
 *
 * State machine:
 * `intro → Q[i]{category → read → answer → reveal} → (i%4==0: scoreboard → lifeline-vote? →
 * showdown{predict → answer → verdict}?) → … → final → end`
 *
 * Every reducer validates against the (frozen) input state first and returns it unchanged
 * when the input is illegal; accepted inputs work on a copy.
 *
 * @module
 */
import { DEFAULT_ROOM_CONFIG, type PlayerId, type Rng, type TeamId } from "@sg/shared";
import type {
  ActionCtx,
  Ctx,
  Effect,
  GameHostCommand,
  GameManifest,
  GameModule,
  GameResult,
  OptionSpec,
  PollResult,
  PollSpec,
  SetupContext,
  Seat,
  Step,
} from "@sg/engine";
import { botAction } from "./bot.ts";
import { drawQuestions, takeBest } from "./draw.ts";
import {
  bottomTwo,
  lifelineRecipient,
  percentages,
  pluralityAnswer,
  readMs,
  scoreAnswer,
  showdownVerdict,
  teamTotals,
} from "./rules.ts";
import { canAnswer, isConnected, isTeamMode, pendingAnswers, standings, teamOf } from "./state.ts";
import {
  BREAK_EVERY,
  CATEGORY_MS,
  COOL_HEAD_POINTS,
  FINAL_MS,
  INTRO_MS,
  LIFELINE_AFTER,
  LIFELINE_MS,
  POLL_GRACE_MS,
  QUIZ_WAIT_MS,
  READ_BASE_MS,
  READ_MAX_MS,
  READ_PER_CHAR_MS,
  REVEAL_MS,
  SCOREBOARD_MS,
  SHOWDOWN_AFTER,
  SHOWDOWN_ANSWER_MS,
  SHOWDOWN_MIN_PLAYERS,
  SHOWDOWN_PREDICT_MS,
  STEAMED_QUESTIONS,
  VERDICT_MS,
  type LastReveal,
  type Lock,
  type McItem,
  type PlayerResult,
  type TnAction,
  type TnOptions,
  type TnPlayer,
  type TnState,
  type TnTeam,
  type TnView,
} from "./types.ts";
import { viewFor } from "./views.ts";

/**
 * The room's minimum audience (SPEC §4 `audienceMin`, default 5). `Ctx` does not carry room
 * config yet (docs/engine-requests.md ER-002), so the default is used unless the platform's
 * result carries its own `counted` flag (ER-005).
 */
export const AUDIENCE_MIN = DEFAULT_ROOM_CONFIG.audienceMin;

/** Stable game id. */
export const GAME_ID = "trivia-night" as const;

/** Spec "Manifest". */
export const manifest: GameManifest = {
  id: GAME_ID,
  name: "Trivia Night",
  version: "1.0.0",
  minPlayers: 1,
  maxPlayers: 10,
  teamSupport: "optional",
  audience: { quiz: true, predict: true, vote: true },
  tickHz: 0,
  renderMode: "on-demand",
  estMinutes: [8, 15],
  tags: ["trivia", "quiz", "party", "audience"],
  contentRating: "all",
  howToPlay: [
    "Answer on your phone. Faster = more points",
    "Bottom two face The Kettle showdown",
    "Chat plays along on its own leaderboard",
  ],
};

/** Spec "Host options" (Classic; the Bluff keys arrive with M4-01b). */
export const optionSpecs: OptionSpec[] = [
  {
    kind: "enum",
    key: "mode",
    label: "Mode",
    choices: [{ value: "classic", label: "Classic" }],
    default: "classic",
  },
  {
    kind: "pack",
    key: "packs",
    label: "Question packs",
    packKind: "trivia-mc",
    multi: true,
    default: ["trivia-general"],
  },
  { kind: "int", key: "questions", label: "Questions", min: 6, max: 20, default: 12 },
  { kind: "seconds", key: "answerSec", label: "Answer time", min: 10, max: 40, default: 20 },
  { kind: "bool", key: "speedScoring", label: "Speed bonus", default: true },
  { kind: "bool", key: "showdown", label: "The Kettle showdown", default: true },
  { kind: "bool", key: "lifeline", label: "Audience lifeline", default: true },
  {
    kind: "enum",
    key: "difficulty",
    label: "Difficulty",
    choices: [
      { value: "easy", label: "Easy" },
      { value: "curve", label: "Easy to hard" },
      { value: "hard", label: "Hard" },
    ],
    default: "curve",
  },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Fx = Effect[];

/**
 * A working copy for an accepted input: every part a reducer mutates in place is copied; the
 * parts it only replaces (items, the last reveal, the showdown, options, teams) stay shared.
 * The runner deep-freezes state in dev, so a stray in-place write to a shared part throws.
 */
const clone = (state: TnState): TnState => ({
  ...state,
  hidden: {
    ...state.hidden,
    queue: [...state.hidden.queue],
    spares: [...state.hidden.spares],
    showdownQueue: [...state.hidden.showdownQueue],
    answers: { ...state.hidden.answers },
    showdownAnswers: { ...state.hidden.showdownAnswers },
  },
  scores: { ...state.scores },
  teamScores: { ...state.teamScores },
  streaks: { ...state.streaks },
  steamed: { ...state.steamed },
  totalCorrectMs: { ...state.totalCorrectMs },
  totalAnswerMs: { ...state.totalAnswerMs },
  answered: [...state.answered],
  lifeline: { ...state.lifeline },
  polls: { ...state.polls },
  timers: [...state.timers],
  players: state.players.map((p) => ({ ...p })),
  played: [...state.played],
  stats: {
    ...state.stats,
    bestStreak: { ...state.stats.bestStreak },
    coolHeads: { ...state.stats.coolHeads },
  },
});

const illegal = (state: TnState, reason?: string): Step<TnState> => ({
  state,
  effects: [{ type: "fx", name: "illegal", ...(reason !== undefined ? { data: { reason } } : {}) }],
});

/** Absolute deadline for an input window, or null at timerScale 0. */
function inputDeadline(ctx: Ctx, baseMs: number): number | null {
  const window = ctx.timing.input(baseMs);
  return window === null ? null : ctx.now + window;
}

function clearTimers(s: TnState, fx: Fx): void {
  for (const id of s.timers) fx.push({ type: "timer.clear", id });
  s.timers = [];
}

function setTimer(s: TnState, fx: Fx, name: string, atMs: number): void {
  s.timerSeq += 1;
  const id = `${name}#${s.timerSeq}`;
  s.timers.push(id);
  fx.push({ type: "timer.set", id, atMs });
}

function nextPollId(s: TnState, kind: string): string {
  s.pollSeq += 1;
  return `tn-${s.index}-${kind}-${s.pollSeq}`;
}

/** Whether a poll result counts (SPEC §4 minimum audience). */
function resultCounts(r: PollResult): boolean {
  const flag = (r as PollResult & { counted?: unknown }).counted;
  return typeof flag === "boolean" ? flag : r.total >= AUDIENCE_MIN;
}

function closePoll(fx: Fx, pollId: string | null): void {
  if (pollId !== null) fx.push({ type: "audience.close", pollId });
}

/** Adds non-zero point deltas to the player scores and emits one `score` effect (R7 teams). */
function award(s: TnState, fx: Fx, deltas: Record<PlayerId, number>): void {
  const out: Record<string, number> = {};
  for (const [id, pts] of Object.entries(deltas)) {
    if (pts === 0) continue;
    s.scores[id] = (s.scores[id] ?? 0) + pts;
    const key = isTeamMode(s) ? teamOf(s, id)?.id : id;
    if (key !== undefined) out[key] = (out[key] ?? 0) + pts;
  }
  s.teamScores = teamTotals(s.teams, s.scores);
  if (Object.keys(out).length > 0) fx.push({ type: "score", deltas: out });
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/**
 * R7 team mode: when every seat carries a room team and two or more teams have members. Teams
 * follow the room's team order; empty teams are excluded (edge case).
 */
function buildTeams(ctx: SetupContext<TnOptions>, seats: readonly Seat[]): TnTeam[] {
  if (seats.length === 0 || !seats.every((s) => s.teamId !== undefined)) return [];
  const ids: TeamId[] = [];
  for (const t of ctx.teams) if (seats.some((s) => s.teamId === t.id)) ids.push(t.id);
  for (const s of seats) if (s.teamId !== undefined && !ids.includes(s.teamId)) ids.push(s.teamId);
  if (ids.length < 2) return [];
  return ids.map((id, i) => {
    const room = ctx.teams.find((t) => t.id === id);
    return {
      id,
      name: room?.name ?? id,
      colorSlot: room?.colorSlot ?? i,
      members: seats.filter((s) => s.teamId === id).map((s) => s.id),
    };
  });
}

/** The number of Showdowns this game can hold (R5, edge case: solo disables it). */
function showdownCount(options: TnOptions, players: number): number {
  if (!options.showdown || players < SHOWDOWN_MIN_PLAYERS) return 0;
  return SHOWDOWN_AFTER.filter((q) => q <= options.questions).length;
}

function setup(ctx: SetupContext<TnOptions>): Step<TnState> {
  const options: TnOptions = { ...ctx.options, packs: [...ctx.options.packs] };
  const seats = [...ctx.players].sort((a, b) => a.seat - b.seat);
  const teams = buildTeams(ctx, seats);
  const players: TnPlayer[] = seats.map((s) => {
    const teamId = teams.find((t) => t.members.includes(s.id))?.id;
    const p: TnPlayer = {
      id: s.id,
      name: s.name,
      seat: s.seat,
      colorSlot: s.colorSlot,
      connected: true,
    };
    if (teamId !== undefined) p.teamId = teamId;
    return p;
  });
  const draw = drawQuestions({
    content: ctx.content,
    packs: options.packs,
    count: options.questions,
    difficulty: options.difficulty,
    showdowns: showdownCount(options, players.length),
    rng: ctx.rng,
    now: ctx.now,
  });
  const zero = (): Record<PlayerId, number> => Object.fromEntries(players.map((p) => [p.id, 0]));
  const state: TnState = {
    phase: "intro",
    mode: "classic",
    index: 0,
    total: draw.queue.length,
    deadline: ctx.now + ctx.timing.pace(INTRO_MS),
    openedAt: null,
    hidden: {
      queue: draw.queue,
      spares: draw.spares,
      showdownQueue: draw.showdown,
      answers: {},
      lies: {},
      bluffAuthors: {},
      picks: {},
      showdownAnswers: {},
    },
    scores: zero(),
    streaks: zero(),
    steamed: {},
    totalCorrectMs: zero(),
    options,
    players,
    teams,
    teamScores: Object.fromEntries(teams.map((t) => [t.id, 0])),
    answered: [],
    answerClosed: false,
    totalAnswerMs: zero(),
    speedBonusOn: options.speedScoring && ctx.timing.input(1000) !== null,
    answerWindow: null,
    lifeline: { status: "unused", recipient: null, question: null },
    polls: { quiz: null, predict: null, vote: null },
    pollSeq: 0,
    timers: [],
    timerSeq: 0,
    stats: {
      chatRateSum: 0,
      chatQuestions: 0,
      playerCorrect: 0,
      playerChances: 0,
      bestStreak: {},
      coolHeads: {},
    },
    played: [],
    closedAt: null,
    winners: null,
  };
  const fx: Fx = [];
  setTimer(state, fx, "intro", state.deadline as number);
  return { state, effects: fx };
}

// ---------------------------------------------------------------------------------------------
// Question flow (R1–R4)
// ---------------------------------------------------------------------------------------------

/** Two random wrong options of `item` (R6), in ascending order. */
function pickRemoved(item: McItem, rng: Rng): [number, number] {
  const wrong = [0, 1, 2, 3].filter((i) => i !== item.correct);
  const [a, b] = rng.shuffle(wrong) as [number, number];
  return a < b ? [a, b] : [b, a];
}

function startQuestion(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  const item = s.hidden.queue.shift();
  if (item === undefined) {
    s.total = s.index;
    enterFinal(s, fx, ctx);
    return;
  }
  s.index += 1;
  delete s.showdown;
  delete s.hidden.quizResult;
  s.hidden.item = item;
  s.hidden.correct = item.correct;
  s.hidden.answers = {};
  s.answered = [];
  s.answerClosed = false;
  s.openedAt = null;
  s.closedAt = null;
  s.answerWindow = null;
  s.polls = { quiz: null, predict: null, vote: null };
  s.current = { kind: "mc", id: item.id, category: item.category, difficulty: item.difficulty };
  s.played.push({ id: item.id, category: item.category });
  if (
    s.lifeline.status === "granted" &&
    s.lifeline.question === s.index &&
    s.lifeline.recipient !== null
  ) {
    s.hidden.lifelineRemoved = { player: s.lifeline.recipient, remove: pickRemoved(item, ctx.rng) };
  } else {
    delete s.hidden.lifelineRemoved;
  }
  s.phase = "category";
  s.deadline = ctx.now + ctx.timing.pace(CATEGORY_MS);
  fx.push({ type: "fx", name: "category", data: { index: s.index, category: item.category } });
  setTimer(s, fx, "category", s.deadline);
}

/** R2 read: the question is shown, the answers stay hidden. */
function enterRead(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  const item = s.hidden.item as McItem;
  s.current = { ...(s.current as NonNullable<TnState["current"]>), q: item.q };
  s.phase = "read";
  s.deadline =
    ctx.now + ctx.timing.pace(readMs(item.q, READ_BASE_MS, READ_PER_CHAR_MS, READ_MAX_MS));
  setTimer(s, fx, "read", s.deadline);
}

/** R2/R3 answer: options public, input window open, the audience quiz opens with it. */
function enterAnswer(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  const item = s.hidden.item as McItem;
  const base = s.options.answerSec * 1000;
  s.current = { ...(s.current as NonNullable<TnState["current"]>), options: [...item.options] };
  s.phase = "answer";
  s.openedAt = ctx.now;
  s.deadline = inputDeadline(ctx, base);
  const full = ctx.timing.input(base);
  const delay = ctx.timing.input(0);
  s.answerWindow =
    s.speedBonusOn && full !== null && delay !== null
      ? { windowMs: full - delay, delayMs: delay }
      : null;
  const pollId = nextPollId(s, "quiz");
  s.polls.quiz = pollId;
  const poll: PollSpec = {
    pollId,
    kind: "quiz",
    prompt: item.q,
    options: item.options.map((label, i) => ({ id: String(i), label })),
    closesAtMs: s.deadline ?? ctx.now + base,
    speedBonus: s.answerWindow !== null,
  };
  if (s.deadline === null) poll.closeOn = "event";
  fx.push({ type: "audience.open", poll });
  fx.push({ type: "fx", name: "options", data: { index: s.index } });
  if (s.deadline !== null) setTimer(s, fx, "answer", s.deadline);
}

/** Whether every connected player has locked (R3 early end; needs someone connected). */
function everyoneAnswered(s: TnState): boolean {
  const ids =
    s.phase === "showdown-answer" ? (s.showdown?.players ?? []) : s.players.map((p) => p.id);
  return ids.some((id) => isConnected(s, id)) && pendingAnswers(s).length === 0;
}

/** R3: the answer window ends (deadline, everyone locked, or the host). */
function endAnswer(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.answerClosed = true;
  s.closedAt = ctx.now;
  s.deadline = null;
  closePoll(fx, s.polls.quiz);
  if (s.polls.quiz === null || s.hidden.quizResult !== undefined) {
    enterReveal(s, fx, ctx);
    return;
  }
  const openedAt = s.openedAt ?? ctx.now;
  setTimer(s, fx, "quizWait", Math.max(ctx.now + POLL_GRACE_MS, openedAt + QUIZ_WAIT_MS));
}

/** R4/R5/R7: score the question and reveal the answer. */
function enterReveal(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "reveal";
  s.answerClosed = true;
  s.deadline = ctx.now + ctx.timing.pace(REVEAL_MS);
  const correct = s.hidden.correct ?? 0;
  const openedAt = s.openedAt ?? ctx.now;
  const closedAt = s.closedAt ?? ctx.now;
  const answers = s.hidden.answers;
  const teamAnswers: Record<TeamId, number | null> = {};
  for (const t of s.teams) {
    const votes = t.members.map((m) => answers[m]).filter((v): v is Lock => v !== undefined);
    teamAnswers[t.id] = pluralityAnswer(votes);
  }
  const perPlayer: Record<PlayerId, PlayerResult> = {};
  const deltas: Record<PlayerId, number> = {};
  const cooledOff: PlayerId[] = [];
  for (const p of s.players) {
    const lock = answers[p.id];
    const team = teamOf(s, p.id);
    const final =
      lock === undefined ? null : team !== undefined ? (teamAnswers[team.id] ?? null) : lock.choice;
    const ok = final !== null && final === correct;
    const t = lock === undefined ? -1 : lock.at - openedAt;
    const steamedNow = (s.steamed[p.id]?.questionsLeft ?? 0) > 0;
    const score = scoreAnswer({
      correct: ok,
      t: Math.max(0, t),
      window: s.answerWindow,
      streakBefore: s.streaks[p.id] ?? 0,
      steamed: steamedNow,
    });
    s.streaks[p.id] = score.streakAfter;
    if (score.streakAfter > (s.stats.bestStreak[p.id] ?? 0))
      s.stats.bestStreak[p.id] = score.streakAfter;
    if (ok) s.totalCorrectMs[p.id] = (s.totalCorrectMs[p.id] ?? 0) + t;
    s.totalAnswerMs[p.id] =
      (s.totalAnswerMs[p.id] ?? 0) + (lock === undefined ? closedAt - openedAt : t);
    if (steamedNow) {
      const left = (s.steamed[p.id]?.questionsLeft ?? 1) - 1;
      if (left <= 0) {
        delete s.steamed[p.id];
        cooledOff.push(p.id);
      } else {
        s.steamed[p.id] = { questionsLeft: left as 1 };
      }
    }
    if (lock !== undefined || p.connected) {
      s.stats.playerChances += 1;
      if (ok) s.stats.playerCorrect += 1;
    }
    deltas[p.id] = score.points;
    perPlayer[p.id] = {
      ok,
      points: score.points,
      ms: t,
      choice: lock?.choice ?? null,
      speed: score.speed,
      streak: score.streak,
      halved: score.halved,
    };
  }
  const reveal: LastReveal = { index: s.index, correct, perPlayer, cooledOff };
  if (isTeamMode(s)) reveal.teamAnswers = teamAnswers;
  const quiz = s.hidden.quizResult;
  if (quiz !== undefined && quiz.total > 0) {
    reveal.audiencePct = percentages(quiz.tallies, 4);
    reveal.audienceTotal = quiz.total;
    s.stats.chatRateSum += Math.min(
      1,
      Math.max(0, (quiz.tallies[String(correct)] ?? 0) / quiz.total),
    );
    s.stats.chatQuestions += 1;
  }
  s.lastReveal = reveal;
  if (s.polls.quiz !== null) {
    fx.push({ type: "audience.resolve", pollId: s.polls.quiz, correct: String(correct) });
  }
  award(s, fx, deltas);
  fx.push({ type: "fx", name: "reveal", data: { index: s.index, correct } });
  if (cooledOff.length > 0)
    fx.push({ type: "fx", name: "cooledOff", data: { players: cooledOff } });
  setTimer(s, fx, "reveal", s.deadline);
}

function afterReveal(s: TnState, fx: Fx, ctx: Ctx): void {
  if (s.index % BREAK_EVERY === 0) enterScoreboard(s, fx, ctx);
  else nextOrFinal(s, fx, ctx);
}

function nextOrFinal(s: TnState, fx: Fx, ctx: Ctx): void {
  if (s.index >= s.total || s.hidden.queue.length === 0) enterFinal(s, fx, ctx);
  else startQuestion(s, fx, ctx);
}

// ---------------------------------------------------------------------------------------------
// Breaks: scoreboard, lifeline, Showdown (R5–R7)
// ---------------------------------------------------------------------------------------------

function enterScoreboard(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "scoreboard";
  s.deadline = ctx.now + ctx.timing.pace(SCOREBOARD_MS);
  fx.push({ type: "fx", name: "scores", data: { index: s.index } });
  setTimer(s, fx, "scoreboard", s.deadline);
}

/** R6: once per game, after question 4, with a question left and 2+ players (edge case: solo). */
function lifelineDue(s: TnState): boolean {
  return (
    s.options.lifeline &&
    s.lifeline.status === "unused" &&
    s.index === LIFELINE_AFTER &&
    s.players.length >= 2 &&
    s.index < s.total &&
    s.hidden.queue.length > 0
  );
}

/** R5: after questions 4 and 8, with 3+ players and the option on. */
function showdownDue(s: TnState): boolean {
  return (
    s.options.showdown &&
    s.players.length >= SHOWDOWN_MIN_PLAYERS &&
    SHOWDOWN_AFTER.includes(s.index) &&
    s.hidden.showdownQueue.length > 0
  );
}

function afterScoreboard(s: TnState, fx: Fx, ctx: Ctx): void {
  if (lifelineDue(s)) enterLifeline(s, fx, ctx);
  else afterLifeline(s, fx, ctx);
}

function afterLifeline(s: TnState, fx: Fx, ctx: Ctx): void {
  if (showdownDue(s)) enterShowdown(s, fx, ctx);
  else nextOrFinal(s, fx, ctx);
}

/** R6: the audience votes who gets a 50/50 on the next question. */
function enterLifeline(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "lifeline-vote";
  s.lifeline = { status: "voting", recipient: null, question: null };
  s.deadline = ctx.now + ctx.timing.pace(LIFELINE_MS);
  const pollId = nextPollId(s, "lifeline");
  s.polls.vote = pollId;
  fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "vote",
      prompt: "Give a 50/50 to…",
      options: s.players.map((p) => ({ id: p.id, label: p.name })),
      closesAtMs: s.deadline,
    },
  });
  setTimer(s, fx, "lifeline", s.deadline + POLL_GRACE_MS);
}

/** R6: the vote result (or none) decides the recipient; then the Showdown or the next question. */
function resolveLifeline(s: TnState, fx: Fx, ctx: Ctx, r: PollResult | null): void {
  clearTimers(s, fx);
  if (r === null) closePoll(fx, s.polls.vote);
  s.polls.vote = null;
  const recipient =
    r !== null && resultCounts(r)
      ? lifelineRecipient(
          r.tallies,
          s.players.map((p) => ({ id: p.id, seat: p.seat, score: s.scores[p.id] ?? 0 })),
        )
      : null;
  if (recipient !== null) {
    s.lifeline = { status: "granted", recipient, question: s.index + 1 };
    fx.push({ type: "fx", name: "lifeline", data: { recipient } });
  } else {
    s.lifeline = { status: "none", recipient: null, question: null };
  }
  afterLifeline(s, fx, ctx);
}

/** R5: the bottom two face The Kettle; the audience predicts who stays cool. */
function enterShowdown(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  const players = bottomTwo(
    s.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      score: s.scores[p.id] ?? 0,
      totalMs: s.totalAnswerMs[p.id] ?? 0,
    })),
  );
  const item = s.hidden.showdownQueue.shift() as McItem;
  s.hidden.showdownItem = item;
  s.hidden.showdownCorrect = item.correct;
  s.hidden.showdownAnswers = {};
  s.showdown = { players, after: s.index, answered: [] };
  s.hidden.answers = {};
  s.answered = [];
  s.answerClosed = false;
  s.openedAt = null;
  s.phase = "showdown";
  s.deadline = ctx.now + ctx.timing.pace(SHOWDOWN_PREDICT_MS);
  const pollId = nextPollId(s, "predict");
  s.polls.predict = pollId;
  fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "predict",
      prompt: "Who stays cool?",
      options: players.map((id) => ({
        id,
        label: s.players.find((p) => p.id === id)?.name ?? id,
      })),
      closesAtMs: s.deadline,
    },
  });
  fx.push({ type: "fx", name: "kettle", data: { players } });
  setTimer(s, fx, "showdown", s.deadline);
}

/** R5: both players answer one question within 10 s. */
function enterShowdownAnswer(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  closePoll(fx, s.polls.predict);
  const item = s.hidden.showdownItem as McItem;
  const sd = s.showdown as NonNullable<TnState["showdown"]>;
  s.showdown = { ...sd, q: { q: item.q, options: [...item.options] }, answered: [] };
  s.phase = "showdown-answer";
  s.answerClosed = false;
  s.openedAt = ctx.now;
  s.deadline = inputDeadline(ctx, SHOWDOWN_ANSWER_MS);
  if (s.deadline !== null) setTimer(s, fx, "showdownAnswer", s.deadline);
}

/** R5 verdict: +750 Cool Head for the winner, Steamed for the loser(s); the predict resolves. */
function enterVerdict(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  const sd = s.showdown as NonNullable<TnState["showdown"]>;
  const correct = s.hidden.showdownCorrect ?? 0;
  const openedAt = s.openedAt ?? ctx.now;
  const results: NonNullable<TnState["showdown"]>["results"] = {};
  const outcome = (id: PlayerId): { id: PlayerId; ok: boolean; ms: number } => {
    const lock = s.hidden.showdownAnswers[id];
    const ok = lock !== undefined && lock.choice === correct;
    const ms = lock === undefined ? -1 : lock.at - openedAt;
    results[id] = { ok, ms, choice: lock?.choice ?? null };
    return { id, ok, ms };
  };
  const [a, b] = sd.players;
  const { losers, winner } = showdownVerdict(outcome(a), outcome(b));
  for (const id of losers) s.steamed[id] = { questionsLeft: STEAMED_QUESTIONS as 2 };
  if (winner !== null) {
    s.stats.coolHeads[winner] = (s.stats.coolHeads[winner] ?? 0) + 1;
    award(s, fx, { [winner]: COOL_HEAD_POINTS });
  }
  s.showdown = { ...sd, verdict: losers, winner, correct, results };
  s.phase = "showdown-verdict";
  s.answerClosed = true;
  s.deadline = ctx.now + ctx.timing.pace(VERDICT_MS);
  if (s.polls.predict !== null) {
    // Both lost: no winner, so the platform refunds every stake.
    fx.push(
      winner !== null
        ? { type: "audience.resolve", pollId: s.polls.predict, correct: winner }
        : { type: "audience.resolve", pollId: s.polls.predict },
    );
  }
  fx.push({ type: "fx", name: "steam", data: { losers, winner } });
  if (winner !== null) fx.push({ type: "fx", name: "coolHead", data: { winner } });
  setTimer(s, fx, "verdict", s.deadline);
}

// ---------------------------------------------------------------------------------------------
// End (R8)
// ---------------------------------------------------------------------------------------------

/** R8: the final ranking (players, or teams in team mode). */
export function finalRanking(s: TnState): GameResult["ranking"] {
  return standings(s).map((r) => ({ id: r.id, score: r.score, place: r.place }));
}

function enterFinal(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "final";
  delete s.showdown;
  s.deadline = ctx.now + ctx.timing.pace(FINAL_MS);
  s.answerClosed = true;
  s.winners = finalRanking(s)
    .filter((r) => r.place === 1)
    .map((r) => r.id);
  // Unplayed items leave the state, so the room marks only played questions as used (R1).
  s.hidden.queue = [];
  s.hidden.spares = [];
  s.hidden.showdownQueue = [];
  fx.push({ type: "fx", name: "win", data: { winners: s.winners } });
  setTimer(s, fx, "final", s.deadline);
}

function highlights(s: TnState): NonNullable<GameResult["highlights"]> {
  const out: NonNullable<GameResult["highlights"]> = [];
  const place = new Map(standings(s).map((r) => [r.id, r.place]));
  const placeOf = (id: string): number => place.get(teamOf(s, id)?.id ?? id) ?? Infinity;
  const best = Object.entries(s.stats.bestStreak).sort(
    (x, y) => y[1] - x[1] || placeOf(x[0]) - placeOf(y[0]),
  )[0];
  if (best !== undefined && best[1] >= 3) {
    out.push({ label: `${best[1]} right in a row`, playerId: best[0] });
  }
  for (const [id, n] of Object.entries(s.stats.coolHeads)) {
    out.push({ label: n > 1 ? `Cool Head ×${n}` : "Cool Head", playerId: id });
  }
  const view = viewFor(s, { role: "stage" }).chatVsPlayers;
  if (view.chatPct !== null && view.playersPct !== null) {
    out.push({ label: `Chat ${view.chatPct}% · Players ${view.playersPct}%` });
  }
  return out;
}

function finish(s: TnState, fx: Fx): void {
  clearTimers(s, fx);
  s.deadline = null;
  fx.push({ type: "end", result: { ranking: finalRanking(s), highlights: highlights(s) } });
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Never throws; anything that is not exactly a {@link TnAction} is null. */
export function parseAction(raw: unknown): TnAction | null {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (rec["type"] !== "answer") return null;
    const choice = rec["choice"];
    return choice === 0 || choice === 1 || choice === 2 || choice === 3
      ? { type: "answer", choice }
      : null;
  } catch {
    return null;
  }
}

function onAction(state: TnState, action: TnAction, ctx: ActionCtx): Step<TnState> {
  const actor = ctx.actor.id;
  if (ctx.actor.role !== "player" || !state.players.some((p) => p.id === actor)) {
    return illegal(state, "not-seated");
  }
  if (!canAnswer(state, actor, ctx.now)) return illegal(state);
  const s = clone(state);
  const fx: Fx = [];
  const lock: Lock = { choice: action.choice, at: ctx.now };
  if (s.phase === "showdown-answer") {
    const sd = s.showdown as NonNullable<TnState["showdown"]>;
    s.hidden.showdownAnswers[actor] = lock;
    s.showdown = { ...sd, answered: [...sd.answered, actor] };
    fx.push({ type: "fx", name: "locked", data: { id: actor } });
    if (everyoneAnswered(s)) enterVerdict(s, fx, ctx);
  } else {
    s.hidden.answers[actor] = lock;
    s.answered.push(actor);
    fx.push({ type: "fx", name: "locked", data: { id: actor } });
    if (everyoneAnswered(s)) endAnswer(s, fx, ctx);
  }
  return { state: s, effects: fx };
}

function onTimer(state: TnState, timerId: string, ctx: Ctx): Step<TnState> {
  if (!state.timers.includes(timerId)) return { state };
  const name = timerId.slice(0, timerId.indexOf("#"));
  const s = clone(state);
  s.timers = s.timers.filter((t) => t !== timerId);
  const fx: Fx = [];
  switch (name) {
    case "intro":
      startQuestion(s, fx, ctx);
      break;
    case "category":
      enterRead(s, fx, ctx);
      break;
    case "read":
      enterAnswer(s, fx, ctx);
      break;
    case "answer":
      endAnswer(s, fx, ctx);
      break;
    case "quizWait":
      enterReveal(s, fx, ctx);
      break;
    case "reveal":
      afterReveal(s, fx, ctx);
      break;
    case "scoreboard":
      afterScoreboard(s, fx, ctx);
      break;
    case "lifeline":
      resolveLifeline(s, fx, ctx, null);
      break;
    case "showdown":
      enterShowdownAnswer(s, fx, ctx);
      break;
    case "showdownAnswer":
      enterVerdict(s, fx, ctx);
      break;
    case "verdict":
      nextOrFinal(s, fx, ctx);
      break;
    case "final":
      finish(s, fx);
      break;
    default:
      return { state };
  }
  return { state: s, effects: fx };
}

function onAudienceResult(state: TnState, r: PollResult, ctx: Ctx): Step<TnState> {
  if (
    r.pollId === state.polls.quiz &&
    state.polls.quiz !== null &&
    state.hidden.quizResult === undefined
  ) {
    const s = clone(state);
    const fx: Fx = [];
    s.hidden.quizResult = { total: Math.max(0, r.total), tallies: { ...r.tallies } };
    if (s.phase === "answer" && s.answerClosed) enterReveal(s, fx, ctx);
    return { state: s, effects: fx };
  }
  if (r.pollId === state.polls.vote && state.phase === "lifeline-vote") {
    const s = clone(state);
    const fx: Fx = [];
    resolveLifeline(s, fx, ctx, r);
    return { state: s, effects: fx };
  }
  return { state };
}

function onPlayerLeave(state: TnState, id: PlayerId, ctx: Ctx): Step<TnState> {
  const idx = state.players.findIndex((p) => p.id === id);
  if (idx < 0) return { state };
  const s = clone(state);
  (s.players[idx] as TnPlayer).connected = false;
  const fx: Fx = [];
  if (!s.answerClosed && everyoneAnswered(s)) {
    if (s.phase === "answer") endAnswer(s, fx, ctx);
    else if (s.phase === "showdown-answer") enterVerdict(s, fx, ctx);
  }
  return { state: s, effects: fx };
}

function onPlayerRejoin(state: TnState, id: PlayerId): Step<TnState> {
  const idx = state.players.findIndex((p) => p.id === id);
  if (idx < 0 || state.players[idx]?.connected === true) return { state };
  const s = clone(state);
  (s.players[idx] as TnPlayer).connected = true;
  return { state: s };
}

/** Host `skipItem`: swaps the current question for a spare (or voids it when none is left). */
function skipQuestion(s: TnState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  closePoll(fx, s.polls.quiz);
  s.polls.quiz = null;
  const skipped = s.played.pop();
  const prev = s.played[s.played.length - 1]?.category;
  const next = s.hidden.queue[0]?.category;
  const avoid = [prev, next].filter((c): c is string => c !== undefined);
  const spare = takeBest(s.hidden.spares, s.current?.difficulty ?? 2, avoid);
  fx.push({ type: "fx", name: "skipped", data: { id: skipped?.id ?? null } });
  s.index -= 1;
  if (spare !== undefined) {
    s.hidden.queue.unshift(spare);
  } else {
    s.total -= 1;
  }
  nextOrFinal(s, fx, ctx);
}

function onHostCommand(state: TnState, cmd: GameHostCommand, ctx: Ctx): Step<TnState> {
  if (cmd.c === "skipItem") {
    const skippable =
      state.phase === "category" || state.phase === "read" || state.phase === "answer";
    if (!skippable || state.current?.id !== cmd.itemId) return { state };
    const s = clone(state);
    const fx: Fx = [];
    skipQuestion(s, fx, ctx);
    return { state: s, effects: fx };
  }
  const s = clone(state);
  const fx: Fx = [];
  switch (s.phase) {
    case "intro":
      startQuestion(s, fx, ctx);
      break;
    case "category":
      enterRead(s, fx, ctx);
      break;
    case "read":
      enterAnswer(s, fx, ctx);
      break;
    case "answer":
      if (s.answerClosed) enterReveal(s, fx, ctx);
      else endAnswer(s, fx, ctx);
      break;
    case "reveal":
      afterReveal(s, fx, ctx);
      break;
    case "scoreboard":
      afterScoreboard(s, fx, ctx);
      break;
    case "lifeline-vote":
      resolveLifeline(s, fx, ctx, null);
      break;
    case "showdown":
      enterShowdownAnswer(s, fx, ctx);
      break;
    case "showdown-answer":
      enterVerdict(s, fx, ctx);
      break;
    case "showdown-verdict":
      nextOrFinal(s, fx, ctx);
      break;
    case "final":
      finish(s, fx);
      break;
  }
  return { state: s, effects: fx };
}

// ---------------------------------------------------------------------------------------------
// Legal actions and the module
// ---------------------------------------------------------------------------------------------

const ANSWERS: readonly TnAction[] = [0, 1, 2, 3].map((choice) => ({
  type: "answer",
  choice: choice as 0 | 1 | 2 | 3,
}));

function legalActions(state: TnState, player: PlayerId): TnAction[] {
  return canAnswer(state, player, null) ? ANSWERS.map((a) => ({ ...a })) : [];
}

/** The Trivia Night game module (SPEC §9.3). */
export const triviaNight: GameModule<TnState, TnAction, TnOptions, TnView> = {
  manifest,
  optionSpecs,
  parseAction,
  setup,
  onAction,
  onTimer,
  onAudienceResult,
  onPlayerLeave,
  onPlayerRejoin,
  onHostCommand,
  view: viewFor,
  legalActions,
  bot(state: TnState, player: PlayerId, rng: Rng): TnAction | null {
    return botAction(state, player, rng);
  },
  serialize(state: TnState): string {
    return JSON.stringify(state);
  },
  deserialize(data: string): TnState {
    return JSON.parse(data) as TnState;
  },
};
