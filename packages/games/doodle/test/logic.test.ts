/**
 * DOD G3 rule tests for Doodle Guess mode (`docs/specs/doodle.md`): every Guess mode rule
 * (R1–R8) and test case (T1–T6, T9–T13) has a test named with its number, plus the edge cases.
 * Telephone mode (R9–R14, T7, T8, T13's `maxSteps`) is ROADMAP M5-01b.
 */
import { EMPTY_CONTENT, createTiming, type PollResult } from "@sg/engine";
import { fakeContent, simulateGame } from "@sg/engine/testing";
import { createRng, type AnyPack } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  BOT_STROKES,
  DECOY_GUESSES,
  DRAWER_CAP,
  MAX_POINTS,
  MAX_STROKES,
  TIER_LABELS,
  applyStroke,
  bestArtist,
  bot,
  buildDeck,
  checkPoints,
  clearDrawing,
  containsAnswer,
  createDoodle,
  drawerPoints,
  drawWord,
  gameResult,
  guesserPoints,
  hintSchedule,
  hintString,
  legalActions,
  logic,
  manifest,
  matchGuess,
  optionSpecs,
  parseAction,
  pollAccept,
  ranking,
  resolveRoomSettings,
  roundsFor,
  scribble,
  stripArticle,
  teamPoints,
  turnOrder,
  undoStroke,
  type DoodleState,
  type Drawing,
} from "../src/logic/index.ts";
import { DoodleDriver, scenarioContent, scenarioSeats, scenarios } from "../src/scenarios.ts";
import { CORE_PACK, CUSTOM_PACK, PRESETS, teamDoodle, testContent } from "./fixtures.ts";
import {
  DRAW_MS,
  WORDS,
  actFx,
  actx,
  ctxAt,
  drawing,
  effectsOf,
  fxNames,
  pv,
  stage,
  table,
  viewOf,
  viewers,
} from "./helpers.ts";

const empty = (): Drawing => ({ strokes: [], points: 0 });
const stroke = (id: string, n = 4, c = 0, s = 1, done = true) => ({
  type: "stroke" as const,
  id,
  c,
  s,
  pts: Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? 100 + i : 200 + i)),
  done,
});

// ---- R1 ---------------------------------------------------------------------------------------

describe("R1 rounds and turn order", () => {
  it("R1: one drawing turn per player per round, in seat order", () => {
    const d = table({ options: { rounds: "3" } });
    expect(d.state.order).toEqual([
      ...["p1", "p2", "p3", "p4", "p5"],
      ...["p1", "p2", "p3", "p4", "p5"],
      ...["p1", "p2", "p3", "p4", "p5"],
    ]);
    expect(d.state.rounds).toBe(3);
    expect(d.state.turnsPerRound).toBe(5);
  });

  it("R1: turns follow the order through the game, round numbers count up", () => {
    const d = table({ players: 3, options: { audiencePicksTier: false } }).skipIntro();
    const seen: string[] = [];
    const rounds: number[] = [];
    while (d.state.phase !== "final") {
      if (d.state.phase === "word-pick") {
        seen.push(d.state.drawer ?? "?");
        rounds.push(d.state.round);
      }
      d.toDeadline();
    }
    expect(seen).toEqual(["p1", "p2", "p3", "p1", "p2", "p3"]);
    expect(rounds).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("R1: auto means 2 rounds for 3–4 players and 1 round for 5 or more", () => {
    expect([3, 4, 5, 8, 12].map((n) => roundsFor("auto", n))).toEqual([2, 2, 1, 1, 1]);
    expect(roundsFor("3", 12)).toBe(3);
    expect(table({ players: 4 }).state.order).toHaveLength(8);
    expect(table({ players: 12 }).state.order).toHaveLength(12);
  });
});

// ---- R2 ---------------------------------------------------------------------------------------

describe("R2 word choice", () => {
  it("R2: the drawer is offered one easy, one medium and one hard word, and only the drawer sees them", () => {
    const d = table({ options: { audiencePicksTier: false } }).skipIntro();
    const choices = pv(d, "p1").you?.choices;
    expect(choices?.map((c) => c.tier)).toEqual([1, 2, 3]);
    expect(choices?.map((c) => c.w)).toEqual(["kitten", "ice cream", "haunted house"]);
    for (const v of viewers(d.state)) {
      if (v.role === "player" && v.id === "p1") continue;
      const text = JSON.stringify(viewOf(d, v));
      for (const w of ["kitten", "ice cream", "haunted house"]) expect(text).not.toContain(w);
    }
  });

  it("R2: no word repeats within the session (earlier games and this one)", () => {
    const content = fakeContent([CORE_PACK], { used: { "doodle-words": ["amber walrus"] } });
    const d = new DoodleDriver({
      seed: 3,
      players: 12,
      options: { rounds: "3", audiencePicksTier: false },
      content,
    }).skipIntro();
    const offered: string[] = [];
    while (d.state.phase !== "final") {
      if (d.state.phase === "word-pick") {
        offered.push(...(d.state.hidden.wordChoices?.words.map((w) => w.w) ?? []));
      }
      d.toDeadline();
    }
    expect(offered).toHaveLength(36 * 3);
    expect(new Set(offered).size).toBe(offered.length);
    expect(offered).not.toContain("amber walrus");
    expect(new Set(d.state.hidden.usedWords).size).toBe(d.state.hidden.usedWords.length);
  });

  it("R2: the audience tier vote shows tier names only and runs for timing.input(8000)", () => {
    const d = table();
    const res = d.runner.advance((d.now = d.state.deadline ?? 0));
    const open = effectsOf(res.effects, "audience.open");
    expect(open).toHaveLength(1);
    const poll = open[0]?.poll;
    expect(poll?.kind).toBe("vote");
    expect(poll?.options?.map((o) => o.label)).toEqual([
      TIER_LABELS[1],
      TIER_LABELS[2],
      TIER_LABELS[3],
    ]);
    expect(poll?.closesAtMs).toBe(d.now + 11_000);
    expect(JSON.stringify(poll)).not.toContain("kitten");
    expect(stage(d).tierVote?.options.map((o) => o.label)).toEqual([
      "Easy 🌱",
      "Medium 🌿",
      "HARD 🌵",
    ]);
    expect(pv(d, "p1").you?.choices).toBeNull(); // "Chat is picking your word"
  });

  it("R2: the drawer gets the word of the winning tier and the Stage shows chat's choice", () => {
    const d = drawing(3);
    expect(d.word).toBe("haunted house");
    expect(stage(d).tier).toEqual({ tier: 3, by: "audience", hard: true });
    expect(pv(d, "p1").you?.word?.w).toBe("haunted house");
    const medium = drawing(2);
    expect(medium.word).toBe("ice cream");
    expect(stage(medium).tier).toEqual({ tier: 2, by: "audience", hard: false });
  });

  it("R2: otherwise the drawer picks within 12 s, and at the timeout a random word is chosen", () => {
    const d = table({ audience: 2 }).skipIntro();
    expect(d.state.picker).toBe("drawer");
    expect(d.state.deadline).toBe(d.now + 15_000);
    d.toDeadline();
    expect(d.state.phase).toBe("draw");
    expect(d.state.tier?.by).toBe("random");
    expect(WORDS.map((w) => w.w)).toContain(d.word);

    const picked = table({ audience: 2 }).skipIntro().pick(1);
    expect(picked.word).toBe("ice cream");
    expect(picked.state.tier).toEqual({ tier: 2, by: "drawer", hard: false });
  });

  it("R2: only the drawer may pick, and only while picking", () => {
    const d = table({ audience: 2 }).skipIntro();
    expect(actFx(d, "p2", { type: "pickWord", idx: 0 }).ok).toBe(false);
    const voting = table().skipIntro();
    expect(actFx(voting, "p1", { type: "pickWord", idx: 0 }).ok).toBe(false);
  });

  it("R2: custom words have no tier, so the tier vote is skipped for them", () => {
    const d = new DoodleDriver({
      seed: 5,
      players: 4,
      options: { customWords: "only", packs: ["custom-host"] },
      content: testContent(),
    }).skipIntro();
    expect(d.state.picker).toBe("drawer");
    expect(d.state.tierPoll).toBeNull();
    expect(pv(d, "p1").you?.choices?.every((c) => c.tier === 0)).toBe(true);
    d.pick(2);
    expect(d.state.tier).toEqual({ tier: 0, by: "drawer", hard: false });
    expect(CUSTOM_PACK.items.map((i) => (i as { w: string }).w)).toContain(d.word);
  });

  it("R2: customWords mix alternates custom turns (drawer pick) and tiered turns (tier vote)", () => {
    const d = new DoodleDriver({
      seed: 8,
      players: 12,
      options: { customWords: "mix", packs: ["doodle-core", "custom-host"], rounds: "2" },
      content: testContent(),
    }).skipIntro();
    let custom = 0;
    let tiered = 0;
    while (d.state.phase !== "final") {
      if (d.state.phase === "word-pick") {
        if (d.state.hidden.wordChoices?.words[0]?.tier === 0) {
          custom++;
          expect(d.state.picker).toBe("drawer");
        } else {
          tiered++;
          expect(d.state.picker).toBe("audience");
        }
      }
      d.toDeadline(d.state.phase === "word-pick" && d.state.picker === "audience" ? 2_000 : 0);
    }
    expect(custom).toBeGreaterThan(3);
    expect(tiered).toBeGreaterThan(3);
  });

  it("R2: customWords off ignores custom packs; the kids pack auto-selects in family mode", () => {
    const kids: AnyPack = {
      id: "doodle-kids",
      kind: "doodle-words",
      name: "Kids",
      lang: "en",
      rating: "all",
      version: 1,
      items: [{ w: "bouncy puppy", d: 1 }],
    };
    const content = fakeContent([CORE_PACK, CUSTOM_PACK, kids]);
    const opts = {
      packs: ["doodle-core", "custom-host"],
      customWords: "off" as const,
      perTier: 50,
      custom: 0,
    };
    const standard = buildDeck(content, { ...opts, family: false }, createRng(1));
    expect(standard[0]).toEqual([]);
    expect(standard[1].map((w) => w.w)).not.toContain("bouncy puppy");
    const family = buildDeck(content, { ...opts, family: true }, createRng(1));
    expect(family[1].map((w) => w.w)).toContain("bouncy puppy");
    const kidsOnly = fakeContent([kids]);
    const d = new DoodleDriver({
      seed: 1,
      players: 3,
      content: kidsOnly,
      room: { contentFilter: "family" },
    });
    expect(d.state.hidden.deck[1][0]?.w).toBe("bouncy puppy");
    const std = new DoodleDriver({ seed: 1, players: 3, content: kidsOnly });
    expect(std.state.hidden.deck[1].map((w) => w.w)).not.toContain("bouncy puppy");
  });

  it("R2: the word is never shown on the Stage before the reveal (then it is)", () => {
    const d = drawing(1);
    expect(JSON.stringify(stage(d))).not.toContain("kitten");
    d.toDeadline();
    expect(d.state.phase).toBe("reveal");
    expect(stage(d).reveal?.word).toBe("kitten");
  });

  it("R2: short tiers borrow from neighbours, then fall back to built-in words", () => {
    const deck = buildDeck(
      EMPTY_CONTENT,
      { packs: ["doodle-core"], customWords: "off", family: false, perTier: 3, custom: 0 },
      createRng(2),
    );
    expect(deck[1]).toHaveLength(3);
    const dry: DoodleState["hidden"]["deck"] = [[], [], [{ w: "yurt", alt: [], tier: 2 }], []];
    expect(drawWord(dry, 1, [], createRng(1)).w).toBe("yurt");
    const fallback = drawWord(dry, 3, ["yurt"], createRng(1));
    expect(fallback.tier).toBe(3);
  });
});

// ---- R3 ---------------------------------------------------------------------------------------

describe("R3 draw and hints", () => {
  it("R3: the draw deadline is timing.input(drawSec × 1000): 73 s at the defaults", () => {
    const d = drawing(1);
    expect(d.state.deadline).toBe(d.state.drawStart + DRAW_MS);
    const long = drawing(1, { options: { drawSec: 150 } });
    expect(long.state.drawTotal).toBe(153_000);
  });

  it("R3: blanks are shown from the start; spaces and hyphens are always visible", () => {
    expect(stage(drawing(1)).hint).toBe("_ _ _ _ _ _");
    expect(stage(drawing(2)).hint).toBe("_ _ _   _ _ _ _ _");
    expect(hintString("jack-in-the-box", [])).toBe("_ _ _ _ - _ _ - _ _ _ - _ _ _");
    expect(hintString("ice cream", [0, 4])).toBe("i _ _   c _ _ _ _");
  });

  it("R3: with hints off, the blanks stay and no letter is revealed", () => {
    const d = drawing(1, { options: { hints: false } });
    d.toDrawShare(0.9);
    expect(stage(d).hint).toBe("_ _ _ _ _ _");
  });
});

describe("T2 hint schedule", () => {
  it("T2: letters are revealed at 50% and 75% only, never spaces", () => {
    const d = drawing(2);
    d.toDrawShare(0.49);
    expect(stage(d).hint).toBe("_ _ _   _ _ _ _ _");
    d.toDrawShare(0.5);
    const at50 = stage(d).hint ?? "";
    expect(at50.split("").filter((ch) => /[a-z]/.test(ch))).toHaveLength(1);
    d.toDrawShare(0.74);
    expect(stage(d).hint).toBe(at50);
    d.toDrawShare(0.75);
    const at75 = stage(d).hint ?? "";
    expect(at75.split("").filter((ch) => /[a-z]/.test(ch))).toHaveLength(2);
    expect(at75.slice(5, 8)).toBe("   "); // the space between the words stays a space
    d.toDrawShare(0.99);
    expect(stage(d).hint).toBe(at75);
  });

  it("T2: a word of 3 letters or fewer gets only the 75% hint", () => {
    expect(hintSchedule(3)).toEqual([0.75]);
    expect(hintSchedule(2)).toEqual([0.75]);
    expect(hintSchedule(1)).toEqual([]);
    expect(hintSchedule(4)).toEqual([0.5, 0.75]);
    const d = new DoodleDriver({
      seed: 4,
      players: 3,
      content: scenarioContent([{ w: "owl", d: 1 }]),
    })
      .skipIntro()
      .voteTier([50, 0, 0]);
    expect(d.word).toBe("owl");
    d.toDrawShare(0.6);
    expect(stage(d).hint).toBe("_ _ _");
    d.toDrawShare(0.75);
    expect((stage(d).hint ?? "").split(" ").filter((t) => t !== "_" && t !== "")).toHaveLength(1);
  });
});

// ---- R4, T1 -----------------------------------------------------------------------------------

describe("T1 matching", () => {
  const word = { w: "kitten", alt: ["cat", "kitty"] };
  const table1: [string, "correct" | "close" | "wrong"][] = [
    ["kitten", "correct"],
    ["KITTEN", "correct"],
    ["  Kitten!! ", "correct"],
    ["kittén", "correct"],
    ["a kitten", "correct"],
    ["the kitten", "correct"],
    ["an kitty", "correct"],
    ["cat", "correct"],
    ["the cat", "correct"],
    ["the the kitten", "wrong"],
    ["kiten", "close"],
    ["kittens", "close"],
    ["a kittens", "close"],
    ["cats", "wrong"], // "cat" has fewer than 5 letters: no close
    ["dog", "wrong"],
    ["", "wrong"],
    ["!!!", "wrong"],
  ];
  for (const [guess, want] of table1) {
    it(`T1: "${guess}" is ${want}`, () => {
      expect(matchGuess(guess, word)).toBe(want);
    });
  }

  it("T1: a multi-word spam guess containing the word is not correct", () => {
    expect(matchGuess("cat dog fish bird house kitten", word)).toBe("wrong");
    expect(containsAnswer("cat dog fish bird house", word)).toBe(true);
    const d = drawing(1);
    const r = actFx(d, "p2", { type: "guess", text: "cat dog fish bird house" });
    expect(r.ok).toBe(true);
    expect(d.state.correct).toEqual({});
    expect(d.state.feed).toEqual([]); // never printed on stream
    expect(effectsOf(r.effects, "private")).toEqual([
      { type: "private", to: "p2", name: "hidden" },
    ]);
  });

  it("T1: words with spaces, hyphens, case and accents match after normalization", () => {
    const ice = { w: "ice cream", alt: ["ice-cream cone"] };
    expect(matchGuess("ICE   CREAM", ice)).toBe("correct");
    expect(matchGuess("ice-cream", ice)).toBe("correct");
    expect(matchGuess("Ice Cream Cone", ice)).toBe("correct");
    expect(matchGuess("icecream", ice)).toBe("close");
    expect(matchGuess("the moon", { w: "moon", alt: [] })).toBe("correct");
    expect(matchGuess("moon", { w: "the moon", alt: [] })).toBe("correct");
    expect(stripArticle("an apple")).toBe("apple");
    expect(stripArticle("the")).toBe("the");
  });

  it("T1: the audience guess poll accepts the word, its alts and their article forms", () => {
    const accept = pollAccept(word);
    for (const a of ["kitten", "cat", "kitty", "a kitten", "the cat", "an kitty"]) {
      expect(accept).toContain(a);
    }
  });
});

describe("R4 guesses", () => {
  it("R4: a guess is 1–32 characters", () => {
    const d = drawing(1);
    expect(actFx(d, "p2", { type: "guess", text: "x".repeat(33) }).ok).toBe(false);
    expect(actFx(d, "p2", { type: "guess", text: "   " }).ok).toBe(false);
    expect(actFx(d, "p2", { type: "guess", text: "y".repeat(32) }).ok).toBe(true);
  });

  it("R4: guesses are rate-limited to one per 800 ms per player", () => {
    const d = drawing(1);
    expect(actFx(d, "p2", { type: "guess", text: "dog" }, 100).ok).toBe(true);
    expect(actFx(d, "p2", { type: "guess", text: "cow" }, 799).ok).toBe(false);
    expect(actFx(d, "p3", { type: "guess", text: "cow" }, 0).ok).toBe(true);
    expect(actFx(d, "p2", { type: "guess", text: "cow" }, 1).ok).toBe(true);
  });

  it("R4: a close guess gets a private So close! and stays off the feed", () => {
    const d = drawing(1);
    const r = actFx(d, "p2", { type: "guess", text: "kiten" });
    expect(effectsOf(r.effects, "private")).toEqual([
      { type: "private", to: "p2", name: "close", data: { text: "kiten" } },
    ]);
    expect(d.state.feed).toEqual([]);
  });

  it("R4: incorrect guesses appear in the feed after filterText (standard flags, family masks)", () => {
    const d = drawing(1);
    d.guess("p2", "a puppy");
    d.guess("p3", "shit dog");
    expect(d.state.feed[0]).toEqual({ by: "p2", text: "a puppy" });
    expect(d.state.feed[1]).toEqual({ by: "p3", text: "shit dog", flagged: true });
    const fam = drawing(1, { room: { contentFilter: "family" } });
    fam.guess("p3", "shit dog");
    expect(fam.state.feed[0]?.text).toBe("**** dog");
    expect(fam.state.feed[0]?.flagged).toBeUndefined();
  });

  it("R4: a correct guess shows as got it and never reveals its text", () => {
    const d = drawing(1);
    const r = actFx(d, "p2", { type: "guess", text: "Kitty!" });
    expect(d.state.feed).toEqual([{ by: "p2", correct: true }]);
    expect(fxNames(r.effects)).toContain("correct");
    for (const v of viewers(d.state)) {
      expect(JSON.stringify(viewOf(d, v))).not.toContain("Kitty!");
    }
  });

  it("R4: a correct guesser's messages reach only the other correct guessers and the drawer", () => {
    const d = drawing(1);
    d.guess("p2", "kitten").guess("p3", "kitten").guess("p2", "so fluffy");
    expect(d.state.feed.at(-1)).toEqual({ by: "p2", text: "so fluffy", insider: true });
    const sees = (id: string): boolean => pv(d, id).feed.some((f) => f.text === "so fluffy");
    expect(sees("p1")).toBe(true);
    expect(sees("p3")).toBe(true);
    expect(sees("p4")).toBe(false);
    expect(stage(d).feed.some((f) => f.text === "so fluffy")).toBe(false);
    expect(viewOf(d, { role: "audience" }).feed.some((f) => f.insider === true)).toBe(false);
    // A correct guesser typing the word again is not printed even to insiders.
    const r = actFx(d, "p2", { type: "guess", text: "it was a kitten" });
    expect(effectsOf(r.effects, "private")[0]?.name).toBe("hidden");
    expect(d.state.feed.some((f) => f.text === "it was a kitten")).toBe(false);
  });

  it("R4: the drawer cannot guess, and nobody guesses outside the draw phase", () => {
    const d = drawing(1);
    expect(actFx(d, "p1", { type: "guess", text: "kitten" }).ok).toBe(false);
    const pick = table().skipIntro();
    expect(actFx(pick, "p2", { type: "guess", text: "kitten" }).ok).toBe(false);
  });

  it("R4: the feed keeps the last 30 entries", () => {
    const d = drawing(1);
    for (let i = 0; i < 40; i++) d.guess(`p${2 + (i % 4)}`, `guess ${i}`, 300);
    expect(d.state.feed).toHaveLength(30);
    expect(d.state.feed.at(-1)?.text).toBe("guess 39");
  });
});

// ---- R5, T3, T12 ------------------------------------------------------------------------------

describe("R5 scoring", () => {
  it("R5: a correct guesser scores 100 + round(200 × remaining / total), the first +50", () => {
    const d = drawing(1);
    d.toDrawShare(0.5);
    d.guess("p2", "kitten", 0);
    expect(d.state.correct["p2"]).toBe(250);
    d.toDrawShare(0.75);
    d.guess("p3", "kitten", 0);
    expect(d.state.correct["p3"]).toBe(150);
    expect(d.state.scores["p2"]).toBe(250);
  });

  it("R5: the turn ends when every guesser is correct; the reveal paces 4000 ms", () => {
    const d = drawing(1);
    for (const id of ["p2", "p3", "p4", "p5"]) d.guess(id, "kitten");
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("all-correct");
    expect(d.state.deadline).toBe(d.now + 4_000);
    expect(d.state.reveal?.points["p1"]).toBe(240); // drawer: 4 × 60
    d.toDeadline();
    expect(d.state.phase).toBe("word-pick");
    expect(d.state.drawer).toBe("p2");
  });

  it("R5: otherwise the turn ends at the deadline", () => {
    const d = drawing(1);
    d.guess("p2", "kitten");
    d.toDeadline();
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("time");
    expect(d.state.reveal?.points).toEqual({ p2: d.state.scores["p2"], p1: 60 });
  });
});

describe("T3 scoring", () => {
  it("T3: guesser points scale with the remaining time", () => {
    expect(guesserPoints(73_000, 73_000, false, false)).toBe(300);
    expect(guesserPoints(36_500, 73_000, false, false)).toBe(200);
    expect(guesserPoints(0, 73_000, false, false)).toBe(100);
    expect(guesserPoints(-5, 73_000, true, false)).toBe(150);
    expect(guesserPoints(99_999, 73_000, true, false)).toBe(350);
    expect(guesserPoints(10, 0, false, false)).toBe(300);
  });

  it("T3: the drawer scores 60 per correct guesser, capped at 360", () => {
    expect([0, 1, 5, 6, 7, 11].map((n) => drawerPoints(n, false))).toEqual([
      0, 60, 300, 360, 360, 360,
    ]);
    expect(DRAWER_CAP).toBe(360);
    const d = drawing(1, { players: 12 });
    for (let i = 2; i <= 12; i++) d.guess(`p${i}`, "kitten", 200);
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.points["p1"]).toBe(360);
  });
});

describe("T12 tier vote", () => {
  it("T12: the drawer gets the word of the winning tier; ties are broken by the rng", () => {
    expect(drawing(1).word).toBe("kitten");
    expect(drawing(2).word).toBe("ice cream");
    const tie = table().skipIntro().voteTier([30, 30, 0]);
    expect(["kitten", "ice cream"]).toContain(tie.word);
  });

  it("T12: an audience HARD turn gives guessers and the drawer ×1.25", () => {
    const d = drawing(3);
    d.toDrawShare(0.5);
    d.guess("p2", "haunted house", 0);
    expect(d.state.correct["p2"]).toBe(313); // round(250 × 1.25)
    d.toDeadline();
    expect(d.state.reveal?.points["p1"]).toBe(75);
    // The drawer choosing HARD themselves gets no bonus.
    const own = table({ audience: 0 }).skipIntro().pick(2);
    own.toDrawShare(0.5);
    own.guess("p2", "haunted house", 0);
    expect(own.state.correct["p2"]).toBe(250);
  });

  it("T12: below audienceMin the vote does not count and the drawer picks", () => {
    const d = table().skipIntro().voteTier([0, 1, 3]);
    expect(d.state.phase).toBe("word-pick");
    expect(d.state.picker).toBe("drawer");
    expect(pv(d, "p1").you?.choices).toHaveLength(3);
    d.pick(2);
    expect(d.state.tier).toEqual({ tier: 3, by: "drawer", hard: false });
    const pinned = new DoodleDriver({
      seed: 1,
      players: 3,
      audience: 40,
      content: scenarioContent(WORDS),
      room: { audienceMin: 50 },
    }).skipIntro();
    expect(pinned.state.picker).toBe("drawer");
  });

  it("T12: a tier vote whose result never arrives picks a random word after the grace", () => {
    const d = table().skipIntro();
    d.wait(11_000 + 1_999);
    expect(d.state.phase).toBe("word-pick");
    d.wait(1);
    expect(d.state.phase).toBe("draw");
    expect(d.state.tier?.by).toBe("random");
    expect(d.state.tier?.hard).toBe(false);
  });
});

// ---- R6, T4 -----------------------------------------------------------------------------------

describe("R6 report", () => {
  it("R6: guessers can report once per turn; the drawer cannot", () => {
    const d = drawing(1);
    expect(actFx(d, "p1", { type: "report" }).ok).toBe(false);
    expect(actFx(d, "p2", { type: "report" }).ok).toBe(true);
    expect(actFx(d, "p2", { type: "report" }).ok).toBe(false);
    expect(pv(d, "p2").you?.reported).toBe(true);
    expect(stage(d).reports).toBe(1);
  });

  it("R6: the host can skip the drawing (skipItem) from the dock", () => {
    const d = drawing(1);
    d.guess("p2", "kitten");
    const itemId = viewOf(d, { role: "host" }).host?.itemId ?? "";
    expect(itemId).toBe("turn-0");
    d.runner.hostCommand({ c: "skipItem", itemId: "turn-9" }, (d.now += 100));
    expect(d.state.phase).toBe("draw");
    d.runner.hostCommand({ c: "skipItem", itemId }, (d.now += 100));
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.skipped).toBe(true);
    expect(d.state.reveal?.reason).toBe("host-skip");
    expect(d.state.drawing).toEqual({ strokes: [], points: 0, skipped: true });
    expect(d.state.scores["p1"]).toBe(0);
  });
});

describe("T4 report threshold", () => {
  it("T4: 50% or more of the connected guessers reporting skips the turn; the drawer scores 0", () => {
    const d = drawing(1);
    d.draw([{ c: 0, s: 1, pts: [10, 10, 20, 20] }]);
    d.guess("p2", "kitten");
    d.act("p3", { type: "report" });
    expect(d.state.phase).toBe("draw");
    const r = actFx(d, "p4", { type: "report" });
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("report");
    expect(d.state.reveal?.skipped).toBe(true);
    expect(fxNames(r.effects)).toContain("skipped");
    expect(d.state.scores["p1"]).toBe(0);
    expect(d.state.scores["p2"]).toBeGreaterThan(0); // correct guessers keep their points
    expect(d.state.gallery).toEqual([]);
    expect(d.state.history[0]).toMatchObject({ skipped: true, correct: 1 });
  });

  it("T4: disconnected guessers do not count toward the threshold", () => {
    const d = drawing(1);
    d.runner.playerLeave("p5", (d.now += 100));
    d.runner.playerLeave("p4", (d.now += 100));
    d.act("p2", { type: "report" });
    expect(d.state.phase).toBe("reveal");
  });
});

// ---- T5, T6 -----------------------------------------------------------------------------------

describe("T5 stroke validation", () => {
  it("T5: out-of-range, fractional and odd point lists are rejected", () => {
    expect(checkPoints([0, 0, 1023, 767])).toBeNull();
    expect(checkPoints([1024, 0])).toBe("bad-points");
    expect(checkPoints([0, 768])).toBe("bad-points");
    expect(checkPoints([-1, 0])).toBe("bad-points");
    expect(checkPoints([1.5, 2])).toBe("bad-points");
    expect(checkPoints([1, 2, 3])).toBe("bad-points");
    expect(checkPoints([])).toBe("bad-points");
  });

  it("T5: more than 128 points per batch is rejected", () => {
    const pts = (n: number) => Array.from({ length: n * 2 }, () => 5);
    expect(checkPoints(pts(128))).toBeNull();
    expect(checkPoints(pts(129))).toBe("batch-too-big");
    const d = drawing(1);
    expect(
      actFx(d, "p1", { type: "stroke", id: "a", c: 0, s: 0, pts: pts(129), done: true }).ok,
    ).toBe(false);
    expect(
      actFx(d, "p1", { type: "stroke", id: "a", c: 0, s: 0, pts: pts(128), done: true }).ok,
    ).toBe(true);
  });

  it("T5: bad colour, size and id are rejected; continuing batches must match", () => {
    const base = empty();
    expect(applyStroke(base, { id: "x", c: 12, s: 0, pts: [1, 1], done: true })).toEqual({
      error: "bad-color",
    });
    expect(applyStroke(base, { id: "x", c: 0, s: 4, pts: [1, 1], done: true })).toEqual({
      error: "bad-size",
    });
    expect(applyStroke(base, { id: "bad id", c: 0, s: 0, pts: [1, 1], done: true })).toEqual({
      error: "bad-id",
    });
    const open = applyStroke(base, { id: "x", c: 1, s: 2, pts: [1, 1], done: false });
    if (!("drawing" in open)) throw new Error("expected a drawing");
    expect(applyStroke(open.drawing, { id: "x", c: 2, s: 2, pts: [2, 2], done: true })).toEqual({
      error: "stroke-mismatch",
    });
    const cont = applyStroke(open.drawing, { id: "x", c: 1, s: 2, pts: [2, 2, 3, 3], done: true });
    if (!("drawing" in cont)) throw new Error("expected a drawing");
    expect(cont.drawing.strokes).toEqual([
      { id: "x", c: 1, s: 2, pts: [1, 1, 2, 2, 3, 3], done: true },
    ]);
    expect(cont.drawing.points).toBe(3);
    expect(applyStroke(cont.drawing, { id: "x", c: 1, s: 2, pts: [4, 4], done: true })).toEqual({
      error: "stroke-closed",
    });
    // A new id closes an open stroke; an old id cannot come back.
    const a = applyStroke(base, { id: "a", c: 0, s: 0, pts: [1, 1], done: false });
    if (!("drawing" in a)) throw new Error("expected a drawing");
    const b = applyStroke(a.drawing, { id: "b", c: 0, s: 0, pts: [2, 2], done: true });
    if (!("drawing" in b)) throw new Error("expected a drawing");
    expect(b.drawing.strokes[0]?.done).toBe(true);
    expect(applyStroke(b.drawing, { id: "a", c: 0, s: 0, pts: [3, 3], done: true })).toEqual({
      error: "stroke-closed",
    });
  });

  it("T5: the 20,000-point cap rejects further strokes (Page full!) while undo still works", () => {
    const d = drawing(1, { options: { drawSec: 150 } });
    const full = Array.from({ length: 256 }, (_, i) => (i % 2 === 0 ? 300 : 400));
    for (let i = 0; i < 156; i++) {
      d.act("p1", { type: "stroke", id: `f${i}`, c: 0, s: 0, pts: full, done: true }, 1);
    }
    d.act("p1", { type: "stroke", id: "last", c: 0, s: 0, pts: full.slice(0, 64), done: true }, 1);
    expect(d.state.drawing.points).toBe(MAX_POINTS);
    expect(pv(d, "p1").you?.pageFull).toBe(true);
    const r = actFx(
      d,
      "p1",
      { type: "stroke", id: "more", c: 0, s: 0, pts: [1, 1], done: true },
      1,
    );
    expect(r.ok).toBe(false);
    expect(effectsOf(r.effects, "fx")[0]?.data).toEqual({ reason: "page-full" });
    d.act("p1", { type: "undo" }, 1);
    expect(d.state.drawing.points).toBe(MAX_POINTS - 32);
    expect(pv(d, "p1").you?.pageFull).toBe(false);
    expect(
      actFx(
        d,
        "p1",
        { type: "stroke", id: "fits", c: 0, s: 0, pts: full.slice(0, 64), done: true },
        1,
      ).ok,
    ).toBe(true);
    expect(
      actFx(
        d,
        "p1",
        { type: "stroke", id: "over", c: 0, s: 0, pts: full.slice(0, 64), done: true },
        1,
      ).ok,
    ).toBe(false);
  });

  it("T5: the 600-stroke cap rejects a new stroke", () => {
    let drawing: Drawing = empty();
    for (let i = 0; i < MAX_STROKES; i++) {
      const r = applyStroke(drawing, { id: `s${i}`, c: 0, s: 0, pts: [i % 1000, 1], done: true });
      if (!("drawing" in r)) throw new Error(`stroke ${i} refused`);
      drawing = r.drawing;
    }
    expect(applyStroke(drawing, { id: "s600", c: 0, s: 0, pts: [1, 1], done: true })).toEqual({
      error: "page-full",
    });
  });

  it("T5: only the drawer draws, and only in the draw phase", () => {
    const d = drawing(1);
    expect(actFx(d, "p2", stroke("z")).ok).toBe(false);
    const pick = table({ audience: 0 }).skipIntro();
    expect(actFx(pick, "p1", stroke("z")).ok).toBe(false);
  });
});

describe("T6 undo and clear", () => {
  it("T6: undo removes the last stroke and frees its points", () => {
    const d = drawing(1);
    d.act("p1", stroke("a", 3)).act("p1", stroke("b", 5));
    d.act("p1", { type: "undo" });
    expect(d.state.drawing.strokes.map((s) => s.id)).toEqual(["a"]);
    expect(d.state.drawing.points).toBe(3);
    d.act("p1", { type: "undo" });
    expect(d.state.drawing).toEqual({ strokes: [], points: 0 });
    expect(actFx(d, "p1", { type: "undo" }).ok).toBe(false);
    expect(undoStroke(empty())).toBeNull();
  });

  it("T6: clear removes every stroke; clearing an empty page is refused", () => {
    const d = drawing(1);
    d.act("p1", stroke("a", 3)).act("p1", stroke("b", 5)).act("p1", { type: "clear" });
    expect(d.state.drawing).toEqual({ strokes: [], points: 0 });
    expect(actFx(d, "p1", { type: "clear" }).ok).toBe(false);
    expect(clearDrawing(empty())).toBeNull();
    // Ids are free again after a clear.
    expect(actFx(d, "p1", stroke("a", 2)).ok).toBe(true);
  });
});

// ---- R7, T10 ----------------------------------------------------------------------------------

function teamTable(players = 4, options = {}): DoodleDriver {
  return new DoodleDriver({
    seed: 21,
    players: scenarioSeats(players, ["tomato", "sky"]),
    content: scenarioContent(WORDS),
    options,
  });
}

describe("R7 Team Doodle", () => {
  it("R7: teams alternate turns with one drawer per team turn, each team cycling its members", () => {
    const d = teamTable(4);
    expect(d.state.teams.map((t) => t.id)).toEqual(["tomato", "sky"]);
    expect(d.state.order).toEqual(["p1", "p2", "p3", "p4", "p1", "p2", "p3", "p4"]);
    expect(d.state.teamOrder).toEqual([
      "tomato",
      "sky",
      "tomato",
      "sky",
      "tomato",
      "sky",
      "tomato",
      "sky",
    ]);
    expect(Object.keys(d.state.scores).sort()).toEqual(["sky", "tomato"]);
    const uneven = turnOrder(teamTable(5).state.players, teamTable(5).state.teams, 1);
    expect(uneven.order).toEqual(["p1", "p2", "p3", "p4", "p5", "p2"]);
    expect(uneven.perRound).toBe(6);
  });

  it("R7: a correct team guess scores 200 + round(300 × remaining / total) and ends the turn", () => {
    const d = teamTable(4).skipIntro().voteTier([90, 5, 5]);
    d.toDrawShare(0.5);
    d.guess("p3", "kitten", 0);
    expect(d.state.scores["tomato"]).toBe(350);
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("team-scored");
    expect(d.state.reveal?.points).toEqual({ tomato: 350 });
    expect(teamPoints(0, 100, true)).toBe(250);
  });

  it("R7: teams need at least two teams with every seat assigned", () => {
    const one = new DoodleDriver({
      seed: 1,
      players: scenarioSeats(4, ["tomato"]),
      content: scenarioContent(WORDS),
    });
    expect(one.state.teams).toEqual([]);
    expect(Object.keys(one.state.scores)).toHaveLength(4);
  });
});

describe("T10 steal window", () => {
  it("T10: only the drawing team guesses for the first 60%; then the other team can steal", () => {
    const d = teamTable(4).skipIntro().voteTier([90, 5, 5]);
    expect(pv(d, "p2").you?.canGuess).toBe(false);
    expect(legalActions(d.state, "p2").map((a) => a.type)).toEqual(["report"]);
    expect(actFx(d, "p2", { type: "guess", text: "kitten" }).ok).toBe(false);
    d.toDrawShare(0.59);
    expect(actFx(d, "p4", { type: "guess", text: "dog" }, 0).ok).toBe(false);
    d.toDrawShare(0.6);
    expect(d.state.stealOpen).toBe(true);
    expect(stage(d).stealOpen).toBe(true);
    d.guess("p2", "kitten", 0);
    expect(d.state.scores["sky"]).toBe(320);
    expect(d.state.scores["tomato"]).toBe(0);
  });
});

// ---- R8 ---------------------------------------------------------------------------------------

describe("R8 end", () => {
  it("R8: ranking by score with ties sharing the place", () => {
    expect(ranking(["a", "b", "c", "d"], { a: 10, b: 20, c: 10, d: 5 })).toEqual([
      { id: "b", score: 20, place: 1 },
      { id: "a", score: 10, place: 2 },
      { id: "c", score: 10, place: 2 },
      { id: "d", score: 5, place: 4 },
    ]);
  });

  it("R8: Best Artist goes to the player whose drawings got the most correct guessers", () => {
    const players = scenarioSeats(3).map((s) => ({ ...s, connected: true }));
    expect(bestArtist(players, { p1: 1, p2: 3, p3: 3 }, { p2: 10, p3: 20 })).toBe("p3");
    expect(bestArtist(players, { p1: 2, p2: 1 }, {})).toBe("p1");
    expect(bestArtist(players, {}, {})).toBeNull();
  });

  it("R8: the game ends with a final podium, a gallery strip and the result", () => {
    const final = scenarios["final"]?.build({
      seed: 2,
      rng: createRng(2),
      players: 5,
      role: "stage",
    });
    const state = final?.state as DoodleState;
    expect(state.phase).toBe("final");
    const view = logic.view(state, { role: "stage" });
    expect(view.final?.gallery.length).toBe(5);
    expect(view.final?.bestArtist).not.toBeNull();
    const result = gameResult(state);
    expect(result.ranking).toHaveLength(5);
    expect(result.highlights?.[0]?.label).toBe("Best Artist");
    const step = logic.onTimer?.(state, "phase", ctxAt((state.deadline ?? 0) + 1));
    const end = effectsOf(step?.effects, "end");
    expect(end).toHaveLength(1);
    expect(end[0]?.result).toEqual(result);
  });

  it("R8: the gallery keeps the 8 best-guessed drawings, in turn order", () => {
    const d = new DoodleDriver({
      seed: 9,
      players: 10,
      options: { audiencePicksTier: false },
      content: testContent(),
    }).skipIntro();
    let turn = 0;
    while (d.state.phase !== "final") {
      if (d.state.phase === "word-pick") d.pick(0);
      d.draw([{ c: 0, s: 1, pts: [10, 10, 20, 20] }]);
      const guessers = d.state.players.filter((p) => p.id !== d.state.drawer).slice(0, turn % 4);
      for (const g of guessers) d.guess(g.id, d.word, 900);
      d.toDeadline(); // draw → reveal
      d.toDeadline(); // reveal → next
      turn++;
    }
    expect(d.state.gallery).toHaveLength(8);
    const turns = d.state.gallery.map((g) => g.turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
    // 10 turns with 0,1,2,3,0,1,2,3,0,1 correct guessers: two of the three 0s drop out.
    expect(d.state.gallery.filter((g) => g.correct === 0)).toHaveLength(1);
  });
});

// ---- T9 secrecy -------------------------------------------------------------------------------

describe("T9 secrecy", () => {
  it("T9: the word never reaches the stage, the audience or a guesser before the reveal (incl. the tier vote)", () => {
    let checked = 0;
    for (const [i, preset] of PRESETS.entries()) {
      for (const players of [3, 6, 12]) {
        const module = i % 2 === 0 || players === 3 ? logic : teamDoodle();
        simulateGame(module, {
          seed: 40 + i * 10 + players,
          players,
          options: preset,
          content: testContent,
          policy: "mixed",
          onStep: ({ state }) => {
            const secrets = [
              ...(state.hidden.word !== undefined
                ? [state.hidden.word.w, ...state.hidden.word.alt]
                : []),
              ...(state.hidden.wordChoices?.words.map((w) => w.w) ?? []),
            ];
            if (secrets.length === 0) return;
            for (const v of viewers(state)) {
              if (v.role === "player" && v.id === state.drawer) continue;
              const text = JSON.stringify(module.view(state, v));
              for (const s of secrets) {
                if (text.includes(s))
                  throw new Error(`${JSON.stringify(v)} sees "${s}" in ${state.phase}`);
              }
              checked++;
            }
          },
        });
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("T9: the drawer sees the word only while drawing; choices only while picking; the host never", () => {
    const d = table({ audience: 0 }).skipIntro();
    expect(pv(d, "p1").you?.choices).toHaveLength(3);
    expect(pv(d, "p1").you?.word).toBeNull();
    d.pick(0);
    expect(pv(d, "p1").you?.word).toEqual({ w: "kitten", alt: ["cat", "kitty"] });
    expect(pv(d, "p1").you?.choices).toBeNull();
    expect(JSON.stringify(viewOf(d, { role: "host" }))).not.toContain("kitten");
    expect(JSON.stringify(viewOf(d, { role: "moderator" }))).not.toContain("kitten");
    expect(JSON.stringify(viewOf(d, { role: "audience", restricted: true }))).not.toContain(
      "kitten",
    );
    for (const v of viewers(d.state)) expect(JSON.stringify(viewOf(d, v))).not.toContain("hidden");
  });

  it("T9: the tier vote poll and every audience.open carry no word (accept is server-side)", () => {
    const d = table();
    const res = d.runner.advance((d.now = d.state.deadline ?? 0));
    const tierPoll = effectsOf(res.effects, "audience.open")[0]?.poll;
    expect(JSON.stringify(tierPoll)).not.toMatch(/kitten|ice cream|haunted/);
    const r2 = d.runner.audienceResult(
      { pollId: d.state.tierPoll ?? "", kind: "vote", total: 50, tallies: { "1": 50 } },
      (d.now += 1000),
    );
    const guessPoll = effectsOf(r2.effects, "audience.open")[0]?.poll;
    expect(guessPoll?.kind).toBe("guess");
    expect(guessPoll?.prompt).not.toContain("kitten");
    expect(guessPoll?.accept).toContain("kitten");
  });
});

// ---- T11 bots ---------------------------------------------------------------------------------

describe("T11 bots", () => {
  it("T11: bots complete Guess mode and Team Doodle for every player count", () => {
    for (let n = 3; n <= 12; n++) {
      for (const module of n >= 4 ? [logic, teamDoodle()] : [logic]) {
        const r = simulateGame(module, {
          seed: 900 + n,
          players: n,
          content: testContent,
          maxSteps: 20_000,
        });
        expect(r.ended, `${n}p ${r.failure ?? ""}`).toBe(true);
        expect(r.illegalActions).toBe(0);
      }
    }
  }, 120_000);

  it("T11: the guess bot names the word with probability 0.3 per 5 s", () => {
    const d = drawing(1);
    d.act("p1", stroke("t", 2), 5_000); // the drawer's stroke moves the state clock 5 s in
    const rng = createRng(77);
    let hits = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const a = bot(d.state, "p2", rng);
      if (a?.type === "guess" && a.text === "kitten") hits++;
      else expect(a?.type === "guess" && DECOY_GUESSES.includes(a.text)).toBe(true);
    }
    expect(hits / n).toBeGreaterThan(0.27);
    expect(hits / n).toBeLessThan(0.33);
  });

  it("T11: the guess bot respects the 800 ms rate limit and stops once correct", () => {
    const d = drawing(1);
    d.guess("p2", "dog", 5_000);
    expect(bot(d.state, "p2", createRng(1))).toBeNull(); // clock == last guess
    d.act("p1", stroke("t", 2), 800);
    expect(bot(d.state, "p2", createRng(1))).not.toBeNull();
    d.guess("p3", "kitten");
    expect(bot(d.state, "p3", createRng(1))).toBeNull();
  });

  it("T11: the drawer bot picks a word and draws random scribble strokes", () => {
    const d = table({ audience: 0 }).skipIntro();
    const pick = bot(d.state, "p1", createRng(3));
    expect(pick?.type).toBe("pickWord");
    expect(bot(d.state, "p2", createRng(3))).toBeNull();
    d.pick(0);
    const rng = createRng(4);
    for (let i = 0; i < BOT_STROKES; i++) {
      const a = bot(d.state, "p1", rng);
      expect(a?.type).toBe("stroke");
      if (a === null) break;
      d.act("p1", a, 200);
    }
    expect(d.state.drawing.strokes).toHaveLength(BOT_STROKES);
    expect(bot(d.state, "p1", rng)).toBeNull();
    const nearFull: Drawing = { strokes: [], points: MAX_POINTS - 3 };
    const tiny = scribble(nearFull, 0, createRng(1));
    expect(tiny?.pts).toHaveLength(6);
    expect(scribble({ strokes: [], points: MAX_POINTS }, 0, createRng(1))).toBeNull();
  });

  it("T11: a disconnected seat's bot does nothing (its drawing turns are skipped)", () => {
    const d = drawing(1);
    d.runner.playerLeave("p3", (d.now += 100));
    expect(bot(d.state, "p3", createRng(1))).toBeNull();
  });
});

// ---- T13 ---------------------------------------------------------------------------------------

describe("T13 defaults", () => {
  it("T13: rounds auto gives 2 rounds for 3–4 players and 1 for 5+ (Telephone maxSteps: M5-01b)", () => {
    const rounds = optionSpecs.find((o) => o.key === "rounds");
    expect(rounds?.default).toBe("auto");
    for (const [n, want] of [
      [3, 2],
      [4, 2],
      [5, 1],
      [12, 1],
    ] as const) {
      expect(table({ players: n }).state.rounds).toBe(want);
    }
  });

  it("T13: the manifest and option defaults follow the spec", () => {
    expect(manifest).toMatchObject({
      id: "doodle",
      minPlayers: 3,
      maxPlayers: 12,
      tickHz: 0,
      renderMode: "on-demand",
      teamSupport: "optional",
      audience: { guess: true, vote: true, predict: true, tap: true },
      estMinutes: [8, 14],
    });
    const byKey = Object.fromEntries(optionSpecs.map((o) => [o.key, o]));
    expect(byKey["mode"]?.default).toBe("guess");
    expect(byKey["packs"]?.default).toEqual(["doodle-core"]);
    expect(byKey["customWords"]?.default).toBe("off");
    expect(byKey["drawSec"]).toMatchObject({ kind: "seconds", min: 40, max: 150, default: 70 });
    expect(byKey["hints"]?.default).toBe(true);
    expect(byKey["audiencePicksTier"]?.default).toBe(true);
  });
});

// ---- Edge cases -------------------------------------------------------------------------------

describe("edge cases", () => {
  it("edge: the drawer disconnecting mid-turn ends the turn; correct guessers keep their points", () => {
    const d = drawing(1);
    d.guess("p2", "kitten");
    const p2 = d.state.scores["p2"];
    d.runner.playerLeave("p1", (d.now += 500));
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("drawer-left");
    expect(d.state.scores["p2"]).toBe(p2);
    d.toDeadline();
    expect(d.state.drawer).toBe("p2");
  });

  it("edge: the drawer disconnecting while picking skips to the next turn", () => {
    const d = table().skipIntro();
    d.runner.playerLeave("p1", (d.now += 500));
    // The tier vote's early close is held by the minimum audience window.
    expect(d.runner.openPolls().map((p) => p.closing)).toEqual([true, false]); // old held, new open
    expect(d.state.phase).toBe("word-pick");
    expect(d.state.drawer).toBe("p2");
    expect(d.state.turn).toBe(1);
  });

  it("edge: a disconnected drawer's turn is skipped; after rejoining they draw again", () => {
    const d = table({ players: 3, audience: 0 });
    d.runner.playerLeave("p1", (d.now += 100));
    d.skipIntro();
    expect(d.state.drawer).toBe("p2");
    d.runner.playerRejoin("p1", (d.now += 100));
    expect(d.state.players[0]?.connected).toBe(true);
    // p2 and p3 draw, then round 2 starts with p1 again.
    while (d.state.turn < 3 && d.state.phase !== "final") d.toDeadline();
    expect(d.state.drawer).toBe("p1");
  });

  it("edge: when every player is gone, the game moves to the final", () => {
    const d = table({ players: 3 });
    for (const id of ["p1", "p2", "p3"]) d.runner.playerLeave(id, (d.now += 10));
    d.skipIntro();
    expect(d.state.phase).toBe("final");
  });

  it("edge: a guesser leaving can complete 'everyone guessed'", () => {
    const d = drawing(1);
    for (const id of ["p2", "p3", "p4"]) d.guess(id, "kitten");
    expect(d.state.phase).toBe("draw");
    d.runner.playerLeave("p5", (d.now += 100));
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("all-correct");
    // Leave/rejoin of unknown or repeated seats changes nothing.
    const s = d.state;
    expect(logic.onPlayerLeave?.(s, "p5", ctxAt(d.now)).state).toBe(s);
    expect(logic.onPlayerLeave?.(s, "zz", ctxAt(d.now)).state).toBe(s);
    expect(logic.onPlayerRejoin?.(s, "p2", ctxAt(d.now)).state).toBe(s);
  });

  it("edge: a guesser leaving can complete the report threshold", () => {
    const d = drawing(1, { players: 3 });
    d.act("p2", { type: "report" }, 100);
    expect(d.state.phase).toBe("reveal"); // 1 of 2 connected guessers is 50%
    const e = drawing(1, { players: 4 });
    e.act("p2", { type: "report" }, 100);
    expect(e.state.phase).toBe("draw");
    e.runner.playerLeave("p3", (e.now += 100));
    expect(e.state.phase).toBe("reveal");
  });

  it("edge: in Team Doodle, a drawer leaving ends the turn with no team points", () => {
    const d = teamTable(4).skipIntro().voteTier([90, 5, 5]);
    d.runner.playerLeave("p1", (d.now += 100));
    expect(d.state.reveal?.reason).toBe("drawer-left");
    expect(d.state.scores).toEqual({ tomato: 0, sky: 0 });
  });
});

// ---- Audience guess poll ----------------------------------------------------------------------

describe("audience guess poll", () => {
  function guessResult(pollId: string, correct: number, atMs?: number): PollResult {
    return {
      pollId,
      kind: "guess",
      total: 300,
      tallies: { correct },
      firstCorrect: [
        { audId: "a1", name: "Ann", ...(atMs !== undefined ? { atMs } : {}) },
        { audId: "a2", name: "Bo" },
        { audId: "a3", name: "Cy" },
        { audId: "a4", name: "Di" },
      ],
    };
  }

  it("audience: one guess poll per turn, closed at the turn end, result shown as chatters got it", () => {
    const d = drawing(1);
    const pollId = d.state.guessPoll ?? "";
    expect(pollId).toMatch(/guess/);
    d.guess("p2", "kitten");
    const firstAt = d.state.firstCorrectAt ?? 0;
    d.now = d.state.deadline ?? 0;
    const r = d.runner.advance(d.now);
    expect(effectsOf(r.effects, "audience.close").map((e) => e.pollId)).toContain(pollId);
    expect(d.state.pendingGuess).toHaveLength(1);
    d.runner.audienceResult(guessResult(pollId, 214, firstAt - 10), (d.now += 100));
    expect(d.state.crowd).toEqual({
      turn: 0,
      correct: 214,
      first: ["Ann", "Bo", "Cy"],
      beat: true,
    });
    expect(stage(d).crowd?.correct).toBe(214);
    expect(d.state.pendingGuess).toEqual([]);
  });

  it("audience: Chat vs Players is false when a player was first, null when the timing is unknown", () => {
    const d = drawing(1);
    const pollId = d.state.guessPoll ?? "";
    d.guess("p2", "kitten");
    const firstAt = d.state.firstCorrectAt ?? 0;
    d.runner.audienceResult(guessResult(pollId, 3, firstAt + 50), (d.now += 100));
    expect(d.state.crowd?.beat).toBe(false);
    expect(d.state.guessPoll).toBeNull();
    const e = drawing(1);
    const id2 = e.state.guessPoll ?? "";
    e.guess("p2", "kitten");
    e.runner.audienceResult(guessResult(id2, 3), (e.now += 100));
    expect(e.state.crowd?.beat).toBeNull();
    const f = drawing(1);
    f.runner.audienceResult(guessResult(f.state.guessPoll ?? "", 0), (f.now += 100));
    expect(f.state.crowd?.beat).toBe(false);
    const g = drawing(1);
    g.runner.audienceResult(guessResult(g.state.guessPoll ?? "", 5), (g.now += 100));
    expect(g.state.crowd?.beat).toBe(true); // chat got it, no player did
  });

  it("audience: unknown or mismatched poll results are ignored", () => {
    const d = drawing(1);
    const s = d.state;
    expect(logic.onAudienceResult?.(s, guessResult("nope", 1), ctxAt(d.now)).state).toBe(s);
    expect(
      logic.onAudienceResult?.(
        s,
        { ...guessResult(s.guessPoll ?? "", 1), kind: "vote" },
        ctxAt(d.now),
      ).state,
    ).toBe(s);
  });
});

// ---- Host and timers --------------------------------------------------------------------------

describe("host commands and timerScale 0", () => {
  it("host: forceAdvance moves every phase on, through to the end", () => {
    const d = table({ players: 3 });
    const phases: string[] = [];
    let guard = 0;
    while (!d.runner.ended && guard++ < 100) {
      phases.push(d.state.phase);
      d.runner.hostCommand({ c: "forceAdvance" }, (d.now += 100));
    }
    expect(d.runner.ended).toBe(true);
    expect(phases.slice(0, 5)).toEqual(["intro", "word-pick", "draw", "reveal", "word-pick"]);
    expect(phases.at(-1)).toBe("final");
    expect(d.state.tier).toBeNull();
    expect(d.state.history.map((h) => h.turn)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("host: skipItem during the word pick skips the turn; outside a turn it is ignored", () => {
    const d = table().skipIntro();
    d.runner.hostCommand({ c: "skipItem", itemId: "turn-0" }, (d.now += 100));
    expect(d.state.turn).toBe(1);
    d.toDeadline(2_000).toDeadline(); // tier vote → grace → draw → deadline → reveal
    expect(d.state.phase).toBe("reveal");
    const s = d.state;
    expect(logic.onHostCommand?.(s, { c: "skipItem", itemId: "turn-1" }, ctxAt(d.now)).state).toBe(
      s,
    );
  });

  it("timerScale 0: no input deadlines; hints still run; the host advances", () => {
    const d = table({ timerScale: 0 }).skipIntro();
    expect(d.state.deadline).toBeNull();
    expect(d.state.picker).toBe("audience");
    d.voteTier([50, 0, 0]);
    expect(d.state.phase).toBe("draw");
    expect(d.state.deadline).toBeNull();
    expect(d.state.drawTotal).toBe(70_000);
    d.wait(35_000);
    expect((stage(d).hint ?? "").replace(/[_ ]/g, "")).toHaveLength(1);
    d.guess("p2", "kitten", 0);
    expect(d.state.correct["p2"]).toBe(100 + 100 + 50);
    d.runner.hostCommand({ c: "forceAdvance" }, (d.now += 100));
    expect(d.state.phase).toBe("reveal");
    expect(d.state.reveal?.reason).toBe("host");
    const pick = table({ timerScale: 0, audience: 0 }).skipIntro();
    expect(pick.state.picker).toBe("drawer");
    expect(pick.state.deadline).toBeNull();
  });

  it("timers: stale timers are ignored", () => {
    const d = drawing(1);
    const s = d.state;
    for (const id of ["tier", "steal", "nope"]) {
      expect(logic.onTimer?.(s, id, ctxAt(d.now)).state).toBe(s);
    }
    const pick = table().skipIntro();
    expect(logic.onTimer?.(pick.state, "phase", ctxAt(pick.now)).state).toBe(pick.state);
    expect(logic.onTimer?.(pick.state, "hint", ctxAt(pick.now)).state).toBe(pick.state);
  });
});

// ---- parseAction, setup, views ----------------------------------------------------------------

describe("parseAction", () => {
  it("parses every Guess mode action and rejects bad shapes", () => {
    expect(parseAction({ type: "pickWord", idx: 2 })).toEqual({ type: "pickWord", idx: 2 });
    expect(parseAction({ type: "pickWord", idx: 3 })).toBeNull();
    expect(parseAction({ type: "undo", extra: 1 })).toEqual({ type: "undo" });
    expect(parseAction({ type: "clear" })).toEqual({ type: "clear" });
    expect(parseAction({ type: "report" })).toEqual({ type: "report" });
    expect(parseAction({ type: "guess", text: "cat" })).toEqual({ type: "guess", text: "cat" });
    expect(parseAction({ type: "guess", text: 3 })).toBeNull();
    expect(parseAction({ type: "guess", text: "x".repeat(300) })).toBeNull();
    const good = { type: "stroke", id: "a", c: 1, s: 2, pts: [1, 2], done: false };
    expect(parseAction(good)).toEqual(good);
    for (const bad of [
      { ...good, id: "" },
      { ...good, id: 5 },
      { ...good, c: 1.5 },
      { ...good, s: "1" },
      { ...good, done: 1 },
      { ...good, pts: "1,2" },
      { ...good, pts: [1, Number.NaN] },
      { ...good, pts: [1, "2"] },
      { ...good, pts: Array.from({ length: 3000 }, () => 1) },
    ]) {
      expect(parseAction(bad)).toBeNull();
    }
    for (const junk of [
      null,
      3,
      "undo",
      [],
      { type: "write", text: "x" },
      { type: "vote", step: 1 },
    ]) {
      expect(parseAction(junk)).toBeNull();
    }
  });
});

describe("setup, rooms and views", () => {
  it("setup sanitizes options it did not get through resolveOptions", () => {
    const step = logic.setup({
      players: scenarioSeats(3),
      teams: [],
      options: { drawSec: 999, rounds: "9", customWords: "x", packs: [] } as never,
      rng: createRng(1),
      now: 0,
      timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
      content: EMPTY_CONTENT,
      audienceCount: 0,
    });
    expect(step.state.options).toEqual({
      mode: "guess",
      packs: ["doodle-core"],
      customWords: "off",
      rounds: "auto",
      drawSec: 150,
      hints: true,
      audiencePicksTier: true,
    });
    const nan = logic.setup({
      players: scenarioSeats(3),
      teams: [],
      options: { drawSec: Number.NaN } as never,
      rng: createRng(1),
      now: 0,
      timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
      content: EMPTY_CONTENT,
      audienceCount: 0,
    });
    expect(nan.state.options.drawSec).toBe(70);
  });

  it("room settings: overrides, then ctx.room, then the defaults", () => {
    const base = {
      players: [],
      teams: [],
      options: {},
      rng: createRng(1),
      now: 0,
      timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
      content: EMPTY_CONTENT,
      audienceCount: 0,
    };
    expect(resolveRoomSettings(base)).toEqual({
      contentFilter: "standard",
      moderation: "off",
      audienceMin: 5,
    });
    expect(
      resolveRoomSettings({
        ...base,
        room: { contentFilter: "family", moderation: "reveal-review", audienceMin: 9 },
      }),
    ).toEqual({ contentFilter: "family", moderation: "reveal-review", audienceMin: 9 });
    expect(
      resolveRoomSettings(
        { ...base, room: { contentFilter: "x" as never, audienceMin: 0 } },
        { moderation: "bad" as never },
      ),
    ).toEqual({ contentFilter: "standard", moderation: "off", audienceMin: 5 });
    expect(createDoodle({ audienceMin: 3 }).manifest.id).toBe("doodle");
  });

  it("views: phase and deadline everywhere; the you slice only for seats; host item only for the host", () => {
    const d = drawing(1);
    for (const v of viewers(d.state)) {
      const view = viewOf(d, v);
      expect(typeof view.phase).toBe("string");
      expect(view.deadline).toBe(d.state.deadline);
      expect(view.you === null).toBe(v.role !== "player");
      expect(view.host === null).toBe(v.role !== "host");
    }
    expect(pv(d, "p2").you).toMatchObject({
      role: "guesser",
      canGuess: true,
      canReport: true,
      correct: null,
    });
    expect(pv(d, "p1").you).toMatchObject({ role: "drawer", canGuess: false, canReport: false });
    expect(viewOf(d, { role: "player", id: "zz" }).you).toBeNull();
    d.toDeadline();
    expect(viewOf(d, { role: "host" }).host?.itemId).toBeNull();
    expect(stage(d).tier?.tier).toBe(1);
  });

  it("host and strangers cannot act; serialize round-trips", () => {
    const d = drawing(1);
    const s = d.state;
    expect(logic.onAction(s, { type: "guess", text: "x" }, actx(d.now, "p2", "host")).state).toBe(
      s,
    );
    expect(logic.onAction(s, { type: "report" }, actx(d.now, "zz")).state).toBe(s);
    expect(logic.deserialize(logic.serialize(s))).toEqual(s);
  });

  it("legalActions: the drawer picks or draws, guessers guess and report, nobody acts in reveals", () => {
    const pick = table({ audience: 0 }).skipIntro();
    expect(legalActions(pick.state, "p1")).toHaveLength(3);
    expect(legalActions(pick.state, "p2")).toEqual([]);
    const d = drawing(1);
    expect(legalActions(d.state, "p1").map((a) => a.type)).toEqual(["stroke"]);
    d.act("p1", stroke("q"));
    expect(legalActions(d.state, "p1").map((a) => a.type)).toEqual(["stroke", "undo", "clear"]);
    expect(legalActions(d.state, "p2").map((a) => a.type)).toEqual(["guess", "guess", "report"]);
    d.guess("p2", "kitten");
    expect(legalActions(d.state, "p2")).toEqual([
      { type: "guess", text: "nice one!" },
      { type: "report" },
    ]);
    expect(legalActions(d.state, "zz")).toEqual([]);
    for (const a of legalActions(d.state, "p1"))
      expect(parseAction(JSON.parse(JSON.stringify(a)))).not.toBeNull();
    d.toDeadline();
    expect(legalActions(d.state, "p1")).toEqual([]);
  });

  it("scenarios: every registered scenario builds for every role with a phase and deadline", () => {
    for (const [id, sc] of Object.entries(scenarios)) {
      for (const role of ["stage", "host", "player", "audience"] as const) {
        const built = sc.build({ seed: 5, rng: createRng(5), players: 5, role });
        const view = logic.view(built.state, built.viewer ?? { role: "stage" });
        expect(typeof view.phase, id).toBe("string");
      }
    }
    expect(Object.keys(scenarios)).toEqual(
      expect.arrayContaining(["word-pick", "drawing", "correct-guess", "reveal", "final"]),
    );
  });
});
