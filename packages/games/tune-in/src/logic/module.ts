/**
 * Tune In game logic (`docs/specs/tune-in.md`): a psychic sees a secret spot on a 0–1000 dial,
 * gives a one-line clue, and their team (teams mode) or everyone else (FFA) tunes the dial to
 * it. The audience picks the card, bets on the result and places its own scored dial.
 *
 * State machine:
 * `intro → [turn]: card-pick → clue → guess → (steal)? → reveal → turn-score → next | final → end`
 *
 * Every reducer validates against the (frozen) input state first and returns it unchanged
 * when the input is illegal; accepted inputs work on a JSON clone.
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
  SetupContext,
  Step,
} from "@sg/engine";
import { botAction, botClue, BOT_CLUES } from "./bot.ts";
import { buildDeck, drawPair } from "./cards.ts";
import {
  betForPoints,
  checkClue,
  clampDial,
  drawTarget,
  isDialValue,
  rankByScore,
  roundedMean,
  scoreDial,
  stealCorrect,
  stealSide,
} from "./rules.ts";
import {
  canLock,
  canSetDial,
  canSteal,
  ffaGuessers,
  isConnected,
  otherTeam,
  stealers,
  teamById,
  teamGuessers,
} from "./state.ts";
import {
  AUDIENCE_BANDS,
  CARD_PICK_MS,
  DIAL_RATE_MAX,
  DIAL_REST,
  DIAL_WAIT_MS,
  FFA_TURN_CAP,
  FINAL_MS,
  INTRO_MS,
  POLL_GRACE_MS,
  REVEAL_MS,
  STEAL_MS,
  TEAM_TURN_CAP,
  TEAMS_MIN_PLAYERS,
  TURN_SCORE_MS,
  type Card,
  type FfaDial,
  type TiAction,
  type TiLast,
  type TiOptions,
  type TiPlayer,
  type TiState,
  type TiTeam,
  type TiView,
} from "./types.ts";
import { viewFor } from "./views.ts";

/**
 * The room's minimum audience (SPEC §4 `audienceMin`, default 5). `Ctx` does not carry room
 * config yet, so the default is used (docs/engine-requests.md ER "audienceMin in Ctx").
 */
export const AUDIENCE_MIN = DEFAULT_ROOM_CONFIG.audienceMin;

/** Stable game id. */
export const GAME_ID = "tune-in" as const;

/** Spec "Manifest". */
export const manifest: GameManifest = {
  id: GAME_ID,
  name: "Tune In",
  version: "1.0.0",
  minPlayers: 2,
  maxPlayers: 12,
  teamSupport: "optional",
  audience: { vote: true, predict: true, dial: true },
  tickHz: 0,
  renderMode: "on-demand",
  estMinutes: [10, 15],
  tags: ["party", "teams", "wordplay", "audience"],
  contentRating: "all",
  howToPlay: [
    "The Psychic sees a secret spot on the dial",
    "They give a one-line clue",
    "Tune the dial to the spot!",
  ],
};

/** Spec "Host options". */
export const optionSpecs: OptionSpec[] = [
  {
    kind: "enum",
    key: "mode",
    label: "Mode",
    choices: [
      { value: "auto", label: "Auto (teams with 4+ players)" },
      { value: "teams", label: "Teams" },
      { value: "ffa", label: "Free for all" },
    ],
    default: "auto",
  },
  {
    kind: "pack",
    key: "packs",
    label: "Card packs",
    packKind: "spectrum",
    multi: true,
    default: ["spectrum-core"],
  },
  { kind: "seconds", key: "clueSec", label: "Clue time", min: 20, max: 120, default: 45 },
  { kind: "seconds", key: "guessSec", label: "Guess time", min: 20, max: 90, default: 40 },
  { kind: "int", key: "scoreToWin", label: "Points to win", min: 5, max: 15, default: 8 },
  { kind: "bool", key: "steal", label: "Steals", default: true },
  { kind: "bool", key: "audiencePicksCard", label: "Chat picks the card", default: true },
  { kind: "bool", key: "liveHeatmap", label: "Live chat heatmap", default: false },
  { kind: "int", key: "cycles", label: "Rotations (0 = auto)", min: 0, max: 3, default: 0 },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Fx = Effect[];

const copyRecord = <T>(rec: Record<string, T>, copy: (v: T) => T): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = copy(v);
  return out;
};

/**
 * A working copy for an accepted input: every part a reducer mutates in place is copied; the
 * parts it only ever replaces (deck, card choices, card, last, options, teams, psychic queue)
 * stay shared. The runner deep-freezes state in dev, so an accidental in-place write to a
 * shared part throws in every test instead of corrupting the previous state.
 */
const clone = (state: TiState): TiState => ({
  ...state,
  hidden: {
    target: state.hidden.target,
    ffaDials: copyRecord(state.hidden.ffaDials, (d) => ({ ...d })),
  },
  stealPicks: { ...state.stealPicks },
  scores: { ...state.scores },
  turnsPerSeat: { ...state.turnsPerSeat },
  teamRotation: { ...state.teamRotation },
  dialRate: { ...state.dialRate },
  polls: { ...state.polls },
  timers: [...state.timers],
  players: state.players.map((p) => ({ ...p })),
  stats: { bullseyes: { ...state.stats.bullseyes }, chatBeats: state.stats.chatBeats },
  suddenDeath: state.suddenDeath === null ? null : { queue: [...state.suddenDeath.queue] },
});

const illegal = (state: TiState, reason?: string): Step<TiState> => ({
  state,
  effects: [{ type: "fx", name: "illegal", ...(reason !== undefined ? { data: { reason } } : {}) }],
});

/** Absolute deadline for an input window, or null at timerScale 0. */
function inputDeadline(ctx: Ctx, baseMs: number): number | null {
  const window = ctx.timing.input(baseMs);
  return window === null ? null : ctx.now + window;
}

function clearTimers(s: TiState, fx: Fx): void {
  for (const id of s.timers) fx.push({ type: "timer.clear", id });
  s.timers = [];
}

function setTimer(s: TiState, fx: Fx, name: string, atMs: number): void {
  const id = `${name}@${s.turn}`;
  if (!s.timers.includes(id)) s.timers.push(id);
  fx.push({ type: "timer.set", id, atMs });
}

function nextPollId(s: TiState, kind: string): string {
  s.pollSeq += 1;
  return `ti-${s.turn}-${kind}-${s.pollSeq}`;
}

function cardLabel(card: Card): string {
  return `${card.left} ↔ ${card.right}`;
}

/** Omits undefined optional keys so state stays plain JSON. */
function omitUndefined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

const DEFAULT_TEAMS: readonly { id: TeamId; name: string; colorSlot: number }[] = [
  { id: "tomato", name: "Tomato", colorSlot: 0 },
  { id: "sky", name: "Sky", colorSlot: 1 },
];

/** Resolves the play mode (host option `mode`, spec header: teams needs 4+ players). */
export function resolveMode(option: TiOptions["mode"], players: number): TiState["mode"] {
  if (players < TEAMS_MIN_PLAYERS) return "ffa";
  return option === "ffa" ? "ffa" : "teams";
}

/**
 * Teams from the room (when the seats carry exactly two team ids) or, otherwise, Tomato vs
 * Sky by alternating seats.
 */
function buildTeams(ctx: SetupContext<TiOptions>): TiTeam[] {
  const seats = [...ctx.players].sort((a, b) => a.seat - b.seat);
  const ids = [...new Set(seats.map((s) => s.teamId).filter((t): t is TeamId => t !== undefined))];
  if (ids.length === 2 && seats.every((s) => s.teamId !== undefined)) {
    return ids.map((id, i) => {
      const room = ctx.teams.find((t) => t.id === id);
      const fallback = DEFAULT_TEAMS[i] as (typeof DEFAULT_TEAMS)[number];
      return {
        id,
        name: room?.name ?? fallback.name,
        colorSlot: room?.colorSlot ?? fallback.colorSlot,
        members: seats.filter((s) => s.teamId === id).map((s) => s.id),
      };
    });
  }
  return DEFAULT_TEAMS.map((t, i) => ({
    ...t,
    members: seats.filter((_, idx) => idx % 2 === i).map((s) => s.id),
  }));
}

/** R3 FFA: the psychic of every turn (full rotations, capped at 9; 10+ players: seeded draw). */
function buildPsychicQueue(seatOrder: PlayerId[], cycles: number, rng: Rng): PlayerId[] {
  const n = seatOrder.length;
  const rounds = cycles > 0 ? cycles : n < TEAMS_MIN_PLAYERS ? 2 : 1;
  if (n > FFA_TURN_CAP) return rng.shuffle(seatOrder).slice(0, FFA_TURN_CAP);
  const start = rng.int(n);
  const rotation = seatOrder.map((_, i) => seatOrder[(start + i) % n] as PlayerId);
  const queue: PlayerId[] = [];
  for (let r = 0; r < rounds; r++) queue.push(...rotation);
  return queue.slice(0, FFA_TURN_CAP);
}

function setup(ctx: SetupContext<TiOptions>): Step<TiState> {
  const options: TiOptions = { ...ctx.options, packs: [...ctx.options.packs] };
  const seats = [...ctx.players].sort((a, b) => a.seat - b.seat);
  const mode = resolveMode(options.mode, seats.length);
  const teams = mode === "teams" ? buildTeams(ctx) : [];
  const players: TiPlayer[] = seats.map((s) => {
    const teamId = teams.find((t) => t.members.includes(s.id))?.id;
    return omitUndefined({
      id: s.id,
      name: s.name,
      seat: s.seat,
      colorSlot: s.colorSlot,
      teamId,
      connected: true,
    });
  });
  const deck = buildDeck(ctx.content, options.packs, ctx.rng);
  const { pair, deck: rest } = drawPair(deck);
  const psychicQueue =
    mode === "ffa"
      ? buildPsychicQueue(
          seats.map((s) => s.id),
          options.cycles,
          ctx.rng,
        )
      : [];
  const firstTeam = mode === "teams" ? (ctx.rng.bool() ? teams[0] : teams[1]) : undefined;
  const scores: Record<string, number> = {};
  for (const id of mode === "teams" ? teams.map((t) => t.id) : players.map((p) => p.id)) {
    scores[id] = 0;
  }
  const state: TiState = omitUndefined({
    phase: "intro",
    mode,
    turn: 0,
    deadline: ctx.now + ctx.timing.pace(INTRO_MS),
    psychic: mode === "ffa" ? (psychicQueue[0] as PlayerId) : (firstTeam?.members[0] as PlayerId),
    activeTeam: undefined,
    cardChoices: pair,
    hidden: { target: drawTarget(ctx.rng), ffaDials: {} },
    deck: rest,
    dial: DIAL_REST,
    stealPicks: {},
    scores,
    catchUpUsed: false,
    turnsPerSeat: Object.fromEntries(players.map((p) => [p.id, 0])),
    options,
    players,
    teams,
    psychicQueue,
    teamRotation: Object.fromEntries(teams.map((t) => [t.id, 0])),
    nextTeam: firstTeam?.id,
    maxTurns: mode === "teams" ? TEAM_TURN_CAP : psychicQueue.length,
    suddenDeath: null,
    cardPicker: null,
    dialMoved: false,
    locked: false,
    guessStartedAt: null,
    dialRate: {},
    polls: { card: null, bet: null, dial: null },
    pollSeq: 0,
    dialResult: null,
    dialOpen: false,
    awaitingDial: false,
    dialWaited: false,
    timers: [],
    lastScorer: null,
    winners: null,
    stats: { bullseyes: {}, chatBeats: 0 },
  });
  const fx: Fx = [];
  setTimer(state, fx, "intro", state.deadline as number);
  return { state, effects: fx };
}

// ---------------------------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------------------------

function startTurn(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.turn += 1;
  if (s.mode === "teams") {
    const teamId =
      s.suddenDeath !== null
        ? (s.suddenDeath.queue.shift() as TeamId)
        : (s.nextTeam ?? (s.teams[0] as TiTeam).id);
    const team = teamById(s, teamId) as TiTeam;
    const idx = s.teamRotation[teamId] ?? 0;
    s.activeTeam = teamId;
    s.psychic = team.members[idx % team.members.length] as PlayerId;
    s.teamRotation[teamId] = idx + 1;
  } else {
    s.psychic = s.psychicQueue[s.turn - 1] as PlayerId;
  }
  s.turnsPerSeat[s.psychic] = (s.turnsPerSeat[s.psychic] ?? 0) + 1;
  delete s.card;
  delete s.clue;
  s.dial = DIAL_REST;
  s.dialMoved = false;
  s.locked = false;
  s.guessStartedAt = null;
  s.dialRate = {};
  s.stealPicks = {};
  s.polls = { card: null, bet: null, dial: null };
  s.dialResult = null;
  s.dialOpen = false;
  s.awaitingDial = false;
  s.dialWaited = false;
  const ffaDials: Record<PlayerId, FfaDial> = {};
  if (s.mode === "ffa") {
    for (const id of ffaGuessers(s)) ffaDials[id] = { v: DIAL_REST, locked: false, moved: false };
  }
  s.hidden = { target: drawTarget(ctx.rng), ffaDials };
  // Turn 1 plays the pair drawn at setup; later turns draw a fresh pair.
  if (s.turn > 1) drawChoices(s);
  enterCardPick(s, fx, ctx);
}

function drawChoices(s: TiState): void {
  const { pair, deck } = drawPair(s.deck);
  s.cardChoices = pair;
  s.deck = deck;
}

/** R4: the audience votes on the two cards, or the psychic picks. */
function enterCardPick(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "card-pick";
  if (!s.options.audiencePicksCard) {
    psychicPick(s, fx, ctx);
    return;
  }
  const pollId = nextPollId(s, "card");
  const deadline = inputDeadline(ctx, CARD_PICK_MS);
  s.cardPicker = "audience";
  s.deadline = deadline;
  s.polls.card = pollId;
  fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "vote",
      prompt: "Pick the next card",
      options: s.cardChoices.map((c, i) => ({ id: String(i), label: cardLabel(c) })),
      closesAtMs: deadline ?? ctx.now + CARD_PICK_MS,
    },
  });
  if (deadline !== null) setTimer(s, fx, "cardVote", deadline + POLL_GRACE_MS);
}

function psychicPick(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "card-pick";
  s.cardPicker = "psychic";
  s.deadline = inputDeadline(ctx, CARD_PICK_MS);
  if (!isConnected(s, s.psychic)) {
    chooseCard(s, fx, ctx, 0, "timeout");
    return;
  }
  if (s.deadline !== null) setTimer(s, fx, "cardPick", s.deadline);
}

function chooseCard(
  s: TiState,
  fx: Fx,
  ctx: Ctx,
  idx: 0 | 1,
  by: "audience" | "psychic" | "timeout" | "host",
): void {
  s.card = s.cardChoices[idx];
  s.cardPicker = null;
  fx.push({ type: "fx", name: "cardPicked", data: { idx, by } });
  enterClue(s, fx, ctx);
}

/** R5 + R4a: the psychic writes the clue while the audience bets on the result. */
function enterClue(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "clue";
  s.deadline = inputDeadline(ctx, s.options.clueSec * 1000);
  const pollId = nextPollId(s, "bet");
  s.polls.bet = pollId;
  fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "predict",
      prompt:
        s.mode === "teams" ? "How close will they get?" : "How close will the best guess get?",
      options: [
        { id: "bullseye", label: "Bullseye (4 pts)" },
        { id: "close", label: "Close (2–3 pts)" },
        { id: "miss", label: "Miss (0)" },
      ],
      closesAtMs: s.deadline ?? ctx.now + s.options.clueSec * 1000,
    },
  });
  if (!isConnected(s, s.psychic)) {
    // R12: a disconnected psychic's clue comes from the bot.
    giveClue(s, fx, ctx, botClue(s, ctx.rng), true);
    return;
  }
  if (s.deadline !== null) setTimer(s, fx, "clue", s.deadline);
}

function giveClue(s: TiState, fx: Fx, ctx: Ctx, clue: string, bot: boolean): void {
  s.clue = clue;
  fx.push({ type: "fx", name: "clue", data: { bot } });
  enterGuess(s, fx, ctx);
}

/** R6/R9/R10: the guess opens, the result bet closes and the audience dial opens. */
function enterGuess(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  if (s.polls.bet !== null) fx.push({ type: "audience.close", pollId: s.polls.bet });
  s.phase = "guess";
  s.guessStartedAt = ctx.now;
  s.deadline = inputDeadline(ctx, s.options.guessSec * 1000);
  const pollId = nextPollId(s, "dial");
  s.polls.dial = pollId;
  s.dialOpen = true;
  fx.push({
    type: "audience.open",
    poll: {
      pollId,
      kind: "dial",
      prompt: `Where is the spot? ${s.clue ?? ""}`.trim(),
      closesAtMs: s.deadline ?? ctx.now + s.options.guessSec * 1000,
      hideLive: !s.options.liveHeatmap,
    },
  });
  if (s.deadline !== null) setTimer(s, fx, "guess", s.deadline);
  if (s.mode === "teams" && teamGuessers(s).length === 0 && ctx.audienceCount === 0) {
    // R6 edge case: a psychic alone on their team with no audience locks at 500.
    lockTeamDial(s, fx, ctx);
  }
}

/**
 * When the game stops waiting for the dial result: at least {@link DIAL_WAIT_MS} after the guess
 * opened (the longest the runner can hold an early close) and {@link POLL_GRACE_MS} after now.
 */
function dialWaitAt(s: TiState, ctx: Ctx): number {
  return Math.max(ctx.now + POLL_GRACE_MS, (s.guessStartedAt ?? ctx.now) + DIAL_WAIT_MS);
}

function closeDial(s: TiState, fx: Fx): void {
  if (s.dialOpen && s.polls.dial !== null) {
    fx.push({ type: "audience.close", pollId: s.polls.dial });
  }
  s.dialOpen = false;
}

/** R6: the team dial locks (by a member, the deadline or the solo-team rule). */
function lockTeamDial(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.locked = true;
  s.awaitingDial = false;
  fx.push({ type: "fx", name: "lock", data: { dial: s.dial } });
  closeDial(s, fx);
  const canStealNow = s.options.steal && stealers(s).length > 0 && s.dial !== s.hidden.target;
  if (canStealNow) enterSteal(s, fx, ctx);
  else toReveal(s, fx, ctx);
}

/** A solo team (only the psychic) waits for the audience dial (R6). */
function awaitSoloDial(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  closeDial(s, fx);
  s.awaitingDial = true;
  s.deadline = null;
  setTimer(s, fx, "dialWait", dialWaitAt(s, ctx));
}

/** R9: the FFA guess ends (everyone locked, or the deadline); open dials lock where they are. */
function endFfaGuess(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.locked = true;
  for (const dial of Object.values(s.hidden.ffaDials)) dial.locked = true;
  fx.push({ type: "fx", name: "lock", data: {} });
  closeDial(s, fx);
  toReveal(s, fx, ctx);
}

function enterSteal(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "steal";
  s.deadline = inputDeadline(ctx, STEAL_MS);
  if (stealDone(s)) {
    toReveal(s, fx, ctx);
    return;
  }
  if (s.deadline !== null) setTimer(s, fx, "steal", s.deadline);
}

/** Every connected stealer has picked. */
function stealDone(s: TiState): boolean {
  return stealers(s).every((id) => s.stealPicks[id] !== undefined || !isConnected(s, id));
}

/** Every connected FFA guesser has locked. */
function ffaDone(s: TiState): boolean {
  return Object.entries(s.hidden.ffaDials).every(([id, d]) => d.locked || !isConnected(s, id));
}

/**
 * Reveal once this turn's audience dial result is in, so "Chat beat you!" is decided with it.
 * The runner may hold the dial close for the minimum audience window (SPEC §4); the game waits
 * for it, at most until {@link DIAL_WAIT_MS} after the guess opened.
 */
function toReveal(s: TiState, fx: Fx, ctx: Ctx): void {
  if (s.polls.dial !== null && s.dialResult === null && !s.dialWaited) {
    clearTimers(s, fx);
    s.awaitingDial = true;
    s.deadline = null;
    setTimer(s, fx, "dialWait", dialWaitAt(s, ctx));
    return;
  }
  enterReveal(s, fx, ctx);
}

function audienceCounts(s: TiState): boolean {
  return s.dialResult !== null && s.dialResult.total >= AUDIENCE_MIN;
}

/** R2, R7, R8, R9, R10, R4a: score the turn and reveal the target. */
function enterReveal(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.awaitingDial = false;
  s.locked = true;
  s.phase = "reveal";
  s.deadline = ctx.now + ctx.timing.pace(REVEAL_MS);
  const target = s.hidden.target;
  const deltas: Record<string, number> = {};
  const add = (id: string, pts: number): void => {
    if (pts <= 0) return;
    deltas[id] = (deltas[id] ?? 0) + pts;
    s.lastScorer = id;
  };
  let bestPoints: number;
  let bestDial: number;
  const last: TiLast = {
    target,
    dial: s.dial,
    points: 0,
    psychic: s.psychic,
    bet: "miss",
    chatBeatYou: false,
    catchUp: false,
  };
  if (s.mode === "teams") {
    const team = s.activeTeam as TeamId;
    const other = otherTeam(s, team)?.id;
    bestPoints = scoreDial(s.dial, target);
    bestDial = s.dial;
    last.team = team;
    add(team, bestPoints);
    if (bestPoints === 4) s.stats.bullseyes[team] = (s.stats.bullseyes[team] ?? 0) + 1;
    const side = stealSide(s.stealPicks);
    if (side !== null && other !== undefined) {
      const ok = stealCorrect(side, s.dial, target);
      last.steal = { side, ok };
      if (ok) add(other, 1);
    }
    // R8 catch-up.
    const after = (id: string | undefined): number =>
      id === undefined ? 0 : (s.scores[id] ?? 0) + (deltas[id] ?? 0);
    if (
      bestPoints === 4 &&
      s.suddenDeath === null &&
      !s.catchUpUsed &&
      after(team) <= after(other)
    ) {
      last.catchUp = true;
      s.catchUpUsed = true;
      s.nextTeam = team;
    } else {
      s.catchUpUsed = false;
      if (other !== undefined) s.nextTeam = other;
    }
  } else {
    const ffa: Record<PlayerId, number> = {};
    const dials: Record<PlayerId, number> = {};
    const guesserPoints: number[] = [];
    bestPoints = -1;
    bestDial = DIAL_REST;
    let bestDist = Infinity;
    for (const [id, dial] of Object.entries(s.hidden.ffaDials)) {
      const pts = scoreDial(dial.v, target);
      ffa[id] = pts;
      dials[id] = dial.v;
      guesserPoints.push(pts);
      const dist = Math.abs(dial.v - target);
      if (pts > bestPoints || (pts === bestPoints && dist < bestDist)) {
        bestPoints = pts;
        bestDial = dial.v;
        bestDist = dist;
      }
      if (pts === 4) s.stats.bullseyes[id] = (s.stats.bullseyes[id] ?? 0) + 1;
    }
    bestPoints = Math.max(0, bestPoints);
    ffa[s.psychic] = roundedMean(guesserPoints);
    for (const [id, pts] of Object.entries(ffa)) add(id, pts);
    last.ffa = ffa;
    last.dials = dials;
  }
  last.points = bestPoints;
  last.dial = bestDial;
  last.bet = betForPoints(bestPoints);
  if (audienceCounts(s) && s.dialResult !== null) {
    const audMean = clampDial(s.dialResult.mean);
    last.audMean = audMean;
    last.audBand = scoreDial(audMean, target);
    if (last.audBand > bestPoints) {
      last.chatBeatYou = true;
      s.stats.chatBeats += 1;
    }
  }
  for (const [id, pts] of Object.entries(deltas)) s.scores[id] = (s.scores[id] ?? 0) + pts;
  s.last = last;
  if (s.polls.bet !== null) {
    fx.push({ type: "audience.resolve", pollId: s.polls.bet, correct: last.bet });
  }
  if (s.polls.dial !== null) {
    fx.push({ type: "audience.resolve", pollId: s.polls.dial, target, bands: AUDIENCE_BANDS });
  }
  if (Object.keys(deltas).length > 0) fx.push({ type: "score", deltas });
  fx.push({ type: "fx", name: "reveal", data: { target, points: bestPoints } });
  if (last.chatBeatYou) fx.push({ type: "fx", name: "chatBeatYou" });
  if (last.catchUp) fx.push({ type: "fx", name: "catchUp", data: { team: last.team } });
  setTimer(s, fx, "reveal", s.deadline);
}

function enterTurnScore(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "turn-score";
  s.deadline = ctx.now + ctx.timing.pace(TURN_SCORE_MS);
  setTimer(s, fx, "score", s.deadline);
}

/** R11: next turn, sudden death, or the end. */
function afterTurnScore(s: TiState, fx: Fx, ctx: Ctx): void {
  if (s.mode === "ffa") {
    if (s.turn >= s.psychicQueue.length) enterFinal(s, fx, ctx);
    else startTurn(s, fx, ctx);
    return;
  }
  const [a, b] = s.teams as [TiTeam, TiTeam];
  const sa = s.scores[a.id] ?? 0;
  const sb = s.scores[b.id] ?? 0;
  if (s.suddenDeath !== null) {
    if (s.suddenDeath.queue.length === 0) enterFinal(s, fx, ctx);
    else startTurn(s, fx, ctx);
    return;
  }
  if (sa >= s.options.scoreToWin || sb >= s.options.scoreToWin) {
    enterFinal(s, fx, ctx);
    return;
  }
  if (s.turn >= TEAM_TURN_CAP) {
    if (sa !== sb) {
      enterFinal(s, fx, ctx);
      return;
    }
    const first = s.nextTeam ?? a.id;
    const second = first === a.id ? b.id : a.id;
    s.suddenDeath = { queue: [first, second] };
    s.maxTurns = s.turn + 2;
    fx.push({ type: "fx", name: "suddenDeath" });
  }
  startTurn(s, fx, ctx);
}

/** The final ranking (R11). */
export function finalRanking(s: TiState): GameResult["ranking"] {
  if (s.mode === "ffa")
    return rankByScore(
      s.players.map((p) => p.id),
      s.scores,
    );
  const ranking = rankByScore(
    s.teams.map((t) => t.id),
    s.scores,
  );
  const [first, second] = ranking;
  if (
    first !== undefined &&
    second !== undefined &&
    first.score === second.score &&
    s.suddenDeath === null &&
    first.score >= s.options.scoreToWin &&
    s.lastScorer !== null
  ) {
    // Both reached scoreToWin on the same turn with equal scores: the team that scored last wins.
    const winner = s.lastScorer;
    return ranking
      .map((r) => ({ ...r, place: r.id === winner ? 1 : 2 }))
      .sort((x, y) => x.place - y.place);
  }
  return ranking;
}

function enterFinal(s: TiState, fx: Fx, ctx: Ctx): void {
  clearTimers(s, fx);
  s.phase = "final";
  s.deadline = ctx.now + ctx.timing.pace(FINAL_MS);
  s.winners = finalRanking(s)
    .filter((r) => r.place === 1)
    .map((r) => r.id);
  fx.push({ type: "fx", name: "win", data: { winners: s.winners } });
  setTimer(s, fx, "final", s.deadline);
}

function highlights(s: TiState): NonNullable<GameResult["highlights"]> {
  const out: NonNullable<GameResult["highlights"]> = [];
  const best = Object.entries(s.stats.bullseyes).sort((x, y) => y[1] - x[1])[0];
  if (best !== undefined && best[1] > 0) {
    const label = `${best[1]} bullseye${best[1] === 1 ? "" : "s"}`;
    out.push(
      s.mode === "ffa"
        ? { label, playerId: best[0] }
        : { label: `${label} (${teamById(s, best[0])?.name ?? best[0]})` },
    );
  }
  if (s.stats.chatBeats > 0) {
    out.push({ label: `Chat beat the table ${s.stats.chatBeats}×` });
  }
  return out;
}

function finish(s: TiState, fx: Fx): void {
  clearTimers(s, fx);
  s.deadline = null;
  fx.push({ type: "end", result: { ranking: finalRanking(s), highlights: highlights(s) } });
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Never throws; anything that is not exactly a {@link TiAction} is null. */
export function parseAction(raw: unknown): TiAction | null {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    switch (rec["type"]) {
      case "pickCard": {
        const idx = rec["idx"];
        return idx === 0 || idx === 1 ? { type: "pickCard", idx } : null;
      }
      case "clue": {
        const text = rec["text"];
        return typeof text === "string" && text.length > 0 && text.length <= 200
          ? { type: "clue", text }
          : null;
      }
      case "setDial": {
        const v = rec["v"];
        return isDialValue(v) ? { type: "setDial", v } : null;
      }
      case "lock":
        return { type: "lock" };
      case "steal": {
        const side = rec["side"];
        return side === "left" || side === "right" ? { type: "steal", side } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function onAction(state: TiState, action: TiAction, ctx: ActionCtx): Step<TiState> {
  const actor = ctx.actor.id;
  if (ctx.actor.role !== "player" || !state.players.some((p) => p.id === actor)) {
    return illegal(state, "not-seated");
  }
  switch (action.type) {
    case "pickCard": {
      if (
        state.phase !== "card-pick" ||
        state.cardPicker !== "psychic" ||
        actor !== state.psychic
      ) {
        return illegal(state);
      }
      const s = clone(state);
      const fx: Fx = [];
      chooseCard(s, fx, ctx, action.idx, "psychic");
      return { state: s, effects: fx };
    }
    case "clue": {
      if (state.phase !== "clue" || actor !== state.psychic || state.card === undefined) {
        return illegal(state);
      }
      const check = checkClue(action.text, state.card);
      if (!check.ok) {
        return {
          state,
          effects: [
            {
              type: "private",
              to: actor,
              name: "clueRejected",
              data:
                check.word !== undefined
                  ? { reason: check.reason, word: check.word }
                  : { reason: check.reason },
            },
          ],
        };
      }
      const s = clone(state);
      const fx: Fx = [];
      giveClue(s, fx, ctx, check.clue, false);
      return { state: s, effects: fx };
    }
    case "setDial": {
      if (!canSetDial(state, actor)) return illegal(state);
      const recent = (state.dialRate[actor] ?? []).filter(
        (t) => t > ctx.now - 1000 && t <= ctx.now,
      );
      if (recent.length >= DIAL_RATE_MAX) return illegal(state, "rate");
      const s = clone(state);
      s.dialRate[actor] = [...recent, ctx.now];
      if (s.mode === "teams") {
        s.dial = action.v;
        s.dialMoved = true;
      } else {
        const own = s.hidden.ffaDials[actor] as FfaDial;
        own.v = action.v;
        own.moved = true;
      }
      return { state: s };
    }
    case "lock": {
      const elapsed = ctx.now - (state.guessStartedAt ?? ctx.now);
      if (!canLock(state, actor, elapsed)) return illegal(state);
      const s = clone(state);
      const fx: Fx = [];
      if (s.mode === "teams") {
        lockTeamDial(s, fx, ctx);
      } else {
        (s.hidden.ffaDials[actor] as FfaDial).locked = true;
        fx.push({ type: "fx", name: "playerLocked", data: { id: actor } });
        if (ffaDone(s)) endFfaGuess(s, fx, ctx);
      }
      return { state: s, effects: fx };
    }
    case "steal": {
      if (!canSteal(state, actor)) return illegal(state);
      const s = clone(state);
      const fx: Fx = [];
      s.stealPicks[actor] = action.side;
      if (stealDone(s)) toReveal(s, fx, ctx);
      return { state: s, effects: fx };
    }
  }
}

function onTimer(state: TiState, timerId: string, ctx: Ctx): Step<TiState> {
  if (!state.timers.includes(timerId)) return { state };
  const name = timerId.slice(0, timerId.indexOf("@"));
  const s = clone(state);
  s.timers = s.timers.filter((t) => t !== timerId);
  const fx: Fx = [];
  switch (name) {
    case "intro":
      startTurn(s, fx, ctx);
      break;
    case "cardVote":
      // The vote's result never arrived: the psychic picks (R4).
      s.polls.card = null;
      psychicPick(s, fx, ctx);
      break;
    case "cardPick":
      chooseCard(s, fx, ctx, 0, "timeout");
      break;
    case "clue":
      giveClue(s, fx, ctx, botClue(s, ctx.rng), true);
      break;
    case "guess":
      guessDeadline(s, fx, ctx);
      break;
    case "steal":
      toReveal(s, fx, ctx);
      break;
    case "dialWait":
      dialWaitOver(s, fx, ctx);
      break;
    case "reveal":
      enterTurnScore(s, fx, ctx);
      break;
    case "score":
      afterTurnScore(s, fx, ctx);
      break;
    case "final":
      finish(s, fx);
      break;
    default:
      return { state };
  }
  return { state: s, effects: fx };
}

function guessDeadline(s: TiState, fx: Fx, ctx: Ctx): void {
  if (s.mode === "ffa") endFfaGuess(s, fx, ctx);
  else if (teamGuessers(s).length === 0) awaitSoloDial(s, fx, ctx);
  else lockTeamDial(s, fx, ctx);
}

function dialWaitOver(s: TiState, fx: Fx, ctx: Ctx): void {
  s.dialWaited = true;
  if (s.mode === "teams" && !s.locked) {
    // Solo team, no dial result: lock at 500 (R6).
    s.dial = DIAL_REST;
    lockTeamDial(s, fx, ctx);
    return;
  }
  enterReveal(s, fx, ctx);
}

function onAudienceResult(state: TiState, r: PollResult, ctx: Ctx): Step<TiState> {
  if (
    r.pollId === state.polls.card &&
    state.phase === "card-pick" &&
    state.cardPicker === "audience"
  ) {
    const s = clone(state);
    const fx: Fx = [];
    s.polls.card = null;
    clearTimers(s, fx);
    fx.push({ type: "fx", name: "cardVote", data: { tallies: { ...r.tallies }, total: r.total } });
    if (r.total >= AUDIENCE_MIN) {
      const a = r.tallies["0"] ?? 0;
      const b = r.tallies["1"] ?? 0;
      const idx: 0 | 1 = a > b ? 0 : b > a ? 1 : ctx.rng.int(2) === 0 ? 0 : 1;
      chooseCard(s, fx, ctx, idx, "audience");
    } else {
      psychicPick(s, fx, ctx);
    }
    return { state: s, effects: fx };
  }
  if (r.pollId === state.polls.dial && state.polls.dial !== null && state.dialResult === null) {
    const s = clone(state);
    const fx: Fx = [];
    s.dialResult = {
      mean: typeof r.mean === "number" && Number.isFinite(r.mean) ? r.mean : DIAL_REST,
      total: r.total,
    };
    s.dialOpen = false;
    if (s.phase === "guess" && s.mode === "teams" && !s.locked && s.awaitingDial) {
      // Solo team: the audience mean becomes the dial when the audience counted (R6).
      s.dial = audienceCounts(s) ? clampDial(s.dialResult.mean) : DIAL_REST;
      lockTeamDial(s, fx, ctx);
    } else if (s.awaitingDial) {
      enterReveal(s, fx, ctx);
    }
    return { state: s, effects: fx };
  }
  return { state };
}

function onPlayerLeave(state: TiState, id: PlayerId, ctx: Ctx): Step<TiState> {
  const s = clone(state);
  const p = s.players.find((x) => x.id === id);
  if (p === undefined) return { state };
  p.connected = false;
  const fx: Fx = [];
  if (s.phase === "clue" && s.psychic === id && s.clue === undefined) {
    giveClue(s, fx, ctx, botClue(s, ctx.rng), true); // R12
  } else if (s.phase === "card-pick" && s.cardPicker === "psychic" && s.psychic === id) {
    chooseCard(s, fx, ctx, 0, "timeout");
  } else if (s.phase === "guess" && s.mode === "ffa" && !s.locked && ffaDone(s)) {
    endFfaGuess(s, fx, ctx);
  } else if (s.phase === "steal" && !s.awaitingDial && stealDone(s)) {
    toReveal(s, fx, ctx);
  }
  return { state: s, effects: fx };
}

function onPlayerRejoin(state: TiState, id: PlayerId): Step<TiState> {
  const idx = state.players.findIndex((p) => p.id === id);
  if (idx < 0 || state.players[idx]?.connected === true) return { state };
  const s = clone(state);
  (s.players[idx] as TiPlayer).connected = true;
  return { state: s };
}

function onHostCommand(state: TiState, cmd: GameHostCommand, ctx: Ctx): Step<TiState> {
  const s = clone(state);
  const fx: Fx = [];
  if (cmd.c === "skipItem") {
    // Skip an offered card: draw a fresh pair and restart the pick.
    if (state.phase !== "card-pick" || !state.cardChoices.some((c) => c.id === cmd.itemId)) {
      return { state };
    }
    if (s.polls.card !== null) fx.push({ type: "audience.close", pollId: s.polls.card });
    s.polls.card = null;
    drawChoices(s);
    enterCardPick(s, fx, ctx);
    return { state: s, effects: fx };
  }
  switch (s.phase) {
    case "intro":
      startTurn(s, fx, ctx);
      break;
    case "card-pick":
      if (s.polls.card !== null) fx.push({ type: "audience.close", pollId: s.polls.card });
      s.polls.card = null;
      chooseCard(s, fx, ctx, 0, "host");
      break;
    case "clue":
      giveClue(s, fx, ctx, botClue(s, ctx.rng), true);
      break;
    case "guess":
      if (s.awaitingDial) dialWaitOver(s, fx, ctx);
      else guessDeadline(s, fx, ctx);
      break;
    case "steal":
      if (s.awaitingDial) dialWaitOver(s, fx, ctx);
      else toReveal(s, fx, ctx);
      break;
    case "reveal":
      enterTurnScore(s, fx, ctx);
      break;
    case "turn-score":
      afterTurnScore(s, fx, ctx);
      break;
    case "final":
      finish(s, fx);
      break;
  }
  return { state: s, effects: fx };
}

// ---------------------------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------------------------

/** Representative dial values for `legalActions` (the dial takes any integer 0–1000). */
const DIAL_SAMPLES = [0, 125, 250, 375, 500, 625, 750, 875, 1000] as const;

function legalActions(state: TiState, player: PlayerId): TiAction[] {
  switch (state.phase) {
    case "card-pick":
      return state.cardPicker === "psychic" && player === state.psychic
        ? [
            { type: "pickCard", idx: 0 },
            { type: "pickCard", idx: 1 },
          ]
        : [];
    case "clue": {
      if (player !== state.psychic || state.card === undefined) return [];
      const card = state.card;
      const valid: string[] = [];
      for (const text of [...(card.examples ?? []), ...BOT_CLUES]) {
        if (valid.length >= 5) break;
        if (checkClue(text, card).ok) valid.push(text);
      }
      return (valid.length > 0 ? valid : [botClue(state, null)]).map((text) => ({
        type: "clue",
        text,
      }));
    }
    case "guess": {
      if (!canSetDial(state, player)) return [];
      const out: TiAction[] = DIAL_SAMPLES.map((v) => ({ type: "setDial", v }));
      if (canLock(state, player, null)) out.push({ type: "lock" });
      return out;
    }
    case "steal":
      return canSteal(state, player)
        ? [
            { type: "steal", side: "left" },
            { type: "steal", side: "right" },
          ]
        : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------------

/** The Tune In game module (SPEC §9.3). */
export const tuneIn: GameModule<TiState, TiAction, TiOptions, TiView> = {
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
  bot(state: TiState, player: PlayerId, rng: Rng): TiAction | null {
    return botAction(state, player, rng);
  },
  serialize(state: TiState): string {
    return JSON.stringify(state);
  },
  deserialize(data: string): TiState {
    return JSON.parse(data) as TiState;
  },
};
