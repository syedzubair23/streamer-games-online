/**
 * Test fixtures for Doodle: schema-valid `doodle-core` and `custom-host` stand-in packs (so
 * sims and contract runs play with real pack plumbing), option presets, and a Team Doodle
 * wrapper for the contract suite (which seats players without teams).
 *
 * The fixture words are two-word phrases no view text can contain by accident, so the contract
 * secrecy fuzz (which searches every view for every hidden string) only reports real leaks.
 */
import type { AnyPack, DoodleWord } from "@sg/shared";
import { fakeContent, type FakeContent } from "@sg/engine/testing";
import { createDoodle, type DoodleModule, type DoodleOptions } from "../src/logic/index.ts";

/** Spec "Test cases": max steps 20,000 (strokes count as steps). */
export const MAX_STEPS = 20_000;

const ADJECTIVES = [
  "amber",
  "brisk",
  "cobalt",
  "dapper",
  "elfin",
  "fuzzy",
  "gilded",
  "hazel",
  "inky",
] as const;
const NOUNS: Readonly<Record<1 | 2 | 3, readonly string[]>> = {
  1: ["walrus", "teapot", "mitten", "pebble", "lantern"],
  2: ["zeppelin", "harpsichord", "igloo", "kazoo", "quokka"],
  3: ["narwhal", "xylophone", "yurt", "jukebox", "origami"],
};

function words(d: 1 | 2 | 3): DoodleWord[] {
  const out: DoodleWord[] = [];
  for (const a of ADJECTIVES) {
    for (const n of NOUNS[d]) out.push({ w: `${a} ${n}`, alt: [`${n} of ${a}`], d });
  }
  return out;
}

/** 45 words per tier: enough for 12 players × 3 rounds without the fallback list. */
export const CORE_WORDS: readonly DoodleWord[] = [...words(1), ...words(2), ...words(3)];

/** A host custom list (no tier: stored with `d: 1`, ignored by the game). */
export const CUSTOM_WORDS: readonly DoodleWord[] = ADJECTIVES.flatMap((a) =>
  ["velvet sofa", "paper crane", "copper kettle", "tin robot", "glass marble"].map((n) => ({
    w: `${a} ${n}`,
    d: 1 as const,
  })),
);

export const CORE_PACK: AnyPack = {
  id: "doodle-core",
  kind: "doodle-words",
  name: "Doodle core (test)",
  lang: "en",
  rating: "all",
  version: 1,
  items: [...CORE_WORDS],
};

export const CUSTOM_PACK: AnyPack = {
  id: "custom-host",
  kind: "doodle-words",
  name: "Host words (test)",
  lang: "en",
  rating: "all",
  version: 1,
  items: [...CUSTOM_WORDS],
};

/** A fresh content access per game (its "used" set starts empty). */
export function testContent(): FakeContent {
  return fakeContent([CORE_PACK, CUSTOM_PACK]);
}

/** The major option presets (spec "Host options"). */
export const PRESETS: readonly Partial<DoodleOptions>[] = [
  {},
  { audiencePicksTier: false, hints: false },
  { rounds: "3", drawSec: 40 },
  { customWords: "mix", packs: ["doodle-core", "custom-host"] },
  { customWords: "only", packs: ["custom-host"], rounds: "1" },
  { rounds: "2", drawSec: 150 },
];

/** The two test teams. */
export const TEAMS = ["tomato", "sky"] as const;

/**
 * Team Doodle for the contract suite and sims: the same module with every seat assigned to a
 * team (alternating), since the contract suite seats players without teams.
 */
export function teamDoodle(teams: readonly string[] = TEAMS): DoodleModule {
  const base = createDoodle();
  return {
    ...base,
    setup: (ctx) =>
      base.setup({
        ...ctx,
        players: ctx.players.map((p, i) => ({ ...p, teamId: teams[i % teams.length] as string })),
        teams: teams.map((id, i) => ({
          id,
          name: id[0]?.toUpperCase() + id.slice(1),
          colorSlot: i,
        })),
      }),
  };
}
