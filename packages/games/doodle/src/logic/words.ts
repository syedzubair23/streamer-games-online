/**
 * Words: guess matching (R4, T1), hints (R3, T2), and the word deck (R2, spec "Content").
 *
 * @module
 */
import {
  CLOSE_GUESS_MIN_LENGTH,
  levenshtein,
  normalize,
  type DoodleWord,
  type Rng,
} from "@sg/shared";
import type { ContentAccess } from "@sg/engine";
import type { DoodleHidden, WordItem } from "./types.ts";

// ---- Matching (R4) ----------------------------------------------------------------------------

/** R4: one leading article is stripped before comparing. */
export const ARTICLES: readonly string[] = Object.freeze(["a", "an", "the"]);

/** Strips one leading article from an already-normalized text (`"the moon"` → `"moon"`). */
export function stripArticle(normalized: string): string {
  const space = normalized.indexOf(" ");
  if (space <= 0) return normalized;
  return ARTICLES.includes(normalized.slice(0, space)) ? normalized.slice(space + 1) : normalized;
}

/**
 * Every accepted form of a word: the normalized word and alts, each with and without one
 * leading article, deduplicated, empty forms dropped.
 */
export function answerKeys(word: { w: string; alt: readonly string[] }): string[] {
  const out = new Set<string>();
  for (const raw of [word.w, ...word.alt]) {
    const n = normalize(raw);
    if (n.length === 0) continue;
    out.add(n);
    out.add(stripArticle(n));
  }
  return [...out];
}

/** Letters in a normalized key, not counting spaces. */
function letterCount(key: string): number {
  return Array.from(key.replace(/ /g, "")).length;
}

/**
 * R4 matching. **Correct**: after `normalize()` and stripping one leading article, the guess
 * equals the word or one of its alts (there is no "contains" rule). **Close**: Levenshtein
 * distance ≤ 1 to an accepted form of 5 or more letters. Otherwise **wrong**.
 */
export function matchGuess(
  text: string,
  word: { w: string; alt: readonly string[] },
): "correct" | "close" | "wrong" {
  const guess = stripArticle(normalize(text));
  if (guess.length === 0) return "wrong";
  const keys = answerKeys(word);
  if (keys.includes(guess)) return "correct";
  for (const key of keys) {
    if (letterCount(key) >= CLOSE_GUESS_MIN_LENGTH && levenshtein(key, guess, 1) <= 1) {
      return "close";
    }
  }
  return "wrong";
}

/**
 * True when a message contains the word (or an alt) anywhere, ignoring case, accents,
 * punctuation and spaces. Such messages never reach the public feed: the word is never shown
 * on the Stage before the reveal (R2), and a spam guess like `"cat dog fish"` must not print
 * the word on stream.
 */
export function containsAnswer(text: string, word: { w: string; alt: readonly string[] }): boolean {
  const compact = normalize(text).replace(/ /g, "");
  if (compact.length === 0) return false;
  return answerKeys(word).some((key) => {
    const k = key.replace(/ /g, "");
    return k.length > 0 && compact.includes(k);
  });
}

/**
 * The accept list for the audience `guess` poll: the word and alts, plus each form with a
 * leading article, so chat matching follows R4 (the platform compares normalized text).
 */
export function pollAccept(word: { w: string; alt: readonly string[] }): string[] {
  const out = new Set<string>();
  for (const key of answerKeys(word)) {
    out.add(key);
    for (const article of ARTICLES) out.add(`${article} ${key}`);
  }
  return [...out];
}

// ---- Hints (R3) -------------------------------------------------------------------------------

/** A character that is hidden behind a blank: letters and digits. Spaces, hyphens and other
 * punctuation are always visible. */
export function isHintLetter(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** The positions (code point indices) of the hideable letters of a word. */
export function letterPositions(word: string): number[] {
  const out: number[] = [];
  Array.from(word).forEach((ch, i) => {
    if (isHintLetter(ch)) out.push(i);
  });
  return out;
}

/**
 * R3 hint schedule as fractions of the draw time: letters at 50% and 75%; a word of 3 letters
 * or fewer gets only the 75% hint. A hint never uncovers the last hidden letter (a 1-letter
 * word gets none).
 */
export function hintSchedule(letters: number): number[] {
  const fractions = letters <= 3 ? [0.75] : [0.5, 0.75];
  return fractions.slice(0, Math.max(0, letters - 1));
}

/**
 * The hint string: one token per character, joined by single spaces. Hidden letters are `_`,
 * revealed letters show, spaces and hyphens are always visible (`"ice cream"` →
 * `"_ _ _   _ _ _ _ _"`).
 */
export function hintString(word: string, shown: readonly number[]): string {
  return Array.from(word)
    .map((ch, i) => (isHintLetter(ch) && !shown.includes(i) ? "_" : ch))
    .join(" ");
}

/** Picks the next letter position to reveal (rng position among the hidden letters). */
export function nextHintPosition(word: string, shown: readonly number[], rng: Rng): number | null {
  const hidden = letterPositions(word).filter((i) => !shown.includes(i));
  if (hidden.length <= 1) return null;
  return rng.pick(hidden);
}

// ---- Deck (R2, "Content") ---------------------------------------------------------------------

/** The default word pack (spec "Host options"). */
export const CORE_PACK = "doodle-core";
/** The kids pack, auto-selected in family mode. */
export const KIDS_PACK = "doodle-kids";

/**
 * Host custom word lists are stored as packs whose id starts with `custom` (engine request
 * ER-010). Their words have no tier.
 */
export function isCustomPack(id: string): boolean {
  return id.startsWith("custom");
}

/**
 * Built-in words used only when the selected packs run dry (or no packs are loaded, as in
 * client scenarios). Original, concrete and drawable in 70 s.
 */
export const FALLBACK_WORDS: Readonly<Record<1 | 2 | 3, readonly DoodleWord[]>> = Object.freeze({
  1: [
    { w: "cat", alt: ["kitty"], d: 1 },
    { w: "sun", d: 1 },
    { w: "tree", d: 1 },
    { w: "fish", d: 1 },
    { w: "house", d: 1 },
    { w: "apple", d: 1 },
    { w: "moon", d: 1 },
    { w: "star", d: 1 },
    { w: "ball", d: 1 },
    { w: "flower", d: 1 },
    { w: "boat", d: 1 },
    { w: "cloud", d: 1 },
    { w: "hat", d: 1 },
    { w: "egg", d: 1 },
    { w: "key", d: 1 },
    { w: "cake", d: 1 },
    { w: "snail", d: 1 },
    { w: "kite", d: 1 },
    { w: "sock", d: 1 },
    { w: "duck", d: 1 },
  ],
  2: [
    { w: "rainbow", d: 2 },
    { w: "snowman", d: 2 },
    { w: "guitar", d: 2 },
    { w: "octopus", d: 2 },
    { w: "umbrella", d: 2 },
    { w: "ice cream", alt: ["ice-cream cone"], d: 2 },
    { w: "lighthouse", d: 2 },
    { w: "volcano", d: 2 },
    { w: "pirate", d: 2 },
    { w: "robot", d: 2 },
    { w: "dragon", d: 2 },
    { w: "castle", d: 2 },
    { w: "bicycle", alt: ["bike"], d: 2 },
    { w: "penguin", d: 2 },
    { w: "treasure map", d: 2 },
    { w: "campfire", d: 2 },
    { w: "hot air balloon", d: 2 },
    { w: "mermaid", d: 2 },
    { w: "spider web", alt: ["cobweb"], d: 2 },
    { w: "windmill", d: 2 },
  ],
  3: [
    { w: "traffic jam", d: 3 },
    { w: "haunted house", d: 3 },
    { w: "sunburn", d: 3 },
    { w: "shipwreck", d: 3 },
    { w: "birthday party", d: 3 },
    { w: "roller coaster", d: 3 },
    { w: "sleepwalking", alt: ["sleepwalker"], d: 3 },
    { w: "treehouse", alt: ["tree house"], d: 3 },
    { w: "thunderstorm", d: 3 },
    { w: "jellyfish", d: 3 },
    { w: "toothbrush", d: 3 },
    { w: "scarecrow", d: 3 },
    { w: "hide and seek", d: 3 },
    { w: "fireworks", d: 3 },
    { w: "tightrope", d: 3 },
    { w: "snow globe", d: 3 },
    { w: "black hole", d: 3 },
    { w: "sandcastle", alt: ["sand castle"], d: 3 },
    { w: "time machine", d: 3 },
    { w: "chess board", alt: ["chessboard"], d: 3 },
  ],
});

/** A content word as the game holds it. `custom` words have no tier. */
export function toWordItem(item: DoodleWord, custom: boolean): WordItem {
  return { w: item.w, alt: [...(item.alt ?? [])], tier: custom ? 0 : item.d };
}

/** A word is usable when it normalizes to something and fits the 32-character limit. */
function usable(item: DoodleWord): boolean {
  return normalize(item.w).length > 0 && Array.from(item.w).length <= 32;
}

/** Options for {@link buildDeck}. */
export interface DeckOptions {
  packs: readonly string[];
  customWords: "off" | "mix" | "only";
  family: boolean;
  /** Words needed per tier bucket (each turn offers one per tier). */
  perTier: number;
  /** Custom words needed (each custom turn offers three). */
  custom: number;
}

/**
 * Builds the game's pre-shuffled deck: `[custom, easy, medium, hard]`. Words come from the
 * selected packs (plus the kids pack in family mode), skipping words used earlier in the
 * session and duplicates after `normalize()`. Short tier buckets are topped up from
 * {@link FALLBACK_WORDS}.
 */
export function buildDeck(
  content: ContentAccess,
  opts: DeckOptions,
  rng: Rng,
): DoodleHidden["deck"] {
  const selected = new Set(opts.packs);
  if (opts.family) selected.add(KIDS_PACK);
  const stockPacks = [...selected].filter((id) => !isCustomPack(id));
  const customPacks = opts.customWords === "off" ? [] : [...selected].filter(isCustomPack);
  const seen = new Set<string>();
  const take = (item: DoodleWord): boolean => {
    if (!usable(item)) return false;
    const key = normalize(item.w);
    if (seen.has(key) || content.isUsed("doodle-words", item.w)) return false;
    seen.add(key);
    return true;
  };
  const custom = content
    .items("doodle-words", customPacks)
    .filter(take)
    .map((i) => toWordItem(i, true));
  const tiers: [WordItem[], WordItem[], WordItem[]] = [[], [], []];
  for (const item of content.items("doodle-words", stockPacks)) {
    if (take(item)) tiers[item.d - 1]?.push(toWordItem(item, false));
  }
  const deck: DoodleHidden["deck"] = [rng.shuffle(custom).slice(0, opts.custom), [], [], []];
  for (const t of [1, 2, 3] as const) {
    let bucket = rng.shuffle(tiers[t - 1] ?? []).slice(0, opts.perTier);
    if (bucket.length < opts.perTier) {
      const extra = rng
        .shuffle(FALLBACK_WORDS[t].filter(take))
        .map((i) => toWordItem(i, false))
        .slice(0, opts.perTier - bucket.length);
      bucket = [...bucket, ...extra];
    }
    deck[t] = bucket;
  }
  return deck;
}

/**
 * Draws one word of `tier` from the deck (mutates `deck`): the tier's bucket first, then the
 * nearest other tier, then (last resort, only after every bucket is empty) a fallback word
 * not offered yet this game, or any fallback word.
 */
export function drawWord(
  deck: DoodleHidden["deck"],
  tier: 1 | 2 | 3,
  used: readonly string[],
  rng: Rng,
): WordItem {
  const order: (1 | 2 | 3)[] = tier === 1 ? [1, 2, 3] : tier === 2 ? [2, 1, 3] : [3, 2, 1];
  for (const t of order) {
    const word = deck[t].shift();
    if (word !== undefined) return word;
  }
  const usedKeys = new Set(used.map(normalize));
  const fresh = FALLBACK_WORDS[tier].filter((i) => !usedKeys.has(normalize(i.w)));
  return toWordItem(rng.pick(fresh.length > 0 ? fresh : FALLBACK_WORDS[tier]), false);
}

/** The three words a drawer is offered: one easy, one medium, one hard (R2). */
export function drawChoices(
  deck: DoodleHidden["deck"],
  used: readonly string[],
  rng: Rng,
): WordItem[] {
  const out: WordItem[] = [];
  for (const t of [1, 2, 3] as const) {
    out.push(drawWord(deck, t, [...used, ...out.map((w) => w.w)], rng));
  }
  return out;
}

/** Three custom words (a custom turn), or null when fewer than three are left. */
export function drawCustomChoices(deck: DoodleHidden["deck"]): WordItem[] | null {
  if (deck[0].length < 3) return null;
  return deck[0].splice(0, 3);
}
