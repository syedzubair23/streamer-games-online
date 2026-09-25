/**
 * Quip Clash rule tests (DOD G3): every numbered rule (R1–R14, R3a) and test case (T1–T16) of
 * `docs/specs/quip-clash.md` has a test named with its number.
 */
import { describe, expect, it } from "vitest";
import { createTiming, resolveScenario, type Effect, type SetupContext } from "@sg/engine";
import { findLeaks, makeSeats, simulateGame } from "@sg/engine/testing";
import { createRng, type Rng } from "@sg/shared";
import {
  AUDIENCE_WAIT_MS,
  bot,
  buildAuthors,
  cleanAnswer,
  createQuipClash,
  currentPrompt,
  freshAnswer,
  gameResult,
  involves,
  isJinx,
  legalActions,
  logic,
  manifest,
  optionSpecs,
  parseAction,
  ranking,
  resolveRoomSettings,
  roundPrompts,
  roundWinner,
  scoreAutoWin,
  scoreJinx,
  scoreLastQuip,
  scoreMatchup,
  selectPrompts,
  TEAM_NOTE,
  TIMER,
  type QcOptions,
  type QcState,
} from "../src/logic/index.ts";
import { bot as botEntry } from "../src/bot.ts";
import {
  FIXTURE_CORE_PACK,
  FIXTURE_SPICY_PACK,
  packContent,
  SCENARIO_NOW,
  scenarios,
} from "../src/scenarios.ts";
import { content, Game, roomTeams, T0, teamSeats } from "./helpers.ts";

/** Whole-game loops take about 1.5 s alone; the full coverage run under load needs headroom. */
const HEAVY_TIMEOUT_MS = 60_000;

const SAFETY = new Set(
  [...FIXTURE_CORE_PACK.items, ...FIXTURE_SPICY_PACK.items].flatMap((i) =>
    "safety" in i ? [...i.safety] : [],
  ),
);

const effectsOf = <T extends Effect["type"]>(effects: readonly Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);

/** Every voter votes `choice` (or per-voter choices), then the audience result arrives. */
function finishVote(g: Game, choices: string[] | string = "A", tallies?: Record<string, number>) {
  const voters = g.voters();
  voters.forEach((v, i) => {
    const choice = typeof choices === "string" ? choices : choices[i];
    if (choice !== undefined) g.ok(v, { type: "vote", choice });
  });
  if (g.s.phase === "vote" && !g.s.closing) g.step();
  if (tallies !== undefined) g.audience(g.s.aud?.pollId as string, tallies);
  else g.audience(g.s.aud?.pollId as string, {}, 0);
}

/** Plays rounds 1 (and 2) with default answers until round 3's answer phase. */
function toRound3(g: Game): Game {
  for (let i = 0; i < 300; i++) {
    const s = g.s;
    if (s.phase === "answer" && s.round === 3) return g;
    if (s.phase === "answer") g.answerAll();
    else if (s.phase === "vote") finishVote(g);
    else g.step();
  }
  throw new Error("never reached round 3");
}

const view = (g: Game, role: "stage" | "audience" | "host") => JSON.stringify(g.view({ role }));

describe("setup and manifest", () => {
  it("R12: the manifest and options follow the spec", () => {
    expect(manifest).toMatchObject({
      id: "quip-clash",
      minPlayers: 3,
      maxPlayers: 8,
      tickHz: 0,
      renderMode: "on-demand",
      teamSupport: "optional",
      audience: { vote: true, predict: true },
      estMinutes: [12, 15],
      contentRating: "all",
    });
    for (const step of manifest.howToPlay) expect(step.length).toBeLessThanOrEqual(60);
    expect(optionSpecs.map((o) => o.key)).toEqual([
      "packs",
      "answerSec",
      "voteSec",
      "audienceWeight",
      "rounds",
      "safetyQuip",
    ]);
    expect(botEntry).toBe(bot);
  });

  it("starts in intro (pace 6000) and moves to round 1 answering", () => {
    const g = new Game({ players: 6 });
    expect(g.s.phase).toBe("intro");
    expect(g.s.deadline).toBeNull();
    expect(g.timerAt()).toBe(T0 + 6000);
    g.step();
    expect(g.s.phase).toBe("answer");
    expect(g.s.round).toBe(1);
  });

  it("refuses to start with too few prompts; the host sees why and forceAdvance ends it", () => {
    const g = new Game({ players: 8, packs: [FIXTURE_SPICY_PACK] });
    expect(g.s.error).toMatch(/Not enough prompts/);
    expect(g.runner.nextEventAt()).toBeNull();
    expect(g.view({ role: "host" }).error).toBe(g.s.error);
    // Timers never move an error state; the host ends it with an empty ranking.
    expect(logic.onTimer?.(g.s, TIMER.phase, ctxAt(T0)).state.phase).toBe("intro");
    const r = g.host();
    const end = effectsOf(r.effects, "end")[0];
    expect(end?.result.ranking).toEqual([]);
    expect(g.runner.ended).toBe(true);
  });
});

function ctxAt(now: number, rng: Rng = createRng(1)) {
  return {
    rng,
    now,
    timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
    audienceCount: 0,
  };
}

describe("R1 / T15: authors and team mode", () => {
  it("R1: T15: with 3 room teams each team is one author (N=3)", () => {
    const g = new Game({ players: teamSeats(6, ["t1", "t2", "t3"]), teams: roomTeams(3) });
    expect(g.s.teamMode).toBe(true);
    expect(g.s.authors.map((a) => [a.id, a.members])).toEqual([
      ["t1", ["p1", "p4"]],
      ["t2", ["p2", "p5"]],
      ["t3", ["p3", "p6"]],
    ]);
    expect(roundPrompts({ ...g.s, round: 1 })).toHaveLength(3);
    expect(g.s.authors[0]?.name).toBe("Tomato");
  });

  it("R1: 4 room teams make 4 authors", () => {
    const g = new Game({ players: teamSeats(8, ["t1", "t2", "t3", "t4"]), teams: roomTeams(4) });
    expect(g.s.teamMode).toBe(true);
    expect(g.s.authors).toHaveLength(4);
  });

  it("T15: 2 teams fall back to non-team mode and the host dock says so", () => {
    const g = new Game({ players: teamSeats(4, ["t1", "t2"]), teams: roomTeams(2) });
    expect(g.s.teamMode).toBe(false);
    expect(g.s.authors.map((a) => a.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(g.s.teamNote).toBe(TEAM_NOTE);
    expect(g.view({ role: "host" }).teamNote).toBe(TEAM_NOTE);
  });

  it("R1: shapes that cannot run as teams play solo with the note", () => {
    // 3 teams listed but only 2 have seats.
    expect(buildAuthors(teamSeats(4, ["t1", "t2"]), roomTeams(3)).teamNote).toBe(TEAM_NOTE);
    // A seat with no team.
    const seats = teamSeats(4, ["t1", "t2", "t3"]);
    delete seats[3]?.teamId;
    expect(buildAuthors(seats, roomTeams(3)).teamMode).toBe(false);
    // No teams at all: solo, no note.
    expect(buildAuthors(makeSeats(3), [])).toMatchObject({ teamMode: false, teamNote: null });
  });

  it("R1: teams come from the seats when the context lists none", () => {
    const setup = buildAuthors(teamSeats(6, ["red", "blue", "gold"]), []);
    expect(setup.teamMode).toBe(true);
    expect(setup.authors.map((a) => a.name)).toEqual(["red", "blue", "gold"]);
  });

  it("R1: any teammate can submit, the last submission counts, teammates see it", () => {
    const g = new Game({ players: teamSeats(6, ["t1", "t2", "t3"]), teams: roomTeams(3) });
    g.until("answer");
    const p = roundPrompts(g.s).find((x) => x.authors.includes("t1"));
    if (p === undefined) throw new Error("no t1 prompt");
    g.ok("p1", { type: "answer", promptId: p.id, text: "first try from p1" });
    g.ok("p4", { type: "answer", promptId: p.id, text: "better one from p4" });
    expect(g.s.hidden.answers[p.id]?.["t1"]?.text).toBe("better one from p4");
    const mate = g.view({ role: "player", id: "p1" }).you;
    expect(mate?.author).toBe("t1");
    expect(mate?.prompts.find((x) => x.id === p.id)?.answer).toBe("better one from p4");
    expect(JSON.stringify(g.view({ role: "player", id: "p2" }))).not.toContain("better one");
  });
});

describe("R2 / T1: prompt assignment", () => {
  it(
    "R2: T1: every author gets exactly 2 prompts and every prompt 2 distinct authors (N=3..8)",
    () => {
      for (let n = 3; n <= 8; n++) {
        for (let seed = 1; seed <= 25; seed++) {
          const g = new Game({ players: n, seed });
          const ids = g.s.prompts.map((p) => p.id);
          expect(new Set(ids).size).toBe(ids.length); // no two prompts repeat
          expect(ids).toHaveLength(2 * n + 1);
          for (const round of [1, 2] as const) {
            const prompts = g.s.prompts.filter((p) => p.round === round);
            expect(prompts).toHaveLength(n);
            for (const p of prompts) {
              expect(p.authors).toHaveLength(2);
              expect(p.authors[0]).not.toBe(p.authors[1]);
            }
            for (const a of g.s.authors) {
              expect(prompts.filter((p) => p.authors.includes(a.id))).toHaveLength(2);
            }
          }
          const last = g.s.prompts.filter((p) => p.round === 3);
          expect(last).toHaveLength(1);
          expect(last[0]?.authors).toEqual(g.s.authors.map((a) => a.id));
        }
      }
    },
    HEAVY_TIMEOUT_MS,
  );

  it("R2: with rounds '2' the game plays round 1 and Last Quip (N+1 prompts)", () => {
    const g = new Game({ players: 4, options: { rounds: "2" } });
    expect(g.s.prompts.map((p) => p.round)).toEqual([1, 1, 1, 1, 3]);
    toRound3(g);
    expect(g.s.round).toBe(3);
  });

  it("R2: prompts prefer unused items, then the core pack, then used ones; teen packs obey the filter", () => {
    const rng = createRng(3);
    const core = FIXTURE_CORE_PACK.items.map((i) => ("id" in i ? i.id : ""));
    // Chosen spicy pack (3 items) is short: the core pack fills the rest.
    const mixed = selectPrompts(
      content(),
      { packs: ["quip-spicy"] },
      { contentFilter: "standard" },
      7,
      rng,
    );
    expect(mixed.ok && mixed.items.slice(0, 3).every((i) => i.id.startsWith("fx-spicy"))).toBe(
      true,
    );
    // Family mode hides the teen pack.
    const family = selectPrompts(
      content(),
      { packs: ["quip-spicy"] },
      { contentFilter: "family" },
      7,
      rng,
    );
    expect(family.ok && family.items.every((i) => !i.id.startsWith("fx-spicy"))).toBe(true);
    // Used items come last.
    const used = core.slice(0, 15);
    const pick = selectPrompts(
      packContent([FIXTURE_CORE_PACK], used),
      { packs: ["quip-core"] },
      { contentFilter: "standard" },
      3,
      rng,
    );
    expect(pick.ok && pick.items.slice(0, 2).every((i) => !used.includes(i.id))).toBe(true);
    expect(pick.ok && used.includes(pick.items[2]?.id ?? "")).toBe(true);
    const all = selectPrompts(
      packContent([FIXTURE_CORE_PACK], core),
      { packs: ["quip-core"] },
      { contentFilter: "standard" },
      17,
      rng,
    );
    expect(all.ok).toBe(true);
    // Unknown packs and a missing core pack: an error for the host.
    const none = selectPrompts(
      packContent([]),
      { packs: ["nope"] },
      { contentFilter: "standard" },
      7,
      rng,
    );
    expect(none.ok).toBe(false);
  });

  it("R2: duplicate prompt texts across packs count once", () => {
    const dup = {
      ...FIXTURE_SPICY_PACK,
      id: "dup",
      rating: "all" as const,
      items: [...FIXTURE_CORE_PACK.items],
    };
    const dupIds = {
      ...dup,
      items: dup.items.map((i) => ({ ...i, id: `${"id" in i ? i.id : ""}-copy` })),
    };
    const r = selectPrompts(
      packContent([FIXTURE_CORE_PACK, dupIds as typeof FIXTURE_CORE_PACK]),
      { packs: ["quip-core", "dup"] },
      { contentFilter: "standard" },
      18,
      createRng(1),
    );
    expect(r.ok).toBe(false);
  });
});

describe("R3 / R4: the answer phase", () => {
  it("R3: the deadline is timing.input(answerSec × 1000)", () => {
    const g = new Game({ options: { answerSec: 60 } });
    g.until("answer");
    expect(g.s.deadline).toBe(g.now + 60_000 + 3_000);
    expect(g.view({ role: "stage" }).deadline).toBe(g.s.deadline);
  });

  it("R3: an answer is 1–45 characters after trimming", () => {
    const g = new Game();
    g.until("answer");
    const p = roundPrompts(g.s)[0];
    if (p === undefined) throw new Error("no prompt");
    const author = p.authors[0] as string;
    expect(g.act(author, { type: "answer", promptId: p.id, text: "   " }).err).toBe("ILLEGAL");
    expect(g.act(author, { type: "answer", promptId: p.id, text: "x".repeat(46) }).err).toBe(
      "ILLEGAL",
    );
    expect(g.act(author, { type: "answer", promptId: p.id, text: "x".repeat(401) }).err).toBe(
      "BAD_ACTION",
    );
    g.ok(author, { type: "answer", promptId: p.id, text: `  ${"y".repeat(45)}  ` });
    expect(g.s.hidden.answers[p.id]?.[author]?.text).toBe("y".repeat(45));
    g.ok(author, { type: "answer", promptId: p.id, text: "  two \n\n words " });
    expect(g.s.hidden.answers[p.id]?.[author]?.text).toBe("two words");
  });

  it("R3: answers go through filterText at the room's level (family masks, standard flags)", () => {
    expect(cleanAnswer("what a shit day", "family")).toMatchObject({
      masked: true,
      flagged: false,
    });
    expect(cleanAnswer("what a shit day", "family")?.text).toContain("****");
    expect(cleanAnswer("what a shit day", "standard")).toEqual({
      text: "what a shit day",
      flagged: true,
      masked: false,
    });
    const g = new Game({ room: { contentFilter: "family" } });
    g.until("answer");
    const p = roundPrompts(g.s)[0];
    if (p === undefined) throw new Error("no prompt");
    const author = p.authors[0] as string;
    g.ok(author, { type: "answer", promptId: p.id, text: "what a shit day" });
    const own = g.view({ role: "player", id: author }).you?.prompts.find((x) => x.id === p.id);
    expect(own?.masked).toBe(true);
    // The author may resubmit.
    g.ok(author, { type: "answer", promptId: p.id, text: "what a lovely day" });
    expect(g.s.hidden.answers[p.id]?.[author]).toMatchObject({
      text: "what a lovely day",
      masked: false,
    });
  });

  it("R3: standard-mode flagged answers reveal with a blur flag", () => {
    const g = new Game();
    g.until("answer");
    const first = roundPrompts(g.s)[0];
    const rude = first?.authors[0] as string;
    g.answerAll((pid, a) =>
      pid === first?.id && a === rude ? "holy shit balls" : `${a} on ${pid}`,
    );
    g.until("show-answers");
    const cards = g.view({ role: "stage" }).cards ?? [];
    expect(cards.map((c) => c.flagged)).toEqual([true, false]);
    expect(cards[0]?.text).toBe("holy shit balls");
  });

  it("R3: an author can resubmit until the deadline, only for their own prompts", () => {
    const g = new Game({ players: 4 });
    g.until("answer");
    const mine = roundPrompts(g.s).find((p) => p.authors.includes("p1"));
    const other = roundPrompts(g.s).find((p) => !p.authors.includes("p1"));
    if (mine === undefined || other === undefined) throw new Error("prompts");
    expect(g.act("p1", { type: "answer", promptId: other.id, text: "not mine" }).err).toBe(
      "ILLEGAL",
    );
    expect(g.act("p1", { type: "answer", promptId: "nope", text: "no such prompt" }).err).toBe(
      "ILLEGAL",
    );
    g.ok("p1", { type: "answer", promptId: mine.id, text: "draft one" });
    g.ok("p1", { type: "answer", promptId: mine.id, text: "final answer" });
    expect(g.s.hidden.answers[mine.id]?.["p1"]?.text).toBe("final answer");
    expect(g.view({ role: "stage" }).authors.find((a) => a.id === "p1")?.done).toBe(false);
  });

  it("R3: the phase ends early once every author has submitted all their prompts", () => {
    const g = new Game({ players: 4 });
    g.until("answer");
    const before = g.effects.length;
    g.answerAll();
    expect(g.s.phase).toBe("show-prompt");
    expect(effectsOf(g.since(before), "audience.close").map((e) => e.pollId)).toEqual([
      "predict-r1",
    ]);
  });

  it("R4: an answer still missing at the deadline counts as blank", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    const p = roundPrompts(g.s)[0];
    if (p === undefined) throw new Error("no prompt");
    g.ok(p.authors[0] as string, { type: "answer", promptId: p.id, text: "only me" });
    g.now = g.s.deadline as number;
    g.wait(0);
    expect(g.s.phase).toBe("show-prompt");
    expect(g.s.hidden.answers[p.id]?.[p.authors[1] as string]).toBeUndefined();
    // No other prompt had an answer: only this matchup is played.
    expect(currentPrompt(g.s).id).toBe(p.id);
  });
});

describe("R3a / T14: the round-winner predict poll", () => {
  it("R3a: T14: opens with the answer phase, closes at the first show-prompt, resolves with the top scorer", () => {
    const g = new Game({ players: 3 });
    const at = g.effects.length;
    g.until("answer");
    const open = effectsOf(g.since(at), "audience.open")[0];
    expect(open?.poll).toMatchObject({
      pollId: "predict-r1",
      kind: "predict",
      prompt: "Who wins this round?",
      closeOn: "event",
      closesAtMs: g.s.deadline,
    });
    expect(open?.poll.options?.map((o) => o.id)).toEqual(["p1", "p2", "p3"]);
    expect(g.view({ role: "audience" }).predict?.open).toBe(true);
    const beforeClose = g.effects.length;
    g.answerAll();
    expect(g.s.phase).toBe("show-prompt");
    expect(effectsOf(g.since(beforeClose), "audience.close").map((e) => e.pollId)).toContain(
      "predict-r1",
    );
    g.audience("predict-r1", { p1: 5, p2: 3, p3: 2 });
    expect(g.s.predict).toMatchObject({ open: false, total: 10, tallies: { p1: 5, p2: 3, p3: 2 } });
    // Play the round: the voter always picks A.
    while (g.s.phase !== "scores") {
      if (g.s.phase === "vote") finishVote(g, "A");
      else g.step();
    }
    const resolve = effectsOf(g.effects, "audience.resolve").find((e) => e.pollId === "predict-r1");
    const top = roundWinner(g.s);
    expect(resolve?.correct).toBe(top);
    const best = Math.max(...Object.values(g.s.roundPoints));
    expect(g.s.roundPoints[top as string]).toBe(best);
  });

  it("R3a: in round 3 the poll is 'Who wins Last Quip?' and resolves at the results", () => {
    const g = toRound3(new Game({ players: 3 }));
    const open = effectsOf(g.effects, "audience.open").find((e) => e.poll.pollId === "predict-r3");
    expect(open?.poll.prompt).toBe("Who wins Last Quip?");
    g.answerAll();
    expect(g.s.phase).toBe("show-all");
    g.until("vote");
    for (const v of g.voters()) {
      const slot = g.module.legalActions(g.s, v)[0];
      if (slot !== undefined) g.ok(v, slot);
    }
    g.audience("vote-r3", {}, 0);
    expect(g.s.phase).toBe("results");
    expect(effectsOf(g.effects, "audience.resolve").map((e) => e.pollId)).toContain("predict-r3");
  });

  it("R3a: ties go to the earlier seat", () => {
    const s = new Game({ players: 4 }).s;
    expect(roundWinner({ authors: s.authors, roundPoints: { p2: 500, p3: 500 } })).toBe("p2");
    expect(roundWinner({ authors: s.authors, roundPoints: {} })).toBe("p1");
  });
});

describe("R5 / R6 / T7: matchups and voting", () => {
  it("R5: show-prompt 2.5 s, show-answers 1.5 s, vote with an A/B audience poll, results 4.5 s", () => {
    const g = new Game({ players: 4 });
    g.until("answer").answerAll();
    expect(g.s.phase).toBe("show-prompt");
    expect(g.timerAt()).toBe(g.now + 2500);
    expect(g.view({ role: "stage" }).prompt?.text).toBe(currentPrompt(g.s).text);
    expect(g.view({ role: "stage" }).cards).toBeNull();
    g.step();
    expect(g.s.phase).toBe("show-answers");
    expect(g.timerAt()).toBe(g.now + 1500);
    const at = g.effects.length;
    g.step();
    expect(g.s.phase).toBe("vote");
    expect(g.s.deadline).toBe(g.now + 23_000);
    const poll = effectsOf(g.since(at), "audience.open")[0]?.poll;
    expect(poll).toMatchObject({ pollId: "vote-r1-m1", kind: "vote", closesAtMs: g.s.deadline });
    expect(poll?.options?.map((o) => o.id)).toEqual(["A", "B"]);
    finishVote(g, "A");
    expect(g.s.phase).toBe("results");
    expect(g.timerAt()).toBe(g.now + 4500);
    g.step();
    expect(g.s.phase).toBe("show-prompt");
    expect(g.s.matchup).toBe(1);
  });

  it("R6: T7: only players outside the matchup vote; an illegal vote leaves the state unchanged", () => {
    const g = new Game({ players: 5 });
    g.until("answer").answerAll();
    g.until("vote");
    const [a, b] = currentPrompt(g.s).authors as [string, string];
    const before = logic.serialize(g.s);
    expect(g.act(a, { type: "vote", choice: "B" }).err).toBe("ILLEGAL");
    expect(g.act(b, { type: "vote", choice: "A" }).err).toBe("ILLEGAL");
    expect(logic.serialize(g.s)).toBe(before);
    expect(g.act("p1", { type: "vote", choice: "C" }).err).toBe("BAD_ACTION");
    expect(g.act("zz", { type: "vote", choice: "A" }).err).toBe("NOT_SEATED");
    expect(g.view({ role: "player", id: a }).you).toMatchObject({
      canVote: false,
      inMatchup: true,
    });
    const voters = g.voters();
    expect(voters).toHaveLength(3);
    expect(voters).not.toContain(a);
    expect(g.view({ role: "stage" }).votersEligible).toBe(3);
  });

  it("R6: a vote can change until the deadline; the phase ends early once all eligible voted", () => {
    const g = new Game({ players: 5 });
    g.until("answer").answerAll();
    g.until("vote");
    const [v1, v2, v3] = g.voters() as [string, string, string];
    g.ok(v1, { type: "vote", choice: "A" }).ok(v1, { type: "vote", choice: "B" });
    expect(g.s.votes[v1]).toBe("B");
    expect(g.view({ role: "player", id: v1 }).you?.vote).toBe("B");
    expect(g.view({ role: "stage" }).votesCast).toBe(1);
    // The stage never shows who voted what during the vote.
    expect(g.view({ role: "stage" }).ballots).toBeNull();
    const at = g.effects.length;
    const openedAt = g.now;
    g.ok(v2, { type: "vote", choice: "A" }).ok(v3, { type: "vote", choice: "A" });
    expect(g.s.closing).toBe(true);
    expect(g.view({ role: "stage" }).closing).toBe(true);
    expect(g.act(v1, { type: "vote", choice: "A" }).err).toBe("ILLEGAL");
    // The runner holds the early close for the minimum audience window (3 s + 5 s).
    expect(effectsOf(g.since(at), "audience.close")).toHaveLength(0);
    g.wait(8_000 - (g.now - openedAt));
    expect(effectsOf(g.since(at), "audience.close").map((e) => e.pollId)).toEqual(["vote-r1-m1"]);
    g.audience("vote-r1-m1", { A: 3, B: 1 });
    expect(g.s.phase).toBe("results");
    expect(g.view({ role: "stage" }).ballots).toEqual({ [v1]: "B", [v2]: "A", [v3]: "A" });
  });

  it("R6: in team mode the authors' teammates cannot vote", () => {
    const g = new Game({ players: teamSeats(6, ["t1", "t2", "t3"]), teams: roomTeams(3) });
    g.until("answer").answerAll();
    g.until("vote");
    const authors = currentPrompt(g.s).authors;
    const third = g.s.authors.find((a) => !authors.includes(a.id));
    expect(g.voters()).toEqual(third?.members);
  });

  it("R6: without an audience result the vote resolves after the audience wait", () => {
    const g = new Game({ players: 3 });
    g.until("answer").answerAll();
    g.until("vote");
    g.ok(g.voters()[0] as string, { type: "vote", choice: "A" });
    expect(g.s.closing).toBe(true);
    const wait = g.timerAt() as number;
    expect(wait).toBe(g.now + AUDIENCE_WAIT_MS);
    g.now = wait;
    g.wait(0);
    expect(g.s.phase).toBe("results");
    expect(g.s.results[currentPrompt(g.s).id]?.audienceCounted).toBe(false);
  });

  it("R6: an audience result that arrives before the vote ends is kept for scoring", () => {
    const g = new Game({ players: 3 });
    g.until("answer").answerAll();
    g.until("vote");
    g.audience("vote-r1-m1", { A: 9, B: 1 });
    expect(g.s.phase).toBe("vote");
    g.ok(g.voters()[0] as string, { type: "vote", choice: "B" });
    expect(g.s.phase).toBe("results");
    expect(g.s.results[currentPrompt(g.s).id]?.audienceCounted).toBe(true);
    // A late duplicate or a stray poll is ignored.
    const s = g.s;
    g.audience("vote-r1-m1", { A: 1 });
    g.audience("nope", { A: 1 });
    expect(g.s).toBe(s);
  });
});

describe("R7 / R8 / T2 / T3 / T4: scoring", () => {
  const base = { a: "x", b: "y", audienceMin: 5, weight: 30, round: 1 as const };

  it("R7: T2: votes 2–1 with no audience give 667/333 in round 1", () => {
    const r = scoreMatchup({ ...base, votesA: 2, votesB: 1, aud: null });
    expect(r.points).toEqual({ x: 667, y: 333 });
    expect((r.playerShare.x ?? 0) + (r.playerShare.y ?? 0)).toBeCloseTo(1);
    expect(r.quipOut).toBeUndefined();
  });

  it("R7: T3: w=0.3, player share 1.0 and audience share 0.4 blend to 0.82", () => {
    const r = scoreMatchup({
      ...base,
      votesA: 3,
      votesB: 0,
      aud: { total: 100, tallies: { A: 40, B: 60 } },
    });
    expect(r.points.x).toBe(820);
    expect(r.points.y).toBe(180);
    expect(r.audShare).toEqual({ x: 0.4, y: 0.6 });
    expect(r.audienceCounted).toBe(true);
  });

  it("R7: no votes cast means 0.5 each; the audience below audienceMin does not count", () => {
    expect(scoreMatchup({ ...base, votesA: 0, votesB: 0, aud: null }).points).toEqual({
      x: 500,
      y: 500,
    });
    const low = scoreMatchup({
      ...base,
      votesA: 2,
      votesB: 1,
      aud: { total: 4, tallies: { A: 0, B: 4 } },
    });
    expect(low.points).toEqual({ x: 667, y: 333 });
    expect(low.audienceCounted).toBe(false);
    expect(low.audShare).toEqual({ x: 0, y: 1 });
    const empty = scoreMatchup({ ...base, votesA: 1, votesB: 1, aud: { total: 0, tallies: {} } });
    expect(empty.audShare).toBeUndefined();
  });

  it("R7: in a real game 2–1 scores 667/333 and emits score deltas", () => {
    const g = new Game({ players: 5 });
    g.until("answer").answerAll();
    g.until("vote");
    const [a, b] = currentPrompt(g.s).authors as [string, string];
    const at = g.effects.length;
    finishVote(g, ["A", "A", "B"], { A: 1, B: 3 });
    expect(g.s.results[currentPrompt(g.s).id]?.points).toEqual({ [a]: 667, [b]: 333 });
    expect(effectsOf(g.since(at), "score")[0]?.deltas).toEqual({ [a]: 667, [b]: 333 });
    expect(g.view({ role: "stage" }).result).toMatchObject({
      audienceCounted: false,
      audienceTotal: 4,
    });
    expect(g.view({ role: "stage" }).poll).toEqual({ pollId: "vote-r1-m1", min: 5 });
  });

  it("R8: T4: a QUIP-OUT needs audShare ≥ 0.8 when the audience counts", () => {
    const yes = scoreMatchup({
      ...base,
      votesA: 3,
      votesB: 0,
      aud: { total: 100, tallies: { A: 85, B: 15 } },
    });
    expect(yes.quipOut).toBe("x");
    expect(yes.points.x).toBe(Math.round(1000 * (0.7 + 0.3 * 0.85)) + 250);
    const no = scoreMatchup({
      ...base,
      votesA: 3,
      votesB: 0,
      aud: { total: 100, tallies: { A: 70, B: 30 } },
    });
    expect(no.quipOut).toBeUndefined();
    expect(no.points.x).toBe(910);
  });

  it("R8: without a counted audience any unanimous vote is a QUIP-OUT (×2 in round 2)", () => {
    expect(scoreMatchup({ ...base, votesA: 2, votesB: 0, aud: null })).toMatchObject({
      quipOut: "x",
      points: { x: 1250, y: 0 },
    });
    expect(scoreMatchup({ ...base, round: 2, votesA: 0, votesB: 4, aud: null })).toMatchObject({
      quipOut: "y",
      points: { x: 0, y: 2500 },
    });
  });

  it("R8: a QUIP-OUT in a real game adds the bonus and counts for the author", () => {
    const g = new Game({ players: 4 });
    g.until("answer").answerAll();
    g.until("vote");
    const [a] = currentPrompt(g.s).authors as [string, string];
    const at = g.effects.length;
    finishVote(g, "A", { A: 90, B: 10 });
    expect(g.s.quipOuts[a]).toBe(1);
    expect(effectsOf(g.since(at), "fx").map((e) => e.name)).toContain("quipout");
    expect(g.view({ role: "stage" }).result?.quipOut).toBe(a);
  });
});

describe("R9 / T5: JINX", () => {
  it("T5: JINX detection is case- and punctuation-insensitive", () => {
    expect(isJinx("Pizza, obviously!", "pizza obviously")).toBe(true);
    expect(isJinx("Crème Brûlée!!", "creme brulee")).toBe(true);
    expect(isJinx("pizza", "pizzas")).toBe(false);
  });

  it("R9: a JINX skips the vote and both authors score 0", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    const first = roundPrompts(g.s)[0];
    if (first === undefined) throw new Error("no prompt");
    g.answerAll((pid, a) =>
      pid === first.id
        ? a === first.authors[0]
          ? "Pizza, obviously!"
          : "pizza obviously"
        : `${a} ${pid}`,
    );
    expect(currentPrompt(g.s).id).toBe(first.id);
    const at = g.effects.length;
    g.step();
    g.step();
    expect(g.s.phase).toBe("results");
    expect(g.since(at).some((e) => e.type === "audience.open")).toBe(false);
    expect(g.s.results[first.id]).toMatchObject({
      jinx: true,
      points: { [first.authors[0] as string]: 0 },
    });
    expect(effectsOf(g.since(at), "fx").map((e) => e.name)).toContain("jinx");
    expect(g.view({ role: "stage" }).result?.jinx).toBe(true);
    expect(scoreJinx("a", "b").points).toEqual({ a: 0, b: 0 });
  });
});

describe("R10 / T6: blanks", () => {
  it("R10: T6: one blank answer gives the other author base + bonus with no vote phase", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    const first = roundPrompts(g.s)[0];
    if (first === undefined) throw new Error("no prompt");
    const [a, b] = first.authors as [string, string];
    g.ok(a, { type: "answer", promptId: first.id, text: "lonely answer" });
    g.now = g.s.deadline as number;
    g.wait(0);
    const phases: string[] = [];
    while (g.s.phase !== "results") {
      g.step();
      phases.push(g.s.phase);
    }
    expect(phases).not.toContain("vote");
    expect(g.s.results[first.id]).toMatchObject({ auto: a, points: { [a]: 1250, [b]: 0 } });
    const cards = g.view({ role: "stage" }).cards ?? [];
    expect(cards.find((c) => c.author === b)).toMatchObject({ blank: true, text: null });
    expect(g.view({ role: "stage" }).result?.auto).toBe(a);
    expect(scoreAutoWin("x", "y", 2).points).toEqual({ x: 2500, y: 0 });
  });

  it("R10: when both answers are blank the matchup is skipped", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    g.now = g.s.deadline as number;
    g.wait(0);
    // Nothing was answered: every matchup is skipped and the round goes to scores.
    expect(g.s.phase).toBe("scores");
    expect(Object.keys(g.s.results)).toHaveLength(0);
    expect(g.timerAt()).toBe(g.now + 5000);
  });

  it("R10: the blank author's matchup partner still wins when the blank author comes second", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    const first = roundPrompts(g.s)[0];
    if (first === undefined) throw new Error("no prompt");
    const [a, b] = first.authors as [string, string];
    g.ok(b, { type: "answer", promptId: first.id, text: "only B" });
    g.now = g.s.deadline as number;
    g.wait(0);
    g.until("results");
    expect(g.s.results[first.id]?.auto).toBe(b);
    expect(g.s.results[first.id]?.points[a]).toBe(0);
  });
});

describe("R11 / T8 / T16: Last Quip", () => {
  it("R11: one prompt for every author with a timing.input(75 s) deadline", () => {
    const g = toRound3(new Game({ players: 4 }));
    expect(roundPrompts(g.s)).toHaveLength(1);
    expect(currentPrompt(g.s).authors).toHaveLength(4);
    expect(g.s.deadline).toBe(g.now + 78_000);
    const you = g.view({ role: "player", id: "p2" }).you;
    expect(you?.prompts).toHaveLength(1);
  });

  it("T16: the Last Quip vote lasts timing.input(voteSec × 1.5 × 1000) and ends early when all allocated", () => {
    const g = toRound3(new Game({ players: 4, options: { voteSec: 20 } }));
    g.answerAll();
    expect(g.s.phase).toBe("show-all");
    expect(g.timerAt()).toBe(g.now + 3000);
    const at = g.effects.length;
    g.step();
    expect(g.s.phase).toBe("vote");
    expect(g.s.deadline).toBe(g.now + 33_000);
    const poll = effectsOf(g.since(at), "audience.open")[0]?.poll;
    expect(poll?.pollId).toBe("vote-r3");
    expect(poll?.options?.map((o) => o.id)).toEqual(["c1", "c2", "c3", "c4"]);
    for (const v of g.voters()) {
      const first = legalActions(g.s, v)[0];
      if (first !== undefined) g.ok(v, first);
    }
    expect(g.s.closing).toBe(true);
    g.audience("vote-r3", { c1: 50, c2: 30, c3: 10, c4: 10 });
    expect(g.s.phase).toBe("results");
    expect(g.timerAt()).toBe(g.now + 7000);
  });

  it("T8: Last Quip rejects allocations that don't sum to 3 or include the voter's own answer", () => {
    const g = toRound3(new Game({ players: 4 }));
    g.answerAll().until("vote");
    const own = g.s.order.indexOf("p1");
    const ownSlot = `c${own + 1}`;
    const others = g.s.order.flatMap((a, i) => (a === "p1" ? [] : [`c${i + 1}`])) as [
      string,
      string,
      string,
    ];
    expect(g.view({ role: "player", id: "p1" }).you?.ownSlots).toEqual([ownSlot]);
    expect(g.act("p1", { type: "lastVote", alloc: { [others[0]]: 2 } }).err).toBe("ILLEGAL");
    expect(g.act("p1", { type: "lastVote", alloc: { [others[0]]: 3, [others[1]]: 1 } }).err).toBe(
      "ILLEGAL",
    );
    expect(g.act("p1", { type: "lastVote", alloc: { [ownSlot]: 1, [others[0]]: 2 } }).err).toBe(
      "ILLEGAL",
    );
    expect(g.act("p1", { type: "lastVote", alloc: { c8: 3 } }).err).toBe("ILLEGAL");
    expect(g.act("p1", { type: "vote", choice: "A" }).err).toBe("ILLEGAL");
    // Stacking is allowed, and a zero on the own card is ignored.
    g.ok("p1", { type: "lastVote", alloc: { [others[0]]: 3, [ownSlot]: 0 } });
    expect(g.s.votes["p1"]).toEqual({ [others[0]]: 3 });
    expect(g.view({ role: "player", id: "p1" }).you?.alloc).toEqual({ [others[0]]: 3 });
    g.ok("p1", { type: "lastVote", alloc: { [others[1]]: 1, [others[2]]: 2 } });
    expect(g.s.votes["p1"]).toEqual({ [others[1]]: 1, [others[2]]: 2 });
  });

  it("R11: scoring is round(3000 × share) with the audience blend; blank answers are not shown", () => {
    const r = scoreLastQuip({
      shown: ["x", "y", "z"],
      votes: { x: 3, y: 3 },
      aud: null,
      audienceMin: 5,
      weight: 30,
    });
    expect(r.points).toEqual({ x: 1500, y: 1500, z: 0 });
    const blended = scoreLastQuip({
      shown: ["x", "y"],
      votes: { x: 6 },
      aud: { total: 10, tallies: { c1: 2, c2: 8 } },
      audienceMin: 5,
      weight: 50,
    });
    expect(blended.points).toEqual({ x: 1800, y: 1200 });
    expect(
      scoreLastQuip({ shown: ["x", "y"], votes: {}, aud: null, audienceMin: 5, weight: 30 }).points,
    ).toEqual({
      x: 1500,
      y: 1500,
    });
    const low = scoreLastQuip({
      shown: ["x", "y"],
      votes: { x: 3 },
      aud: { total: 2, tallies: { c2: 2 } },
      audienceMin: 5,
      weight: 30,
    });
    expect(low).toMatchObject({
      audienceCounted: false,
      points: { x: 3000, y: 0 },
      audShare: { x: 0, y: 1 },
    });

    const g = toRound3(new Game({ players: 4 }));
    g.answerAll((pid, a) => (a === "p4" ? null : `${a} last ${pid}`));
    g.now = g.s.deadline as number;
    g.wait(0);
    expect(g.s.order).not.toContain("p4");
    expect(g.view({ role: "stage" }).cards).toHaveLength(3);
    g.until("vote");
    for (const v of g.voters()) {
      const first = legalActions(g.s, v)[0];
      if (first !== undefined) g.ok(v, first);
    }
    g.audience("vote-r3", {}, 0);
    const result = g.s.results[currentPrompt(g.s).id];
    expect(result?.points["p4"]).toBeUndefined();
    const total = Object.values(result?.points ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(2999);
    expect(total).toBeLessThanOrEqual(3001);
    const shown = g.view({ role: "stage" }).cards ?? [];
    expect(shown.every((c) => c.author !== null)).toBe(true);
  });

  it("R11: with fewer than 2 answers there is no vote", () => {
    const g = toRound3(new Game({ players: 3 }));
    g.answerAll((_pid, a) => (a === "p1" ? "the only one" : null));
    g.now = g.s.deadline as number;
    g.wait(0);
    g.step();
    expect(g.s.phase).toBe("results");
    expect(g.s.results[currentPrompt(g.s).id]?.points).toEqual({ p1: 3000 });
  });
});

describe("R12 / T13: the end", () => {
  it("R12: the game ends after round 3 with the ranking and highlights", () => {
    const g = toRound3(new Game({ players: 3 }));
    g.answerAll().until("vote");
    for (const v of g.voters()) {
      const first = legalActions(g.s, v)[0];
      if (first !== undefined) g.ok(v, first);
    }
    g.audience("vote-r3", { c1: 70, c2: 20, c3: 10 });
    g.until("final");
    expect(g.timerAt()).toBe(g.now + 9000);
    const fin = g.view({ role: "stage" }).final;
    expect(fin?.ranking.map((r) => r.place)).toEqual([1, 2, 3]);
    expect(fin?.highlights.find((h) => h.kind === "audience-favourite")?.label).toMatch(
      /^Audience Favourite: "/,
    );
    const at = g.effects.length;
    g.now = g.timerAt() as number;
    g.wait(0);
    const end = effectsOf(g.since(at), "end")[0];
    expect(g.runner.ended).toBe(true);
    expect(end?.result.ranking).toEqual(ranking(g.s));
    expect(end?.result.highlights?.every((h) => h.playerId !== undefined)).toBe(true);
    expect(end?.result.ranking[0]?.score).toBe(Math.max(...Object.values(g.s.scores)));
  });

  it("T13: ties are broken by more QUIP-OUTs, then by the earliest seat", () => {
    const authors = new Game({ players: 4 }).s.authors;
    const r = ranking({
      authors,
      scores: { p1: 1000, p2: 1000, p3: 1000, p4: 2000 },
      quipOuts: { p1: 0, p2: 0, p3: 1, p4: 0 },
    });
    expect(r.map((x) => x.id)).toEqual(["p4", "p3", "p1", "p2"]);
    expect(r.map((x) => x.place)).toEqual([1, 2, 3, 4]);
  });

  it("R12: Quip-Out King goes to the most QUIP-OUTs; team highlights name the team", () => {
    const g = new Game({ players: teamSeats(6, ["t1", "t2", "t3"]), teams: roomTeams(3) });
    const s: QcState = {
      ...g.s,
      quipOuts: { t1: 1, t2: 2, t3: 2 },
      highlights: [{ kind: "quip-out-king", label: "Quip-Out King", author: "t2" }],
    };
    const res = gameResult(s);
    expect(res.highlights?.[0]?.label).toBe("Quip-Out King (Sky)");
    expect(res.ranking.map((x) => x.id)).toEqual(["t2", "t3", "t1"]);
    // Played out: the king is computed at the final.
    const played = new Game({ players: 3 });
    played.until("answer").answerAll();
    for (let i = 0; i < 400 && !played.runner.ended; i++) {
      if (played.s.phase === "answer") played.answerAll();
      else if (played.s.phase === "vote" && played.s.round !== 3) finishVote(played, "A");
      else if (played.s.phase === "vote") {
        for (const v of played.voters()) {
          const first = legalActions(played.s, v)[0];
          if (first !== undefined) played.ok(v, first);
        }
        played.audience("vote-r3", {}, 0);
      } else played.step();
      if (played.s.phase === "final") break;
    }
    expect(played.s.phase).toBe("final");
    const king = played.s.highlights.find((h) => h.kind === "quip-out-king");
    const most = Math.max(...Object.values(played.s.quipOuts));
    expect(played.s.quipOuts[king?.author as string]).toBe(most);
    expect(played.s.highlights.some((h) => h.kind === "audience-favourite")).toBe(false);
  });
});

describe("R13 / T10: moderation", () => {
  function moderated(players = 3) {
    const g = new Game({ players, room: { moderation: "reveal-review" } });
    g.until("answer");
    return g;
  }

  it("R13: every submitted answer emits a moderate effect and waits as pending", () => {
    const g = moderated();
    const p = roundPrompts(g.s)[0];
    if (p === undefined) throw new Error("no prompt");
    const author = p.authors[0] as string;
    const at = g.effects.length;
    g.ok(author, { type: "answer", promptId: p.id, text: "needs a look" });
    const mod = effectsOf(g.since(at), "moderate")[0];
    expect(mod).toMatchObject({ kind: "text", ownerId: author, preview: "needs a look" });
    expect(g.s.hidden.answers[p.id]?.[author]?.mod).toBe("pending");
    expect(g.view({ role: "host" }).host?.review).toEqual([
      { itemId: mod?.itemId, promptId: p.id, promptText: p.text, text: "needs a look" },
    ]);
    // A resubmission replaces the queue item; the stale decision is ignored.
    g.ok(author, { type: "answer", promptId: p.id, text: "second look" });
    const s = g.s;
    g.moderate(mod?.itemId as string, true);
    expect(g.s).toBe(s);
    expect(g.view({ role: "host" }).host?.review).toHaveLength(1);
    // A Safety Quip is a submitted answer too: it is queued for review like any other.
    const other = roundPrompts(g.s).find((x) => x.authors.includes(author) && x.id !== p.id);
    const before = g.effects.length;
    g.ok(author, { type: "safety", promptId: other?.id as string });
    const line = g.s.hidden.answers[other?.id as string]?.[author];
    expect(line).toMatchObject({ safety: true, mod: "pending" });
    expect(effectsOf(g.since(before), "moderate")).toEqual([
      expect.objectContaining({ kind: "text", ownerId: author, preview: line?.text }),
    ]);
    expect(g.view({ role: "host" }).host?.review).toHaveLength(2);
  });

  it("T10: a pending answer blocks show-answers; approval reveals it and the vote opens", () => {
    const g = moderated();
    g.answerAll();
    const p = currentPrompt(g.s);
    const items = Object.entries(g.s.modItems);
    const hold = items.filter(([, it]) => it.promptId === p.id);
    for (const [id, it] of items) if (it.promptId !== p.id) g.moderate(id, true);
    g.step();
    expect(g.s.phase).toBe("show-answers");
    const stage = g.view({ role: "stage" });
    expect(stage.awaiting).toBe(2);
    expect(stage.cards?.every((c) => c.awaiting && c.text === null)).toBe(true);
    g.step();
    expect(g.s.phase).toBe("review-wait");
    expect(g.s.deadline).toBeNull();
    for (const role of ["stage", "audience"] as const) {
      for (const [, it] of hold) {
        expect(view(g, role)).not.toContain(g.s.hidden.answers[p.id]?.[it.author]?.text);
      }
    }
    expect(g.view({ role: "host" }).host?.review.map((r) => r.promptId)).toEqual([p.id, p.id]);
    g.moderate(hold[0]?.[0] as string, true);
    expect(g.s.phase).toBe("review-wait");
    expect(g.view({ role: "stage" }).cards?.filter((c) => c.text !== null)).toHaveLength(1);
    g.moderate(hold[1]?.[0] as string, true);
    expect(g.s.phase).toBe("vote");
  });

  it("T10: a rejected answer is replaced with a safety quip marked edited by host", () => {
    const g = moderated();
    g.answerAll();
    const p = currentPrompt(g.s);
    const items = Object.entries(g.s.modItems);
    for (const [id, it] of items) if (it.promptId !== p.id) g.moderate(id, true);
    const mine = items.filter(([, it]) => it.promptId === p.id);
    g.moderate(mine[0]?.[0] as string, false);
    const rejected = mine[0]?.[1].author as string;
    const replaced = g.s.hidden.answers[p.id]?.[rejected];
    expect(replaced).toMatchObject({ safety: true, mod: "edited" });
    expect(SAFETY.has(replaced?.text as string)).toBe(true);
    g.until("review-wait");
    // 20 s later the other pending answer counts as rejected too.
    expect(g.timerAt()).toBe(g.now + 20_000);
    g.step();
    expect(g.s.phase).toBe("vote");
    const cards = g.view({ role: "stage" }).cards ?? [];
    expect(cards.every((c) => c.byHost && c.text !== null && SAFETY.has(c.text))).toBe(true);
  });

  it("R13: an approval during show-answers reveals the answer at once", () => {
    const g = moderated();
    g.answerAll();
    const p = currentPrompt(g.s);
    for (const [id, it] of Object.entries(g.s.modItems))
      if (it.promptId !== p.id) g.moderate(id, true);
    g.step();
    expect(g.s.phase).toBe("show-answers");
    for (const [id] of Object.entries(g.s.modItems)) g.moderate(id, true);
    expect(g.view({ role: "stage" }).cards?.every((c) => c.text !== null)).toBe(true);
    g.step();
    expect(g.s.phase).toBe("vote");
  });

  it("R13: R3: in Last Quip every author can use Safety and a rejection is always a safety quip", () => {
    const g = new Game({ players: 5, room: { moderation: "reveal-review" } });
    g.until("answer");
    for (let i = 0; i < 400 && !(g.s.phase === "answer" && g.s.round === 3); i++) {
      if (g.s.phase === "answer") g.answerAll();
      else if (g.s.phase === "vote") finishVote(g, "A");
      else if (g.s.phase === "review-wait") g.host();
      else g.step();
    }
    const p = currentPrompt(g.s);
    // Three authors take the prompt's three safety lines; authors 4 and 5 still get one (R3).
    for (const a of ["p1", "p2", "p3"]) g.ok(a, { type: "safety", promptId: p.id });
    expect(g.s.hidden.safetyPool[p.id]).toEqual([]);
    const safetyFor = (a: string) => {
      expect(g.view({ role: "player", id: a }).you?.safetyLeft).toBe(true);
      g.ok(a, { type: "safety", promptId: p.id });
      const line = g.s.hidden.answers[p.id]?.[a];
      expect(line?.safety).toBe(true);
      expect(SAFETY.has(line?.text as string)).toBe(true);
      expect(g.act(a, { type: "safety", promptId: p.id }).err).toBe("ILLEGAL");
    };
    safetyFor("p4");
    // p4 overwrites its (shared) line; the pool gets nothing another author still holds.
    g.ok("p4", { type: "answer", promptId: p.id, text: "typed after all" });
    expect(g.s.hidden.safetyPool[p.id]).toEqual([]);
    safetyFor("p5");
    expect(g.s.phase).toBe("show-all");
    g.step();
    expect(g.s.phase).toBe("review-wait");
    const items = Object.entries(g.s.modItems);
    expect(items).toHaveLength(5);
    const typed = items.find(([, it]) => it.author === "p4")?.[0] as string;
    for (const [id] of items) if (id !== typed) g.moderate(id, true);
    expect(g.s.phase).toBe("review-wait");
    // With every line out, the rejected answer still becomes a safety quip, marked edited.
    g.moderate(typed, false);
    expect(g.s.hidden.answers[p.id]?.["p4"]).toMatchObject({ safety: true, mod: "edited" });
    expect(SAFETY.has(g.s.hidden.answers[p.id]?.["p4"]?.text as string)).toBe(true);
    expect(g.s.revealed[p.id]?.edited).toContain("p4");
    expect(g.s.phase).toBe("vote");
    expect(g.s.order).toHaveLength(5);
  });

  it("R13: a rejected Safety Quip is replaced by a different safety line", () => {
    const g = moderated();
    const p = roundPrompts(g.s)[0] as QcState["prompts"][number];
    const author = p.authors[0] as string;
    g.ok(author, { type: "safety", promptId: p.id });
    const first = g.s.hidden.answers[p.id]?.[author]?.text as string;
    const [itemId] = Object.keys(g.s.modItems);
    g.moderate(itemId as string, false);
    const after = g.s.hidden.answers[p.id]?.[author];
    expect(after).toMatchObject({ safety: true, mod: "edited" });
    expect(after?.text).not.toBe(first);
    expect(g.s.hidden.safetyPool[p.id]).toContain(first);
  });
});

describe("R14: disconnects", () => {
  it("R14: a disconnected author's safety quips land 10 s before the deadline", () => {
    const g = new Game({ players: 4 });
    g.until("answer");
    expect(g.timerAt(TIMER.away)).toBe((g.s.deadline as number) - 10_000);
    g.leave("p2");
    expect(g.view({ role: "stage" }).authors.find((a) => a.id === "p2")?.away).toBe(true);
    expect(bot(g.s, "p2", createRng(1))).toBeNull();
    g.answerAll((pid, a) => (a === "p2" ? null : `${a} on ${pid}`));
    expect(g.s.phase).toBe("answer");
    g.now = g.timerAt(TIMER.away) as number;
    g.wait(0);
    const mine = roundPrompts({ ...g.s, round: 1 }).filter((p) => p.authors.includes("p2"));
    for (const p of mine) {
      expect(g.s.hidden.answers[p.id]?.["p2"]?.safety).toBe(true);
    }
    expect(g.s.phase).toBe("show-prompt");
  });

  it("R14: with under 10 s left a leaving author's quips go in at once; the timer is a no-op otherwise", () => {
    const g = new Game({ players: 4 });
    g.until("answer");
    const s = g.s;
    expect(logic.onTimer?.(s, TIMER.away, ctxAt(g.now)).state).toBe(s);
    g.answerAll((pid, a) => (a === "p3" ? null : `${a} on ${pid}`));
    g.now = (g.s.deadline as number) - 5_000;
    g.leave("p3");
    expect(g.s.phase).toBe("show-prompt");
    // The away timer outside the answer phase does nothing.
    expect(logic.onTimer?.(g.s, TIMER.away, ctxAt(g.now)).state).toBe(g.s);
    expect(logic.onTimer?.(g.s, "unknown", ctxAt(g.now)).state).toBe(g.s);
  });

  it("R14: a disconnected voter's vote is simply missing", () => {
    const g = new Game({ players: 5 });
    g.until("answer").answerAll();
    g.until("vote");
    const [v1, v2, v3] = g.voters() as [string, string, string];
    g.ok(v1, { type: "vote", choice: "A" }).ok(v2, { type: "vote", choice: "A" });
    g.leave(v3);
    expect(g.s.closing).toBe(true);
    expect(bot(g.s, v3, createRng(1))).toBeNull();
  });

  it("R6: R14: a vote with no connected eligible voter closes as it opens", () => {
    const g = new Game({ players: 3 });
    g.until("answer").answerAll();
    g.until("show-answers");
    const voter = g.s.authors.find((a) => !currentPrompt(g.s).authors.includes(a.id))?.id;
    g.leave(voter as string);
    const at = g.effects.length;
    g.step();
    expect(g.s.phase).toBe("vote");
    expect(g.s.closing).toBe(true);
    expect(effectsOf(g.since(at), "audience.open")).toHaveLength(1);
    // The players' vote is over; the runner still holds the audience poll for its window.
    expect(effectsOf(g.since(at), "audience.close")).toHaveLength(0);
    g.wait(8_000);
    expect(effectsOf(g.since(at), "audience.close").map((e) => e.pollId)).toEqual(["vote-r1-m1"]);
    g.audience("vote-r1-m1", { A: 2, B: 1 });
    expect(g.s.phase).toBe("results");
  });

  it("R14: in Last Quip every away author gets a safety quip, even with the lines all taken", () => {
    const g = toRound3(new Game({ players: 6 }));
    const p = currentPrompt(g.s);
    for (const a of ["p1", "p2", "p3"]) g.ok(a, { type: "safety", promptId: p.id });
    g.ok("p4", { type: "answer", promptId: p.id, text: "typed last quip" });
    g.leave("p5");
    g.leave("p6");
    g.now = g.timerAt(TIMER.away) as number;
    g.wait(0);
    for (const a of ["p5", "p6"]) {
      const ans = g.s.hidden.answers[p.id]?.[a];
      expect(ans?.safety).toBe(true);
      expect(SAFETY.has(ans?.text as string)).toBe(true);
    }
    expect(g.s.phase).toBe("show-all");
    expect(g.s.order).toHaveLength(6);
  });

  it("R14: fewer than 3 connected authors for 30 s prompts the host; forceAdvance ends the game", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    g.leave("p3");
    expect(g.s.lowSince).toBe(g.now);
    g.rejoin("p3");
    expect(g.s.lowSince).toBeNull();
    g.leave("p3");
    g.wait(30_000);
    expect(g.s.endPrompt).toBe(true);
    expect(g.view({ role: "host" }).host?.endPrompt).toBe(true);
    // A second leave while already low changes nothing.
    const s = logic.onPlayerLeave?.(g.s, "p3", ctxAt(g.now)).state;
    expect(s).toBe(g.s);
    expect(logic.onPlayerLeave?.(g.s, "zz", ctxAt(g.now)).state).toBe(g.s);
    expect(logic.onPlayerRejoin?.(g.s, "p1", ctxAt(g.now)).state).toBe(g.s);
    expect(logic.onTimer?.(g.s, TIMER.low, ctxAt(g.now)).state).toBe(g.s);
    const r = g.host();
    const end = effectsOf(r.effects, "end")[0];
    expect(end?.result.ranking.map((x) => x.id)).toEqual(["p1", "p2", "p3"]);
    expect(g.runner.ended).toBe(true);
  });

  it("R14: a rejoin clears the end prompt", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    g.leave("p2");
    g.wait(31_000);
    expect(g.s.endPrompt).toBe(true);
    g.rejoin("p2");
    expect(g.s.endPrompt).toBe(false);
    expect(g.s.phase).not.toBe("final");
  });
});

describe("T9: Safety Quip", () => {
  it("T9: Safety Quip is limited to once per round", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    const mine = roundPrompts(g.s).filter((p) => p.authors.includes("p1"));
    const [p1, p2] = mine as [QcState["prompts"][number], QcState["prompts"][number]];
    expect(g.view({ role: "player", id: "p1" }).you?.safetyLeft).toBe(true);
    g.ok("p1", { type: "safety", promptId: p1.id });
    const line = g.s.hidden.answers[p1.id]?.["p1"]?.text as string;
    expect(SAFETY.has(line)).toBe(true);
    expect(g.s.hidden.safetyPool[p1.id]).not.toContain(line);
    expect(g.act("p1", { type: "safety", promptId: p2.id }).err).toBe("ILLEGAL");
    expect(g.view({ role: "player", id: "p1" }).you?.safetyLeft).toBe(false);
    // Overwriting the safety answer returns its line to the pool.
    g.ok("p1", { type: "answer", promptId: p1.id, text: "my own words" });
    expect(g.s.hidden.safetyPool[p1.id]).toContain(line);
    // The partner on the same prompt draws a different line.
    const partner = p2.authors.find((a) => a !== "p1") as string;
    g.ok(partner, { type: "safety", promptId: p2.id });
    expect(g.s.hidden.answers[p2.id]?.[partner]?.safety).toBe(true);
    // Round 2 allows it again.
    toRound2(g);
    const next = roundPrompts(g.s).find((p) => p.authors.includes("p1"));
    g.ok("p1", { type: "safety", promptId: next?.id as string });
  });

  it("T9: the safetyQuip option off disables the button", () => {
    const g = new Game({ options: { safetyQuip: false } });
    g.until("answer");
    const p = roundPrompts(g.s)[0];
    expect(g.act(p?.authors[0] as string, { type: "safety", promptId: p?.id }).err).toBe("ILLEGAL");
    expect(legalActions(g.s, "p1").some((a) => a.type === "safety")).toBe(false);
  });
});

function toRound2(g: Game): void {
  for (let i = 0; i < 300 && !(g.s.phase === "answer" && g.s.round === 2); i++) {
    if (g.s.phase === "answer") g.answerAll();
    else if (g.s.phase === "vote") finishVote(g);
    else g.step();
  }
}

describe("T11: secrecy", () => {
  it("T11: before show-answers no stage, audience or other-player view contains any answer text", () => {
    const g = new Game({ players: 5 });
    g.until("answer").answerAll();
    const p = currentPrompt(g.s);
    const texts = Object.values(g.s.hidden.answers[p.id] ?? {}).map((a) => a.text);
    expect(g.s.phase).toBe("show-prompt");
    const outsiders = g.s.players.map((x) => x.id).filter((id) => !p.authors.includes(id));
    for (const t of texts) {
      for (const role of ["stage", "audience", "host"] as const)
        expect(view(g, role)).not.toContain(t);
      expect(JSON.stringify(g.view({ role: "audience", restricted: true }))).not.toContain(t);
      for (const id of outsiders)
        expect(JSON.stringify(g.view({ role: "player", id }))).not.toContain(t);
    }
    g.step();
    for (const t of texts) expect(view(g, "stage")).toContain(t);
    // Authors of A/B are only named from results.
    expect(g.view({ role: "stage" }).cards?.every((c) => c.author === null)).toBe(true);
  });

  it("T11: prompts stay off the stage during the answer phase; players see only their own", () => {
    const g = new Game({ players: 4 });
    g.until("answer");
    for (const p of roundPrompts(g.s)) expect(view(g, "stage")).not.toContain(p.text);
    const own = g.view({ role: "player", id: "p1" }).you?.prompts.map((x) => x.id) ?? [];
    expect(own.sort()).toEqual(
      roundPrompts(g.s)
        .filter((p) => p.authors.includes("p1"))
        .map((p) => p.id)
        .sort(),
    );
  });

  it(
    "T11: no view leaks another viewer's hidden values across whole bot games (solo and team)",
    () => {
      for (const seats of [makeSeats(5), teamSeats(6, ["t1", "t2", "t3"])]) {
        for (const room of [{}, { moderation: "reveal-review" as const }]) {
          const module = createQuipClash(room);
          const moderated = new Set<string>();
          let leaks: string[] = [];
          const sim = simulateGame(module, {
            seed: 7,
            players: seats,
            content: () => content(),
            onStep: ({ state, effects, runner }) => {
              for (const e of effects) if (e.type === "moderate") moderated.add(e.preview);
              if (leaks.length === 0)
                leaks = findLeaks(module, state, runner.players, { moderated });
            },
          });
          expect(sim.ended).toBe(true);
          expect(leaks).toEqual([]);
        }
      }
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe("T12: bots", () => {
  it(
    "T12: bots finish a full game for N=3..8 in team and non-team mode",
    () => {
      for (let n = 3; n <= 8; n++) {
        const variants = [makeSeats(n)];
        if (n >= 3)
          variants.push(teamSeats(n, n >= 4 ? ["t1", "t2", "t3", "t4"] : ["t1", "t2", "t3"]));
        if (n >= 6) variants.push(teamSeats(n, ["t1", "t2", "t3"]));
        for (const seats of variants) {
          const sim = simulateGame(logic, {
            seed: n,
            players: seats,
            content: () => content(),
            maxSteps: 400,
          });
          expect(sim.ended, `${n}p`).toBe(true);
          expect(sim.illegalActions).toBe(0);
          expect(sim.steps).toBeLessThanOrEqual(400);
          expect(sim.result?.ranking.length).toBe(new Set(seats.map((s) => s.teamId ?? s.id)).size);
        }
      }
    },
    HEAVY_TIMEOUT_MS,
  );

  it("the bot answers, sometimes presses Safety, votes and spreads hearts", () => {
    const g = new Game({ players: 4 });
    g.until("answer");
    const rng = createRng(5);
    const actions = Array.from({ length: 40 }, () => bot(g.s, "p1", rng));
    expect(actions.some((a) => a?.type === "safety")).toBe(true);
    expect(actions.some((a) => a?.type === "answer")).toBe(true);
    for (const p of roundPrompts(g.s)) {
      if (p.authors.includes("p1")) g.ok("p1", { type: "safety", promptId: p.id });
      break;
    }
    // Once p1 used Safety, the bot writes.
    expect(Array.from({ length: 10 }, () => bot(g.s, "p1", rng)?.type)).not.toContain("safety");
    g.answerAll();
    expect(bot(g.s, "p1", rng)).toBeNull();
    expect(bot(g.s, "zz", rng)).toBeNull();
    g.until("vote");
    const voter = g.voters()[0] as string;
    expect(bot(g.s, voter, rng)?.type).toBe("vote");
    g.ok(voter, { type: "vote", choice: "A" });
    expect(bot(g.s, voter, rng)).toBeNull();
    expect(legalActions(g.s, "zz")).toEqual([]);
  });

  it("generated answers never clash with any text in the game", () => {
    const g = new Game({ players: 3 });
    const pickFirst = { ...createRng(1), pick: <T>(items: readonly T[]) => items[0] as T };
    const first = freshAnswer(g.s, pickFirst);
    expect(first).toBe("a suspiciously damp trombone");
    const s: QcState = {
      ...g.s,
      players: g.s.players.map((p, i) => (i === 0 ? { ...p, name: first } : p)),
    };
    // Every templated candidate now clashes with a name: the numbered fallback is used.
    expect(freshAnswer(s, pickFirst)).toBe("trombone number 2");
    const s2: QcState = {
      ...s,
      players: s.players.map((p, i) => (i === 1 ? { ...p, name: "trombone number 2" } : p)),
    };
    expect(freshAnswer(s2, pickFirst)).toBe("trombone number 3");
  });

  it("legalActions offers a spread allocation in Last Quip with 3+ other cards", () => {
    const g = toRound3(new Game({ players: 4 }));
    g.answerAll().until("vote");
    const acts = legalActions(g.s, "p1");
    expect(acts.filter((a) => a.type === "lastVote")).toHaveLength(4);
    const rng = createRng(2);
    const a = bot(g.s, "p1", rng);
    expect(a?.type === "lastVote" && Object.values(a.alloc).reduce((x, y) => x + y, 0)).toBe(3);
  });
});

describe("host commands, timing and views", () => {
  it("forceAdvance moves every phase on (vote uses the votes so far)", () => {
    const g = new Game({ players: 3 });
    const seen: string[] = [];
    for (let i = 0; i < 200 && !g.runner.ended; i++) {
      seen.push(`${g.s.phase}:${g.s.closing ? "c" : ""}`);
      if (g.s.phase === "answer" && g.s.round === 1 && i < 3) {
        const p = roundPrompts(g.s)[0];
        g.ok(p?.authors[0] as string, {
          type: "answer",
          promptId: p?.id as string,
          text: "a first line",
        });
        g.ok(p?.authors[1] as string, {
          type: "answer",
          promptId: p?.id as string,
          text: "a second line",
        });
      }
      g.host();
    }
    expect(g.runner.ended).toBe(true);
    expect(seen).toContain("vote:");
    expect(seen).toContain("vote:c");
    expect(seen).toContain("final:");
    expect(g.act("p1", { type: "vote", choice: "A" }).err).toBe("ENDED");
  });

  it("skipItem is not used and leaves the state unchanged", () => {
    const g = new Game();
    const s = g.s;
    expect(logic.onHostCommand?.(s, { c: "skipItem", itemId: "x" }, ctxAt(T0)).state).toBe(s);
  });

  it("with timerScale 0 there are no deadlines; the host moves the game on", () => {
    const g = new Game({ players: 3, timerScale: 0 });
    g.step();
    expect(g.s.phase).toBe("answer");
    expect(g.s.deadline).toBeNull();
    expect(g.timerAt(TIMER.away)).toBeUndefined();
    expect(g.timerAt()).toBeUndefined();
    const open = effectsOf(g.effects, "audience.open")[0];
    expect(open?.poll.closesAtMs).toBe(g.now + 90_000);
    g.answerAll((pid, a) => (a === "p3" ? null : `${a} on ${pid}`));
    g.leave("p3");
    g.host();
    // The away author's prompts were filled with safety quips at the host's advance.
    const p3 = roundPrompts({ ...g.s, round: 1 }).filter((p) => p.authors.includes("p3"));
    expect(p3.every((p) => g.s.hidden.answers[p.id]?.["p3"]?.safety === true)).toBe(true);
    g.until("vote");
    expect(g.s.deadline).toBeNull();
  });

  it("the deadline invariant holds: set only in input phases", () => {
    const sim = simulateGame(logic, {
      seed: 3,
      players: 4,
      content: () => content(),
      onStep: ({ state }) => {
        const input = state.phase === "answer" || state.phase === "vote";
        expect(state.deadline !== null).toBe(input);
      },
    });
    expect(sim.ended).toBe(true);
  });

  it("views carry the right fields for each role", () => {
    const g = new Game({ players: 4 });
    const intro = g.view({ role: "stage" });
    expect(intro).toMatchObject({
      phase: "intro",
      prompt: null,
      cards: null,
      you: null,
      host: null,
      rounds: [1, 2, 3],
      matchups: 4,
    });
    expect(g.view({ role: "moderator" }).host?.review).toEqual([]);
    g.until("answer").answerAll();
    g.until("vote");
    const [a] = currentPrompt(g.s).authors as [string, string];
    expect(g.view({ role: "player", id: a }).you?.ownSlots).toEqual(["A"]);
    const b = currentPrompt(g.s).authors[1] as string;
    expect(g.view({ role: "player", id: b }).you?.ownSlots).toEqual(["B"]);
    expect(g.view({ role: "player", id: "zz" }).you).toBeNull();
    expect(involves(g.s, a)).toBe(true);
    expect(involves(g.s, g.voters()[0] as string)).toBe(false);
    expect(involves(g.s, "zz")).toBe(false);
    finishVote(g, "B");
    expect(g.view({ role: "stage" }).result?.quipOut).toBe(currentPrompt(g.s).authors[1]);
    g.until("scores");
    expect(g.view({ role: "stage" }).result).toBeNull();
    expect(involves(g.s, a)).toBe(false);
    const r3 = toRound3(g);
    r3.answerAll();
    expect(involves(r3.s, "p1")).toBe(false);
    expect(r3.view({ role: "player", id: "p1" }).you?.ownSlots).toHaveLength(1);
  });

  it("a results view without a stored result (defensive) is null", () => {
    const g = new Game({ players: 3 });
    g.until("answer").answerAll();
    const s: QcState = { ...g.s, phase: "results" };
    expect(logic.view(s, { role: "stage" }).result).toBeNull();
  });
});

describe("parseAction and room settings", () => {
  it("parseAction accepts only well-formed actions", () => {
    expect(parseAction({ type: "answer", promptId: "p", text: "hi" })).toEqual({
      type: "answer",
      promptId: "p",
      text: "hi",
    });
    expect(parseAction({ type: "answer", promptId: "", text: "hi" })).toBeNull();
    expect(parseAction({ type: "answer", promptId: "p", text: 5 })).toBeNull();
    expect(parseAction({ type: "safety", promptId: "p" })).toEqual({
      type: "safety",
      promptId: "p",
    });
    expect(parseAction({ type: "safety", promptId: "x".repeat(65) })).toBeNull();
    expect(parseAction({ type: "vote", choice: "B" })).toEqual({ type: "vote", choice: "B" });
    expect(parseAction({ type: "lastVote", alloc: { c1: 2, c2: 1 } })).toEqual({
      type: "lastVote",
      alloc: { c1: 2, c2: 1 },
    });
    expect(parseAction({ type: "lastVote", alloc: {} })).toBeNull();
    expect(parseAction({ type: "lastVote", alloc: [1] })).toBeNull();
    expect(parseAction({ type: "lastVote", alloc: { c9: 1 } })).toBeNull();
    expect(parseAction({ type: "lastVote", alloc: { c1: 1.5 } })).toBeNull();
    expect(parseAction({ type: "lastVote", alloc: { c1: 4 } })).toBeNull();
    expect(parseAction({ type: "lastVote", alloc: { c1: "1" } })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, 0]));
    expect(parseAction({ type: "lastVote", alloc: many })).toBeNull();
    expect(parseAction({ type: "move" })).toBeNull();
    expect(parseAction(null)).toBeNull();
    expect(parseAction([1])).toBeNull();
    expect(parseAction("vote")).toBeNull();
  });

  it("room settings: override, then the context, then defaults; invalid values fall back", () => {
    const ctx = {
      room: { contentFilter: "family", moderation: "reveal-review", audienceMin: 9 },
    } as unknown as SetupContext<QcOptions>;
    expect(resolveRoomSettings(ctx)).toEqual({
      contentFilter: "family",
      moderation: "reveal-review",
      audienceMin: 9,
    });
    expect(resolveRoomSettings(ctx, { audienceMin: 2 }).audienceMin).toBe(2);
    const bad = {
      room: { contentFilter: "x", moderation: "y", audienceMin: 0 },
    } as unknown as SetupContext<QcOptions>;
    expect(resolveRoomSettings(bad)).toEqual({
      contentFilter: "standard",
      moderation: "off",
      audienceMin: 5,
    });
    expect(resolveRoomSettings({} as SetupContext<QcOptions>).audienceMin).toBe(5);
  });

  it("the audience minimum comes from the room (chip: chat vote not counted)", () => {
    const g = new Game({ players: 3, room: { audienceMin: 50 } });
    g.until("answer").answerAll();
    g.until("vote");
    expect(g.view({ role: "stage" }).poll?.min).toBe(50);
    g.audience("vote-r1-m1", { A: 30, B: 10 });
    g.ok(g.voters()[0] as string, { type: "vote", choice: "A" });
    expect(g.s.results[currentPrompt(g.s).id]?.audienceCounted).toBe(false);
  });

  it("odd audience payloads are sanitised", () => {
    const g = new Game({ players: 3 });
    g.until("answer");
    g.runner.audienceResult(
      { pollId: "predict-r1", kind: "predict", total: Number.NaN, tallies: { p1: -1, p2: 3 } },
      g.now,
    );
    expect(g.s.predict).toMatchObject({ total: 0, tallies: { p2: 3 } });
  });
});

describe("scenarios (SPEC §14)", () => {
  const SPEC: Record<
    string,
    { roles: ("stage" | "host" | "player" | "audience")[]; anim: string | null }
  > = {
    intro: { roles: ["stage"], anim: null },
    answering: { roles: ["stage", "player"], anim: "plane:600" },
    reveal: { roles: ["stage"], anim: "reveal:900" },
    voting: { roles: ["stage", "player", "audience"], anim: "hearts:1500" },
    results: { roles: ["stage"], anim: "results:1200" },
    quipout: { roles: ["stage"], anim: "quipout:1600" },
    jinx: { roles: ["stage"], anim: "jinx:900" },
    "last-quip": { roles: ["stage", "player"], anim: null },
    final: { roles: ["stage"], anim: "win:2000" },
    "review-wait": { roles: ["stage", "host"], anim: null },
    "round-predict": { roles: ["stage", "audience"], anim: null },
  };

  it("every spec scenario is registered with its anim and builds for each listed role", () => {
    for (const [id, spec] of Object.entries(SPEC)) {
      const sc = scenarios[id];
      expect(sc?.id, id).toBe(id);
      expect(sc?.anim === undefined ? null : `${sc.anim.name}:${sc.anim.durationMs}`).toBe(
        spec.anim,
      );
      for (const role of spec.roles) {
        const r = resolveScenario(logic, scenarios, { state: id, role, seed: 3 });
        expect(r.view.phase).toBe(r.state.phase);
      }
    }
    expect(scenarios["midgame"]?.anim?.name).toBe("hearts");
  });

  it("scenarios show what the spec table describes, as of SCENARIO_NOW", () => {
    const at = (id: string, role: "stage" | "host" | "player" | "audience" = "stage") =>
      resolveScenario(logic, scenarios, { state: id, role, seed: 1 });
    expect(at("intro").state.phase).toBe("intro");
    const answering = at("answering", "player");
    expect(answering.state.deadline).toBe(SCENARIO_NOW + 42_000);
    expect(answering.view.authors.filter((a) => a.done)).toHaveLength(4);
    expect(answering.view.you?.prompts.every((p) => p.answer === null)).toBe(true);
    const reveal = at("reveal");
    expect([reveal.state.phase, reveal.state.matchup]).toEqual(["show-answers", 1]);
    expect(reveal.view.cards?.every((c) => c.text !== null)).toBe(true);
    const voting = at("voting", "player");
    expect(voting.view.votesCast).toBe(3);
    expect(voting.view.votersEligible).toBe(4);
    expect(voting.view.you?.canVote).toBe(true);
    expect(at("results").view.result?.quipOut).toBeNull();
    expect(at("quipout").view.result?.quipOut).not.toBeNull();
    expect(at("jinx").view.result?.jinx).toBe(true);
    const last = at("last-quip", "player");
    expect([last.state.phase, last.state.round, last.view.cards?.length]).toEqual(["vote", 3, 7]);
    expect(last.view.you?.canVote).toBe(true);
    const fin = at("final");
    expect(fin.view.final?.highlights.length).toBeGreaterThan(0);
    const review = at("review-wait", "host");
    expect(review.state.phase).toBe("review-wait");
    expect(review.view.host?.review).toHaveLength(1);
    const pending = review.view.host?.review[0]?.text as string;
    expect(JSON.stringify(at("review-wait").view)).not.toContain(pending);
    expect(at("review-wait").view.awaiting).toBe(1);
    const predict = at("round-predict", "audience");
    expect(predict.view.predict?.open).toBe(true);
    expect(predict.fx[0]?.name).toBe("audience-tally");
  });
});
