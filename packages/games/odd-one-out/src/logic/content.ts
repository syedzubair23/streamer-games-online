/**
 * Round content for Odd One Out (`docs/specs/odd-one-out.md` R1, R2, "Content"): the deck of
 * one card per round, dealt at setup because `ContentAccess` is only available there.
 *
 * - **Classic:** a category from the host's `ooo-categories` packs and one of its 12 secrets.
 *   Categories not used earlier in the session come first; a match never repeats a secret.
 * - **Undercover:** a pair from the `ooo-pairs` packs; a coin flip decides which word is the
 *   secret and which the odd ones' similar word (decoy). When both words are secrets of one
 *   category the round uses that category (R1); otherwise the pair's own category name, with the
 *   two words as the options.
 *
 * @module
 */
import { contentKey, type ContentAccess } from "@sg/engine";
import { normalize, type OooCategory, type OooPair, type Rng } from "@sg/shared";
import type { OooCard, OooCategoryInfo, OooOptions } from "./types.ts";

/** Category-wide clues for a bot when the content has none (Undercover pair categories). */
export const FALLBACK_GENERIC: readonly string[] = Object.freeze([
  "classic",
  "familiar",
  "everyday",
  "popular",
  "common",
  "typical",
]);

/** The result of {@link dealDeck}. */
export type DealResult = { ok: true; deck: OooCard[] } | { ok: false; error: string };

const key = (s: string): string => normalize(s);

/** A category is playable with exactly 12 distinct secrets (edge case: fewer is rejected). */
const playable = (c: OooCategory): boolean =>
  c.secrets.length === 12 && new Set(c.secrets.map(key)).size === 12;

/** The categories of `packIds`, playable ones only, each id once. */
export function loadCategories(content: ContentAccess, packIds: readonly string[]): OooCategory[] {
  const seen = new Set<string>();
  const out: OooCategory[] = [];
  for (const c of content.items("ooo-categories", packIds)) {
    if (seen.has(c.id) || !playable(c)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Every Undercover pair available to the room, each once. */
export function loadPairs(content: ContentAccess): OooPair[] {
  const ids = content.packs("ooo-pairs").map((p) => p.id);
  const seen = new Set<string>();
  const out: OooPair[] = [];
  for (const pair of content.items("ooo-pairs", ids)) {
    const k = [key(pair.a), key(pair.b)].sort().join("|");
    if (seen.has(k) || key(pair.a) === key(pair.b)) continue;
    seen.add(k);
    out.push(pair);
  }
  return out;
}

const info = (c: OooCategory): OooCategoryInfo => ({
  id: c.id,
  name: c.name,
  options: [...c.secrets],
});

const bankOf = (c: OooCategory | undefined, secret: string): string[] => [
  ...(c?.clueBank[secret] ?? []),
];

/** Unused items first (each group shuffled). */
function freshFirst<T>(items: readonly T[], used: (item: T) => boolean, rng: Rng): T[] {
  return [...rng.shuffle(items.filter((i) => !used(i))), ...rng.shuffle(items.filter(used))];
}

/** Deals `rounds` cards for the options' variant (R1: no repeated secret in the match). */
export function dealDeck(
  content: ContentAccess,
  options: OooOptions,
  rounds: number,
  rng: Rng,
): DealResult {
  const categories = loadCategories(content, options.packs);
  return options.variant === "undercover"
    ? dealUndercover(content, categories, rounds, rng)
    : dealClassic(content, categories, rounds, rng);
}

function dealClassic(
  content: ContentAccess,
  categories: readonly OooCategory[],
  rounds: number,
  rng: Rng,
): DealResult {
  if (categories.length === 0) {
    return { ok: false, error: "No playable categories: add an ooo-categories pack (ooo-core)." };
  }
  const pool = freshFirst(categories, (c) => content.isUsed("ooo-categories", c.id), rng);
  const taken = new Set<string>();
  const deck: OooCard[] = [];
  for (let r = 0; r < rounds; r++) {
    const category = pool[r % pool.length] as OooCategory;
    const free = category.secrets.filter((s) => !taken.has(key(s)));
    // 12 secrets per category and at most 8 rounds: a category never runs dry.
    const secret = rng.pick(free);
    taken.add(key(secret));
    deck.push({
      category: info(category),
      secret,
      bank: bankOf(category, secret),
      generic: [...category.genericClues],
    });
  }
  return { ok: true, deck };
}

interface PairPlan {
  pair: OooPair;
  /** The category holding both words (R1), when there is one. */
  home: OooCategory | undefined;
}

function dealUndercover(
  content: ContentAccess,
  categories: readonly OooCategory[],
  rounds: number,
  rng: Rng,
): DealResult {
  const pairs = loadPairs(content);
  const holding = (word: string): OooCategory | undefined =>
    categories.find((c) => c.secrets.some((s) => key(s) === key(word)));
  const plans: PairPlan[] = pairs.map((pair) => ({
    pair,
    home: categories.find(
      (c) =>
        c.secrets.some((s) => key(s) === key(pair.a)) &&
        c.secrets.some((s) => key(s) === key(pair.b)),
    ),
  }));
  const used = (p: PairPlan): boolean =>
    content.isUsed("ooo-pairs", contentKey("ooo-pairs", p.pair));
  const fresh = plans.filter((p) => !used(p));
  const stale = plans.filter(used);
  const order = [
    ...rng.shuffle(fresh.filter((p) => p.home !== undefined)),
    ...rng.shuffle(fresh.filter((p) => p.home === undefined)),
    ...rng.shuffle(stale.filter((p) => p.home !== undefined)),
    ...rng.shuffle(stale.filter((p) => p.home === undefined)),
  ];
  const taken = new Set<string>();
  const deck: OooCard[] = [];
  for (const plan of order) {
    if (deck.length === rounds) break;
    const { pair, home } = plan;
    if (taken.has(key(pair.a)) || taken.has(key(pair.b))) continue;
    taken.add(key(pair.a));
    taken.add(key(pair.b));
    const flip = rng.bool();
    const [s, d] = flip ? [pair.a, pair.b] : [pair.b, pair.a];
    const pairKey = contentKey("ooo-pairs", pair);
    if (home !== undefined) {
      const spell = (w: string): string => home.secrets.find((x) => key(x) === key(w)) ?? w;
      const secret = spell(s);
      deck.push({
        category: info(home),
        secret,
        decoy: spell(d),
        pairKey,
        bank: bankOf(home, secret),
        generic: [...home.genericClues],
      });
    } else {
      const source = holding(s);
      const named = categories.find((c) => key(c.name) === key(pair.category)) ?? source;
      deck.push({
        category: {
          id: `pair:${[key(pair.a), key(pair.b)].sort().join("|")}`,
          name: pair.category,
          options: [pair.a, pair.b].sort((x, y) => (key(x) < key(y) ? -1 : 1)),
        },
        secret: s,
        decoy: d,
        pairKey,
        bank:
          source === undefined
            ? []
            : bankOf(source, source.secrets.find((x) => key(x) === key(s)) ?? s),
        generic: named === undefined ? [...FALLBACK_GENERIC] : [...named.genericClues],
      });
    }
  }
  if (deck.length < rounds) {
    return {
      ok: false,
      error: `Undercover needs ${rounds} word pairs: add an ooo-pairs pack (found ${deck.length}).`,
    };
  }
  return { ok: true, deck };
}
