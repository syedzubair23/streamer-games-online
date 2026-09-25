/**
 * Read-only state queries shared by the reducers, the views, `legalActions` and the bot.
 *
 * @module
 */
import type { PlayerId, TeamId } from "@sg/shared";
import { LOCK_MIN_MS, type TiPlayer, type TiState, type TiTeam } from "./types.ts";

/** A seated player by id. */
export function playerById(state: TiState, id: PlayerId): TiPlayer | undefined {
  return state.players.find((p) => p.id === id);
}

/** A team by id. */
export function teamById(state: TiState, id: TeamId | undefined): TiTeam | undefined {
  return id === undefined ? undefined : state.teams.find((t) => t.id === id);
}

/** The team a player is on (teams mode), from the game's own team table. */
export function teamOf(state: TiState, id: PlayerId): TiTeam | undefined {
  return state.teams.find((t) => t.members.includes(id));
}

/** The other team (teams mode has exactly two). */
export function otherTeam(state: TiState, id: TeamId | undefined): TiTeam | undefined {
  return state.teams.find((t) => t.id !== id);
}

/** Teams mode: the active team's members who guess (everyone but the psychic). */
export function teamGuessers(state: TiState): PlayerId[] {
  const team = teamById(state, state.activeTeam);
  return team === undefined ? [] : team.members.filter((m) => m !== state.psychic);
}

/** FFA: every player but the psychic guesses. */
export function ffaGuessers(state: TiState): PlayerId[] {
  return state.players.filter((p) => p.id !== state.psychic).map((p) => p.id);
}

/** Teams mode: the members of the stealing team (R7), when a steal can happen at all. */
export function stealers(state: TiState): PlayerId[] {
  if (state.mode !== "teams") return [];
  return otherTeam(state, state.activeTeam)?.members ?? [];
}

/** Whether a player is connected. Unknown ids count as disconnected. */
export function isConnected(state: TiState, id: PlayerId): boolean {
  return playerById(state, id)?.connected ?? false;
}

/** May `player` move the dial now (ignoring the time-based rate limit)? */
export function canSetDial(state: TiState, player: PlayerId): boolean {
  if (state.phase !== "guess" || state.locked || state.awaitingDial) return false;
  if (state.mode === "teams") return teamGuessers(state).includes(player);
  const own = state.hidden.ffaDials[player];
  return own !== undefined && !own.locked && player !== state.psychic;
}

/**
 * May `player` lock now? `elapsedMs` is the time since the guess opened; `null` means "don't
 * count the clock" (only a moved dial unlocks the lock), which is what `legalActions` uses.
 */
export function canLock(state: TiState, player: PlayerId, elapsedMs: number | null): boolean {
  if (!canSetDial(state, player)) return false;
  const moved =
    state.mode === "teams" ? state.dialMoved : (state.hidden.ffaDials[player]?.moved ?? false);
  return moved || (elapsedMs !== null && elapsedMs >= LOCK_MIN_MS);
}

/** May `player` pick a steal side now? Picks are final. */
export function canSteal(state: TiState, player: PlayerId): boolean {
  return (
    state.phase === "steal" &&
    stealers(state).includes(player) &&
    state.stealPicks[player] === undefined
  );
}
