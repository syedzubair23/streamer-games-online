/**
 * Test fixtures for Tune In: a `spectrum-core` stand-in pack (original cards, schema-valid)
 * so sims and contract runs play with default options, and seat helpers.
 */
import type { AnyPack } from "@sg/shared";
import { fakeContent, makeSeats, type FakeContent } from "@sg/engine/testing";
import type { Seat } from "@sg/engine";
import { FALLBACK_CARDS, type TiOptions } from "../src/logic/index.ts";

const EXTRA: { id: string; left: string; right: string; examples: [string, string, string] }[] = [
  { id: "t-dry-wet", left: "Dry", right: "Wet", examples: ["Desert", "Towel", "Ocean"] },
  { id: "t-dark-bright", left: "Dark", right: "Bright", examples: ["Cave", "Candle", "Sun"] },
  {
    id: "t-weak-strong",
    left: "Weak",
    right: "Strong",
    examples: ["Kitten", "Horse", "Bulldozer"],
  },
  { id: "t-short-long", left: "Short", right: "Long", examples: ["Blink", "Movie", "Century"] },
  { id: "t-rare-common", left: "Rare", right: "Common", examples: ["Comet", "Umbrella", "Sand"] },
  {
    id: "t-safe-risky",
    left: "Safe",
    right: "Risky",
    examples: ["Pillow", "Skateboard", "Skydiving"],
  },
  {
    id: "t-simple-complex",
    left: "Simple",
    right: "Complex",
    examples: ["Spoon", "Watch", "Rocket"],
  },
  {
    id: "t-light-heavy",
    left: "Light",
    right: "Heavy",
    examples: ["Feather", "Backpack", "Anvil"],
  },
  {
    id: "t-smooth-bumpy",
    left: "Smooth",
    right: "Bumpy",
    examples: ["Glass", "Gravel road", "Mountain trail"],
  },
  {
    id: "t-lazy-busy",
    left: "Lazy",
    right: "Busy",
    examples: ["Sloth", "Waiter", "Air traffic control"],
  },
  {
    id: "t-bad-good",
    left: "Bad movie",
    right: "Good movie",
    examples: ["Cardboard sharks", "Popcorn flick", "Masterpiece"],
  },
  {
    id: "t-sad-happy",
    left: "Sad song",
    right: "Happy song",
    examples: ["Rainy ballad", "Road trip tune", "Birthday jingle"],
  },
  {
    id: "t-messy-tidy",
    left: "Messy",
    right: "Tidy",
    examples: ["Teen bedroom", "Office desk", "Museum"],
  },
  {
    id: "t-ugly-pretty",
    left: "Ugly",
    right: "Pretty",
    examples: ["Blobfish", "Pigeon", "Peacock"],
  },
];

/** 30 schema-valid cards under the default pack id. */
export const TEST_PACK: AnyPack = {
  id: "spectrum-core",
  kind: "spectrum",
  name: "Spectrum (test)",
  lang: "en",
  rating: "all",
  version: 1,
  items: [
    ...FALLBACK_CARDS.map((c) => ({
      id: c.id,
      left: c.left,
      right: c.right,
      examples: [...(c.examples ?? [])] as [string, string, string],
    })),
    ...EXTRA,
  ],
} as AnyPack;

/** A fresh content access with the test pack. */
export function testContent(): FakeContent {
  return fakeContent([TEST_PACK]);
}

/** Seats `p1..pn`; with `teams`, alternating room team ids. */
export function seats(n: number, teams?: readonly string[]): Seat[] {
  return makeSeats(n, teams !== undefined ? { teams } : {});
}

/** The spec's max-steps bound ("Test cases": Max steps 2,000). */
export const MAX_STEPS = 2_000;

/** Every major option preset of the spec's host options. */
export const PRESETS: Partial<TiOptions>[] = [
  {},
  { mode: "ffa" },
  { mode: "teams", steal: false },
  { audiencePicksCard: false, liveHeatmap: true },
  { scoreToWin: 15, cycles: 3 },
  { scoreToWin: 5, clueSec: 20, guessSec: 20 },
  { mode: "ffa", cycles: 1, clueSec: 120, guessSec: 90 },
];
