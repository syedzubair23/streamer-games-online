/**
 * The between-games decisions of a room (SPEC §3 steps 3–6): which playlist entry runs next,
 * the audience's next-game vote, who plays a game and who is benched, and the seat raffle.
 *
 * Everything here is a pure function of its inputs and a seeded {@link Rng}, so a room with a
 * fixed seed makes the same choices every time (the raffle and the participant draw are
 * deterministic for a fixed seed, ROADMAP M1-02).
 *
 * @module
 */
import type { PlayerId, PlaylistItem, Rng } from "@sg/shared";

// ---------------------------------------------------------------------------------------------
// Playlist order and the next-game vote
// ---------------------------------------------------------------------------------------------

/** The audience's next-game vote runs this long (SPEC §3 step 5), plus the stream delay. */
export const NEXT_GAME_VOTE_MS = 15_000;
/** How many not-yet-played entries the next-game vote offers. */
export const NEXT_GAME_CANDIDATES = 3;
/** Poll id of the next-game vote. */
export const NEXT_GAME_POLL_ID = "sg:next-game";

/**
 * Unplayed playlist indices in playlist order, starting after `after` and wrapping around
 * (so a room that skipped ahead still reaches earlier entries). At most `max` are returned.
 */
export function unplayedAfter(
  playlist: readonly PlaylistItem[],
  played: ReadonlySet<number>,
  after: number,
  max = Number.POSITIVE_INFINITY,
): number[] {
  const out: number[] = [];
  const n = playlist.length;
  for (let k = 1; k <= n && out.length < max; k++) {
    const i = (((after + k) % n) + n) % n;
    if (!played.has(i)) out.push(i);
  }
  return out;
}

/** The next unplayed entry in playlist order (the `fixed` mode and the vote fallback). */
export function nextInOrder(
  playlist: readonly PlaylistItem[],
  played: ReadonlySet<number>,
  after: number,
): number | null {
  return unplayedAfter(playlist, played, after, 1)[0] ?? null;
}

/** The candidates of a next-game vote: up to 3 unplayed entries in playlist order. */
export function nextGameCandidates(
  playlist: readonly PlaylistItem[],
  played: ReadonlySet<number>,
  after: number,
): number[] {
  return unplayedAfter(playlist, played, after, NEXT_GAME_CANDIDATES);
}

/** How a next-game vote was decided. */
export interface VoteOutcome {
  /** The chosen playlist index. */
  index: number;
  /** True when the audience decided (at least `audienceMin` voters and a vote was cast). */
  counted: boolean;
}

/**
 * Decides a next-game vote (SPEC §3 step 5, §4 "Minimum audience"). With at least
 * `audienceMin` voters the plurality candidate wins, ties going to the earlier candidate in
 * playlist order; below that, the first candidate (the playlist order) runs.
 *
 * @param candidates playlist indices in playlist order (non-empty)
 * @param tallies option id (the playlist index as a string) → votes
 * @param voters distinct audience members who voted
 * @throws RangeError when there are no candidates
 */
export function resolveNextGameVote(
  candidates: readonly number[],
  tallies: Readonly<Record<string, number>>,
  voters: number,
  audienceMin: number,
): VoteOutcome {
  const first = candidates[0];
  if (first === undefined) throw new RangeError("resolveNextGameVote: no candidates");
  if (voters < audienceMin) return { index: first, counted: false };
  let best = first;
  let bestVotes = -1;
  for (const c of candidates) {
    const v = tallies[String(c)] ?? 0;
    if (v > bestVotes) {
      best = c;
      bestVotes = v;
    }
  }
  return bestVotes > 0 ? { index: best, counted: true } : { index: first, counted: false };
}

// ---------------------------------------------------------------------------------------------
// Participants and the bench (SPEC §3 step 4)
// ---------------------------------------------------------------------------------------------

/** A seated player eligible to play. */
export interface SeatedPlayer {
  id: PlayerId;
  seat: number;
}

/** Input of {@link pickParticipants}. */
export interface ParticipantPick {
  /** Every seated player, any order. */
  seated: readonly SeatedPlayer[];
  /** The game's maximum player count. */
  capacity: number;
  /** Players who sat out the previous game: they are drawn first (guaranteed a seat). */
  satOut: ReadonlySet<PlayerId>;
  /** Players the host benched for this game with the `bench` command. */
  hostBenched: ReadonlySet<PlayerId>;
  rng: Rng;
}

/** Result of {@link pickParticipants}; both lists are in seat order. */
export interface ParticipantSplit {
  participants: SeatedPlayer[];
  benched: SeatedPlayer[];
}

/**
 * Picks a game's participants from the seated players (SPEC §3 step 4): players the host
 * benched sit out; then players who sat out the previous game go first; remaining places are
 * a seeded random draw. When more players have priority than there are places, the draw runs
 * among them (those left out keep priority for the next game). Everyone not picked is benched.
 */
export function pickParticipants(o: ParticipantPick): ParticipantSplit {
  const capacity = Math.max(0, Math.floor(o.capacity));
  const bySeat = [...o.seated].sort((a, b) => a.seat - b.seat);
  const eligible = bySeat.filter((p) => !o.hostBenched.has(p.id));
  const priority = eligible.filter((p) => o.satOut.has(p.id));
  const rest = eligible.filter((p) => !o.satOut.has(p.id));
  const chosen = new Set<PlayerId>();
  const draw = (pool: SeatedPlayer[]): void => {
    const room = capacity - chosen.size;
    if (room <= 0) return;
    const picked = pool.length <= room ? pool : o.rng.shuffle(pool).slice(0, room);
    for (const p of picked) chosen.add(p.id);
  };
  draw(priority);
  draw(rest);
  return {
    participants: bySeat.filter((p) => chosen.has(p.id)),
    benched: bySeat.filter((p) => !chosen.has(p.id)),
  };
}

// ---------------------------------------------------------------------------------------------
// Seat raffle and filling free seats (SPEC §3 step 3)
// ---------------------------------------------------------------------------------------------

/**
 * Picks `n` distinct members uniformly at random from `pool` with the room's seeded RNG
 * (SPEC §3 step 3 "Seat raffle"). Fewer are returned when the pool is smaller. Duplicate pool
 * entries count once.
 */
export function raffle(pool: readonly string[], n: number, rng: Rng): string[] {
  const unique = [...new Set(pool)];
  const k = Math.max(0, Math.min(Math.floor(n), unique.length));
  if (k === 0) return [];
  return rng.shuffle(unique).slice(0, k);
}

/**
 * Who fills `free` seats from the queue at a game boundary (`RoomConfig.seatPick`): `fifo`
 * takes the longest-waiting members, `raffle` draws at random.
 *
 * @param queue audience ids in the order they joined the queue
 */
export function fillFromQueue(
  queue: readonly string[],
  free: number,
  mode: "fifo" | "raffle",
  rng: Rng,
): string[] {
  const k = Math.max(0, Math.floor(free));
  if (k === 0 || queue.length === 0) return [];
  return mode === "fifo" ? [...new Set(queue)].slice(0, k) : raffle(queue, k, rng);
}
