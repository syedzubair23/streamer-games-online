/**
 * Test fixtures for Trivia Night: schema-valid `trivia-mc` stand-in packs under the default pack
 * id (so sims and contract runs play with default options), and the option presets.
 *
 * The fixture strings are built so that no string is a substring of another item's strings
 * (fixed-width codes): the contract suite's secrecy fuzz matches hidden strings verbatim inside
 * serialized views, and real-looking questions would collide by accident ("Mars" inside a
 * public question about Mars). `test/logic.test.ts` asserts the property.
 */
import type { AnyPack } from "@sg/shared";
import { fakeContent, type FakeContent } from "@sg/engine/testing";
import type { McItem, TnOptions } from "../src/logic/index.ts";

/** The eight launch categories (spec "Content"). */
export const CATEGORIES = [
  "General",
  "Geography",
  "Science",
  "History",
  "Movies & TV",
  "Music",
  "Gaming",
  "Food & Nature",
] as const;

/** Builds `perCell` items for each category × difficulty with a fixed-width code prefix. */
export function fixtureItems(prefix: string, perCell: number): McItem[] {
  const items: McItem[] = [];
  CATEGORIES.forEach((category, c) => {
    for (const difficulty of [1, 2, 3] as const) {
      for (let n = 0; n < perCell; n++) {
        const code = `${prefix}${c}${difficulty}${String(n).padStart(2, "0")}`;
        items.push({
          id: `fx-${code}`,
          q: `Riddle ${code}: which answer is right?`,
          options: [`${code} alpha`, `${code} bravo`, `${code} charl`, `${code} delta`],
          correct: ((c + difficulty + n) % 4) as 0 | 1 | 2 | 3,
          category,
          difficulty,
          source: `https://example.com/trivia/${code}`,
        });
      }
    }
  });
  return items;
}

const pack = (id: string, items: McItem[]): AnyPack =>
  ({
    id,
    kind: "trivia-mc",
    name: `Trivia ${id} (test)`,
    lang: "en",
    rating: "all",
    version: 1,
    items,
  }) as AnyPack;

/** 144 items (8 categories × 3 difficulties × 6) under the default pack id. */
export const GENERAL_PACK: AnyPack = pack("trivia-general", fixtureItems("g", 6));
/** A second pack (48 items) for multi-pack draws. */
export const SCIENCE_PACK: AnyPack = pack("trivia-science", fixtureItems("s", 2));

/** A fresh content access with the test packs. */
export function testContent(): FakeContent {
  return fakeContent([GENERAL_PACK, SCIENCE_PACK]);
}

/** The spec's max-steps bound ("Test cases": Max steps 1,500). */
export const MAX_STEPS = 1_500;

/** Every major option preset of the spec's host options (Classic). */
export const PRESETS: Partial<TnOptions>[] = [
  {},
  { speedScoring: false },
  { showdown: false, lifeline: false },
  { questions: 6, answerSec: 10 },
  { questions: 20, answerSec: 40, difficulty: "hard" },
  { difficulty: "easy", packs: ["trivia-general", "trivia-science"] },
  { questions: 8, lifeline: false },
];
