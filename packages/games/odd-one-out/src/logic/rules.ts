/**
 * Pure rule helpers for Odd One Out (`docs/specs/odd-one-out.md` R1, R3, R4, R6–R9): odd-count
 * and clue-pass selection, clue validation and "said the word" matching, vote tallies, round
 * scoring and the final ranking. No state, no effects.
 *
 * @module
 */
import { cleanUserText, normalize, type PlayerId } from "@sg/shared";
import type { GameResult } from "@sg/engine";
import { CLUE_MAX, type OooOptions, type OooPlayer, type Outcome } from "./types.ts";

// ---- R1 / R3: round shape ---------------------------------------------------------------------

/** R1 / T1: 1 odd one, or 2 with `auto` and 8 or more players; `1`/`2` force the count. */
export function oddCountFor(players: number, option: OooOptions["oddCount"]): number {
  if (option === "1") return 1;
  if (option === "2") return 2;
  return players >= 8 ? 2 : 1;
}

/** R3 / T11: clue passes; `auto` is 2 for 4–7 players and 1 for 8–10. */
export function passesFor(players: number, option: OooOptions["clueRounds"]): number {
  if (option === "auto") return players <= 7 ? 2 : 1;
  return Number(option);
}

/** R1: the clue order, a random start then seat order (`start` in `0..n-1`). */
export function clueOrder(players: readonly OooPlayer[], start: number): PlayerId[] {
  const ids = [...players].sort((a, b) => a.seat - b.seat).map((p) => p.id);
  return ids.map((_, i) => ids[(start + i) % ids.length] as PlayerId);
}

// ---- R3 / R4: clues ---------------------------------------------------------------------------

/** The result of {@link checkClue}. */
export type ClueCheck = { ok: true; text: string } | { ok: false; reason: ClueProblem };

/** Why a clue was refused. */
export type ClueProblem = "empty" | "spaces" | "long" | "no-letters";

/**
 * R3 / T4: a clue is 1–{@link CLUE_MAX} characters with no whitespace after trimming; hyphens
 * (and other punctuation) are allowed, but it needs at least one letter or digit so it can never
 * be confused with the "…" pass.
 */
export function checkClue(raw: string): ClueCheck {
  const text = cleanUserText(raw, 64).trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (/\s/u.test(text)) return { ok: false, reason: "spaces" };
  if (Array.from(text).length > CLUE_MAX) return { ok: false, reason: "long" };
  if (normalize(text).length === 0) return { ok: false, reason: "no-letters" };
  return { ok: true, text };
}

/** A word's matching key: normalised (accents, case, punctuation folded) with spaces removed. */
export function clueKey(text: string): string {
  return normalize(text).replace(/\s+/gu, "");
}

/**
 * R4: whether a clue "says the word": after normalisation it equals or contains the word.
 * "sunflowers" says "sunflower"; "sun" does not (spec edge case).
 */
export function says(clue: string, word: string): boolean {
  const w = clueKey(word);
  return w.length > 0 && clueKey(clue).includes(w);
}

/**
 * Turns a clue-bank phrase into a one-word clue (spaces become hyphens), or null when it cannot
 * be one (too long, no letters). Bots only give clues that pass {@link checkClue}.
 */
export function toClue(phrase: string): string | null {
  const joined = phrase.trim().replace(/\s+/gu, "-");
  const check = checkClue(joined);
  return check.ok ? check.text : null;
}

// ---- R6: votes --------------------------------------------------------------------------------

/** The outcome of a vote: one accused, or the tied players. */
export type VoteOutcome = { accused: PlayerId } | { tied: PlayerId[] };

/**
 * R6: the plurality among `candidates` (ballots for anyone else are ignored; missing votes don't
 * count). With no votes at all, every candidate is tied. `candidates` order is kept for ties.
 */
export function tally(
  votes: Readonly<Record<PlayerId, PlayerId>>,
  candidates: readonly PlayerId[],
): VoteOutcome {
  const counts = new Map<PlayerId, number>(candidates.map((c) => [c, 0]));
  for (const target of Object.values(votes)) {
    const n = counts.get(target);
    if (n !== undefined) counts.set(target, n + 1);
  }
  const max = Math.max(0, ...counts.values());
  const top = candidates.filter((c) => counts.get(c) === max);
  return top.length === 1 ? { accused: top[0] as PlayerId } : { tied: top };
}

/** Ballot counts per target, for views and tests. */
export function voteCounts(votes: Readonly<Record<PlayerId, PlayerId>>): Record<PlayerId, number> {
  const out: Record<PlayerId, number> = {};
  for (const target of Object.values(votes)) out[target] = (out[target] ?? 0) + 1;
  return out;
}

// ---- R4, R6–R8: scoring -----------------------------------------------------------------------

/** What {@link scoreRound} needs besides the outcome. */
export interface ScoreInput {
  players: readonly PlayerId[];
  odd: readonly PlayerId[];
  /** R4: the player whose clue said the word. */
  saidBy?: PlayerId;
  /** R7: the deciding ballots (regular voters for an odd one get +1 on a wrong guess). */
  votes?: Readonly<Record<PlayerId, PlayerId>>;
}

/**
 * Round points per player (T2), every player listed:
 *
 * | outcome | points |
 * |---|---|
 * | `said-word` (R4) | each odd one +2, the regular who said it −1 |
 * | `odd-said-word` (R4) | that odd one +3 |
 * | `tie-twice` (R6) | each odd one +3 |
 * | `caught-stole` (R7) | each odd one +2, regulars 0 |
 * | `caught-wrong-guess` (R7) | each regular +2, +1 more for a regular who voted for an odd one |
 * | `caught` (R7, Undercover) | each regular +2 |
 * | `innocent-accused` (R8) | each odd one +3 |
 * | `void` (R10) | nothing |
 */
export function scoreRound(outcome: Outcome, input: ScoreInput): Record<PlayerId, number> {
  const points: Record<PlayerId, number> = Object.fromEntries(input.players.map((p) => [p, 0]));
  const isOdd = (p: PlayerId): boolean => input.odd.includes(p);
  const regulars = input.players.filter((p) => !isOdd(p));
  const add = (p: PlayerId, n: number): void => {
    points[p] = (points[p] ?? 0) + n;
  };
  switch (outcome) {
    case "said-word":
      for (const o of input.odd) add(o, 2);
      if (input.saidBy !== undefined) add(input.saidBy, -1);
      break;
    case "odd-said-word":
      if (input.saidBy !== undefined) add(input.saidBy, 3);
      break;
    case "tie-twice":
    case "innocent-accused":
      for (const o of input.odd) add(o, 3);
      break;
    case "caught-stole":
      for (const o of input.odd) add(o, 2);
      break;
    case "caught-wrong-guess":
      for (const r of regulars) {
        const target = input.votes?.[r];
        add(r, target !== undefined && isOdd(target) ? 3 : 2);
      }
      break;
    case "caught":
      for (const r of regulars) add(r, 2);
      break;
    case "void":
      break;
  }
  return points;
}

// ---- R9: match end ----------------------------------------------------------------------------

/** R9: ranking by score; tied players share the place (1, 1, 3…). Seat order breaks display ties. */
export function ranking(
  players: readonly OooPlayer[],
  scores: Readonly<Record<PlayerId, number>>,
): GameResult["ranking"] {
  const rows = [...players]
    .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0) || a.seat - b.seat)
    .map((p) => ({ id: p.id, score: scores[p.id] ?? 0 }));
  return rows.map((r) => ({
    ...r,
    place: 1 + rows.filter((o) => o.score > r.score).length,
  }));
}

/** R9: "Master of Disguise": the most points earned as an odd one (ties all get it; 0 gets none). */
export function mastersOfDisguise(
  players: readonly OooPlayer[],
  oddPoints: Readonly<Record<PlayerId, number>>,
): PlayerId[] {
  const best = Math.max(0, ...players.map((p) => oddPoints[p.id] ?? 0));
  return best > 0 ? players.filter((p) => (oddPoints[p.id] ?? 0) === best).map((p) => p.id) : [];
}
