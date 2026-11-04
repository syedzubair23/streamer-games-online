/**
 * Doodle bots and legal actions (T11): the drawer bot picks a word and draws random scribble
 * strokes; the guess bot guesses the word with probability 0.3 per 5 s (otherwise a harmless
 * wrong guess), never faster than the 800 ms rate limit. A disconnected seat's bot does
 * nothing: its drawing turns are skipped and it sits out the guessing (spec "Edge cases").
 *
 * @module
 */
import type { PlayerId, Rng } from "@sg/shared";
import { mayGuess, mayReport } from "./game.ts";
import { pageFull } from "./rules.ts";
import {
  CANVAS_H,
  CANVAS_W,
  ERASER_COLOR,
  GUESS_INTERVAL_MS,
  MAX_POINTS,
  BRUSH_SIZES,
  type DoodleAction,
  type DoodleState,
  type Drawing,
} from "./types.ts";
import { containsAnswer, matchGuess } from "./words.ts";

/** The drawer bot stops after this many strokes per turn. */
export const BOT_STROKES = 10;
/** T11: probability that the guess bot names the word, per 5 s of thinking. */
export const BOT_GUESS_P = 0.3;
export const BOT_GUESS_PERIOD_MS = 5_000;

/** Wrong guesses bots (and `legalActions` samples) use. None is a real doodle word. */
export const DECOY_GUESSES: readonly string[] = Object.freeze([
  "hmm",
  "a blob?",
  "squiggles",
  "no clue yet",
  "some kind of shape",
  "zigzag thingy",
  "is it food?",
  "big circle",
  "wobbly lines",
  "modern art",
]);

/** A chat line for players who already guessed (insider chat sample). */
export const INSIDER_SAMPLE = "nice one!";

function player(state: DoodleState, id: PlayerId) {
  return state.players.find((p) => p.id === id);
}

/** A stroke id not used in the drawing yet. */
function freshStrokeId(drawing: Drawing, turn: number, prefix: string): string {
  const used = new Set(drawing.strokes.map((s) => s.id));
  for (let k = drawing.strokes.length; ; k++) {
    const id = `${prefix}${turn}-${k}`;
    if (!used.has(id)) return id;
  }
}

/** A random scribble: a clamped random walk of 6–24 points, fitting the point cap. */
export function scribble(
  drawing: Drawing,
  turn: number,
  rng: Rng,
): Extract<DoodleAction, { type: "stroke" }> | null {
  if (pageFull(drawing)) return null;
  const room = MAX_POINTS - drawing.points;
  const n = Math.min(room, 6 + rng.int(19));
  if (n <= 0) return null;
  let x = 80 + rng.int(CANVAS_W - 160);
  let y = 80 + rng.int(CANVAS_H - 160);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    pts.push(x, y);
    x = Math.min(CANVAS_W - 1, Math.max(0, x + rng.int(81) - 40));
    y = Math.min(CANVAS_H - 1, Math.max(0, y + rng.int(81) - 40));
  }
  return {
    type: "stroke",
    id: freshStrokeId(drawing, turn, "b"),
    c: rng.int(ERASER_COLOR),
    s: rng.int(BRUSH_SIZES.length),
    pts,
    done: true,
  };
}

/** A wrong guess that neither matches nor contains the current word. */
function decoy(state: DoodleState, rng: Rng): string | null {
  const word = state.hidden.word;
  const safe = DECOY_GUESSES.filter(
    (d) => word === undefined || (matchGuess(d, word) === "wrong" && !containsAnswer(d, word)),
  );
  return safe.length > 0 ? rng.pick(safe) : null;
}

/** `legalActions`: a representative sample for text actions (spec allows it). */
export function legalActions(state: DoodleState, id: PlayerId): DoodleAction[] {
  if (player(state, id) === undefined) return [];
  const out: DoodleAction[] = [];
  if (state.phase === "word-pick") {
    if (state.picker === "drawer" && id === state.drawer) {
      out.push(
        { type: "pickWord", idx: 0 },
        { type: "pickWord", idx: 1 },
        { type: "pickWord", idx: 2 },
      );
    }
    return out;
  }
  if (state.phase !== "draw") return out;
  if (id === state.drawer) {
    const pts = [100, 100, 140, 120, 180, 160];
    if (!pageFull(state.drawing) && state.drawing.points + pts.length / 2 <= MAX_POINTS) {
      out.push({
        type: "stroke",
        id: freshStrokeId(state.drawing, state.turn, "l"),
        c: 0,
        s: 1,
        pts,
        done: true,
      });
    }
    if (state.drawing.strokes.length > 0) out.push({ type: "undo" }, { type: "clear" });
    return out;
  }
  if (mayGuess(state, id)) {
    if (Object.hasOwn(state.correct, id)) out.push({ type: "guess", text: INSIDER_SAMPLE });
    else for (const text of DECOY_GUESSES.slice(0, 2)) out.push({ type: "guess", text });
  }
  if (mayReport(state, id)) out.push({ type: "report" });
  return out;
}

/** `bot` (T11). Never returns an illegal action. */
export function bot(state: DoodleState, id: PlayerId, rng: Rng): DoodleAction | null {
  const me = player(state, id);
  if (me === undefined || !me.connected) return null;
  if (state.phase === "word-pick") {
    return state.picker === "drawer" && id === state.drawer
      ? { type: "pickWord", idx: rng.int(3) as 0 | 1 | 2 }
      : null;
  }
  if (state.phase !== "draw") return null;
  if (id === state.drawer) {
    return state.drawing.strokes.length < BOT_STROKES
      ? scribble(state.drawing, state.turn, rng)
      : null;
  }
  const word = state.hidden.word;
  if (word === undefined || !mayGuess(state, id) || Object.hasOwn(state.correct, id)) return null;
  const last = state.lastGuessAt[id];
  if (last !== undefined && state.clock - last < GUESS_INTERVAL_MS) return null;
  const thinking = Math.max(0, state.clock - (last ?? state.drawStart));
  const p = 1 - Math.pow(1 - BOT_GUESS_P, thinking / BOT_GUESS_PERIOD_MS);
  if (rng.bool(p)) return { type: "guess", text: word.w };
  const text = decoy(state, rng);
  return text === null ? null : { type: "guess", text };
}
