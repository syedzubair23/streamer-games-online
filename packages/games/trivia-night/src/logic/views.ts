/**
 * Trivia Night views (`docs/specs/trivia-night.md` "Views"): the security boundary.
 *
 * - The correct option, the audience distribution and other players' answers stay hidden until
 *   the reveal; the question text is public from `read`, the options from `answer`.
 * - A player sees their own lock state and choice. Only the lifeline recipient sees the two
 *   removed options, and only for the question the lifeline applies to.
 * - Stage and audience see the question and options (from `answer`), who has locked (plates),
 *   the countdown, and at the reveal each player's result and the audience share per option.
 * - The queue, spares, showdown questions and the full current item never leave the server.
 *
 * @module
 */
import type { ViewerKey } from "@sg/engine";

import { canAnswer, standings, teamOf } from "./state.ts";
import type { LastReveal, Showdown, TnState, TnView, TnYou } from "./types.ts";

/** Phases in which the current question's options are public (from `answer` on). */
const OPTIONS_PUBLIC = new Set<TnState["phase"]>(["answer", "reveal"]);
/** Phases in which the current question's text is public (from `read` on). */
const QUESTION_PUBLIC = new Set<TnState["phase"]>(["read", "answer", "reveal"]);
/** Phases in which the current question's category is public. */
const CATEGORY_PUBLIC = new Set<TnState["phase"]>(["category", "read", "answer", "reveal"]);

function copyReveal(r: LastReveal): LastReveal {
  const perPlayer: LastReveal["perPlayer"] = {};
  for (const [id, line] of Object.entries(r.perPlayer)) perPlayer[id] = { ...line };
  const out: LastReveal = { ...r, perPlayer, cooledOff: [...r.cooledOff] };
  if (r.audiencePct !== undefined) out.audiencePct = [...r.audiencePct];
  if (r.teamAnswers !== undefined) out.teamAnswers = { ...r.teamAnswers };
  return out;
}

function copyShowdown(sd: Showdown): Showdown {
  const out: Showdown = { ...sd, players: [...sd.players], answered: [...sd.answered] };
  if (sd.q !== undefined) out.q = { q: sd.q.q, options: [...sd.q.options] };
  if (sd.verdict !== undefined) out.verdict = [...sd.verdict];
  if (sd.results !== undefined) {
    const results: NonNullable<Showdown["results"]> = {};
    for (const [id, r] of Object.entries(sd.results)) results[id] = { ...r };
    out.results = results;
  }
  return out;
}

function you(state: TnState, id: string): TnYou | null {
  const me = state.players.find((p) => p.id === id);
  if (me === undefined) return null;
  const inShowdown =
    state.showdown !== undefined &&
    state.showdown.players.includes(id) &&
    (state.phase === "showdown" ||
      state.phase === "showdown-answer" ||
      state.phase === "showdown-verdict");
  const lock =
    state.phase === "showdown-answer" || state.phase === "showdown-verdict"
      ? state.hidden.showdownAnswers[id]
      : state.phase === "answer" || state.phase === "reveal"
        ? state.hidden.answers[id]
        : undefined;
  const removed = state.hidden.lifelineRemoved;
  const showRemoved =
    removed !== undefined &&
    removed.player === id &&
    state.lifeline.question === state.index &&
    OPTIONS_PUBLIC.has(state.phase);
  const last =
    state.lastReveal !== undefined && state.lastReveal.index === state.index
      ? (state.lastReveal.perPlayer[id] ?? null)
      : null;
  return {
    id,
    teamId: teamOf(state, id)?.id ?? null,
    canAnswer: canAnswer(state, id, null),
    locked: lock !== undefined,
    choice: lock?.choice ?? null,
    removed: showRemoved ? [removed.remove[0], removed.remove[1]] : null,
    streak: state.streaks[id] ?? 0,
    steamedLeft: state.steamed[id]?.questionsLeft ?? 0,
    last: last === null ? null : { ...last },
    inShowdown,
  };
}

/** Builds the view for one viewer. Pure; never includes another viewer's secrets. */
export function viewFor(state: TnState, viewer: ViewerKey): TnView {
  const cur = state.current;
  const chatPct =
    state.stats.chatQuestions > 0
      ? Math.round((100 * state.stats.chatRateSum) / state.stats.chatQuestions)
      : null;
  const playersPct =
    state.stats.playerChances > 0
      ? Math.round((100 * state.stats.playerCorrect) / state.stats.playerChances)
      : null;
  const speedNote = viewer.role === "host" && !state.speedBonusOn;
  return {
    phase: state.phase,
    deadline: state.deadline,
    mode: state.mode,
    index: state.index,
    total: state.total,
    category: cur !== undefined && CATEGORY_PUBLIC.has(state.phase) ? cur.category : null,
    difficulty: cur !== undefined && CATEGORY_PUBLIC.has(state.phase) ? cur.difficulty : null,
    q: cur?.q !== undefined && QUESTION_PUBLIC.has(state.phase) ? cur.q : null,
    options:
      cur?.options !== undefined && OPTIONS_PUBLIC.has(state.phase) ? [...cur.options] : null,
    inputMs:
      (state.phase === "answer" || state.phase === "showdown-answer") &&
      state.deadline !== null &&
      state.openedAt !== null
        ? state.deadline - state.openedAt
        : null,
    answered: [...state.answered],
    answerClosed: state.answerClosed,
    lastReveal: state.lastReveal === undefined ? null : copyReveal(state.lastReveal),
    scores: { ...state.scores },
    teamScores: { ...state.teamScores },
    streaks: { ...state.streaks },
    steamed: Object.fromEntries(
      Object.entries(state.steamed).map(([id, s]) => [id, { questionsLeft: s.questionsLeft }]),
    ),
    standings: standings(state),
    players: state.players.map((p) => ({ ...p })),
    teams: state.teams.map((t) => ({ ...t, members: [...t.members] })),
    showdown: state.showdown === undefined ? null : copyShowdown(state.showdown),
    lifeline: { ...state.lifeline },
    polls: { ...state.polls },
    answerSec: state.options.answerSec,
    speedBonus: state.speedBonusOn,
    hostNote: speedNote
      ? state.options.speedScoring
        ? "Speed bonus off (no timer)"
        : "Speed bonus off"
      : null,
    chatVsPlayers: { chatPct, playersPct },
    winners: state.winners === null ? null : [...state.winners],
    you: viewer.role === "player" ? you(state, viewer.id) : null,
  };
}
