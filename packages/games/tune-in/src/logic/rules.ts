/**
 * Pure rule helpers for Tune In (`docs/specs/tune-in.md` R1, R2, R5, R7, R11): scoring bands,
 * targets, the clue filter, steal resolution and rankings. No state, no effects.
 *
 * @module
 */
import { cleanUserText, filterText, normalize, type Rng } from "@sg/shared";
import type { GameResult } from "@sg/engine";
import {
  CLUE_MAX,
  CLUE_MIN,
  CLUE_TOKEN_MIN,
  DIAL_MAX,
  type BetOption,
  type Card,
  type Side,
} from "./types.ts";

/** R1: a secret target in 50–950 (`rng.int(901) + 50`). */
export function drawTarget(rng: Rng): number {
  return rng.int(901) + 50;
}

/** R2: points for a dial at distance `d` from the target. Boundaries take the higher score. */
export function bandPoints(d: number): number {
  const dist = Math.abs(d);
  if (dist <= 25) return 4;
  if (dist <= 75) return 3;
  if (dist <= 125) return 2;
  return 0;
}

/** R2 applied to a dial and a target. */
export function scoreDial(dial: number, target: number): number {
  return bandPoints(dial - target);
}

/** R4a: the result-bet option a band resolves to. */
export function betForPoints(points: number): BetOption {
  if (points >= 4) return "bullseye";
  if (points >= 2) return "close";
  return "miss";
}

/** A dial value is an integer in 0–1000 (edge case: anything else is rejected). */
export function isDialValue(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= DIAL_MAX;
}

/** Clamps and rounds any number onto the dial. */
export function clampDial(v: number): number {
  if (!Number.isFinite(v)) return 500;
  return Math.min(DIAL_MAX, Math.max(0, Math.round(v)));
}

/** Why a clue was rejected (R5), sent privately to the psychic. */
export type ClueRejection = "length" | "digit" | "card-word" | "filter";

/** The outcome of {@link checkClue}. */
export type ClueCheck =
  { ok: true; clue: string } | { ok: false; reason: ClueRejection; word?: string };

const NUMERIC = /\p{N}/u;

const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** User-perceived characters (grapheme clusters), as `cleanUserText` counts them. */
export function graphemeLength(text: string): number {
  if (segmenter === null) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Normalized tokens of a card end that the clue filter checks (length ≥ 3). */
export function cardEndTokens(card: Pick<Card, "left" | "right">): string[] {
  const tokens = `${normalize(card.left)} ${normalize(card.right)}`
    .split(" ")
    .filter((t) => t.length >= CLUE_TOKEN_MIN);
  return [...new Set(tokens)];
}

/**
 * R5: validates a clue against a card. The clue is cleaned (control characters removed,
 * whitespace collapsed) and must be 1–40 characters. It is rejected if it contains a digit, if
 * a card-end token (length ≥ 3) equals a clue token or is a substring of one, or if the
 * profanity filter flags it.
 */
export function checkClue(text: string, card: Pick<Card, "left" | "right">): ClueCheck {
  const clue = cleanUserText(text, CLUE_MAX + 1);
  const length = graphemeLength(clue);
  if (length < CLUE_MIN || length > CLUE_MAX) return { ok: false, reason: "length" };
  if (NUMERIC.test(clue.normalize("NFKC"))) return { ok: false, reason: "digit" };
  const clueTokens = normalize(clue)
    .split(" ")
    .filter((t) => t.length > 0);
  for (const end of cardEndTokens(card)) {
    if (clueTokens.some((t) => t === end || t.includes(end))) {
      return { ok: false, reason: "card-word", word: end };
    }
  }
  if (filterText(clue, "family").flagged) return { ok: false, reason: "filter" };
  return { ok: true, clue };
}

/**
 * R7: the plurality side of the steal picks; a tie (or no picks) is no steal.
 */
export function stealSide(picks: Readonly<Record<string, Side>>): Side | null {
  let left = 0;
  let right = 0;
  for (const side of Object.values(picks)) {
    if (side === "left") left++;
    else right++;
  }
  if (left === right) return null;
  return left > right ? "left" : "right";
}

/** R7: a steal is correct when the target is on the picked side of the locked dial. */
export function stealCorrect(side: Side, dial: number, target: number): boolean {
  return side === "left" ? target < dial : target > dial;
}

/**
 * Standard competition ranking (1, 1, 3): ties share the higher place (R11 FFA, SPEC §5).
 * `order` breaks nothing; it only keeps the output stable for equal scores.
 */
export function rankByScore(
  ids: readonly string[],
  scores: Readonly<Record<string, number>>,
): GameResult["ranking"] {
  const sorted = ids
    .map((id, i) => ({ id, score: scores[id] ?? 0, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return sorted.map((entry) => ({
    id: entry.id,
    score: entry.score,
    place: 1 + sorted.filter((o) => o.score > entry.score).length,
  }));
}

/** Rounded mean of a list of points (R9: the psychic's FFA score). Empty → 0. */
export function roundedMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
