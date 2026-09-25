/**
 * Read-only state queries shared by the reducers, the views, `legalActions` and the bot.
 *
 * @module
 */
import type { PlayerId } from "@sg/shared";
import { rankEntries } from "./rules.ts";
import type { Standing, TnPlayer, TnState, TnTeam } from "./types.ts";

/** A seated player by id. */
export function playerById(state: TnState, id: PlayerId): TnPlayer | undefined {
  return state.players.find((p) => p.id === id);
}

/** The team a player is on (team mode), from the game's own team table. */
export function teamOf(state: TnState, id: PlayerId): TnTeam | undefined {
  return state.teams.find((t) => t.members.includes(id));
}

/** Whether a player is connected. Unknown ids count as disconnected. */
export function isConnected(state: TnState, id: PlayerId): boolean {
  return playerById(state, id)?.connected ?? false;
}

/** Team mode is on (R7). */
export function isTeamMode(state: TnState): boolean {
  return state.teams.length > 0;
}

/**
 * May `player` lock an answer now? `now` is the game time of the attempt (a late answer is
 * rejected: the server time decides); `null` skips the clock check (views, `legalActions`).
 */
export function canAnswer(state: TnState, player: PlayerId, now: number | null): boolean {
  if (!state.players.some((p) => p.id === player)) return false;
  if (now !== null && state.deadline !== null && now > state.deadline) return false;
  if (state.phase === "answer") {
    return !state.answerClosed && state.hidden.answers[player] === undefined;
  }
  if (state.phase === "showdown-answer") {
    return (
      !state.answerClosed &&
      state.showdown !== undefined &&
      state.showdown.players.includes(player) &&
      state.hidden.showdownAnswers[player] === undefined
    );
  }
  return false;
}

/** Every connected player who must still answer the current question. */
export function pendingAnswers(state: TnState): PlayerId[] {
  if (state.phase === "showdown-answer") {
    return (state.showdown?.players ?? []).filter(
      (id) => state.hidden.showdownAnswers[id] === undefined && isConnected(state, id),
    );
  }
  return state.players
    .filter((p) => p.connected && state.hidden.answers[p.id] === undefined)
    .map((p) => p.id);
}

/** Total correct-answer time of a team (R8 tie-break in team mode). */
function teamCorrectMs(state: TnState, team: TnTeam): number {
  return team.members.reduce((sum, m) => sum + (state.totalCorrectMs[m] ?? 0), 0);
}

/** The lowest seat among a team's members. */
function teamSeat(state: TnState, team: TnTeam): number {
  return Math.min(...team.members.map((m) => playerById(state, m)?.seat ?? Infinity));
}

/** R8 standings: players, or teams in team mode. */
export function standings(state: TnState): Standing[] {
  if (isTeamMode(state)) {
    return rankEntries(
      state.teams.map((t) => ({
        id: t.id,
        score: state.teamScores[t.id] ?? 0,
        correctMs: teamCorrectMs(state, t),
        seat: teamSeat(state, t),
      })),
    );
  }
  return rankEntries(
    state.players.map((p) => ({
      id: p.id,
      score: state.scores[p.id] ?? 0,
      correctMs: state.totalCorrectMs[p.id] ?? 0,
      seat: p.seat,
    })),
  );
}

/**
 * Whether a phase involves `player`'s own content (DOD G14 "player idle": a reveal involving
 * their own content): their result at the reveal, their standing at the scoreboard, the
 * audience voting on them for the lifeline, and the Showdown for its two players.
 */
export function involves(state: TnState, player: PlayerId): boolean {
  switch (state.phase) {
    case "reveal":
    case "scoreboard":
    case "lifeline-vote":
      return state.players.some((p) => p.id === player);
    case "showdown":
    case "showdown-answer":
    case "showdown-verdict":
      return state.showdown?.players.includes(player) ?? false;
    default:
      return false;
  }
}
