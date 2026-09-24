import { describe, expect, it } from "vitest";
import {
  CUSTOM_PACK_MAX_ITEMS,
  isPackKind,
  PACK_ITEM_SCHEMAS,
  PACK_KINDS,
  packSchema,
  parsePack,
  parseWordList,
  validateCustomPack,
  type PackItemMap,
  type PackKind,
} from "../src/content.ts";

const secrets = [
  "lantern",
  "candle",
  "torch",
  "firefly",
  "moon",
  "star",
  "lamp",
  "sun",
  "match",
  "neon",
  "glowstick",
  "lighthouse",
];

/** One valid item per kind, taken from the shapes in each game spec. */
const VALID: { [K in PackKind]: PackItemMap[K] } = {
  "quip-prompts": {
    id: "q-001",
    text: "The worst thing to hear from your dentist: ___",
    safety: ["Oops", "Is that normal?", "Hold still forever"],
    tags: ["work"],
  },
  "trivia-mc": {
    id: "gen-001",
    q: "Which planet has the most known moons?",
    options: ["Saturn", "Jupiter", "Mars", "Venus"],
    correct: 0,
    category: "science",
    difficulty: 2,
    source: "https://science.nasa.gov/saturn/moons/",
    validUntil: "2027-12-31",
  },
  "trivia-bluff": {
    id: "bluff-001",
    prompt: "The world's oldest known pet cat was found buried in ___.",
    truth: "Cyprus",
    alts: ["cyprus island"],
    houseLies: ["Egypt", "Iceland", "Peru"],
    category: "history",
    source: "https://www.nationalgeographic.com/",
  },
  spectrum: {
    id: "s-001",
    left: "Underrated",
    right: "Overrated",
    examples: ["Brunch", "Naps", "Socks"],
  },
  "doodle-words": { w: "cat", alt: ["kitty"], d: 1 },
  "ooo-categories": {
    id: "things-that-glow",
    name: "Things that glow",
    secrets,
    clueBank: Object.fromEntries(secrets.map((s) => [s, ["bright", "warm", "night"]])) as Record<
      string,
      [string, string, string]
    >,
    genericClues: ["hmm", "maybe", "classic", "outside", "small", "old"],
  },
  "ooo-pairs": { a: "cat", b: "dog", category: "pets" },
};

function pack<K extends PackKind>(kind: K, items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: `${kind}-test`,
    kind,
    name: "Test pack",
    lang: "en",
    rating: "all",
    version: 1,
    items,
    ...extra,
  };
}

describe("pack schemas (SPEC §12)", () => {
  it("covers every PackKind", () => {
    expect(Object.keys(PACK_ITEM_SCHEMAS).sort()).toEqual([...PACK_KINDS].sort());
    for (const kind of PACK_KINDS) expect(isPackKind(kind)).toBe(true);
    expect(isPackKind("nope")).toBe(false);
  });

  it.each(PACK_KINDS)("accepts a valid %s pack", (kind) => {
    const result = parsePack(pack(kind, [VALID[kind]]), kind);
    expect(result).toEqual({ ok: true, pack: pack(kind, [VALID[kind]]) });
    expect(packSchema(kind).safeParse(pack(kind, [VALID[kind]])).success).toBe(true);
  });

  it("parsePack dispatches on kind and checks an expected kind", () => {
    expect(parsePack(pack("spectrum", [VALID.spectrum])).ok).toBe(true);
    expect(parsePack(pack("spectrum", [VALID.spectrum]), "doodle-words")).toEqual({
      ok: false,
      errors: ["kind: expected doodle-words, got spectrum"],
    });
    expect(parsePack({ kind: "mystery" }).ok).toBe(false);
    expect(parsePack(null).ok).toBe(false);
    expect(parsePack("text").ok).toBe(false);
  });

  it.each<[string, PackKind, Record<string, unknown>]>([
    ["a lang other than en", "spectrum", { lang: "fr" }],
    ["a bad rating", "spectrum", { rating: "adult" }],
    ["a version < 1", "spectrum", { version: 0 }],
    ["a fractional version", "spectrum", { version: 1.5 }],
    ["an unknown envelope key", "spectrum", { author: "me" }],
    ["an id with spaces", "spectrum", { id: "My Pack" }],
    ["no items", "spectrum", { items: [] }],
  ])("rejects an envelope with %s", (_name, kind, extra) => {
    expect(parsePack(pack(kind, [VALID[kind]], extra)).ok).toBe(false);
  });

  it("rejects duplicate items (by id, by normalised word, by unordered pair)", () => {
    const dupId = parsePack(
      pack("spectrum", [VALID.spectrum, { ...VALID.spectrum, left: "Cold", right: "Hot" }]),
    );
    expect(dupId).toEqual({ ok: false, errors: ["items.1: duplicate item (same as items[0])"] });
    expect(parsePack(pack("doodle-words", [VALID["doodle-words"], { w: " CAT!", d: 2 }])).ok).toBe(
      false,
    );
    expect(
      parsePack(pack("ooo-pairs", [VALID["ooo-pairs"], { a: "Dog", b: "cat", category: "x" }])).ok,
    ).toBe(false);
    expect(parsePack(pack("doodle-words", [VALID["doodle-words"], { w: "dog", d: 2 }])).ok).toBe(
      true,
    );
  });

  const bad = <K extends PackKind>(
    kind: K,
    patch: Partial<Record<keyof PackItemMap[K], unknown>>,
  ) => parsePack(pack(kind, [{ ...VALID[kind], ...patch }]));

  it("quip-prompts: exactly 3 safety lines", () => {
    expect(bad("quip-prompts", { safety: ["a", "b"] }).ok).toBe(false);
    expect(bad("quip-prompts", { safety: ["a", "b", "c", "d"] }).ok).toBe(false);
    expect(bad("quip-prompts", { text: "   " }).ok).toBe(false);
  });

  it("trivia-mc: question-writing rules, a valid answer index, a source URL", () => {
    expect(bad("trivia-mc", { q: "x".repeat(111) }).ok).toBe(false);
    expect(bad("trivia-mc", { q: "x".repeat(110) }).ok).toBe(true);
    expect(bad("trivia-mc", { options: ["a".repeat(29), "b", "c", "d"] }).ok).toBe(false);
    expect(bad("trivia-mc", { options: ["a", "b", "c"] }).ok).toBe(false);
    expect(bad("trivia-mc", { options: ["Paris", "paris!", "Rome", "Oslo"] }).ok).toBe(false);
    expect(bad("trivia-mc", { correct: 4 }).ok).toBe(false);
    expect(bad("trivia-mc", { difficulty: 0 }).ok).toBe(false);
    expect(bad("trivia-mc", { source: "not a url" }).ok).toBe(false);
    expect(bad("trivia-mc", { source: "ftp://example.com/x" }).ok).toBe(false);
    expect(bad("trivia-mc", { validUntil: "next year" }).ok).toBe(false);
    expect(bad("trivia-mc", { validUntil: undefined }).ok).toBe(true);
  });

  it("trivia-bluff: a blank, ≥ 3 distinct house lies that are not the truth (R9)", () => {
    expect(bad("trivia-bluff", { prompt: "No blank here." }).ok).toBe(false);
    expect(bad("trivia-bluff", { houseLies: ["Egypt", "Peru"] }).ok).toBe(false);
    expect(bad("trivia-bluff", { houseLies: ["Egypt", "Peru", "CYPRUS"] }).ok).toBe(false);
    expect(bad("trivia-bluff", { houseLies: ["Egypt", "Peru", "Cyprus Island"] }).ok).toBe(false);
    expect(bad("trivia-bluff", { houseLies: ["Egypt", "Peru", "egypt"] }).ok).toBe(false);
  });

  it("spectrum: 3 examples and two different ends", () => {
    expect(bad("spectrum", { examples: ["a", "b"] }).ok).toBe(false);
    expect(bad("spectrum", { right: "underrated" }).ok).toBe(false);
  });

  it("doodle-words: difficulty 1..3", () => {
    expect(bad("doodle-words", { d: 4 }).ok).toBe(false);
    expect(bad("doodle-words", { w: "" }).ok).toBe(false);
    expect(parsePack(pack("doodle-words", [{ w: "sun", d: 1 }])).ok).toBe(true);
  });

  it("ooo-categories: exactly 12 distinct secrets, one clueBank entry each, 6 generic clues", () => {
    const cat = VALID["ooo-categories"];
    expect(bad("ooo-categories", { secrets: secrets.slice(0, 11) }).ok).toBe(false);
    expect(bad("ooo-categories", { secrets: [...secrets.slice(0, 11), "moon"] }).ok).toBe(false);
    const { lantern: _dropped, ...missing } = cat.clueBank;
    expect(bad("ooo-categories", { clueBank: missing }).ok).toBe(false);
    expect(
      bad("ooo-categories", { clueBank: { ...cat.clueBank, extra: ["a", "b", "c"] } }).ok,
    ).toBe(false);
    expect(bad("ooo-categories", { clueBank: { ...cat.clueBank, lantern: ["a", "b"] } }).ok).toBe(
      false,
    );
    expect(bad("ooo-categories", { genericClues: ["a", "b", "c", "d", "e"] }).ok).toBe(false);
  });

  it("ooo-pairs: a and b differ", () => {
    expect(bad("ooo-pairs", { b: "CAT" }).ok).toBe(false);
  });

  it("formats errors as path: message", () => {
    const result = bad("doodle-words", { d: 9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^items\.0\.d: /);
    const root = parsePack({ kind: "spectrum" });
    if (!root.ok) expect(root.errors.length).toBeGreaterThan(0);
  });
});

describe("host custom packs", () => {
  it("drops items with profanity and reports them", () => {
    const words = [
      { w: "cat", d: 1 },
      { w: "shit", d: 1 },
      { w: "dog", d: 2 },
    ];
    const result = validateCustomPack(pack("doodle-words", words), "doodle-words");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.items.map((i) => i.w)).toEqual(["cat", "dog"]);
      expect(result.removed).toEqual([{ index: 1, reason: "profanity" }]);
    }
  });

  it("looks for profanity in nested text and keys", () => {
    const item = { ...VALID["ooo-pairs"], category: "fucking pets" };
    const result = validateCustomPack(
      pack("ooo-pairs", [VALID["ooo-pairs"], { ...item, a: "cow", b: "pig" }]),
      "ooo-pairs",
    );
    expect(result.ok && result.removed.length).toBe(1);
  });

  it(`enforces the ${CUSTOM_PACK_MAX_ITEMS}-item cap`, () => {
    const words = Array.from({ length: CUSTOM_PACK_MAX_ITEMS + 1 }, (_, i) => ({
      w: `word${i}`,
      d: 1,
    }));
    expect(validateCustomPack(pack("doodle-words", words), "doodle-words")).toEqual({
      ok: false,
      errors: [`items: at most ${CUSTOM_PACK_MAX_ITEMS} items`],
    });
    expect(validateCustomPack(pack("doodle-words", words.slice(1)), "doodle-words").ok).toBe(true);
  });

  it("rejects invalid packs and packs left empty by filtering", () => {
    expect(validateCustomPack(pack("doodle-words", [{ w: 1 }]), "doodle-words").ok).toBe(false);
    expect(validateCustomPack(pack("doodle-words", [{ w: "shit", d: 1 }]), "doodle-words")).toEqual(
      {
        ok: false,
        errors: ["items: no items left after filtering"],
      },
    );
  });

  it("parseWordList cleans, dedupes, filters and caps a pasted list", () => {
    const input = "Cat\r\n  cat!  \n\nDog\rshit\n!!!\n" + "x".repeat(40);
    const result = parseWordList(input);
    expect(result.words).toEqual(["Cat", "Dog", "x".repeat(32)]);
    expect(result.dropped).toEqual({ duplicate: 1, profanity: 1, overLimit: 0 });

    const many = Array.from({ length: CUSTOM_PACK_MAX_ITEMS + 5 }, (_, i) => `w${i}`).join("\n");
    const capped = parseWordList(many);
    expect(capped.words).toHaveLength(CUSTOM_PACK_MAX_ITEMS);
    expect(capped.dropped.overLimit).toBe(5);
    expect(parseWordList("abcdef", 3).words).toEqual(["abc"]);
  });
});
