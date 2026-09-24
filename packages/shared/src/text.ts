/**
 * Text utilities for user input: normalisation for answer matching, Levenshtein distance,
 * guess classification (SPEC §4 `guess` polls), length-capped cleaning for names and answers,
 * and the profanity filter wrapper around `obscenity` (SPEC §9.7).
 *
 * @module
 */
import {
  asteriskCensorStrategy,
  collapseDuplicatesTransformer,
  compareMatchByPositionAndId,
  DataSet,
  englishDataset,
  englishRecommendedTransformers,
  parseRawPattern,
  RegExpMatcher,
  resolveConfusablesTransformer,
  resolveLeetSpeakTransformer,
  TextCensor,
  toAsciiLowerCaseTransformer,
} from "obscenity";
import type { RoomConfig } from "./room.ts";

// ---------------------------------------------------------------------------------------------
// Normalisation and distance
// ---------------------------------------------------------------------------------------------

/** Apostrophes (straight, curly and modifier) are deleted so "don't" matches "dont". */
const APOSTROPHES = /['‘’ʼ`´]/g;
/** Combining marks left over after NFKD decomposition (accents, diacritics). */
const MARKS = /\p{M}/gu;
/** Everything that is not a letter, a digit or whitespace becomes a space. */
const NON_WORD = /[^\p{L}\p{N}\s]/gu;
const SPACES = /\s+/gu;

/**
 * Canonical form for comparing answers: Unicode-compatibility decomposed (so full-width and
 * ligature forms fold), accents stripped, lowercased, apostrophes deleted, all other punctuation
 * and symbols turned into spaces, whitespace collapsed to single spaces and trimmed.
 *
 * `"  Crème Brûlée!! "` → `"creme brulee"`, `"Rock'n'Roll"` → `"rocknroll"`, `"ice-cream"` →
 * `"ice cream"`.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(NON_WORD, " ")
    .replace(SPACES, " ")
    .trim();
}

/**
 * Levenshtein edit distance (insertions, deletions, substitutions; each costs 1), counted in
 * Unicode code points so an emoji is one character.
 *
 * With `max`, the computation stops early once the distance must exceed `max` and returns
 * `max + 1`; use it for "is it within k?" checks on long strings.
 */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  let s = Array.from(a);
  let t = Array.from(b);
  if (s.length < t.length) [s, t] = [t, s]; // t is the shorter one: O(min) memory
  const cap = max + 1;
  if (s.length - t.length > max) return cap;
  if (t.length === 0) return s.length;

  let prev = new Array<number>(t.length + 1);
  let curr = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    let rowMin = i;
    const si = s[i - 1];
    for (let j = 1; j <= t.length; j++) {
      const cost = si === t[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return cap;
    [prev, curr] = [curr, prev];
  }
  const distance = prev[t.length] as number;
  return distance > max ? cap : distance;
}

/** A `guess` is "close" only when the accepted answer has at least this many characters (SPEC §4). */
export const CLOSE_GUESS_MIN_LENGTH = 5;

/**
 * Classifies a free-text guess against the secret accepted answers (SPEC §4 `guess` polls,
 * Doodle): `"correct"` when the normalised guess equals a normalised accepted answer,
 * `"close"` when it is within Levenshtein distance 1 of an accepted answer that is at least
 * {@link CLOSE_GUESS_MIN_LENGTH} characters long (spaces not counted), otherwise `"wrong"`.
 * An empty guess is always `"wrong"`.
 */
export function classifyGuess(
  guess: string,
  accept: readonly string[],
): "correct" | "close" | "wrong" {
  const g = normalize(guess);
  if (g.length === 0) return "wrong";
  let close = false;
  for (const answer of accept) {
    const a = normalize(answer);
    if (a.length === 0) continue;
    if (a === g) return "correct";
    if (!close && Array.from(a.replace(/ /g, "")).length >= CLOSE_GUESS_MIN_LENGTH) {
      close = levenshtein(a, g, 1) <= 1;
    }
  }
  return close ? "close" : "wrong";
}

// ---------------------------------------------------------------------------------------------
// Cleaning user text
// ---------------------------------------------------------------------------------------------

/** Display names are capped at 16 characters (SPEC §3 step 3). */
export const NAME_MAX_LENGTH = 16;

/** Control characters, and bidi overrides/isolates that could reorder text on the Stage. */
const UNSAFE_CHARS = /[\p{Cc}‪-‮⁦-⁩‎‏؜]/gu;

const graphemes: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Makes user text safe to store and display: removes control characters and bidi overrides,
 * collapses whitespace (including newlines) to single spaces, trims, and caps the result at
 * `maxLength` user-perceived characters (grapheme clusters, so an emoji or an accented letter
 * is never cut in half). Does not filter profanity; see {@link filterText}.
 */
export function cleanUserText(text: string, maxLength: number): string {
  const cleaned = text.replace(UNSAFE_CHARS, " ").replace(SPACES, " ").trim();
  const units = graphemes
    ? Array.from(graphemes.segment(cleaned), (s) => s.segment)
    : Array.from(cleaned);
  return units.length <= maxLength ? cleaned : units.slice(0, maxLength).join("").trimEnd();
}

/** {@link cleanUserText} with the display-name cap ({@link NAME_MAX_LENGTH}). */
export function cleanName(name: string): string {
  return cleanUserText(name, NAME_MAX_LENGTH);
}

// ---------------------------------------------------------------------------------------------
// Profanity filter
// ---------------------------------------------------------------------------------------------

/**
 * Our own blocklist on top of obscenity's English dataset (SPEC §9.7), in obscenity's pattern
 * syntax (`|` = word boundary). These are stream-safety phrases the dataset does not cover.
 * The trailing boundary is omitted on purpose: obscenity's boundary check fails when the
 * phrase is followed by punctuation ("kys!").
 */
export const HOUSE_BLOCKLIST: readonly string[] = [
  "|kys",
  "|kill yourself",
  "|kill urself",
  "|kill your self",
  "|neck yourself",
];

/** The result of {@link filterText}. */
export interface FilterResult {
  /**
   * The text to use: masked in family mode, the original in standard mode (where the Stage
   * blurs flagged text until the host reveals it).
   */
  text: string;
  /** Whether any blocked term was found. */
  flagged: boolean;
  /** The text with every match replaced by `*` (one per character), whatever the mode. */
  masked: string;
}

/** Options for {@link createTextFilter}. */
export interface TextFilterOptions {
  /**
   * Extra blocked words or phrases, matched literally after {@link normalize} (so punctuation
   * in a term is ignored), with a leading word boundary.
   */
  extraTerms?: readonly string[];
}

/** A configured profanity filter. */
export interface TextFilter {
  /** True when `text` contains a blocked term. */
  hasMatch(text: string): boolean;
  /** Filters `text` for the room's content filter mode (see {@link FilterResult}). */
  filter(text: string, mode: RoomConfig["contentFilter"]): FilterResult;
}

/**
 * Builds a filter from obscenity's English dataset and recommended transformers (which catch
 * leetspeak, confusable characters and repeated letters, and whitelist words like
 * "Scunthorpe"), plus {@link HOUSE_BLOCKLIST} and any `extraTerms`.
 */
export function createTextFilter(options: TextFilterOptions = {}): TextFilter {
  const english = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });

  // Our own terms get a separate matcher without obscenity's letter-collapsing transformer:
  // that transformer is tuned to the English dataset's patterns and would turn "zz" in the
  // input into "z", so literal terms with doubled letters could never match. Only runs of
  // spaces are collapsed here.
  const houseSet = new DataSet<{ originalWord: string }>();
  const extra = (options.extraTerms ?? [])
    .map(normalize) // letters, digits and single spaces only: no pattern metacharacters survive
    .filter((term) => term.length > 0)
    .map((term) => `|${escapePattern(term)}`);
  for (const raw of [...HOUSE_BLOCKLIST, ...extra]) {
    houseSet.addPhrase((phrase) =>
      phrase.setMetadata({ originalWord: raw }).addPattern(parseRawPattern(raw)),
    );
  }
  const house = new RegExpMatcher({
    ...houseSet.build(),
    blacklistMatcherTransformers: [
      resolveConfusablesTransformer(),
      resolveLeetSpeakTransformer(),
      toAsciiLowerCaseTransformer(),
      collapseDuplicatesTransformer({
        defaultThreshold: Number.POSITIVE_INFINITY,
        customThresholds: new Map([[" ", 1]]), // "kill   yourself" == "kill yourself"
      }),
    ],
  });
  const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

  return {
    hasMatch: (text) => english.hasMatch(text) || house.hasMatch(text),
    filter(text, mode) {
      const matches = [...english.getAllMatches(text), ...house.getAllMatches(text)];
      if (matches.length === 0) return { text, flagged: false, masked: text };
      matches.sort(compareMatchByPositionAndId);
      const masked = censor.applyTo(text, matches);
      return { text: mode === "family" ? masked : text, flagged: true, masked };
    },
  };
}

let defaultFilter: TextFilter | null = null;

/** The shared default filter, built on first use (building the matcher takes a few ms). */
function getDefaultFilter(): TextFilter {
  defaultFilter ??= createTextFilter();
  return defaultFilter;
}

/**
 * Runs the profanity filter on names, answers, guesses, prompts and clues (SPEC §9.7).
 *
 * - **family**: matches are masked with `*` (`"what the fuck"` → `"what the ****"`); the
 *   player may resubmit.
 * - **standard**: the text is returned unchanged with `flagged: true`, so the Stage can blur
 *   it until the host clicks to reveal.
 */
export function filterText(text: string, mode: RoomConfig["contentFilter"]): FilterResult {
  return getDefaultFilter().filter(text, mode);
}

/** True when `text` contains a blocked term (default filter). */
export function hasProfanity(text: string): boolean {
  return getDefaultFilter().hasMatch(text);
}

/** Escapes obscenity pattern metacharacters so a term matches literally. */
function escapePattern(term: string): string {
  return term.replace(/[[\]?|\\]/g, (ch) => `\\${ch}`);
}
