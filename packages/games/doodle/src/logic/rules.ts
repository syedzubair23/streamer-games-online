/**
 * Pure Doodle rules: rounds and turn order (R1, R7), scoring (R5, R7), stroke validation
 * (spec "Stroke format", T5), undo/clear (T6) and the final ranking (R8).
 *
 * @module
 */
import type { GameResult } from "@sg/engine";
import type { PlayerId, TeamId } from "@sg/shared";
import {
  CANVAS_H,
  CANVAS_W,
  DRAWER_CAP,
  DRAWER_PER_GUESSER,
  FIRST_BONUS,
  GUESS_BASE,
  GUESS_TIME_BONUS,
  HARD_MULTIPLIER,
  MAX_BATCH_POINTS,
  MAX_POINTS,
  MAX_STROKES,
  PALETTE_SIZE,
  BRUSH_SIZES,
  STROKE_ID_RE,
  TEAM_BASE,
  TEAM_TIME_BONUS,
  type DoodleOptions,
  type DoodlePlayer,
  type DoodleTeam,
  type Drawing,
  type Stroke,
} from "./types.ts";

// ---- Rounds and order (R1, R7) ------------------------------------------------------------------

/** R1: `auto` is 2 rounds for 3–4 players and 1 round for 5 or more. */
export function roundsFor(option: DoodleOptions["rounds"], players: number): number {
  if (option === "auto") return players <= 4 ? 2 : 1;
  return Number(option);
}

/**
 * The drawer of every turn. FFA (R1): one turn per player per round, in seat order. Team
 * Doodle (R7): teams alternate, one drawer per team turn, each team cycling through its own
 * members; a round is `teams × largest team` turns so every team draws equally often.
 */
export function turnOrder(
  players: readonly DoodlePlayer[],
  teams: readonly DoodleTeam[],
  rounds: number,
): { order: PlayerId[]; teamOrder: TeamId[]; perRound: number } {
  if (teams.length === 0) {
    const seatOrder = [...players].sort((a, b) => a.seat - b.seat).map((p) => p.id);
    const order: PlayerId[] = [];
    for (let r = 0; r < rounds; r++) order.push(...seatOrder);
    return { order, teamOrder: [], perRound: seatOrder.length };
  }
  const largest = Math.max(...teams.map((t) => t.members.length));
  const order: PlayerId[] = [];
  const teamOrder: TeamId[] = [];
  let k = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < largest; i++, k++) {
      for (const team of teams) {
        order.push(team.members[k % team.members.length] as PlayerId);
        teamOrder.push(team.id);
      }
    }
  }
  return { order, teamOrder, perRound: teams.length * largest };
}

/**
 * Team Doodle is on when every seat has a team and there are at least two teams. Teams are
 * listed in the order of their first seat; names come from the room teams when known.
 */
export function buildTeams(
  players: readonly DoodlePlayer[],
  roomTeams: readonly { id: TeamId; name: string; colorSlot: number }[],
): DoodleTeam[] {
  if (players.length === 0 || players.some((p) => p.teamId === undefined)) return [];
  const teams: DoodleTeam[] = [];
  for (const p of [...players].sort((a, b) => a.seat - b.seat)) {
    const id = p.teamId as TeamId;
    let team = teams.find((t) => t.id === id);
    if (team === undefined) {
      const room = roomTeams.find((t) => t.id === id);
      team = {
        id,
        name: room?.name ?? id,
        colorSlot: room?.colorSlot ?? teams.length % 8,
        members: [],
      };
      teams.push(team);
    }
    team.members.push(p.id);
  }
  return teams.length >= 2 ? teams : [];
}

// ---- Scoring (R5, R7) ---------------------------------------------------------------------------

/** `remaining / total` clamped to `[0, 1]` (1 when there is no time base). */
export function timeShare(remaining: number, total: number): number {
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, remaining / total));
}

/** R2/R5: ×1.25 (rounded) on an audience-chosen HARD turn. */
export function applyHard(points: number, hard: boolean): number {
  return hard ? Math.round(points * HARD_MULTIPLIER) : points;
}

/** R5: a correct guesser scores `100 + round(200 × remaining / total)`, +50 when first. */
export function guesserPoints(
  remaining: number,
  total: number,
  first: boolean,
  hard: boolean,
): number {
  const base =
    GUESS_BASE +
    Math.round(GUESS_TIME_BONUS * timeShare(remaining, total)) +
    (first ? FIRST_BONUS : 0);
  return applyHard(base, hard);
}

/** R5: the drawer scores 60 per correct guesser, capped at 360. */
export function drawerPoints(correctGuessers: number, hard: boolean): number {
  return applyHard(Math.min(DRAWER_CAP, DRAWER_PER_GUESSER * correctGuessers), hard);
}

/** R7: a correct team guess scores `200 + round(300 × remaining / total)` to the team. */
export function teamPoints(remaining: number, total: number, hard: boolean): number {
  return applyHard(TEAM_BASE + Math.round(TEAM_TIME_BONUS * timeShare(remaining, total)), hard);
}

// ---- Strokes (spec "Stroke format", T5, T6) -----------------------------------------------------

/** Why a stroke batch was refused. */
export type StrokeError =
  | "bad-id"
  | "bad-color"
  | "bad-size"
  | "bad-points"
  | "batch-too-big"
  | "page-full"
  | "stroke-closed"
  | "stroke-mismatch";

/** Points in a flat `pts` array (`pts.length / 2`). */
export function pointCount(pts: readonly number[]): number {
  return pts.length / 2;
}

/**
 * Validates a flat point list: an even, non-empty list of integers with x in `0..1023` and
 * y in `0..767`, at most 128 points.
 */
export function checkPoints(pts: readonly number[]): StrokeError | null {
  if (pts.length === 0 || pts.length % 2 !== 0) return "bad-points";
  if (pointCount(pts) > MAX_BATCH_POINTS) return "batch-too-big";
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i] as number;
    const max = i % 2 === 0 ? CANVAS_W - 1 : CANVAS_H - 1;
    if (!Number.isInteger(v) || v < 0 || v > max) return "bad-points";
  }
  return null;
}

/** True when the drawing cannot take another point (the drawer sees "Page full!"). */
export function pageFull(drawing: Drawing): boolean {
  return drawing.points >= MAX_POINTS || drawing.strokes.length >= MAX_STROKES;
}

/**
 * Applies one `stroke` batch to a drawing (pure: returns a new drawing or an error).
 *
 * - A batch whose id is the last stroke's id and that stroke is still open appends points
 *   (colour and size must match).
 * - Any other new id starts a new stroke (closing an open one); an id already used in the
 *   drawing is refused.
 * - The 20,000-point and 600-stroke caps refuse the batch whole once it would exceed them.
 */
export function applyStroke(
  drawing: Drawing,
  batch: { id: string; c: number; s: number; pts: readonly number[]; done: boolean },
): { drawing: Drawing } | { error: StrokeError } {
  if (!STROKE_ID_RE.test(batch.id)) return { error: "bad-id" };
  if (!Number.isInteger(batch.c) || batch.c < 0 || batch.c >= PALETTE_SIZE) {
    return { error: "bad-color" };
  }
  if (!Number.isInteger(batch.s) || batch.s < 0 || batch.s >= BRUSH_SIZES.length) {
    return { error: "bad-size" };
  }
  const bad = checkPoints(batch.pts);
  if (bad !== null) return { error: bad };
  const n = pointCount(batch.pts);
  if (drawing.points + n > MAX_POINTS) return { error: "page-full" };
  const strokes = drawing.strokes;
  const last = strokes[strokes.length - 1];
  if (last !== undefined && last.id === batch.id) {
    if (last.done) return { error: "stroke-closed" };
    if (last.c !== batch.c || last.s !== batch.s) return { error: "stroke-mismatch" };
    const merged: Stroke = { ...last, pts: [...last.pts, ...batch.pts], done: batch.done };
    return {
      drawing: { strokes: [...strokes.slice(0, -1), merged], points: drawing.points + n },
    };
  }
  if (strokes.some((st) => st.id === batch.id)) return { error: "stroke-closed" };
  if (strokes.length >= MAX_STROKES) return { error: "page-full" };
  const closed =
    last !== undefined && !last.done ? [...strokes.slice(0, -1), { ...last, done: true }] : strokes;
  const stroke: Stroke = {
    id: batch.id,
    c: batch.c,
    s: batch.s,
    pts: [...batch.pts],
    done: batch.done,
  };
  return { drawing: { strokes: [...closed, stroke], points: drawing.points + n } };
}

/** T6: `undo` removes the last stroke (its points are freed); null when there is none. */
export function undoStroke(drawing: Drawing): Drawing | null {
  const last = drawing.strokes[drawing.strokes.length - 1];
  if (last === undefined) return null;
  return {
    strokes: drawing.strokes.slice(0, -1),
    points: drawing.points - pointCount(last.pts),
  };
}

/** T6: `clear` removes every stroke; null when the page is already empty. */
export function clearDrawing(drawing: Drawing): Drawing | null {
  return drawing.strokes.length === 0 ? null : { strokes: [], points: 0 };
}

/** An empty drawing. */
export function emptyDrawing(): Drawing {
  return { strokes: [], points: 0 };
}

// ---- Ranking (R8) -------------------------------------------------------------------------------

/**
 * R8: ranking by score, highest first; ties share the place (1, 1, 3). Ties keep the given
 * order (seat or team order).
 */
export function ranking(
  ids: readonly string[],
  scores: Readonly<Record<string, number>>,
): GameResult["ranking"] {
  const rows = ids.map((id, i) => ({ id, score: scores[id] ?? 0, i }));
  rows.sort((a, b) => b.score - a.score || a.i - b.i);
  let place = 0;
  let prev: number | null = null;
  return rows.map((row, idx) => {
    if (prev === null || row.score !== prev) place = idx + 1;
    prev = row.score;
    return { id: row.id, score: row.score, place };
  });
}

/**
 * R8 highlight: "Best Artist" is the player whose drawings got the most correct guessers
 * (ties: higher score, then seat order). None when nobody's drawing was guessed.
 */
export function bestArtist(
  players: readonly DoodlePlayer[],
  artist: Readonly<Record<PlayerId, number>>,
  scores: Readonly<Record<string, number>>,
): PlayerId | null {
  let best: DoodlePlayer | null = null;
  for (const p of [...players].sort((a, b) => a.seat - b.seat)) {
    const n = artist[p.id] ?? 0;
    if (n <= 0) continue;
    if (best === null) {
      best = p;
      continue;
    }
    const bn = artist[best.id] ?? 0;
    const pScore = scores[p.teamId ?? p.id] ?? scores[p.id] ?? 0;
    const bScore = scores[best.teamId ?? best.id] ?? scores[best.id] ?? 0;
    if (n > bn || (n === bn && pScore > bScore)) best = p;
  }
  return best?.id ?? null;
}
