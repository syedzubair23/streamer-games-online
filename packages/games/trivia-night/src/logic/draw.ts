/**
 * Question drawing (spec R1): the difficulty curve, no back-to-back categories, no repeats
 * within a room session (`content.isUsed`), expired `validUntil` items skipped (edge case), and
 * the built-in questions as a top-up when the packs run short.
 *
 * @module
 */
import type { Rng } from "@sg/shared";
import type { ContentAccess } from "@sg/engine";
import { FALLBACK_QUESTIONS } from "./fallback.ts";
import { isExpired } from "./rules.ts";
import { SPARE_QUESTIONS, type McItem, type TnOptions } from "./types.ts";

/** R1: the target difficulty of question `i` (0-based) of `n`. */
export function targetDifficulty(i: number, n: number, mode: TnOptions["difficulty"]): 1 | 2 | 3 {
  if (mode === "easy") return 1;
  if (mode === "hard") return 3;
  // Curve: the first third easy, the middle medium, the last third hard.
  const third = (i * 3) / n;
  return third < 1 ? 1 : third < 2 ? 2 : 3;
}

/**
 * Removes and returns the best item of `pool` for a slot: the target difficulty in another
 * category than `avoid`; else the nearest difficulty in another category; else the nearest
 * difficulty at all. `pool` is already shuffled, so ties fall to the seeded order.
 */
export function takeBest(
  pool: McItem[],
  target: 1 | 2 | 3,
  avoid: readonly string[],
): McItem | undefined {
  let bestIdx = -1;
  let bestCost = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const item = pool[i] as McItem;
    const cost = (avoid.includes(item.category) ? 10 : 0) + Math.abs(item.difficulty - target);
    if (cost < bestCost) {
      bestCost = cost;
      bestIdx = i;
      if (cost === 0) break;
    }
  }
  if (bestIdx < 0) return undefined;
  return pool.splice(bestIdx, 1)[0];
}

/** What setup draws for a game. */
export interface Draw {
  /** The game's questions, in play order. */
  queue: McItem[];
  /** One question per possible Showdown. */
  showdown: McItem[];
  /** Replacements for the host's `skipItem`. */
  spares: McItem[];
}

/** Inputs to {@link drawQuestions}. */
export interface DrawInput {
  content: ContentAccess;
  packs: readonly string[];
  count: number;
  difficulty: TnOptions["difficulty"];
  showdowns: number;
  rng: Rng;
  /** Setup time (server ms), for `validUntil`. */
  now: number;
}

/**
 * R1: draws the questions for one game. Unused pack items come first; when they cannot fill
 * the game, unused built-in questions top them up, and only then are items already used this
 * session reused (a session that played every question still gets a full game).
 */
export function drawQuestions(input: DrawInput): Draw {
  const seen = new Set<string>();
  const valid: McItem[] = [];
  const add = (item: McItem): void => {
    if (seen.has(item.id) || isExpired(item.validUntil, input.now)) return;
    seen.add(item.id);
    valid.push(item);
  };
  for (const item of input.content.items("trivia-mc", input.packs)) add(item);
  const isUsed = (item: McItem): boolean => input.content.isUsed("trivia-mc", item.id);
  const needed = input.count + input.showdowns;
  if (valid.filter((i) => !isUsed(i)).length < needed) {
    for (const item of FALLBACK_QUESTIONS) add(item);
  }
  const fresh = input.rng.shuffle(valid.filter((i) => !isUsed(i)));
  const used = input.rng.shuffle(valid.filter((i) => isUsed(i)));

  const take = (target: 1 | 2 | 3, avoid: readonly string[]): McItem | undefined =>
    takeBest(fresh, target, avoid) ?? takeBest(used, target, avoid);

  const queue: McItem[] = [];
  for (let i = 0; i < input.count; i++) {
    const prev = queue[queue.length - 1];
    const item = take(
      targetDifficulty(i, input.count, input.difficulty),
      prev ? [prev.category] : [],
    );
    if (item === undefined) break;
    queue.push(item);
  }
  const showdown: McItem[] = [];
  for (let i = 0; i < input.showdowns; i++) {
    const item = take(2, []);
    if (item === undefined) break;
    showdown.push(item);
  }
  const spares: McItem[] = [];
  for (let i = 0; i < SPARE_QUESTIONS; i++) {
    const item = take(2, []);
    if (item === undefined) break;
    spares.push(item);
  }
  return { queue, showdown, spares };
}
