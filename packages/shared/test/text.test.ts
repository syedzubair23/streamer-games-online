import { describe, expect, it } from "vitest";
import {
  classifyGuess,
  cleanName,
  cleanUserText,
  createTextFilter,
  filterText,
  hasProfanity,
  levenshtein,
  NAME_MAX_LENGTH,
  normalize,
} from "../src/text.ts";

describe("normalize", () => {
  it.each([
    ["Hello World", "hello world"],
    ["  Crème   Brûlée!! ", "creme brulee"],
    ["Rock'n'Roll", "rocknroll"],
    ["don’t", "dont"],
    ["ice-cream", "ice cream"],
    ["Ｆｕｌｌ　Ｗｉｄｔｈ", "full width"], // NFKD folds full-width letters and spaces
    ["ﬁsh", "fish"], // ligature
    ["São Paulo", "sao paulo"],
    ["Ñandú", "nandu"],
    ["tab\tand\nnewline", "tab and newline"],
    ["...!?", ""],
    ["", ""],
    ["R2-D2", "r2 d2"],
    ["🐱 cat 🐱", "cat"],
    ["ΑΒΓ", "αβγ"],
  ])("normalize(%j) === %j", (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const s of ["  Crème Brûlée!! ", "Rock'n'Roll", "R2-D2", "Ｆｕｌｌ"]) {
      expect(normalize(normalize(s))).toBe(normalize(s));
    }
  });
});

describe("levenshtein (M0-02 accept: correct on a table of cases)", () => {
  it.each([
    ["", "", 0],
    ["", "abc", 3],
    ["abc", "", 3],
    ["abc", "abc", 0],
    ["kitten", "sitting", 3],
    ["sitting", "kitten", 3],
    ["flaw", "lawn", 2],
    ["saturday", "sunday", 3],
    ["gumbo", "gambol", 2],
    ["book", "back", 2],
    ["a", "b", 1],
    ["ab", "ba", 2], // transposition = 2 edits in plain Levenshtein
    ["abc", "abcd", 1],
    ["abcd", "abc", 1],
    ["abc", "xabc", 1],
    ["intention", "execution", 5],
    ["elephant", "relevant", 3],
    ["pizza", "piza", 1],
    ["giraffe", "girafe", 1],
    ["🐱cat", "🐶cat", 1], // code points, not UTF-16 units
    ["héllo", "hello", 1],
    ["aaaa", "bbbb", 4],
  ])("levenshtein(%j, %j) === %i", (a, b, d) => {
    expect(levenshtein(a, b)).toBe(d);
    expect(levenshtein(b, a)).toBe(d);
  });

  it("satisfies the metric axioms on random strings", () => {
    const words = ["", "a", "ab", "abc", "cab", "banana", "bandana", "cabana", "xyz"];
    for (const a of words) {
      for (const b of words) {
        const ab = levenshtein(a, b);
        expect(ab === 0).toBe(a === b);
        expect(ab).toBe(levenshtein(b, a));
        expect(ab).toBeLessThanOrEqual(Math.max(a.length, b.length));
        expect(ab).toBeGreaterThanOrEqual(Math.abs(a.length - b.length));
        for (const c of words) {
          expect(ab).toBeLessThanOrEqual(levenshtein(a, c) + levenshtein(c, b));
        }
      }
    }
  });

  it("with max: exact when within max, max + 1 when beyond", () => {
    expect(levenshtein("kitten", "sitting", 3)).toBe(3);
    expect(levenshtein("kitten", "sitting", 2)).toBe(3);
    expect(levenshtein("kitten", "sitting", 1)).toBe(2);
    expect(levenshtein("a", "abcdefgh", 1)).toBe(2); // length gap short-circuit
    expect(levenshtein("abcdefgh", "hgfedcba", 0)).toBe(1);
    expect(levenshtein("same", "same", 0)).toBe(0);
    expect(levenshtein("", "ab", 5)).toBe(2);
  });
});

describe("classifyGuess (SPEC §4 guess polls)", () => {
  const accept = ["Giraffe", "camelopard"];
  it.each([
    ["giraffe", "correct"],
    ["  GIRAFFE! ", "correct"],
    ["Camelopard", "correct"],
    ["girafe", "close"],
    ["giraffes", "close"],
    ["giraff", "close"],
    ["elephant", "wrong"],
    ["", "wrong"],
    ["!!!", "wrong"],
  ] as const)("%j → %s", (guess, expected) => {
    expect(classifyGuess(guess, accept)).toBe(expected);
  });

  it("near misses on words shorter than 5 letters are wrong, not close", () => {
    expect(classifyGuess("cats", ["cat"])).toBe("wrong");
    expect(classifyGuess("dig", ["dog"])).toBe("wrong");
    expect(classifyGuess("house", ["horse"])).toBe("close");
  });

  it("ignores empty accepted answers and prefers correct over close", () => {
    expect(classifyGuess("x", ["", "..."])).toBe("wrong");
    expect(classifyGuess("pizza", ["pizzas", "pizza"])).toBe("correct");
  });
});

describe("cleanUserText / cleanName", () => {
  it("strips control and bidi characters, collapses whitespace and trims", () => {
    expect(cleanUserText("  hi\n\tthere\u0000 ", 50)).toBe("hi there");
    expect(cleanUserText("abc‮def", 50)).toBe("abc def");
  });

  it("caps at grapheme clusters without splitting emoji or accents", () => {
    expect(cleanUserText("abcdefghijklmnopqrstuvwxyz", 16)).toBe("abcdefghijklmnop");
    const family = "👨‍👩‍👧‍👦";
    expect(cleanUserText(`${family}${family}${family}`, 2)).toBe(`${family}${family}`);
    expect(cleanUserText("ééé", 2)).toBe("éé");
    expect(cleanUserText("short", 16)).toBe("short");
    expect(cleanUserText("fifteen chars! x", 15)).toBe("fifteen chars!");
  });

  it("cleanName uses the 16-character name cap", () => {
    expect(NAME_MAX_LENGTH).toBe(16);
    expect(cleanName("  A Very Long Display Name Indeed ")).toBe("A Very Long Disp");
  });
});

describe("filterText (M0-02 accept: masks a known bad word in family mode)", () => {
  it("family mode masks a known bad word with asterisks", () => {
    const result = filterText("what the fuck is this", "family");
    expect(result.flagged).toBe(true);
    expect(result.text).toBe("what the **** is this");
    expect(result.text).not.toMatch(/fuck/i);
    expect(result.masked).toBe(result.text);
  });

  it("catches obfuscated variants (leetspeak, case, accents)", () => {
    for (const bad of ["sh1t happens", "FUCK", "Fück", "fuuuuck", "b1tch please"]) {
      const result = filterText(bad, "family");
      expect(result.flagged, bad).toBe(true);
      expect(result.text, bad).toContain("*");
    }
  });

  it("standard mode leaves the text as written but flags it for the Stage blur", () => {
    const result = filterText("what the fuck", "standard");
    expect(result).toEqual({ text: "what the fuck", flagged: true, masked: "what the ****" });
  });

  it("passes clean text untouched, including classic false positives", () => {
    for (const clean of [
      "Scunthorpe",
      "assassin",
      "classic",
      "grape",
      "cocktail hour",
      "skill yourself up",
      "",
    ]) {
      expect(filterText(clean, "family"), clean).toEqual({
        text: clean,
        flagged: false,
        masked: clean,
      });
    }
  });

  it("applies the house blocklist, including before punctuation", () => {
    expect(filterText("kys", "family").text).toBe("***");
    expect(filterText("just kys!", "family").flagged).toBe(true);
    expect(filterText("go kill yourself", "family").text).toBe("go *************");
    expect(hasProfanity("Kill Urself!")).toBe(true);
    expect(hasProfanity("skys are blue")).toBe(false);
  });

  it("createTextFilter adds literal extra terms", () => {
    const filter = createTextFilter({ extraTerms: ["  Blorp!  ", "", "?!", "[zz]|?"] });
    expect(filter.hasMatch("no blorp here")).toBe(true);
    expect(filter.hasMatch("Blorp!")).toBe(true);
    expect(filter.filter("BLORP", "family")).toEqual({
      text: "*****",
      flagged: true,
      masked: "*****",
    });
    expect(filter.hasMatch("zz")).toBe(true); // pattern metacharacters are not interpreted
    expect(filter.hasMatch("z")).toBe(false); // "[zz]" did not become an optional group
    expect(filter.hasMatch("fuck")).toBe(true); // still has the English dataset
    expect(hasProfanity("blorp")).toBe(false); // the default filter is unaffected
  });
});
