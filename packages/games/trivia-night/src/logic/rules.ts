/**
 * Pure Classic rules of Trivia Night (`docs/specs/trivia-night.md` R3–R8): scoring, the
 * Showdown selection and verdict, team plurality answers and the final ranking. No state, no
 * rng, no clock: every function is a plain calculation the reducers and tests share.
 *
 * @module
 */
import type { PlayerId, TeamId } from "@sg/shared";
import {
  CORRECT_POINTS,
  SPEED_MAX,
  STEAMED_FACTOR,
  STREAK_CAP,
  STREAK_STEP,
  type Lock,
  type Standing,
} from "./types.ts";

/** Clamps to `[0, 1]`. */
export function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/**
 * R4 speed bonus: `round(500 × clamp01((window − max(0, t − streamDelay)) / window))`. The first
 * `delayMs` always count as full speed. A window of 0 (timerScale 0: no timer) gives no bonus.
 *
 * @param t answer time in ms since the window opened
 * @param windowMs `answerSec × 1000 × timerScale`
 * @param delayMs the room's stream delay in ms
 */
export function speedBonus(t: number, windowMs: number, delayMs: number): number {
  if (!(windowMs > 0)) return 0;
  const effective = Math.max(0, t - delayMs);
  return Math.round(SPEED_MAX * clamp01((windowMs - effective) / windowMs));
}

/**
 * R4 streak bonus for a correct answer that makes the streak `streak` long (this answer
 * included): +100 per consecutive correct answer beyond the first, capped at +300.
 */
export function streakBonus(streak: number): number {
  return Math.min(STREAK_CAP, STREAK_STEP * Math.max(0, streak - 1));
}

/** Inputs to {@link scoreAnswer}. */
export interface AnswerInput {
  correct: boolean;
  /** Answer time in ms. */
  t: number;
  /** Speed window and stream delay, or null when the speed bonus is off (R4). */
  window: { windowMs: number; delayMs: number } | null;
  /** The streak before this answer. */
  streakBefore: number;
  /** R5: the player is Steamed for this question (×0.5). */
  steamed: boolean;
}

/** The points of one answer and their breakdown. */
export interface AnswerScore {
  points: number;
  speed: number;
  streak: number;
  /** The streak after this answer (0 after a wrong answer). */
  streakAfter: number;
  halved: boolean;
}

/**
 * R4 + R5: the points of one locked answer. Correct: 500 + speed bonus + streak bonus, halved
 * (rounded) when Steamed. Wrong: 0, and the streak resets.
 */
export function scoreAnswer(input: AnswerInput): AnswerScore {
  if (!input.correct) return { points: 0, speed: 0, streak: 0, streakAfter: 0, halved: false };
  const streakAfter = input.streakBefore + 1;
  const speed =
    input.window === null ? 0 : speedBonus(input.t, input.window.windowMs, input.window.delayMs);
  const streak = streakBonus(streakAfter);
  const raw = CORRECT_POINTS + speed + streak;
  return {
    points: input.steamed ? Math.round(raw * STEAMED_FACTOR) : raw,
    speed,
    streak,
    streakAfter,
    halved: input.steamed,
  };
}

/** A candidate for the Showdown. */
export interface ShowdownCandidate {
  id: PlayerId;
  seat: number;
  score: number;
  /** Total answer time so far (R5 tie-break: the slower player faces the kettle). */
  totalMs: number;
}

/**
 * R5: the bottom two players by score, lowest first. Ties go to the slower total answer time
 * (the slower player ranks lower), then to the later seat.
 *
 * @throws RangeError with fewer than two candidates.
 */
export function bottomTwo(candidates: readonly ShowdownCandidate[]): [PlayerId, PlayerId] {
  if (candidates.length < 2) throw new RangeError("the Showdown needs two players");
  const sorted = [...candidates].sort(
    (a, b) => a.score - b.score || b.totalMs - a.totalMs || b.seat - a.seat,
  );
  return [(sorted[0] as ShowdownCandidate).id, (sorted[1] as ShowdownCandidate).id];
}

/** One showdown player's outcome. */
export interface ShowdownOutcome {
  id: PlayerId;
  ok: boolean;
  /** Answer time in ms (a missing answer counts as wrong, its time does not matter). */
  ms: number;
}

/**
 * R5 verdict matrix: the wrong player loses; both wrong → both lose; both right → the slower
 * one loses (an exact tie in time goes against the higher-placed player, `b`: the Showdown is
 * a comeback, not a pile-on).
 *
 * @param a the lower-placed player
 * @param b the higher-placed player
 * @returns the losers and the winner (null when both lost)
 */
export function showdownVerdict(
  a: ShowdownOutcome,
  b: ShowdownOutcome,
): { losers: PlayerId[]; winner: PlayerId | null } {
  if (!a.ok && !b.ok) return { losers: [a.id, b.id], winner: null };
  if (a.ok && !b.ok) return { losers: [b.id], winner: a.id };
  if (!a.ok && b.ok) return { losers: [a.id], winner: b.id };
  return a.ms < b.ms
    ? { losers: [b.id], winner: a.id }
    : b.ms < a.ms
      ? { losers: [a.id], winner: b.id }
      : { losers: [b.id], winner: a.id };
}

/**
 * R7 team answer: the members' plurality. Ties go to the earliest vote (the tied option whose
 * first vote arrived first). Null when no member locked.
 */
export function pluralityAnswer(votes: readonly Lock[]): number | null {
  if (votes.length === 0) return null;
  const count = new Map<number, number>();
  const first = new Map<number, number>();
  for (const v of votes) {
    count.set(v.choice, (count.get(v.choice) ?? 0) + 1);
    const f = first.get(v.choice);
    if (f === undefined || v.at < f) first.set(v.choice, v.at);
  }
  let best: number | null = null;
  for (const [choice, n] of count) {
    if (best === null) {
      best = choice;
      continue;
    }
    const bn = count.get(best) ?? 0;
    if (n > bn || (n === bn && (first.get(choice) ?? 0) < (first.get(best) ?? 0))) best = choice;
  }
  return best;
}

/** A ranked entry for {@link rankEntries}. */
export interface RankInput {
  id: string;
  score: number;
  /** Total correct-answer time (R8 first tie-break: lower is better). */
  correctMs: number;
  /** Seat (R8 second tie-break: lower is better). */
  seat: number;
}

/**
 * R8 ranking: score (high first), then lower total correct-answer time, then seat. Places are
 * 1..n in that order (the tie-breaks always separate distinct seats).
 */
export function rankEntries(entries: readonly RankInput[]): Standing[] {
  return [...entries]
    .sort((a, b) => b.score - a.score || a.correctMs - b.correctMs || a.seat - b.seat)
    .map((e, i) => ({ id: e.id, score: e.score, place: i + 1 }));
}

/**
 * R6 lifeline recipient: the plurality of the vote; ties go to the lowest score, then the
 * earlier seat. Null when nobody got a vote.
 */
export function lifelineRecipient(
  tallies: Readonly<Record<string, number>>,
  players: readonly { id: PlayerId; seat: number; score: number }[],
): PlayerId | null {
  let best: { id: PlayerId; votes: number; score: number; seat: number } | null = null;
  for (const p of players) {
    const votes = tallies[p.id] ?? 0;
    if (!(votes > 0)) continue;
    if (
      best === null ||
      votes > best.votes ||
      (votes === best.votes &&
        (p.score < best.score || (p.score === best.score && p.seat < best.seat)))
    ) {
      best = { id: p.id, votes, score: p.score, seat: p.seat };
    }
  }
  return best?.id ?? null;
}

/** R2 read time: 2500 + 40 ms per character, at most 6000. */
export function readMs(question: string, base: number, perChar: number, max: number): number {
  return Math.min(max, base + perChar * question.length);
}

/** Whole-percent shares of `tallies` over options `0..n-1` (sums may differ from 100 by rounding). */
export function percentages(tallies: Readonly<Record<string, number>>, n: number): number[] {
  const counts = Array.from({ length: n }, (_, i) => Math.max(0, tallies[String(i)] ?? 0));
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => (total > 0 ? Math.round((100 * c) / total) : 0));
}

/**
 * Days since 1970-01-01 of a proleptic Gregorian civil date (Howard Hinnant's algorithm), so
 * logic can read `validUntil` without `Date`.
 */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const DAY_MS = 86_400_000;

/**
 * Whether an item's `validUntil` (ISO `YYYY-MM-DD`, valid through the end of that UTC day) has
 * passed at `nowMs`. Items without it never expire; an unparsable date counts as expired.
 */
export function isExpired(validUntil: string | undefined, nowMs: number): boolean {
  if (validUntil === undefined) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(validUntil);
  if (m === null) return true;
  const end = (daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])) + 1) * DAY_MS;
  return nowMs >= end;
}

/** Sums member scores into team scores (R7). */
export function teamTotals(
  teams: readonly { id: TeamId; members: readonly PlayerId[] }[],
  scores: Readonly<Record<string, number>>,
): Record<TeamId, number> {
  const out: Record<TeamId, number> = {};
  for (const t of teams) out[t.id] = t.members.reduce((sum, m) => sum + (scores[m] ?? 0), 0);
  return out;
}
