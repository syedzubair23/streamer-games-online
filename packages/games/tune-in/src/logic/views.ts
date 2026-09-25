/**
 * Tune In views (`docs/specs/tune-in.md` "Views"): the security boundary.
 *
 * - The target is in the psychic's own player view during `clue` and `guess` only, and public
 *   from `reveal` on. Every other view (stage, audience, host, moderator, other players) gets
 *   `target: null` until then.
 * - FFA dials: each player sees only their own dial before the reveal; the stage sees only who
 *   has locked.
 * - The team dial is live and public: it is part of the show.
 * - The deck and bot examples never leave the server.
 *
 * @module
 */
import type { ViewerKey } from "@sg/engine";
import { canLock, otherTeam, teamOf } from "./state.ts";
import {
  LOCK_MIN_MS,
  type Card,
  type CardView,
  type TiLast,
  type TiState,
  type TiView,
  type TiYou,
} from "./types.ts";

const cardView = (c: Card): CardView => ({ id: c.id, left: c.left, right: c.right });

/** Phases in which the target is public (R1: secret until the reveal). */
const PUBLIC_TARGET = new Set<TiState["phase"]>(["reveal", "turn-score"]);

function you(state: TiState, id: string): TiYou | null {
  const me = state.players.find((p) => p.id === id);
  if (me === undefined) return null;
  const teamId = teamOf(state, id)?.id ?? null;
  let role: TiYou["role"] = "waiting";
  if (state.phase === "card-pick" || state.phase === "clue") {
    if (id === state.psychic) role = "psychic";
  } else if (state.phase === "guess") {
    if (id === state.psychic) role = "psychic";
    else if (state.mode === "ffa" || teamId === state.activeTeam) role = "guesser";
  } else if (state.phase === "steal") {
    if (teamId !== null && teamId === otherTeam(state, state.activeTeam)?.id) role = "stealer";
    else if (id === state.psychic) role = "psychic";
    else if (teamId === state.activeTeam) role = "guesser";
  }
  const own = state.hidden.ffaDials[id];
  return {
    id,
    teamId,
    role,
    ffaDial: own === undefined ? null : { ...own },
    canLock: canLock(state, id, null),
    stealPick: state.stealPicks[id] ?? null,
  };
}

/** Builds the view for one viewer. Pure; never includes another viewer's secrets. */
export function viewFor(state: TiState, viewer: ViewerKey): TiView {
  const isPsychic = viewer.role === "player" && viewer.id === state.psychic;
  const psychicSees = isPsychic && (state.phase === "clue" || state.phase === "guess");
  const lastPublic = state.last !== undefined && state.turn > 0;
  // `last` is this turn's result from `reveal` on; before that it is the previous turn's.
  const target =
    PUBLIC_TARGET.has(state.phase) || state.phase === "final"
      ? (state.last?.target ?? null)
      : psychicSees
        ? state.hidden.target
        : null;
  const stealTeam =
    state.phase === "steal" || (state.phase === "reveal" && state.last?.steal !== undefined)
      ? (otherTeam(state, state.activeTeam)?.id ?? null)
      : null;
  return {
    phase: state.phase,
    deadline: state.deadline,
    mode: state.mode,
    turn: state.turn,
    maxTurns: state.maxTurns,
    suddenDeath: state.suddenDeath !== null,
    players: state.players.map((p) => ({ ...p })),
    teams: state.teams.map((t) => ({ ...t, members: [...t.members] })),
    psychic: state.psychic,
    activeTeam: state.activeTeam ?? null,
    stealTeam,
    cardChoices: [cardView(state.cardChoices[0]), cardView(state.cardChoices[1])],
    card: state.card === undefined ? null : cardView(state.card),
    cardPicker: state.cardPicker,
    clue: state.clue ?? null,
    dial: state.dial,
    dialMoved: state.dialMoved,
    locked: state.locked,
    lockOpensAt: state.guessStartedAt === null ? null : state.guessStartedAt + LOCK_MIN_MS,
    ffaLocked: Object.entries(state.hidden.ffaDials)
      .filter(([, d]) => d.locked)
      .map(([id]) => id),
    stealPicks: { ...state.stealPicks },
    awaitingDial: state.awaitingDial,
    target,
    last: lastPublic && state.last !== undefined ? copyLast(state.last) : null,
    scores: { ...state.scores },
    catchUpUsed: state.catchUpUsed,
    polls: { ...state.polls },
    winners: state.winners === null ? null : [...state.winners],
    scoreToWin: state.options.scoreToWin,
    liveHeatmap: state.options.liveHeatmap,
    you: viewer.role === "player" ? you(state, viewer.id) : null,
  };
}

function copyLast(last: TiLast): TiLast {
  const out: TiLast = { ...last };
  if (last.steal !== undefined) out.steal = { ...last.steal };
  if (last.ffa !== undefined) out.ffa = { ...last.ffa };
  if (last.dials !== undefined) out.dials = { ...last.dials };
  return out;
}
