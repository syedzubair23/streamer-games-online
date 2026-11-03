/**
 * Rule tests for Odd One Out (DOD G3): every numbered rule (R1–R11) and test case (T1–T11) of
 * `docs/specs/odd-one-out.md` has at least one test named with its number. Games run on the
 * real `GameRunner` with a virtual clock (see `helpers.ts`).
 */
import { describe, expect, it } from "vitest";
import { createTiming, resolveScenario, type Effect, type ViewerKey } from "@sg/engine";
import { fakeContent, makeSeats, simulateGame } from "@sg/engine/testing";
import {
  createRng,
  PACK_ITEM_SCHEMAS,
  type AnyPack,
  type OooCategory,
  type PlayerId,
} from "@sg/shared";
import {
  bot,
  checkClue,
  clueCandidates,
  clueKey,
  clueOrder,
  createOddOneOut,
  currentGiver,
  dealDeck,
  FALLBACK_GENERIC,
  gameResult,
  involves,
  legalActions,
  loadCategories,
  loadPairs,
  logic,
  manifest,
  mastersOfDisguise,
  oddCountFor,
  optionSpecs,
  parseAction,
  passesFor,
  PASS_CLUE,
  QUICK_LINES,
  ranking,
  resolveRoomSettings,
  says,
  scoreRound,
  tally,
  toClue,
  voteCounts,
  voteTargets,
  type OooOptions,
  type OooState,
  type OooView,
} from "../src/logic/index.ts";
import {
  FIXTURE_CATEGORIES,
  FIXTURE_CORE_PACK,
  FIXTURE_PAIRS,
  FIXTURE_PAIRS_PACK,
  packContent,
  scenarios,
} from "../src/scenarios.ts";
import { content, Game, otherThan, T0 } from "./helpers.ts";

const DEFAULTS: OooOptions = {
  packs: ["ooo-core"],
  variant: "classic",
  oddCount: "auto",
  rounds: 3,
  clueRounds: "auto",
  clueSec: 20,
  discussSec: 45,
  audienceSecret: "phones",
};

const of = (effects: readonly Effect[], type: Effect["type"]) =>
  effects.filter((e) => e.type === type);

const fxNames = (effects: readonly Effect[]): string[] =>
  effects.flatMap((e) => (e.type === "fx" ? [e.name] : []));

/** A category pack with the given 12 secrets (clue banks and generic clues filled in). */
function categoryPack(id: string, secrets: string[], name = "Test Things"): AnyPack {
  const cat: OooCategory = {
    id,
    name,
    secrets,
    clueBank: Object.fromEntries(
      secrets.map((s, i) => [s, [`hintone${i}`, `hinttwo${i}`, `hintthree${i}`]]),
    ),
    genericClues: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
  } as OooCategory;
  return {
    id: "ooo-core",
    kind: "ooo-categories",
    name: "Test",
    lang: "en",
    rating: "all",
    version: 1,
    items: [cat],
  };
}

const TWELVE = [
  "Sunflower",
  "Tulip",
  "Daisy",
  "Rose",
  "Lily",
  "Orchid",
  "Poppy",
  "Violet",
  "Lotus",
  "Iris",
  "Peony",
  "Dahlia",
];

// ---- Manifest and options -------------------------------------------------------------------

describe("manifest and options", () => {
  it("matches the spec manifest and host options", () => {
    expect(manifest).toMatchObject({
      id: "odd-one-out",
      minPlayers: 4,
      maxPlayers: 10,
      tickHz: 0,
      renderMode: "on-demand",
      teamSupport: "none",
      audience: { predict: true },
      estMinutes: [10, 14],
      contentRating: "all",
    });
    expect(manifest.howToPlay).toEqual([
      "Everyone gets the secret word except the Odd One",
      "Give a one-word clue — not too obvious!",
      "Vote out the Odd One",
    ]);
    for (const step of manifest.howToPlay) expect(step.length).toBeLessThanOrEqual(60);
    const byKey = Object.fromEntries(optionSpecs.map((o) => [o.key, o]));
    expect(byKey["packs"]).toMatchObject({
      kind: "pack",
      packKind: "ooo-categories",
      multi: true,
      default: ["ooo-core"],
    });
    expect(byKey["variant"]).toMatchObject({ kind: "enum", default: "classic" });
    expect(byKey["oddCount"]).toMatchObject({ kind: "enum", default: "auto" });
    expect(byKey["rounds"]).toMatchObject({ kind: "int", min: 2, max: 8, default: 3 });
    expect(byKey["clueRounds"]).toMatchObject({ kind: "enum", default: "auto" });
    expect(byKey["clueSec"]).toMatchObject({ kind: "seconds", min: 10, max: 60, default: 20 });
    expect(byKey["discussSec"]).toMatchObject({ kind: "seconds", min: 20, max: 180, default: 45 });
    expect(byKey["audienceSecret"]).toMatchObject({ kind: "enum", default: "phones" });
  });

  it("room settings: override, then ctx.room, then defaults", () => {
    const ctx = { room: { contentFilter: "family" as const, hostSeated: true } } as never;
    expect(resolveRoomSettings(ctx)).toEqual({ contentFilter: "family", hostSeated: true });
    expect(resolveRoomSettings(ctx, { hostSeated: false })).toEqual({
      contentFilter: "family",
      hostSeated: false,
    });
    expect(resolveRoomSettings({ room: { contentFilter: "bogus" } } as never)).toEqual({
      contentFilter: "standard",
      hostSeated: false,
    });
    expect(resolveRoomSettings({} as never)).toEqual({
      contentFilter: "standard",
      hostSeated: false,
    });
  });

  it("the fixture content validates and its clue banks never say their secret", () => {
    for (const c of FIXTURE_CATEGORIES) {
      expect(PACK_ITEM_SCHEMAS["ooo-categories"].safeParse(c).success).toBe(true);
      for (const [secret, bank] of Object.entries(c.clueBank)) {
        for (const clue of bank) {
          expect(says(clue, secret), `${clue} / ${secret}`).toBe(false);
          expect(toClue(clue)).not.toBeNull();
        }
      }
    }
    for (const p of FIXTURE_PAIRS)
      expect(PACK_ITEM_SCHEMAS["ooo-pairs"].safeParse(p).success).toBe(true);
  });
});

// ---- R1 ----------------------------------------------------------------------------------------

describe("R1 round setup", () => {
  it("R1: a category and one of its 12 secrets per round, never repeated in the match", () => {
    const g = new Game({ players: 5, options: { rounds: 8 } });
    const secrets: string[] = [];
    const categories: string[] = [];
    for (let r = 1; r <= 8; r++) {
      g.until("reveal", r);
      const cat = FIXTURE_CATEGORIES.find((c) => c.id === g.s.category?.id);
      expect(cat?.secrets).toContain(g.secret);
      expect(g.s.category?.options).toEqual(cat?.secrets);
      secrets.push(clueKey(g.secret));
      categories.push(g.s.category?.id as string);
      g.until("round-result", r);
    }
    expect(new Set(secrets).size).toBe(8);
    // 6 fixture categories: the first 6 rounds use distinct ones.
    expect(new Set(categories.slice(0, 6)).size).toBe(6);
  });

  it("R1: categories not used earlier in the session come first", () => {
    const used = FIXTURE_CATEGORIES.slice(0, 4).map((c) => c.id);
    for (let seed = 1; seed <= 5; seed++) {
      const g = new Game({ seed, players: 4, options: { rounds: 2 }, used: { categories: used } });
      g.until("deal");
      const first = g.s.category?.id as string;
      expect(used).not.toContain(first);
    }
  });

  it("R1: odd ones are picked at random each round and do not learn about each other", () => {
    const counts = new Map<PlayerId, number>();
    for (let seed = 1; seed <= 40; seed++) {
      const g = new Game({ seed, players: 8 });
      g.until("reveal");
      expect(g.odd).toHaveLength(2);
      expect(new Set(g.odd).size).toBe(2);
      for (const o of g.odd) counts.set(o, (counts.get(o) ?? 0) + 1);
      const [a, b] = g.odd as [PlayerId, PlayerId];
      const va = JSON.stringify(g.view({ role: "player", id: a }));
      const vb = JSON.stringify(g.view({ role: "player", id: b }));
      // Each odd one's view is the same as the other's apart from its own id.
      expect(va.replaceAll(`"id":"${a}","word"`, "X")).toBe(
        vb.replaceAll(`"id":"${b}","word"`, "X"),
      );
    }
    expect(counts.size).toBe(8);
  });

  it("R1: the clue order is a random start, then seat order", () => {
    const starts = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const g = new Game({ seed, players: 6 });
      g.until("deal");
      const order = g.s.order;
      const i = g.ids.indexOf(order[0] as PlayerId);
      expect(order).toEqual(g.ids.map((_, k) => g.ids[(i + k) % 6]));
      starts.add(order[0] as string);
    }
    expect(starts.size).toBeGreaterThan(3);
    const players = makeSeats(4).map((s) => ({ ...s }));
    expect(clueOrder(players, 2)).toEqual(["p3", "p4", "p1", "p2"]);
  });

  it("R1: too little content keeps the game in intro with an error; forceAdvance ends it unplayed", () => {
    const g = new Game({ packs: [FIXTURE_PAIRS_PACK] });
    expect(g.s.phase).toBe("intro");
    expect(g.s.error).toMatch(/categories/);
    expect(g.runner.nextEventAt()).toBeNull();
    expect(g.view({ role: "stage" }).error).toMatch(/categories/);
    g.host();
    expect(g.runner.ended).toBe(true);
    expect(g.runner.result).toEqual({ ranking: [] });
  });

  it("R1: a category with fewer than 12 secrets is never played", () => {
    const short = {
      ...(FIXTURE_CATEGORIES[0] as OooCategory),
      id: "short",
      secrets: TWELVE.slice(0, 11),
    };
    const pack = { ...FIXTURE_CORE_PACK, items: [short] } as AnyPack;
    const c = fakeContent([pack], { validate: false });
    expect(loadCategories(c, ["ooo-core"])).toEqual([]);
    expect(PACK_ITEM_SCHEMAS["ooo-categories"].safeParse(short).success).toBe(false);
  });

  it("R1: oddCount 1 and 2 force the count", () => {
    expect(oddCountFor(9, "1")).toBe(1);
    expect(oddCountFor(5, "2")).toBe(2);
    const g = new Game({ players: 6, options: { oddCount: "2" } });
    g.until("reveal");
    expect(g.odd).toHaveLength(2);
  });
});

describe("T1 odd count", () => {
  it("T1: auto picks 1 odd one below 8 players and 2 at 8 or more", () => {
    for (const n of [4, 5, 6, 7]) expect(oddCountFor(n, "auto")).toBe(1);
    for (const n of [8, 9, 10]) expect(oddCountFor(n, "auto")).toBe(2);
    for (const n of [4, 7, 8, 10]) {
      const g = new Game({ players: n });
      g.until("reveal");
      expect(g.odd).toHaveLength(n >= 8 ? 2 : 1);
      expect(g.view({ role: "stage" }).oddCount).toBe(n >= 8 ? 2 : 1);
    }
  });

  it("T1: 4 players with auto never get 2 odd ones", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = new Game({ seed, players: 4, options: { rounds: 2 } });
      g.until("reveal");
      expect(g.odd).toHaveLength(1);
    }
  });
});

// ---- R2 ----------------------------------------------------------------------------------------

describe("R2 role reveal", () => {
  it("R2: a regular phone shows the category and the secret; an odd one's shows the odd card", () => {
    const g = new Game({ players: 5 });
    g.until("reveal");
    const reg = g.view({ role: "player", id: g.regulars[0] as PlayerId });
    expect(reg.category?.name).toBe(g.s.category?.name);
    expect(reg.me).toEqual({ id: g.regulars[0], word: g.secret, odd: false, vote: null });
    const odd = g.view({ role: "player", id: g.odd[0] as PlayerId });
    expect(odd.category?.name).toBe(g.s.category?.name);
    expect(odd.me).toEqual({ id: g.odd[0], word: null, odd: true, vote: null });
    expect(JSON.stringify(odd)).not.toContain(`"${g.secret}"`);
  });

  it("R2: the reveal lasts pace 6000 and auto-advances into the clues", () => {
    const g = new Game({ players: 5, timerScale: 2 });
    g.until("reveal");
    const start = g.now;
    expect(g.s.deadline).toBe(start + 6_000);
    g.step();
    expect(g.s.phase).toBe("clues");
    expect(g.now).toBe(start + 6_000);
  });

  it("R2: once every player taps Got it the reveal ends early; tapping twice is illegal", () => {
    const g = new Game({ players: 4 });
    g.until("reveal");
    g.ok("p1", { type: "gotIt" });
    g.no("p1", { type: "gotIt" });
    expect(g.view({ role: "stage" }).ready).toEqual(["p1"]);
    g.ok("p2", { type: "gotIt" }).ok("p3", { type: "gotIt" });
    expect(g.s.phase).toBe("reveal");
    g.ok("p4", { type: "gotIt" });
    expect(g.s.phase).toBe("clues");
    g.no("p1", { type: "gotIt" });
  });

  it("R2: a disconnected player is not waited for", () => {
    const g = new Game({ players: 4 });
    g.until("reveal");
    g.ok("p1", { type: "gotIt" }).ok("p2", { type: "gotIt" }).ok("p3", { type: "gotIt" });
    g.leave("p4");
    expect(g.s.phase).toBe("clues");
  });

  it("R2: in Undercover the odd one gets the similar word with no label", () => {
    const g = new Game({ players: 5, options: { variant: "undercover" } });
    g.until("reveal");
    const decoy = g.s.hidden.decoy as string;
    expect(decoy).toBeTruthy();
    expect(clueKey(decoy)).not.toBe(clueKey(g.secret));
    expect(g.view({ role: "player", id: g.odd[0] as PlayerId }).me).toEqual({
      id: g.odd[0],
      word: decoy,
      odd: false,
      vote: null,
    });
  });
});

// ---- R3 ----------------------------------------------------------------------------------------

describe("R3 clues", () => {
  it("R3: every player in order gives a clue within timing.input(clueSec*1000) per pass", () => {
    const g = new Game({ players: 5, options: { clueSec: 30 }, streamDelaySec: 2 });
    g.gotAll();
    expect(g.s.phase).toBe("clues");
    expect(g.s.deadline).toBe(g.now + 30_000 + 2_000);
    const givers: PlayerId[] = [];
    for (let i = 0; i < 10; i++) {
      givers.push(currentGiver(g.s) as PlayerId);
      g.clues(1);
    }
    expect(givers).toEqual([...g.s.order, ...g.s.order]);
    expect(g.s.phase).toBe("discuss");
    expect(g.s.clues.map((c) => c.pass)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("R3: only the current giver may give a clue", () => {
    const g = new Game({ players: 4 });
    g.gotAll();
    const other = otherThan(g.ids, currentGiver(g.s) as PlayerId);
    g.no(other, { type: "clue", text: "anything" });
  });

  it("R3: a missing clue becomes … (a pass)", () => {
    const g = new Game({ players: 4 });
    g.gotAll();
    const giver = currentGiver(g.s) as PlayerId;
    g.step();
    expect(g.s.clues).toEqual([{ by: giver, text: PASS_CLUE, pass: 0 }]);
    expect(currentGiver(g.s)).toBe(g.s.order[1]);
  });

  it("R3: clues are public at once and shown on the Stage", () => {
    const g = new Game({ players: 4 });
    g.gotAll();
    const giver = currentGiver(g.s) as PlayerId;
    const from = g.effects.length;
    g.ok(giver, { type: "clue", text: "  zebra-ish  " });
    expect(g.view({ role: "stage" }).clues).toEqual([{ by: giver, text: "zebra-ish", pass: 0 }]);
    expect(g.view({ role: "audience", restricted: true }).clues).toHaveLength(1);
    expect(fxNames(g.since(from))).toContain("lantern");
  });

  it("R3: family filter refuses a flagged clue with a private cue; standard keeps it flagged", () => {
    const fam = new Game({ players: 4, room: { contentFilter: "family" } });
    fam.gotAll();
    const giver = currentGiver(fam.s) as PlayerId;
    const from = fam.effects.length;
    fam.no(giver, { type: "clue", text: "shit" });
    expect(of(fam.since(from), "private")).toEqual([
      { type: "private", to: giver, name: "clue-rejected", data: { reason: "filtered" } },
    ]);
    const std = new Game({ players: 4 });
    std.gotAll();
    const g2 = currentGiver(std.s) as PlayerId;
    std.ok(g2, { type: "clue", text: "shit" });
    expect(std.s.clues[0]).toEqual({ by: g2, text: "shit", pass: 0, flagged: true });
  });

  it("R3: at timerScale 0 clue turns have no deadline and the host advances", () => {
    const g = new Game({ players: 4, timerScale: 0 });
    g.gotAll();
    expect(g.s.deadline).toBeNull();
    expect(g.runner.nextEventAt()).toBeNull();
    g.host();
    expect(g.s.clues[0]?.text).toBe(PASS_CLUE);
  });
});

describe("T4 clue validation", () => {
  it("T4: whitespace is rejected and hyphens are allowed", () => {
    expect(checkClue("ice cream")).toEqual({ ok: false, reason: "spaces" });
    expect(checkClue("ice-cream")).toEqual({ ok: true, text: "ice-cream" });
    expect(checkClue("  trimmed  ")).toEqual({ ok: true, text: "trimmed" });
    expect(checkClue("tab\there")).toEqual({ ok: false, reason: "spaces" });
    expect(checkClue("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkClue("a".repeat(20))).toEqual({ ok: true, text: "a".repeat(20) });
    expect(checkClue("a".repeat(21))).toEqual({ ok: false, reason: "long" });
    expect(checkClue("…")).toEqual({ ok: false, reason: "no-letters" });
    expect(checkClue("x")).toEqual({ ok: true, text: "x" });
    const g = new Game({ players: 4 });
    g.gotAll();
    const giver = currentGiver(g.s) as PlayerId;
    const from = g.effects.length;
    g.no(giver, { type: "clue", text: "two words" });
    expect(of(g.since(from), "private")[0]).toMatchObject({ data: { reason: "spaces" } });
    g.no(giver, { type: "clue", text: "x".repeat(21) });
    g.ok(giver, { type: "clue", text: "well-known" });
  });
});

describe("T11 clue passes", () => {
  it("T11: clueRounds auto gives 2 passes for 4–7 players and 1 for 8–10", () => {
    for (const n of [4, 5, 6, 7]) expect(passesFor(n, "auto")).toBe(2);
    for (const n of [8, 9, 10]) expect(passesFor(n, "auto")).toBe(1);
    expect(passesFor(10, "3")).toBe(3);
    expect(passesFor(4, "1")).toBe(1);
    const g = new Game({ players: 8 });
    g.gotAll().clues(8);
    expect(g.s.phase).toBe("discuss");
    const h = new Game({ players: 4, options: { clueRounds: "3" } });
    h.gotAll().clues(11);
    expect(h.s.phase).toBe("clues");
    h.clues(1);
    expect(h.s.phase).toBe("discuss");
  });
});

// ---- R4 ----------------------------------------------------------------------------------------

/** A game in the clues phase where the current giver is a regular (or odd) player. */
function atGiver(kind: "regular" | "odd", opts: ConstructorParameters<typeof Game>[0] = {}): Game {
  for (let seed = 1; seed < 200; seed++) {
    const g = new Game({ players: 5, ...opts, seed });
    g.gotAll();
    for (let i = 0; i < 5; i++) {
      const giver = currentGiver(g.s) as PlayerId;
      if (g.odd.includes(giver) === (kind === "odd")) return g;
      g.clues(1);
    }
  }
  throw new Error("no such game");
}

describe("R4 saying the word", () => {
  it("R4: a regular clue containing the secret ends the round: odd ones +2, the sayer −1", () => {
    const g = atGiver("regular");
    const sayer = currentGiver(g.s) as PlayerId;
    const from = g.effects.length;
    g.ok(sayer, { type: "clue", text: `${g.secret}s` });
    expect(g.s.phase).toBe("round-result");
    expect(g.s.roundResult).toMatchObject({ outcome: "said-word", saidBy: sayer, word: g.secret });
    for (const id of g.ids) {
      const want = g.odd.includes(id) ? 2 : id === sayer ? -1 : 0;
      expect(g.s.roundResult?.points[id]).toBe(want);
      expect(g.s.scores[id]).toBe(want);
    }
    expect(of(g.since(from), "score")).toHaveLength(1);
  });

  it("R4: an odd one whose clue says the secret scores +3", () => {
    const g = atGiver("odd");
    const odd = currentGiver(g.s) as PlayerId;
    g.ok(odd, { type: "clue", text: g.secret.toUpperCase() });
    expect(g.s.roundResult).toMatchObject({ outcome: "odd-said-word", saidBy: odd });
    expect(g.s.scores[odd]).toBe(3);
    expect(Object.values(g.s.scores).reduce((a, b) => a + b, 0)).toBe(3);
    expect(g.s.oddPoints[odd]).toBe(3);
  });

  it("R4: part of the secret does not end the round (sun vs sunflower)", () => {
    expect(says("sunflowers", "sunflower")).toBe(true);
    expect(says("Sun-Flower", "sunflower")).toBe(true);
    expect(says("sun", "sunflower")).toBe(false);
    expect(says("anything", "")).toBe(false);
    const g = atGiver("regular");
    const sayer = currentGiver(g.s) as PlayerId;
    g.ok(sayer, { type: "clue", text: g.secret.slice(0, 3) });
    expect(g.s.phase).toBe("clues");
  });

  it("R4: in Undercover the odd one's own word does not count", () => {
    // Secret and decoy where the decoy contains the secret (Rain / Rainbow style).
    const pack = categoryPack("wx", ["Rain", "Rainbow", ...TWELVE.slice(0, 10)], "Weather");
    const pairs: AnyPack = {
      ...FIXTURE_PAIRS_PACK,
      items: [
        { a: "Rain", b: "Rainbow", category: "Weather" },
        { a: "Tulip", b: "Rose", category: "Flowers" },
      ],
    } as AnyPack;
    for (let seed = 1; seed < 80; seed++) {
      const g = new Game({
        seed,
        players: 4,
        packs: [pack, pairs],
        options: { variant: "undercover", rounds: 2 },
      });
      g.gotAll();
      if (g.secret !== "Rain") continue;
      for (let i = 0; i < 4; i++) {
        const giver = currentGiver(g.s) as PlayerId;
        if (!g.odd.includes(giver)) {
          g.clues(1);
          continue;
        }
        g.ok(giver, { type: "clue", text: "rainbows" });
        expect(g.s.phase).toBe("clues");
        return;
      }
    }
    throw new Error("no suitable game");
  });
});

// ---- R5 ----------------------------------------------------------------------------------------

describe("R5 discussion", () => {
  it("R5: the discussion lasts timing.input(discussSec*1000) and early-ends when all are ready", () => {
    const g = new Game({ players: 4, options: { discussSec: 60 } });
    g.gotAll().clues();
    expect(g.s.phase).toBe("discuss");
    expect(g.s.deadline).toBe(g.now + 63_000);
    g.ok("p1", { type: "ready" });
    g.no("p1", { type: "ready" });
    g.ok("p2", { type: "ready" }).ok("p3", { type: "ready" });
    expect(g.s.phase).toBe("discuss");
    g.ok("p4", { type: "ready" });
    expect(g.s.phase).toBe("vote");
  });

  it("R5: the discussion times out into the vote", () => {
    const g = new Game({ players: 4 });
    g.gotAll().clues();
    g.step();
    expect(g.s.phase).toBe("vote");
  });

  it("R5: pointing is public, changeable and can be lowered; never at yourself", () => {
    const g = new Game({ players: 4 });
    g.gotAll();
    g.ok("p1", { type: "point", target: "p2" });
    expect(g.view({ role: "stage" }).points["p1"]).toBe("p2");
    g.no("p1", { type: "point", target: "p2" });
    g.no("p1", { type: "point", target: "p1" });
    g.no("p1", { type: "point", target: "p9" });
    g.ok("p1", { type: "point", target: "p3" });
    g.ok("p1", { type: "point", target: null });
    g.no("p1", { type: "point", target: null });
    expect(g.s.points["p1"]).toBeNull();
  });

  it("R5: quick-chat shows one of 8 fixed lines as a bubble, keeping the last 12", () => {
    expect(QUICK_LINES).toHaveLength(8);
    expect(QUICK_LINES[0]).toBe("It's you! 👉");
    const g = new Game({ players: 4, options: { discussSec: 180 } });
    g.gotAll().clues();
    const from = g.effects.length;
    for (let i = 0; i < 14; i++) {
      g.now += 4_000;
      g.ok(g.ids[i % 4] as PlayerId, { type: "quick", line: (i % 8) as 0 });
    }
    expect(g.s.chat).toHaveLength(12);
    expect(g.s.chat.at(-1)).toEqual({ by: "p2", line: 5, at: g.now });
    expect(fxNames(g.since(from)).filter((n) => n === "bubble")).toHaveLength(14);
    expect(g.view({ role: "stage" }).chat).toHaveLength(12);
  });
});

describe("T10 point and quick", () => {
  it("T10: point and quick are accepted only in clues and discuss", () => {
    const g = new Game({ players: 4 });
    g.until("reveal");
    g.no("p1", { type: "point", target: "p2" });
    g.no("p1", { type: "quick", line: 1 });
    g.gotAll();
    g.ok("p1", { type: "point", target: "p2" }).ok("p1", { type: "quick", line: 1 });
    g.clues();
    g.now += 5_000;
    g.ok("p2", { type: "point", target: "p1" }).ok("p2", { type: "quick", line: 2 });
    g.readyAll();
    expect(g.s.phase).toBe("vote");
    g.no("p3", { type: "point", target: "p1" });
    g.no("p3", { type: "quick", line: 3 });
    expect(legalActions(g.s, "p3").some((a) => a.type === "point" || a.type === "quick")).toBe(
      false,
    );
  });

  it("T10: quick-chat is limited to one line per 4 s per player", () => {
    const g = new Game({ players: 4 });
    g.gotAll();
    g.ok("p1", { type: "quick", line: 0 });
    g.now += 3_999;
    g.no("p1", { type: "quick", line: 1 });
    g.ok("p2", { type: "quick", line: 1 });
    g.now += 1;
    g.ok("p1", { type: "quick", line: 1 });
    // legalActions only offers quick once the cooldown has passed at the state's clock.
    expect(legalActions(g.s, "p1").some((a) => a.type === "quick")).toBe(false);
  });

  it("T10: parseAction rejects quick lines outside 0–7", () => {
    for (const line of [-1, 8, 1.5, "1", null, Number.NaN]) {
      expect(parseAction({ type: "quick", line })).toBeNull();
    }
    for (const line of [0, 7])
      expect(parseAction({ type: "quick", line })).toEqual({ type: "quick", line });
    const g = new Game({ players: 4 });
    g.gotAll();
    expect(g.act("p1", { type: "quick", line: 8 })).toMatchObject({ ok: false, err: "BAD_ACTION" });
  });
});

// ---- R6 ----------------------------------------------------------------------------------------

describe("R6 vote", () => {
  it("R6: players vote secretly for another player within 20 s; votes are revealed together", () => {
    const g = new Game({ players: 5 }).toVote();
    expect(g.s.deadline).toBe(g.now + 23_000);
    g.no("p1", { type: "vote", target: "p1" });
    g.ok("p1", { type: "vote", target: "p2" });
    g.no("p1", { type: "vote", target: "p3" });
    const stage = g.view({ role: "stage" });
    expect(stage.voted).toEqual(["p1"]);
    expect(stage.revealedVotes).toBeUndefined();
    expect(JSON.stringify(g.view({ role: "player", id: "p3" }))).not.toContain('"vote":"p2"');
    expect(g.view({ role: "player", id: "p1" }).me?.vote).toBe("p2");
    g.ok("p2", { type: "vote", target: "p3" }).ok("p3", { type: "vote", target: "p2" });
    g.ok("p4", { type: "vote", target: "p2" }).ok("p5", { type: "vote", target: "p1" });
    expect(g.s.phase).toBe("accuse-reveal");
    expect(g.s.accused).toBe("p2");
    expect(g.view({ role: "stage" }).revealedVotes).toEqual({
      p1: "p2",
      p2: "p3",
      p3: "p2",
      p4: "p2",
      p5: "p1",
    });
    expect(g.view({ role: "audience" }).revealedVotes?.["p5"]).toBe("p1");
  });

  it("R6: the predict closes when the vote starts", () => {
    const g = new Game({ players: 4 }).gotAll().clues().readyAll();
    const close = of(g.effects, "audience.close");
    expect(close).toEqual([{ type: "audience.close", pollId: "predict-r1" }]);
    expect(g.s.predict?.open).toBe(false);
  });

  it("R6: missing votes don't count; the plurality is accused", () => {
    const g = new Game({ players: 5 }).toVote();
    g.ok("p1", { type: "vote", target: "p4" });
    g.step();
    expect(g.s.accused).toBe("p4");
  });

  it("R6: a tie goes to a 15 s revote among the tied, who can't vote for themselves", () => {
    const g = new Game({ players: 4 }).toVote();
    g.voteAll((v) => ({ p1: "p2", p2: "p1", p3: "p1", p4: "p2" })[v] as PlayerId);
    expect(g.s.phase).toBe("revote");
    expect(g.s.tied).toEqual(["p1", "p2"]);
    expect(g.s.deadline).toBe(g.now + 18_000);
    expect(voteTargets(g.s, "p1")).toEqual(["p2"]);
    expect(voteTargets(g.s, "p3")).toEqual(["p1", "p2"]);
    g.no("p1", { type: "vote", target: "p1" });
    g.no("p3", { type: "vote", target: "p4" });
    g.voteAll((v) => (v === "p2" ? "p1" : v === "p1" ? "p2" : "p1"));
    expect(g.s.phase).toBe("accuse-reveal");
    expect(g.s.accused).toBe("p1");
  });

  it("R6: with no votes at all everyone is tied", () => {
    expect(tally({}, ["p1", "p2", "p3"])).toEqual({ tied: ["p1", "p2", "p3"] });
    expect(tally({ p1: "p9", p2: "p3" }, ["p1", "p3"])).toEqual({ accused: "p3" });
    expect(voteCounts({ p1: "p2", p3: "p2", p2: "p1" })).toEqual({ p2: 2, p1: 1 });
  });
});

describe("T3 tie, revote, tie", () => {
  it("T3: a tie, a revote, then a second tie means the odd ones win (+3 each)", () => {
    const g = new Game({ players: 4 }).toVote();
    g.voteAll((v) => ({ p1: "p2", p2: "p1", p3: "p1", p4: "p2" })[v] as PlayerId);
    expect(g.s.phase).toBe("revote");
    g.voteAll((v) => ({ p1: "p2", p2: "p1", p3: "p1", p4: "p2" })[v] as PlayerId);
    expect(g.s.phase).toBe("round-result");
    expect(g.s.roundResult?.outcome).toBe("tie-twice");
    for (const id of g.ids) expect(g.s.scores[id]).toBe(g.odd.includes(id) ? 3 : 0);
  });

  it("T3: a revote that times out with no votes is a second tie", () => {
    const g = new Game({ players: 4 }).toVote();
    g.step();
    expect(g.s.phase).toBe("revote");
    expect(g.s.tied).toEqual(g.ids);
    g.step();
    expect(g.s.roundResult?.outcome).toBe("tie-twice");
  });
});

// ---- R7 / R8 -----------------------------------------------------------------------------------

describe("R7 accused is an odd one", () => {
  it("R7: the accused odd one picks the secret from the 12 options within 20 s", () => {
    const g = new Game({ players: 5 }).toVote();
    const odd = g.odd[0] as PlayerId;
    g.accuse(odd);
    expect(g.s.phase).toBe("accuse-reveal");
    expect(g.s.deadline).toBe(g.now + 4_000);
    expect(g.view({ role: "stage" }).category?.options).toBeUndefined();
    g.step();
    expect(g.s.phase).toBe("last-guess");
    expect(g.s.deadline).toBe(g.now + 23_000);
    const phone = g.view({ role: "player", id: odd });
    expect(phone.category?.options).toHaveLength(12);
    expect(g.view({ role: "stage" }).category?.options).toHaveLength(12);
    expect(legalActions(g.s, odd)).toHaveLength(12);
    const other = otherThan(g.ids, odd);
    expect(legalActions(g.s, other)).toEqual([]);
    g.no(other, { type: "guess", option: g.secret });
    g.no(odd, { type: "guess", option: "Not an option" });
  });

  it("R7: a correct guess steals the round: each odd one +2, regulars 0", () => {
    const g = new Game({ players: 5 }).toVote();
    const odd = g.odd[0] as PlayerId;
    g.accuse(odd).until("last-guess");
    g.ok(odd, { type: "guess", option: g.secret });
    expect(g.s.roundResult).toMatchObject({
      outcome: "caught-stole",
      guess: g.secret,
      accused: odd,
    });
    for (const id of g.ids) expect(g.s.scores[id]).toBe(id === odd ? 2 : 0);
  });

  it("R7: a wrong guess: regulars +2, +1 more for those who voted for an odd one", () => {
    const g = new Game({ players: 5 }).toVote();
    const odd = g.odd[0] as PlayerId;
    const [r1, r2, r3, r4] = g.regulars as [PlayerId, PlayerId, PlayerId, PlayerId];
    g.voteAll((v) => (v === r4 ? r1 : v === odd ? r1 : odd));
    expect(g.s.accused).toBe(odd);
    g.until("last-guess");
    const wrong = g.s.category?.options.find((o) => o !== g.secret) as string;
    g.ok(odd, { type: "guess", option: wrong });
    expect(g.s.roundResult?.outcome).toBe("caught-wrong-guess");
    expect(g.s.scores).toMatchObject({ [odd]: 0, [r1]: 3, [r2]: 3, [r3]: 3, [r4]: 2 });
    expect(g.s.hidden.guess).toBe(wrong);
  });

  it("R7: time running out on the last guess counts as a wrong guess", () => {
    const g = new Game({ players: 4 }).toVote();
    const odd = g.odd[0] as PlayerId;
    g.accuse(odd).until("last-guess");
    g.step();
    expect(g.s.roundResult).toMatchObject({ outcome: "caught-wrong-guess", guess: null });
  });

  it("R7: Undercover has no guess; regular players score +2 each", () => {
    const g = new Game({ players: 5, options: { variant: "undercover" } }).toVote();
    const odd = g.odd[0] as PlayerId;
    g.accuse(odd).step();
    expect(g.s.phase).toBe("round-result");
    expect(g.s.roundResult?.outcome).toBe("caught");
    expect(g.s.roundResult?.decoy).toBe(g.s.hidden.decoy);
    for (const id of g.ids) expect(g.s.scores[id]).toBe(id === odd ? 0 : 2);
  });

  it("R7: with 2 odd ones only the accused guesses, and a correct guess gives both +2", () => {
    const g = new Game({ players: 8 }).toVote();
    const [a, b] = g.odd as [PlayerId, PlayerId];
    g.accuse(a).until("last-guess");
    expect(legalActions(g.s, b)).toEqual([]);
    g.no(b, { type: "guess", option: g.secret });
    g.ok(a, { type: "guess", option: g.secret });
    expect(g.s.scores[a]).toBe(2);
    expect(g.s.scores[b]).toBe(2);
    expect(g.s.oddPoints[b]).toBe(2);
  });
});

describe("R8 accused is innocent", () => {
  it("R8: each odd one scores +3 and the Stage plays the Wrong! reveal of the odd ones", () => {
    const g = new Game({ players: 8 }).toVote();
    const innocent = g.regulars[0] as PlayerId;
    g.accuse(innocent);
    const from = g.effects.length;
    g.step();
    expect(g.s.phase).toBe("round-result");
    expect(g.s.roundResult).toMatchObject({ outcome: "innocent-accused", accused: innocent });
    for (const id of g.ids) expect(g.s.scores[id]).toBe(g.odd.includes(id) ? 3 : 0);
    expect(fxNames(g.since(from))).toContain("innocent-accused");
    expect(g.view({ role: "stage" }).roundResult?.odd).toEqual(g.odd);
  });
});

describe("T2 scoring table", () => {
  const players = ["p1", "p2", "p3", "p4", "p5"];
  const odd = ["p5"];
  it.each([
    ["said-word", { saidBy: "p1" }, { p1: -1, p2: 0, p3: 0, p4: 0, p5: 2 }],
    ["odd-said-word", { saidBy: "p5" }, { p1: 0, p2: 0, p3: 0, p4: 0, p5: 3 }],
    ["tie-twice", {}, { p1: 0, p2: 0, p3: 0, p4: 0, p5: 3 }],
    ["innocent-accused", {}, { p1: 0, p2: 0, p3: 0, p4: 0, p5: 3 }],
    ["caught-stole", {}, { p1: 0, p2: 0, p3: 0, p4: 0, p5: 2 }],
    [
      "caught-wrong-guess",
      { votes: { p1: "p5", p2: "p5", p3: "p1", p5: "p1" } },
      { p1: 3, p2: 3, p3: 2, p4: 2, p5: 0 },
    ],
    ["caught", {}, { p1: 2, p2: 2, p3: 2, p4: 2, p5: 0 }],
    ["void", {}, { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0 }],
  ] as const)("T2: %s", (outcome, extra, want) => {
    expect(scoreRound(outcome, { players, odd, ...extra })).toEqual(want);
  });

  it("T2: with two odd ones, R4 and R6–R8 pay both", () => {
    const two = ["p4", "p5"];
    expect(scoreRound("said-word", { players, odd: two, saidBy: "p2" })).toEqual({
      p1: 0,
      p2: -1,
      p3: 0,
      p4: 2,
      p5: 2,
    });
    expect(scoreRound("innocent-accused", { players, odd: two })).toEqual({
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 3,
      p5: 3,
    });
    expect(scoreRound("caught-stole", { players, odd: two })).toEqual({
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 2,
      p5: 2,
    });
    expect(
      scoreRound("caught-wrong-guess", {
        players,
        odd: two,
        votes: { p1: "p4", p2: "p5", p3: "p1" },
      }),
    ).toEqual({ p1: 3, p2: 3, p3: 2, p4: 0, p5: 0 });
    expect(scoreRound("said-word", { players, odd: two })).toEqual({
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 2,
      p5: 2,
    });
    expect(scoreRound("odd-said-word", { players, odd: two })).toEqual({
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 0,
      p5: 0,
    });
  });

  it("T2: every in-game outcome awards exactly the table's points", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sim = simulateGame(logic, { seed, players: 4 + (seed % 7), content: () => content() });
      const s = sim.finalState;
      const total = s.history.reduce(
        (a, r) => a + Object.values(r.points).reduce((x, y) => x + y, 0),
        0,
      );
      expect(Object.values(s.scores).reduce((a, b) => a + b, 0)).toBe(total);
      for (const r of s.history) {
        const ids = s.players.map((p) => p.id);
        if (r.outcome === "caught-wrong-guess") {
          for (const id of ids) {
            if (r.odd.includes(id)) expect(r.points[id]).toBe(0);
            else expect([2, 3]).toContain(r.points[id]);
          }
          continue;
        }
        expect(r.points).toEqual(
          scoreRound(r.outcome, {
            players: ids,
            odd: r.odd,
            ...(r.saidBy !== undefined ? { saidBy: r.saidBy } : {}),
          }),
        );
      }
    }
  }, 300_000);
});

// ---- R9 ----------------------------------------------------------------------------------------

describe("R9 match end", () => {
  it("R9: after `rounds` rounds the final podium, then end with the ranking and highlight", () => {
    const g = new Game({ players: 4, options: { rounds: 2 } });
    g.toVote();
    const odd1 = g.odd[0] as PlayerId;
    g.accuse(otherThan(g.ids, odd1)).until("round-result");
    g.step();
    expect(g.s.phase).toBe("deal");
    expect(g.s.round).toBe(2);
    expect(g.s.roundResult).toBeUndefined();
    g.toVote();
    const odd2 = g.odd[0] as PlayerId;
    g.accuse(odd2).until("last-guess");
    g.ok(odd2, { type: "guess", option: g.secret });
    g.step();
    expect(g.s.phase).toBe("final");
    expect(g.s.deadline).toBe(g.now + 8_000);
    const from = g.effects.length;
    g.step();
    expect(g.runner.ended).toBe(true);
    const end = of(g.since(from), "end")[0] as Extract<Effect, { type: "end" }>;
    expect(end.result).toEqual(gameResult(g.s));
    expect(g.s.history).toHaveLength(2);
    expect(end.result.ranking[0]?.score).toBe(Math.max(...Object.values(g.s.scores)));
    expect(end.result.highlights?.[0]?.label).toBe("Master of Disguise");
    expect(g.runner.scores).toEqual(
      Object.fromEntries(Object.entries(g.s.scores).filter(([, v]) => v !== 0)),
    );
  });

  it("R9: ties share the place; Master of Disguise goes to the most points as an odd one", () => {
    const players = makeSeats(5).map((s) => ({ ...s }));
    expect(ranking(players, { p1: 3, p2: 5, p3: 3, p4: 0, p5: 5 })).toEqual([
      { id: "p2", score: 5, place: 1 },
      { id: "p5", score: 5, place: 1 },
      { id: "p1", score: 3, place: 3 },
      { id: "p3", score: 3, place: 3 },
      { id: "p4", score: 0, place: 5 },
    ]);
    expect(mastersOfDisguise(players, { p1: 3, p2: 5 })).toEqual(["p2"]);
    expect(mastersOfDisguise(players, { p1: 3, p3: 3 })).toEqual(["p1", "p3"]);
    expect(mastersOfDisguise(players, {})).toEqual([]);
    const state = { players, scores: { p1: 1 }, oddPoints: {} } as unknown as OooState;
    expect(gameResult(state).highlights).toBeUndefined();
  });
});

// ---- R10 ---------------------------------------------------------------------------------------

describe("R10 disconnects", () => {
  it("R10: a disconnected regular's bot clues from the clue bank; an odd one's from generic clues", () => {
    const g = new Game({ players: 5 });
    g.gotAll();
    const reg = g.regulars[0] as PlayerId;
    const odd = g.odd[0] as PlayerId;
    const bank = g.s.hidden.bank.map(toClue);
    const generic = g.s.hidden.generic.map(toClue);
    expect(bank).toContain(clueCandidates(g.s, reg)[0]);
    expect(generic).toContain(clueCandidates(g.s, odd)[0]);
    for (const c of clueCandidates(g.s, reg)) expect(says(c, g.secret)).toBe(false);
    // Taken over by the runner's bot, the clue comes out on its turn.
    for (const id of g.ids) g.runner.setBot(id, true, g.now);
    g.wait(1);
    const byReg = g.s.clues.find((c) => c.by === reg);
    const byOdd = g.s.clues.find((c) => c.by === odd);
    expect([...bank, ...generic, ...FALLBACK_GENERIC]).toContain(byReg?.text);
    expect([...generic, ...FALLBACK_GENERIC]).toContain(byOdd?.text);
  });

  it("R10: a bot votes for a legal target and an accused odd one's bot makes a random guess", () => {
    const g = new Game({ players: 5 }).toVote();
    const rng = createRng(3);
    for (const id of g.ids) {
      const a = bot(g.s, id, rng);
      expect(a?.type).toBe("vote");
      expect(voteTargets(g.s, id)).toContain((a as { target: PlayerId }).target);
    }
    const odd = g.odd[0] as PlayerId;
    g.accuse(odd).until("last-guess");
    const guess = bot(g.s, odd, rng);
    expect(g.s.category?.options).toContain((guess as { option: string }).option);
    expect(bot(g.s, otherThan(g.ids, odd), rng)).toBeNull();
  });

  it("R10: an odd one still disconnected when the vote starts voids the round", () => {
    const g = new Game({ players: 5 }).gotAll().clues();
    const odd = g.odd[0] as PlayerId;
    g.leave(odd);
    expect(g.view({ role: "stage" }).players.find((p) => p.id === odd)?.away).toBe(true);
    const from = g.effects.length;
    g.readyAll();
    expect(g.s.phase).toBe("round-result");
    expect(g.s.roundResult?.outcome).toBe("void");
    expect(Object.values(g.s.scores).every((v) => v === 0)).toBe(true);
    expect(of(g.since(from), "audience.resolve")).toEqual([
      { type: "audience.resolve", pollId: "predict-r1" },
    ]);
    g.step();
    expect(g.s.phase).toBe("deal");
    expect(g.s.round).toBe(2);
  });

  it("R10: reconnecting before the vote keeps the round alive", () => {
    const g = new Game({ players: 5 }).gotAll();
    const odd = g.odd[0] as PlayerId;
    g.leave(odd);
    g.leave(odd);
    g.clues();
    g.rejoin(odd);
    g.rejoin(odd);
    expect(g.s.away).toEqual([]);
    g.readyAll();
    expect(g.s.phase).toBe("vote");
    expect(g.s.roundResult).toBeUndefined();
  });

  it("R10: a disconnected voter is not waited for, and an accused who left still stands", () => {
    const g = new Game({ players: 5 }).toVote();
    const reg = g.regulars[0] as PlayerId;
    g.leave(reg);
    g.accuse(reg);
    expect(g.s.accused).toBe(reg);
    const h = new Game({ players: 5 }).toVote();
    const others = h.ids.filter((id) => id !== "p5");
    for (const id of others) h.ok(id, { type: "vote", target: id === "p1" ? "p2" : "p1" });
    expect(h.s.phase).toBe("vote");
    h.leave("p5");
    expect(h.s.phase).toBe("accuse-reveal");
  });
});

describe("T7 disconnected odd one", () => {
  it("T7: still disconnected at vote start voids; back before it does not; bot clues are generic", () => {
    const g = new Game({ players: 6 }).gotAll();
    const odd = g.odd[0] as PlayerId;
    g.leave(odd);
    g.runner.setBot(odd, true, g.now);
    const generic = [...g.s.hidden.generic.map(toClue), ...FALLBACK_GENERIC];
    g.clues(99, (giver) => clueCandidates(g.s, giver)[0] as string);
    for (const c of g.s.clues.filter((c) => c.by === odd)) expect(generic).toContain(c.text);
    g.readyAll();
    expect(g.s.roundResult?.outcome).toBe("void");

    const h = new Game({ players: 6 }).gotAll();
    const o2 = h.odd[0] as PlayerId;
    h.leave(o2);
    h.clues();
    h.rejoin(o2);
    h.readyAll();
    expect(h.s.phase).toBe("vote");
  });
});

// ---- R11 / T5 / T6 -----------------------------------------------------------------------------

/** Every viewer of the Views table for a game's seats. */
const viewers = (ids: readonly PlayerId[]): ViewerKey[] => [
  { role: "stage" },
  { role: "audience" },
  { role: "audience", restricted: true },
  { role: "host" },
  { role: "moderator" },
  ...ids.map((id): ViewerKey => ({ role: "player", id })),
];

/** Strips the parts of a view that may legitimately name the secret or odd ones. */
function scrub(view: OooView): unknown {
  const v = structuredClone(view) as Partial<OooView> & Record<string, unknown>;
  delete v.roundResult;
  delete v.history;
  delete v.me;
  delete v.secret;
  if (v.category) delete v.category.options;
  delete v.clues;
  return v;
}

/** Checks one state against the Views table; returns the violations. */
function viewProblems(module: typeof logic, s: OooState): string[] {
  const out: string[] = [];
  const live = s.hidden.secret !== "" && s.phase !== "intro" && s.phase !== "final";
  const revealed = s.roundResult !== undefined;
  for (const viewer of viewers(s.players.map((p) => p.id))) {
    const view = module.view(s, viewer);
    const name = viewer.role + (viewer.role === "player" ? `:${viewer.id}` : "");
    const text = JSON.stringify(view);
    if (text.includes('"hidden"')) out.push(`${name} has hidden`);
    if (text.includes('"deck"') || text.includes('"bank"')) out.push(`${name} has deck/bank`);
    const rest = JSON.stringify(scrub(view));
    if (live && rest.includes(`"${s.hidden.secret}"`)) out.push(`${name} sees the secret`);
    if (s.hidden.decoy !== undefined && rest.includes(`"${s.hidden.decoy}"`))
      out.push(`${name} sees the decoy`);
    if (!revealed && view.roundResult !== undefined) out.push(`${name} result early`);
    // "who is odd": only through roundResult / history, and a Classic odd one's own card.
    if (rest.includes('"odd"')) out.push(`${name} has an odd list outside the result`);
    const shouldSee =
      live &&
      (viewer.role === "audience"
        ? viewer.restricted !== true && s.options.audienceSecret === "phones"
        : viewer.role === "host" || viewer.role === "moderator"
          ? !s.room.hostSeated
          : false);
    if ((view.secret !== undefined) !== shouldSee)
      out.push(`${name} secret field ${String(view.secret)}`);
    if (view.secret !== undefined && view.secret !== s.hidden.secret)
      out.push(`${name} wrong secret`);
    if (
      (viewer.role === "host" || viewer.role === "moderator") &&
      s.room.hostSeated !== (view.hostSeated === true)
    ) {
      out.push(`${name} hostSeated flag`);
    }
    if (viewer.role === "player") {
      const me = view.me;
      if (me === undefined) {
        out.push(`${name} has no card`);
        continue;
      }
      const odd = s.hidden.odd.includes(viewer.id);
      const inRoundNow = s.hidden.odd.length > 0 && !["intro", "final"].includes(s.phase);
      const want = !inRoundNow ? null : odd ? (s.hidden.decoy ?? null) : s.hidden.secret;
      if (me.word !== want) out.push(`${name} word ${me.word} want ${want}`);
      if (me.odd !== (inRoundNow && odd && s.variant === "classic")) out.push(`${name} odd flag`);
      const own = s.hidden.votes[viewer.id] ?? null;
      if ((s.phase === "vote" || s.phase === "revote") && me.vote !== own)
        out.push(`${name} own vote`);
      const ballots = structuredClone(view) as Partial<OooView>;
      delete ballots.points;
      delete ballots.revealedVotes;
      delete ballots.me;
      const btext = JSON.stringify(ballots);
      for (const [voter, target] of Object.entries(s.hidden.votes)) {
        if (voter !== viewer.id && btext.includes(`"${voter}":"${target}"`)) {
          out.push(`${name} sees ${voter}'s ballot`);
        }
      }
    } else if (view.me !== undefined) out.push(`${name} has a card`);
    if (viewer.role !== "player" && (s.phase === "vote" || s.phase === "revote")) {
      if (view.revealedVotes !== undefined && s.phase === "vote") out.push(`${name} votes early`);
    }
  }
  return out;
}

describe("R11 anti-sniping", () => {
  it("R11: the Stage never has the secret until the round-result reveal", () => {
    const g = new Game({ players: 5 }).toVote();
    const stage = () => JSON.stringify(scrub(g.view({ role: "stage" })));
    expect(stage()).not.toContain(g.secret);
    expect(g.view({ role: "stage" }).secret).toBeUndefined();
    const odd = g.odd[0] as PlayerId;
    g.accuse(odd).until("last-guess");
    g.step();
    expect(g.view({ role: "stage" }).roundResult?.word).toBe(g.secret);
  });

  it("R11: audience phones get the secret with audienceSecret phones; the restricted view never", () => {
    const g = new Game({ players: 4 }).gotAll();
    expect(g.view({ role: "audience" }).secret).toBe(g.secret);
    expect(g.view({ role: "audience", restricted: true }).secret).toBeUndefined();
    const off = new Game({ players: 4, options: { audienceSecret: "off" } }).gotAll();
    expect(off.view({ role: "audience" }).secret).toBeUndefined();
  });

  it("R11: the host panel shows the secret only when the host is not seated, never who is odd", () => {
    const g = new Game({ players: 4 }).gotAll();
    expect(g.view({ role: "host" }).secret).toBe(g.secret);
    expect(g.view({ role: "moderator" }).secret).toBe(g.secret);
    expect(JSON.stringify(scrub(g.view({ role: "host" })))).not.toContain('"odd"');
    const seated = new Game({ players: 4, room: { hostSeated: true } }).gotAll();
    expect(seated.view({ role: "host" }).secret).toBeUndefined();
    expect(seated.view({ role: "host" }).hostSeated).toBe(true);
    expect(seated.view({ role: "moderator" }).hostSeated).toBe(true);
  });

  it("R11: no secret anywhere before the first deal or on the final podium", () => {
    const g = new Game({ players: 4 });
    for (const v of viewers(g.ids)) {
      const view = g.view(v);
      expect(view.secret).toBeUndefined();
      expect(view.me?.word ?? null).toBeNull();
    }
    const finished = new Game({ players: 4, options: { rounds: 2 } });
    for (let round = 0; round < 2; round++) {
      finished.toVote();
      const odd = finished.odd[0] as PlayerId;
      finished.accuse(otherThan(finished.ids, odd)).until("round-result");
      finished.step();
    }
    expect(finished.s.phase).toBe("final");
    for (const v of viewers(finished.ids)) {
      const view = finished.view(v);
      expect(view.secret).toBeUndefined();
      expect(view.me?.word ?? null).toBeNull();
      expect(view.me?.odd ?? false).toBe(false);
    }
  });
});

describe("T5 secrecy fuzz", () => {
  const variants = [
    { name: "classic", module: logic, options: {} },
    { name: "undercover", module: logic, options: { variant: "undercover" as const } },
    { name: "audience off", module: logic, options: { audienceSecret: "off" as const } },
    { name: "host seated", module: createOddOneOut({ hostSeated: true }), options: {} },
    {
      name: "host seated undercover",
      module: createOddOneOut({ hostSeated: true }),
      options: { variant: "undercover" as const },
    },
  ];
  it.each(variants)(
    "T5: every view of every step follows the Views table ($name)",
    ({ module, options }) => {
      const problems: string[] = [];
      let states = 0;
      for (let i = 0; i < 24; i++) {
        const players = 4 + (i % 7);
        simulateGame(module, {
          seed: 500 + i,
          players,
          options: { ...options, rounds: 2 },
          policy: "mixed",
          content: () => content(),
          dev: false,
          onStep: ({ state }) => {
            states++;
            if (problems.length < 5) {
              for (const p of viewProblems(module, state))
                problems.push(`seed ${500 + i}: ${state.phase}: ${p}`);
            }
          },
        });
      }
      expect(problems).toEqual([]);
      expect(states).toBeGreaterThan(1_000);
    },
    300_000,
  );
});

describe("T6 Undercover card", () => {
  it("T6: the Undercover odd one sees the decoy as if it were the secret, never the odd label", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const g = new Game({ seed, players: 6, options: { variant: "undercover" } });
      g.until("reveal");
      const odd = g.odd[0] as PlayerId;
      const reg = g.regulars[0] as PlayerId;
      const vo = g.view({ role: "player", id: odd });
      const vr = g.view({ role: "player", id: reg });
      expect(vo.me?.word).toBe(g.s.hidden.decoy);
      expect(vo.me?.odd).toBe(false);
      expect(Object.keys(vo.me ?? {})).toEqual(Object.keys(vr.me ?? {}));
      expect(Object.keys(vo)).toEqual(Object.keys(vr));
      expect(JSON.stringify(vo)).not.toMatch(/Odd One|"odd":true/);
      expect(JSON.stringify(scrub(vo))).not.toContain(`"${g.secret}"`);
    }
  });
});

// ---- T8 / audience hooks -----------------------------------------------------------------------

describe("T8 predict poll", () => {
  it("T8: opens at the clues with every player as an option", () => {
    const g = new Game({ players: 5 });
    g.until("reveal");
    expect(of(g.effects, "audience.open")).toEqual([]);
    const from = g.effects.length;
    g.gotAll();
    const open = of(g.since(from), "audience.open")[0] as Extract<
      Effect,
      { type: "audience.open" }
    >;
    expect(open.poll).toMatchObject({
      pollId: "predict-r1",
      kind: "predict",
      prompt: "Who's the Odd One?",
    });
    expect(open.poll.options).toEqual(g.s.players.map((p) => ({ id: p.id, label: p.name })));
    // It runs at most as long as every clue turn plus the discussion.
    expect(open.poll.closesAtMs).toBe(g.now + 10 * 23_000 + 48_000);
    g.audience("predict-r1", { p1: 4, p2: 9 });
    expect(g.s.predict).toEqual({
      pollId: "predict-r1",
      open: false,
      tallies: { p1: 4, p2: 9 },
      total: 13,
    });
    g.audience("predict-r1", { p1: 99 });
    g.audience("other", { p1: 99 });
    expect(g.s.predict?.tallies).toEqual({ p1: 4, p2: 9 });
  });

  it("T8: resolves with the odd one", () => {
    const g = new Game({ players: 5 }).toVote();
    const odd = g.odd[0] as PlayerId;
    g.accuse(otherThan(g.ids, odd)).until("round-result");
    expect(of(g.effects, "audience.resolve")).toEqual([
      { type: "audience.resolve", pollId: "predict-r1", correct: odd },
    ]);
  });

  it("T8: with 2 odd ones: the accused odd one, else the first odd one", () => {
    const g = new Game({ players: 9 }).toVote();
    const [a, b] = g.odd as [PlayerId, PlayerId];
    g.accuse(b).until("last-guess");
    g.step();
    expect(of(g.effects, "audience.resolve")[0]).toMatchObject({ correct: b });
    const h = new Game({ players: 9 }).toVote();
    const first = h.odd[0] as PlayerId;
    h.accuse(h.regulars[0] as PlayerId).until("round-result");
    expect(of(h.effects, "audience.resolve")[0]).toMatchObject({ correct: first });
    expect(a).not.toBe(b);
  });

  it("T8: a round ended by a said word closes and resolves the still-open poll", () => {
    const g = atGiver("regular");
    const sayer = currentGiver(g.s) as PlayerId;
    const odd = g.odd[0];
    const from = g.effects.length;
    g.ok(sayer, { type: "clue", text: g.secret });
    // The close (and the resolve queued behind it) waits for the minimum audience window.
    expect(g.since(from).map((e) => e.type)).not.toContain("audience.resolve");
    g.wait(8_000);
    const types = g.since(from).map((e) => e.type);
    expect(types).toContain("audience.resolve");
    expect(of(g.since(from), "audience.resolve")[0]).toMatchObject({ correct: odd });
  });
});

// ---- T9 ----------------------------------------------------------------------------------------

describe("T9 bots", () => {
  it("T9: bots complete 4–10 players in both variants", () => {
    for (const variant of ["classic", "undercover"] as const) {
      for (let n = 4; n <= 10; n++) {
        const sim = simulateGame(logic, {
          seed: n * 7,
          players: n,
          options: { variant },
          content: () => content(),
          maxSteps: 1_000,
        });
        expect(sim.ended, `${variant} ${n}p ${sim.failure ?? ""}`).toBe(true);
        expect(sim.illegalActions).toBe(0);
        expect(sim.finalState.history).toHaveLength(3);
        expect(sim.result?.ranking).toHaveLength(n);
      }
    }
  }, 300_000);
});

// ---- Content and plumbing ----------------------------------------------------------------------

describe("content", () => {
  it("Undercover prefers pairs inside one category and uses its spelling and options", () => {
    const deck = dealDeck(
      content(),
      { ...DEFAULTS, variant: "undercover", rounds: 8 },
      8,
      createRng(4),
    );
    expect(deck.ok).toBe(true);
    if (!deck.ok) return;
    for (const card of deck.deck) {
      expect(card.category.options).toContain(card.secret);
      expect(card.category.options).toContain(card.decoy);
      expect(card.pairKey).toMatch(/\|/);
      expect(card.category.id.startsWith("fx-")).toBe(true);
    }
    const words = deck.deck.flatMap((c) => [clueKey(c.secret), clueKey(c.decoy as string)]);
    expect(new Set(words).size).toBe(words.length);
  });

  it("Undercover falls back to the pair's own category, and fails with too few pairs", () => {
    const pairs = {
      ...FIXTURE_PAIRS_PACK,
      items: [
        { a: "Coffee", b: "Tea", category: "Drinks" },
        { a: "Cat", b: "Kitten", category: "Animals" },
      ],
    } as AnyPack;
    const c = packContent([FIXTURE_CORE_PACK, pairs]);
    const deck = dealDeck(c, { ...DEFAULTS, variant: "undercover" }, 2, createRng(1));
    expect(deck.ok).toBe(true);
    if (!deck.ok) return;
    const drinks = deck.deck.find((d) => d.category.name === "Drinks");
    expect(drinks?.category).toEqual({
      id: "pair:coffee|tea",
      name: "Drinks",
      options: ["Coffee", "Tea"],
    });
    expect(drinks?.generic).toEqual([...FALLBACK_GENERIC]);
    expect(drinks?.bank).toEqual([]);
    const animals = deck.deck.find((d) => d.category.name === "Animals");
    expect(animals?.generic).toEqual(FIXTURE_CATEGORIES[1]?.genericClues);
    if (animals?.secret === "Cat")
      expect(animals.bank).toEqual(FIXTURE_CATEGORIES[1]?.clueBank["Cat"]);
    const few = dealDeck(c, { ...DEFAULTS, variant: "undercover" }, 3, createRng(1));
    expect(few).toEqual({ ok: false, error: expect.stringMatching(/3 word pairs/) });
    const g = new Game({ packs: [FIXTURE_CORE_PACK], options: { variant: "undercover" } });
    expect(g.s.error).toMatch(/word pairs/);
  });

  it("Undercover pairs used earlier in the session come last; duplicate pairs are dropped", () => {
    const dup = {
      ...FIXTURE_PAIRS_PACK,
      id: "dup",
      items: [
        { a: "Dog", b: "Cat", category: "Animals" },
        { a: "Same", b: "same", category: "X" },
      ],
    } as AnyPack;
    const c = fakeContent([FIXTURE_CORE_PACK, FIXTURE_PAIRS_PACK, dup], { validate: false });
    expect(loadPairs(c)).toHaveLength(FIXTURE_PAIRS.length);
    const used = FIXTURE_PAIRS.slice(0, 17).map((p) => `${p.a}|${p.b}`);
    const u = fakeContent([FIXTURE_CORE_PACK, FIXTURE_PAIRS_PACK], { used: { "ooo-pairs": used } });
    const deck = dealDeck(u, { ...DEFAULTS, variant: "undercover" }, 1, createRng(2));
    expect(deck.ok && deck.deck[0]?.pairKey).toBe("Trumpet|Tuba");
  });

  it("the room marks played content used: keys appear verbatim in the final state", () => {
    const sim = simulateGame(logic, {
      seed: 3,
      players: 5,
      options: { variant: "undercover" },
      content: () => content(),
    });
    const text = logic.serialize(sim.finalState);
    for (const key of sim.finalState.hidden.used) expect(text).toContain(key);
    expect(sim.finalState.hidden.used.some((k) => k.includes("|"))).toBe(true);
  });
});

describe("plumbing", () => {
  it("parseAction keeps only valid fields and never throws", () => {
    expect(parseAction({ type: "gotIt", extra: 1 })).toEqual({ type: "gotIt" });
    expect(parseAction({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseAction({ type: "clue", text: "x" })).toEqual({ type: "clue", text: "x" });
    expect(parseAction({ type: "clue", text: "x".repeat(201) })).toBeNull();
    expect(parseAction({ type: "clue", text: 3 })).toBeNull();
    expect(parseAction({ type: "vote", target: "p1" })).toEqual({ type: "vote", target: "p1" });
    expect(parseAction({ type: "vote", target: "" })).toBeNull();
    expect(parseAction({ type: "vote", target: "x".repeat(65) })).toBeNull();
    expect(parseAction({ type: "guess", option: "Apple" })).toEqual({
      type: "guess",
      option: "Apple",
    });
    expect(parseAction({ type: "guess", option: "" })).toBeNull();
    expect(parseAction({ type: "point", target: null })).toEqual({ type: "point", target: null });
    expect(parseAction({ type: "point", target: "p2" })).toEqual({ type: "point", target: "p2" });
    expect(parseAction({ type: "point", target: 2 })).toBeNull();
    expect(parseAction({ type: "nope" })).toBeNull();
    expect(parseAction(null)).toBeNull();
    expect(parseAction([{ type: "ready" }])).toBeNull();
  });

  it("non-players, the host role and unknown timers change nothing", () => {
    const g = new Game({ players: 4 });
    g.until("reveal");
    const s = g.s;
    const ctx = {
      rng: createRng(1),
      now: g.now,
      timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
      audienceCount: 0,
    };
    expect(
      logic.onAction(s, { type: "gotIt" }, { ...ctx, actor: { id: "p1", role: "host" } }).state,
    ).toBe(s);
    expect(
      logic.onAction(s, { type: "gotIt" }, { ...ctx, actor: { id: "zz", role: "player" } }).state,
    ).toBe(s);
    expect(logic.onTimer?.(s, "other", ctx).state).toBe(s);
    expect(logic.onHostCommand?.(s, { c: "skipItem", itemId: "x" }, ctx).state).toBe(s);
    expect(logic.onPlayerLeave?.(s, "zz", ctx).state).toBe(s);
    expect(logic.onPlayerRejoin?.(s, "p1", ctx).state).toBe(s);
    expect(logic.view(s, { role: "player", id: "zz" }).me).toBeUndefined();
    expect(legalActions(s, "zz")).toEqual([]);
    expect(bot(s, "zz", createRng(1))).toBeNull();
    expect(logic.deserialize(logic.serialize(s))).toEqual(s);
  });

  it("forceAdvance moves every phase along like its timer", () => {
    const g = new Game({ players: 4, timerScale: 0 });
    const seen: string[] = [];
    for (let i = 0; i < 200 && !g.runner.ended; i++) {
      seen.push(g.s.phase);
      g.host();
    }
    expect(g.runner.ended).toBe(true);
    for (const p of [
      "intro",
      "deal",
      "reveal",
      "clues",
      "discuss",
      "vote",
      "revote",
      "round-result",
      "final",
    ]) {
      expect(seen).toContain(p);
    }
  });

  it("legalActions: the clue sample is the bot's choice; talk actions everywhere they apply", () => {
    const g = new Game({ players: 4 }).gotAll();
    const giver = currentGiver(g.s) as PlayerId;
    const acts = legalActions(g.s, giver);
    expect(acts[0]).toEqual({ type: "clue", text: clueCandidates(g.s, giver)[0] });
    expect(acts.filter((a) => a.type === "point")).toHaveLength(3);
    expect(acts.filter((a) => a.type === "quick")).toHaveLength(8);
    g.ok(giver, { type: "point", target: otherThan(g.ids, giver) });
    expect(legalActions(g.s, giver).filter((a) => a.type === "point")).toContainEqual({
      type: "point",
      target: null,
    });
    g.clues().readyAll();
    g.accuse("p1").until("accuse-reveal");
    expect(legalActions(g.s, "p1")).toEqual([]);
  });

  it("bot: taps, points once, one quick line, then ready; nothing to do elsewhere", () => {
    const g = new Game({ players: 4 }).gotAll();
    const rng = createRng(9);
    const giver = currentGiver(g.s) as PlayerId;
    expect(bot(g.s, giver, rng)?.type).toBe("clue");
    g.clues().until("discuss");
    const p = "p1";
    const first = bot(g.s, p, rng);
    expect(first?.type).toBe("point");
    g.ok(p, first as never);
    const seen = new Set<string>();
    for (let i = 0; i < 4 && !g.s.ready.includes(p); i++) {
      const a = bot(g.s, p, rng);
      if (a === null) break;
      seen.add(a.type);
      g.now += 4_000;
      g.ok(p, a);
    }
    expect(seen.has("ready")).toBe(true);
    expect(bot(g.s, p, rng)).toBeNull();
    const intro = new Game({ players: 4 });
    expect(bot(intro.s, "p1", rng)).toBeNull();
    expect(legalActions(intro.s, "p1")).toEqual([]);
  });

  it("clue candidates skip used, unsafe and over-long clues and never run dry", () => {
    const g = new Game({ players: 4 }).gotAll();
    const reg = g.regulars[0] as PlayerId;
    const s = structuredClone(g.s);
    s.hidden.bank = ["two words here", "x".repeat(30), `${s.hidden.secret}ish`];
    s.hidden.generic = [];
    s.clues = FALLBACK_GENERIC.map((t) => ({ by: "p1", text: t, pass: 0 }));
    expect(clueCandidates(s, reg)).toEqual(["two-words-here"]);
    s.hidden.bank = [];
    expect(clueCandidates(s, reg)).toEqual(["hmm"]);
  });

  it("involves: role cards and the accusation through the result involve every player", () => {
    const g = new Game({ players: 4 });
    expect(involves(g.s, "p1")).toBe(false);
    g.until("reveal");
    expect(involves(g.s, "p1")).toBe(true);
    expect(involves(g.s, "zz")).toBe(false);
    g.gotAll();
    expect(involves(g.s, "p1")).toBe(false);
  });

  it("scenarios: every spec scenario resolves for its roles with the spec's anims", () => {
    const want: Record<string, string | null> = {
      "reveal-roles": null,
      clues: "lantern 1200",
      discuss: "bubble 600",
      "vote-reveal": "strings 2000",
      "last-guess": null,
      "odd-caught": "mask 1500",
      "odd-wins": "mask 1500",
      final: "win 2000",
    };
    for (const [id, anim] of Object.entries(want)) {
      const sc = scenarios[id];
      expect(sc, id).toBeDefined();
      expect(sc?.anim ? `${sc.anim.name} ${sc.anim.durationMs}` : null).toBe(anim);
    }
    const phase = (id: string, role: "stage" | "player" | "audience" | "host" = "stage") =>
      resolveScenario(logic, scenarios, { state: id, role, seed: 1 });
    const reveal = phase("reveal-roles", "player");
    expect(reveal.state.phase).toBe("reveal");
    expect(reveal.view.me?.odd).toBe(false);
    expect(reveal.view.me?.word).toBe(reveal.state.hidden.secret);
    expect(phase("reveal-roles-odd", "player").view.me?.odd).toBe(true);
    const clues = phase("clues");
    expect(clues.state.clues).toHaveLength(11);
    expect(currentGiver(clues.state)).toBe("p4");
    expect(clues.state.turn.pass).toBe(1);
    expect(clues.fx.map((f) => f.name)).toEqual(["lantern", "audience-tally"]);
    expect(phase("midgame").state.phase).toBe("clues");
    const discuss = phase("discuss", "player");
    expect(discuss.state.ready).toHaveLength(3);
    expect(Object.values(discuss.state.points).filter((p) => p !== null)).toHaveLength(4);
    expect(discuss.state.chat.filter((c) => discuss.state.clock - c.at < 3_000)).toHaveLength(2);
    expect(discuss.view.me?.odd).toBe(false);
    const vr = phase("vote-reveal");
    expect(vr.state.phase).toBe("accuse-reveal");
    expect(vr.view.revealedVotes).toBeDefined();
    const lg = phase("last-guess", "player");
    expect(lg.state.phase).toBe("last-guess");
    expect(lg.view.category?.options).toHaveLength(12);
    expect(lg.view.me?.odd).toBe(true);
    expect(phase("odd-caught").state.roundResult?.outcome).toBe("caught-wrong-guess");
    expect(phase("odd-wins").state.roundResult?.outcome).toBe("innocent-accused");
    const fin = phase("final");
    expect(fin.state.phase).toBe("final");
    expect(gameResult(fin.state).highlights?.[0]?.label).toBe("Master of Disguise");
    for (const id of Object.keys(scenarios)) {
      for (const role of ["stage", "player", "audience", "host"] as const) {
        const r = phase(id, role);
        expect(r.state.deadline === null || r.state.deadline > 1_000_000 - 1).toBe(true);
        expect(r.view.phase).toBe(r.state.phase);
      }
      // Deterministic for a seed.
      expect(JSON.stringify(phase(id).state)).toBe(JSON.stringify(phase(id).state));
    }
    expect(T0).toBe(1_000_000);
  });
});
