/**
 * The Tune In bot (SPEC §9.3 `bot()`: takeover and sims). It plays fair: it never reads the
 * secret target except as the psychic (who sees it anyway), and guesses only from public
 * information, the card and the clue.
 *
 * - **Psychic:** clues with the card's `examples` (R5), which run left to right along the
 *   dial: it picks the example whose slot holds the target, falling back to a neutral word.
 * - **Guesser:** reads a clue that is one of the card's examples as that example's slot
 *   centre, anything else as the middle, and adds human-like noise. In teams mode the first
 *   bot to act moves the dial and the next one locks it (no tug of war).
 * - **Stealer:** picks the side of the locked dial its own reading of the clue points to.
 *
 * @module
 */
import { normalize, type PlayerId, type Rng } from "@sg/shared";
import { checkClue, clampDial } from "./rules.ts";
import { canLock, canSetDial, canSteal } from "./state.ts";
import { DIAL_MAX, DIAL_REST, type Card, type TiAction, type TiState } from "./types.ts";

/** Neutral fallback clues (checked against the card before use). */
export const BOT_CLUES: readonly string[] = Object.freeze([
  "Sauna",
  "Grandma",
  "Thunder",
  "Velvet",
  "Pancake",
  "Marathon",
  "Teacup",
  "Volcano",
  "Whisper",
  "Lighthouse",
  "Jellyfish",
  "Hammock",
]);

/** Always valid: 2 characters, so no card-end token (3+) can hide in it. */
const LAST_RESORT_CLUE = "Mm";

/** The example slot (0-based) a dial value falls in, for `n` examples. */
export function exampleSlot(v: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor((v * n) / (DIAL_MAX + 1))));
}

/**
 * The psychic bot's clue (R5 timeout, R12 disconnect): the example for the target's slot, or
 * the nearest valid example, or a neutral word. `rng` shuffles the neutral words; `null` keeps
 * their order (used by `legalActions`).
 */
export function botClue(state: TiState, rng: Rng | null): string {
  const card = state.card ?? state.cardChoices[0];
  const examples = card.examples ?? [];
  if (examples.length > 0) {
    const want = exampleSlot(state.hidden.target, examples.length);
    const order = examples
      .map((_, i) => i)
      .sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b);
    for (const i of order) {
      const check = checkClue(examples[i] as string, card);
      if (check.ok) return check.clue;
    }
  }
  const words = rng === null ? BOT_CLUES : rng.shuffle(BOT_CLUES);
  for (const word of words) {
    const check = checkClue(word, card);
    if (check.ok) return check.clue;
  }
  return LAST_RESORT_CLUE;
}

/**
 * A guesser's reading of a clue: the centre of the matching example's slot, else the middle.
 */
export function estimateFromClue(card: Card, clue: string | undefined): number {
  const examples = card.examples ?? [];
  if (clue === undefined || examples.length === 0) return DIAL_REST;
  const n = normalize(clue);
  const i = examples.findIndex((e) => normalize(e) === n);
  if (i < 0) return DIAL_REST;
  return Math.round(((i + 0.5) * DIAL_MAX) / examples.length);
}

/** Human-like spread around an estimate (≈ ±45 standard deviation), clamped to the dial. */
function noisy(estimate: number, rng: Rng): number {
  const spread = (rng.float() + rng.float() + rng.float() - 1.5) * 90;
  return clampDial(estimate + spread);
}

/** The bot's action for `player`, or null when it has nothing to do. */
export function botAction(state: TiState, player: PlayerId, rng: Rng): TiAction | null {
  switch (state.phase) {
    case "card-pick":
      if (state.cardPicker !== "psychic" || player !== state.psychic) return null;
      return { type: "pickCard", idx: rng.int(2) === 0 ? 0 : 1 };
    case "clue":
      if (player !== state.psychic || state.card === undefined) return null;
      return { type: "clue", text: botClue(state, rng) };
    case "guess": {
      if (!canSetDial(state, player) || state.card === undefined) return null;
      const moved =
        state.mode === "teams" ? state.dialMoved : (state.hidden.ffaDials[player]?.moved ?? false);
      if (!moved)
        return { type: "setDial", v: noisy(estimateFromClue(state.card, state.clue), rng) };
      return canLock(state, player, null) ? { type: "lock" } : null;
    }
    case "steal": {
      if (!canSteal(state, player) || state.card === undefined) return null;
      const estimate = estimateFromClue(state.card, state.clue);
      if (estimate === state.dial) return { type: "steal", side: rng.bool() ? "left" : "right" };
      return { type: "steal", side: estimate < state.dial ? "left" : "right" };
    }
    default:
      return null;
  }
}
