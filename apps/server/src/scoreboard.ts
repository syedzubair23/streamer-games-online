/**
 * Night Champion, the session scoreboard (SPEC §5).
 *
 * - Each finished game's `GameResult.ranking` becomes placement points **10 / 7 / 5 / 3 / 2 / 1**;
 *   every lower place gets 1. Ties share the higher placement (the ranking's `place` already
 *   says so: two players on place 2 both get 7).
 * - `scoring: "raw"` adds the game's own score instead.
 * - Benched players and bots earn nothing for a game they did not play, and bot-filled seats
 *   never appear in the standings: only ids in the game's **scorable participants** count.
 * - A ranking entry may be a team (team games): every scorable participant on that team gets
 *   the team's points.
 * - An empty ranking (Marble Rally with no seated players, Chess Streamer vs Chat when the
 *   streamer loses) leaves the standings unchanged.
 *
 * Pure bookkeeping: no sockets, no timers. The room actor feeds it and puts
 * {@link Scoreboard.standings} into the room snapshot.
 *
 * @module
 */
import type { GameId, PlayerId, RoomConfig, StandingRow, TeamId } from "@sg/shared";
import type { GameResult } from "@sg/engine";

/** Placement points for places 1..6 (SPEC §5); every lower place gets {@link LOWER_PLACE_POINTS}. */
export const PLACEMENT_POINTS: readonly number[] = Object.freeze([10, 7, 5, 3, 2, 1]);
/** Points for 7th place and below. */
export const LOWER_PLACE_POINTS = 1;

/** Placement points for a 1-based place. Non-positive or non-integer places earn nothing. */
export function placementPoints(place: number): number {
  if (!Number.isInteger(place) || place < 1) return 0;
  return PLACEMENT_POINTS[place - 1] ?? LOWER_PLACE_POINTS;
}

/** One participant of a finished game, as the scoreboard needs it. */
export interface ScoredParticipant {
  id: PlayerId;
  name: string;
  teamId?: TeamId;
}

/** What one game added to the standings. */
export interface GameAward {
  gameId: GameId;
  /** Points per player id. */
  points: Record<PlayerId, number>;
}

/** One player's running total. */
interface Entry {
  id: PlayerId;
  name: string;
  points: number;
  /** Order of first appearance: the stable tie-break for display order. */
  order: number;
}

/** The persisted form of a {@link Scoreboard}. */
export interface ScoreboardRecord {
  entries: { id: PlayerId; name: string; points: number }[];
  history: GameAward[];
}

/**
 * Night Champion totals across the games of one room session.
 */
export class Scoreboard {
  readonly #entries = new Map<PlayerId, Entry>();
  readonly #history: GameAward[] = [];

  /**
   * Adds a finished game. Only `participants` (real, non-bot players who played) can score;
   * ranking ids that are neither a participant nor a participant's team are ignored.
   * Returns the points awarded (empty when the ranking is empty).
   */
  record(
    gameId: GameId,
    result: GameResult,
    participants: readonly ScoredParticipant[],
    scoring: RoomConfig["scoring"],
  ): GameAward {
    const award: GameAward = { gameId, points: {} };
    const byId = new Map(participants.map((p) => [p.id, p]));
    for (const row of result.ranking) {
      const pts = scoring === "raw" ? finite(row.score) : placementPoints(row.place);
      const direct = byId.get(row.id);
      const receivers =
        direct !== undefined
          ? [direct]
          : participants.filter((p) => p.teamId !== undefined && p.teamId === row.id);
      for (const p of receivers) {
        // A player listed twice (as themself and via a team) keeps the better award.
        const prev = award.points[p.id];
        if (prev === undefined || pts > prev) award.points[p.id] = pts;
      }
    }
    for (const p of participants) {
      const pts = award.points[p.id];
      if (pts === undefined) continue;
      const entry = this.#entry(p.id, p.name);
      entry.name = p.name;
      entry.points += pts;
    }
    this.#history.push(award);
    return award;
  }

  /** Updates the display name of a player already on the board (rename). */
  rename(id: PlayerId, name: string): void {
    const e = this.#entries.get(id);
    if (e !== undefined) e.name = name;
  }

  /** Points of one player (0 when absent). */
  points(id: PlayerId): number {
    return this.#entries.get(id)?.points ?? 0;
  }

  /** Awards of every recorded game, oldest first. */
  get history(): readonly GameAward[] {
    return this.#history;
  }

  /**
   * The standings: highest points first; ties share the higher place (1, 2, 2, 4) and keep
   * first-appearance order. Players with 0 points after at least one game still appear if
   * they ever scored an entry.
   */
  standings(): StandingRow[] {
    const rows = [...this.#entries.values()].sort(
      (a, b) => b.points - a.points || a.order - b.order,
    );
    const out: StandingRow[] = [];
    rows.forEach((r, i) => {
      const prev = out[i - 1];
      const place = prev !== undefined && prev.points === r.points ? prev.place : i + 1;
      out.push({ id: r.id, name: r.name, points: r.points, place });
    });
    return out;
  }

  /** JSON-safe copy for room snapshots. */
  toRecord(): ScoreboardRecord {
    return {
      entries: [...this.#entries.values()]
        .sort((a, b) => a.order - b.order)
        .map((e) => ({ id: e.id, name: e.name, points: e.points })),
      history: this.#history.map((h) => ({ gameId: h.gameId, points: { ...h.points } })),
    };
  }

  /** Rebuilds a scoreboard from {@link toRecord}. */
  static fromRecord(r: ScoreboardRecord): Scoreboard {
    const s = new Scoreboard();
    for (const e of r.entries) s.#entry(e.id, e.name).points = e.points;
    for (const h of r.history) s.#history.push({ gameId: h.gameId, points: { ...h.points } });
    return s;
  }

  #entry(id: PlayerId, name: string): Entry {
    let e = this.#entries.get(id);
    if (e === undefined) {
      e = { id, name, points: 0, order: this.#entries.size };
      this.#entries.set(id, e);
    }
    return e;
  }
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}
