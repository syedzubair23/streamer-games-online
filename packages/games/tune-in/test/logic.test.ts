/**
 * Tune In rule tests (DOD G3): every numbered rule (R1–R12, R4a) and every test case (T1–T13)
 * of `docs/specs/tune-in.md` has at least one test named with its number, plus the spec's edge
 * cases, host commands, views and the bot.
 */
import { createRng, type PlayerId } from "@sg/shared";
import { EMPTY_CONTENT, createTiming, defaultOptions, type Effect, type Seat } from "@sg/engine";
import { fakeContent, simulateGame } from "@sg/engine/testing";
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_MIN,
  BOT_CLUES,
  CARD_PICK_MS,
  DIAL_WAIT_MS,
  FALLBACK_CARDS,
  POLL_GRACE_MS,
  bandPoints,
  betForPoints,
  botAction,
  botClue,
  buildDeck,
  cardEndTokens,
  checkClue,
  clampDial,
  drawPair,
  drawTarget,
  estimateFromClue,
  exampleSlot,
  finalRanking,
  graphemeLength,
  parseAction,
  rankByScore,
  resolveMode,
  roundedMean,
  sameCard,
  scoreDial,
  stealCorrect,
  stealSide,
  teamGuessers,
  tuneIn,
  type Card,
  type TiOptions,
  type TiState,
} from "../src/logic/index.ts";
import { TableDriver, scenarioSeats, scenarios } from "../src/scenarios.ts";
import { TEST_PACK, testContent } from "./fixtures.ts";
import { actx, ctxAt, effectsOf, fxNames, secrecyProblems } from "./helpers.ts";

const COLD_HOT: Card = {
  id: "c",
  left: "Cold",
  right: "Hot",
  examples: ["Ice cube", "Tap water", "Lava"],
};

/** A teams table (6 seats) in the guess phase of turn 1. */
function teamsAtGuess(seed = 1, options: Partial<TiOptions> = {}, audience = 800): TableDriver {
  return new TableDriver({ seed, players: 6, options, audience })
    .skipIntro()
    .voteCard([60, 40])
    .clue();
}

/** An FFA table in the guess phase of turn 1. */
function ffaAtGuess(players: number, seed = 1, options: Partial<TiOptions> = {}): TableDriver {
  return new TableDriver({ seed, players, options: { mode: "ffa", ...options } })
    .skipIntro()
    .voteCard([60, 40])
    .clue();
}

/** Every effect a runner emitted on the last call, via a fresh act. */
function actEffects(
  d: TableDriver,
  id: PlayerId,
  action: unknown,
  gap = 700,
): { ok: boolean; effects: Effect[] } {
  d.now += gap;
  const r = d.runner.act(id, action, d.now);
  return { ok: r.ok, effects: r.effects };
}

// ---------------------------------------------------------------------------------------------

describe("R1 dial units and target", () => {
  it("R1: the target is rng.int(901) + 50 and secret until the reveal", () => {
    const rng = createRng(3);
    const copy = createRng(3);
    expect(drawTarget(rng)).toBe(copy.int(901) + 50);
    const d = teamsAtGuess(4);
    expect(tuneIn.view(d.state, { role: "stage" }).target).toBeNull();
    expect(tuneIn.view(d.state, { role: "player", id: d.state.psychic }).target).toBe(
      d.state.hidden.target,
    );
  });

  it("R1: the dial spans 0–1000; parseAction rejects anything else (edge case)", () => {
    expect(parseAction({ type: "setDial", v: 0 })).toEqual({ type: "setDial", v: 0 });
    expect(parseAction({ type: "setDial", v: 1000 })).toEqual({ type: "setDial", v: 1000 });
    for (const v of [-1, 1001, 1.5, Number.NaN, "500", null, Infinity]) {
      expect(parseAction({ type: "setDial", v })).toBeNull();
    }
  });
});

describe("R2 scoring bands", () => {
  it("R2: 4 / 3 / 2 / 0 by distance, boundaries score the higher band", () => {
    expect(bandPoints(0)).toBe(4);
    expect(bandPoints(-25)).toBe(4);
    expect(bandPoints(75)).toBe(3);
    expect(bandPoints(-125)).toBe(2);
    expect(bandPoints(500)).toBe(0);
    expect(scoreDial(600, 525)).toBe(3);
  });

  it("T1: 25 scores 4, 26 scores 3, 75 scores 3, 125 scores 2, 126 scores 0", () => {
    expect([25, 26, 75, 125, 126].map(bandPoints)).toEqual([4, 3, 3, 2, 0]);
    expect([76].map(bandPoints)).toEqual([2]);
  });

  it("T2: the target always falls in 50–950 (property, 20,000 draws, every value reachable)", () => {
    const rng = createRng("t2");
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) {
      const t = drawTarget(rng);
      expect(t).toBeGreaterThanOrEqual(50);
      expect(t).toBeLessThanOrEqual(950);
      seen.add(t);
    }
    expect(seen.has(50) && seen.has(950)).toBe(true);
    for (let seed = 1; seed <= 60; seed++) {
      const t = new TableDriver({ seed, players: 2 }).state.hidden.target;
      expect(t >= 50 && t <= 950).toBe(true);
    }
  });
});

describe("R3 psychic rotation", () => {
  it("R3: teams alternate turns and the psychic rotates by seat within each team", () => {
    const d = new TableDriver({ seed: 11, players: 6, options: { steal: false } }).skipIntro();
    const seen: { team: string; psychic: string }[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push({ team: d.state.activeTeam as string, psychic: d.state.psychic });
      d.playTeamTurn(0);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]?.team).not.toBe(seen[i - 1]?.team);
    const byTeam = (t: string) => seen.filter((s) => s.team === t).map((s) => s.psychic);
    const tomato = d.state.teams.find((t) => t.id === "tomato")?.members ?? [];
    const sky = d.state.teams.find((t) => t.id === "sky")?.members ?? [];
    expect(byTeam("tomato")).toEqual(tomato);
    expect(byTeam("sky")).toEqual(sky);
    expect(tomato).toEqual(["p1", "p3", "p5"]);
    expect(sky).toEqual(["p2", "p4", "p6"]);
  });

  it("R3: FFA rotates through all seats; default 1 cycle, 2 with fewer than 4 players", () => {
    for (const [n, turns] of [
      [2, 4],
      [3, 6],
      [4, 4],
      [9, 9],
    ] as const) {
      const s = new TableDriver({ seed: n, players: n, options: { mode: "ffa" } }).state;
      expect(s.psychicQueue).toHaveLength(turns);
      expect(new Set(s.psychicQueue).size).toBe(n);
      expect(s.maxTurns).toBe(turns);
      // Consecutive seats: each rotation is the seat order from a seeded start.
      const first = s.psychicQueue.slice(0, n).map((id) => Number(id.slice(1)) - 1);
      for (let i = 1; i < n; i++) expect(first[i]).toBe(((first[0] as number) + i) % n);
    }
  });

  it("R3: host cycles override the default; FFA is capped at 9 turns", () => {
    const s3 = new TableDriver({ seed: 1, players: 4, options: { mode: "ffa", cycles: 3 } }).state;
    expect(s3.psychicQueue).toHaveLength(9);
    const s5 = new TableDriver({ seed: 1, players: 5, options: { mode: "ffa", cycles: 2 } }).state;
    expect(s5.psychicQueue).toHaveLength(9);
  });

  it("R3: with 10–12 players, 9 distinct psychics are drawn by seeded shuffle", () => {
    for (const n of [10, 11, 12]) {
      const a = new TableDriver({ seed: 5, players: n, options: { mode: "ffa" } }).state;
      const b = new TableDriver({ seed: 5, players: n, options: { mode: "ffa" } }).state;
      expect(a.psychicQueue).toHaveLength(9);
      expect(new Set(a.psychicQueue).size).toBe(9);
      expect(a.psychicQueue).toEqual(b.psychicQueue);
    }
    const draws = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      draws.add(
        new TableDriver({ seed, players: 12, options: { mode: "ffa" } }).state.psychicQueue.join(),
      );
    }
    expect(draws.size).toBeGreaterThan(1);
  });

  it("R3: everyone still guesses every FFA turn, including seats skipped as psychic", () => {
    const d = ffaAtGuess(11, 3);
    expect(Object.keys(d.state.hidden.ffaDials)).toHaveLength(10);
    expect(d.state.hidden.ffaDials[d.state.psychic]).toBeUndefined();
  });
});

describe("R4 card pick", () => {
  it("R4: two different cards are drawn and the audience vote opens for timing.input(10 s)", () => {
    const d = new TableDriver({ seed: 2, players: 4 });
    d.wait((d.state.deadline as number) - d.now);
    const s = d.state;
    expect(s.phase).toBe("card-pick");
    expect(s.cardPicker).toBe("audience");
    expect(sameCard(s.cardChoices[0], s.cardChoices[1])).toBe(false);
    expect(s.deadline).toBe(d.now + CARD_PICK_MS + 3_000);
    expect(s.polls.card).not.toBeNull();
  });

  it("R4: the plurality card wins; the psychic sees the target only after the pick", () => {
    const d = new TableDriver({ seed: 2, players: 4 }).skipIntro();
    const psychic = d.state.psychic;
    expect(tuneIn.view(d.state, { role: "player", id: psychic }).target).toBeNull();
    const second = d.state.cardChoices[1];
    d.voteCard([3, 9]);
    expect(d.state.phase).toBe("clue");
    expect(d.state.card?.id).toBe(second.id);
    expect(tuneIn.view(d.state, { role: "player", id: psychic }).target).toBe(
      d.state.hidden.target,
    );
  });

  it("R4: a tied vote is broken by the rng (both outcomes occur across seeds)", () => {
    const picked = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const d = new TableDriver({ seed, players: 4 }).skipIntro();
      const choices = d.state.cardChoices.map((c) => c.id);
      d.voteCard([6, 6]);
      picked.add(String(choices.indexOf(d.state.card?.id as string)));
    }
    expect([...picked].sort()).toEqual(["0", "1"]);
  });

  it("R4: with audiencePicksCard off the psychic picks, and the first card is taken on timeout", () => {
    const d = new TableDriver({
      seed: 3,
      players: 4,
      options: { audiencePicksCard: false },
    }).skipIntro();
    expect(d.state.cardPicker).toBe("psychic");
    expect(d.state.polls.card).toBeNull();
    expect(tuneIn.legalActions(d.state, d.state.psychic)).toHaveLength(2);
    const first = d.state.cardChoices[0].id;
    d.toDeadline();
    expect(d.state.phase).toBe("clue");
    expect(d.state.card?.id).toBe(first);

    const e = new TableDriver({
      seed: 3,
      players: 4,
      options: { audiencePicksCard: false },
    }).skipIntro();
    const second = e.state.cardChoices[1].id;
    e.act(e.state.psychic, { type: "pickCard", idx: 1 });
    expect(e.state.card?.id).toBe(second);
  });

  it("R4: if the vote result never arrives, the psychic picks after a grace period", () => {
    const d = new TableDriver({ seed: 3, players: 4 }).skipIntro();
    const deadline = d.state.deadline as number;
    d.wait(deadline - d.now + POLL_GRACE_MS);
    expect(d.state.cardPicker).toBe("psychic");
    expect(d.state.phase).toBe("card-pick");
    // A late result for the old poll is ignored.
    d.runner.audienceResult(
      { pollId: "ti-1-card-1", kind: "vote", total: 50, tallies: { "0": 50 } },
      d.now,
    );
    expect(d.state.cardPicker).toBe("psychic");
  });

  it("T8: an audience below the minimum falls back to the psychic's pick", () => {
    const d = new TableDriver({ seed: 8, players: 4 }).skipIntro();
    d.voteCard([AUDIENCE_MIN - 2, 1]);
    expect(d.state.phase).toBe("card-pick");
    expect(d.state.cardPicker).toBe("psychic");
    expect(d.state.deadline).toBe(d.now + CARD_PICK_MS + 3_000);
    const view = tuneIn.view(d.state, { role: "player", id: d.state.psychic });
    expect(view.target).toBeNull();
    expect(view.you?.role).toBe("psychic");
    d.act(d.state.psychic, { type: "pickCard", idx: 0 });
    expect(d.state.phase).toBe("clue");
  });

  it("R4: only the psychic may pick, and only when the audience is not picking", () => {
    const d = new TableDriver({ seed: 8, players: 4 }).skipIntro();
    expect(actEffects(d, d.state.psychic, { type: "pickCard", idx: 0 }).ok).toBe(false);
    d.voteCard([1, 1]);
    const other = d.state.players.find((p) => p.id !== d.state.psychic)?.id as string;
    expect(actEffects(d, other, { type: "pickCard", idx: 0 }).ok).toBe(false);
  });
});

describe("R4a result bet", () => {
  it("R4a: the predict poll opens with the clue phase and closes when the guess starts", () => {
    const d = new TableDriver({ seed: 5, players: 4 }).skipIntro();
    d.wait(1_000);
    const res = d.runner.audienceResult(
      { pollId: d.state.polls.card as string, kind: "vote", total: 9, tallies: { "0": 9 } },
      d.now,
    );
    const open = effectsOf(res.effects, "audience.open").map((e) => e.poll);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("predict");
    expect(open[0]?.options?.map((o) => o.id)).toEqual(["bullseye", "close", "miss"]);
    expect(open[0]?.closesAtMs).toBe(d.state.deadline);
    const betId = d.state.polls.bet as string;
    // A clue after the minimum window (3 + 5 s) closes the bet at once.
    const clued = actEffects(d, d.state.psychic, { type: "clue", text: "Lava" }, 9_000);
    expect(effectsOf(clued.effects, "audience.close").map((e) => e.pollId)).toContain(betId);
    expect(effectsOf(clued.effects, "audience.open").map((e) => e.poll.kind)).toEqual(["dial"]);
  });

  it("T11: the bet resolves with the team's band (teams)", () => {
    for (const [pts, bet] of [
      [4, "bullseye"],
      [3, "close"],
      [2, "close"],
      [0, "miss"],
    ] as const) {
      // Clue after the minimum audience window so the bet close (and its resolve) is not held.
      const d = new TableDriver({ seed: 6, players: 6, options: { steal: false } })
        .skipIntro()
        .voteCard([60, 40])
        .clue(undefined, 9_000);
      const betId = d.state.polls.bet;
      d.teamGuess(d.dialFor(pts));
      const r = d.runner.audienceResult(
        { pollId: d.state.polls.dial as string, kind: "dial", total: 0, tallies: {}, mean: 0 },
        d.now,
      );
      const resolve = effectsOf(r.effects, "audience.resolve").find((e) => e.pollId === betId);
      expect(resolve?.correct).toBe(bet);
      expect(betForPoints(pts)).toBe(bet);
    }
  });

  it("T11: in FFA the bet resolves with the best guesser's band, opens at clue, closes at guess", () => {
    const d = new TableDriver({ seed: 7, players: 4, options: { mode: "ffa" } }).skipIntro();
    d.voteCard([5, 5]);
    expect(d.state.phase).toBe("clue");
    const betId = d.state.polls.bet as string;
    d.clue();
    const [a, b, c] = Object.keys(d.state.hidden.ffaDials) as [string, string, string];
    d.act(a, { type: "setDial", v: d.dialFor(2) }).act(a, { type: "lock" });
    d.act(b, { type: "setDial", v: d.dialFor(3) }).act(b, { type: "lock" });
    d.act(c, { type: "setDial", v: d.dialFor(0) });
    const r = actEffects(d, c, { type: "lock" }, 9_000);
    expect(effectsOf(r.effects, "audience.close").length).toBeGreaterThan(0);
    const rr = d.runner.audienceResult(
      { pollId: d.state.polls.dial as string, kind: "dial", total: 0, tallies: {}, mean: 0 },
      d.now,
    );
    expect(effectsOf(rr.effects, "audience.resolve").find((e) => e.pollId === betId)?.correct).toBe(
      "close",
    );
    expect(d.state.last?.points).toBe(3);
  });
});

describe("R5 clue", () => {
  it("R5: a valid clue is 1–40 characters and moves to the guess", () => {
    expect(checkClue("Sauna", COLD_HOT)).toEqual({ ok: true, clue: "Sauna" });
    expect(checkClue("  Warm   bath  ", COLD_HOT)).toEqual({ ok: true, clue: "Warm bath" });
    expect(checkClue("", COLD_HOT)).toMatchObject({ ok: false, reason: "length" });
    expect(checkClue("   ", COLD_HOT)).toMatchObject({ ok: false, reason: "length" });
    expect(checkClue("a".repeat(40), COLD_HOT).ok).toBe(true);
    expect(checkClue("a".repeat(41), COLD_HOT)).toMatchObject({ ok: false, reason: "length" });
    expect(graphemeLength("👍🏽ok")).toBe(3);
  });

  it("T3: rejects 'hot' for Cold ↔ Hot, rejects 'h0t2', accepts 'Sauna'", () => {
    expect(checkClue("hot", COLD_HOT)).toMatchObject({
      ok: false,
      reason: "card-word",
      word: "hot",
    });
    expect(checkClue("h0t2", COLD_HOT)).toMatchObject({ ok: false, reason: "digit" });
    expect(checkClue("Sauna", COLD_HOT).ok).toBe(true);
    // A card-end token inside a clue token, full-width digits, and profanity are rejected too.
    expect(checkClue("Hotdog stand", COLD_HOT)).toMatchObject({ ok: false, reason: "card-word" });
    expect(checkClue("Ice ２", COLD_HOT)).toMatchObject({ ok: false, reason: "digit" });
    expect(checkClue("COLD!", COLD_HOT)).toMatchObject({ ok: false, reason: "card-word" });
    expect(checkClue("fuck", COLD_HOT)).toMatchObject({ ok: false, reason: "filter" });
  });

  it("R5: short common words are never checked (edge case: only tokens of 3+ characters)", () => {
    const card: Card = { id: "x", left: "In", right: "Out of it" };
    expect(cardEndTokens(card)).toEqual(["out"]);
    expect(checkClue("in it to win it", card).ok).toBe(true);
    expect(checkClue("Shout", card).ok).toBe(false);
  });

  it("R5: a rejected clue leaves the state unchanged and privately tells the psychic", () => {
    const d = new TableDriver({ seed: 9, players: 4 }).skipIntro().voteCard([5, 1]);
    const before = d.state;
    const word = cardEndTokens(before.card as Card)[0] as string;
    const r = actEffects(d, before.psychic, { type: "clue", text: `${word} 2` });
    expect(r.ok).toBe(false);
    expect(d.state).toBe(before);
    const priv = effectsOf(r.effects, "private");
    expect(priv).toEqual([
      { type: "private", to: before.psychic, name: "clueRejected", data: { reason: "digit" } },
    ]);
    const r2 = actEffects(d, before.psychic, { type: "clue", text: word });
    expect(effectsOf(r2.effects, "private")[0]?.data).toEqual({ reason: "card-word", word });
    expect(d.state.phase).toBe("clue");
  });

  it("R5: on timeout the bot gives a clue from the card's examples", () => {
    const d = new TableDriver({ seed: 10, players: 4, content: testContent() })
      .skipIntro()
      .voteCard([5, 1]);
    const card = d.state.card as Card;
    d.toDeadline();
    expect(d.state.phase).toBe("guess");
    expect(card.examples).toContain(d.state.clue);
    const slot = exampleSlot(d.state.hidden.target, 3);
    expect(d.state.clue).toBe(card.examples?.[slot]);
  });

  it("R5: only the psychic, in the clue phase, may clue", () => {
    const d = new TableDriver({ seed: 10, players: 4 }).skipIntro();
    expect(actEffects(d, d.state.psychic, { type: "clue", text: "Sauna" }).ok).toBe(false);
    d.voteCard([5, 1]);
    const other = d.state.players.find((p) => p.id !== d.state.psychic)?.id as string;
    expect(actEffects(d, other, { type: "clue", text: "Sauna" }).ok).toBe(false);
  });
});

describe("R6 team guess", () => {
  it("R6: any guesser moves the shared dial, the last value wins, and the psychic cannot", () => {
    const d = teamsAtGuess(12);
    const [a, b] = teamGuessers(d.state) as [string, string];
    d.act(a, { type: "setDial", v: 300 }).act(b, { type: "setDial", v: 640 });
    expect(d.state.dial).toBe(640);
    expect(tuneIn.view(d.state, { role: "stage" }).dial).toBe(640);
    expect(actEffects(d, d.state.psychic, { type: "setDial", v: 10 }).ok).toBe(false);
    const opponent = d.state.teams.find((t) => t.id !== d.state.activeTeam)?.members[0] as string;
    expect(actEffects(d, opponent, { type: "setDial", v: 10 }).ok).toBe(false);
  });

  it("R6: setDial is limited to 5 per second per player", () => {
    const d = teamsAtGuess(12);
    const [a, b] = teamGuessers(d.state) as [string, string];
    for (let i = 0; i < 5; i++)
      expect(actEffects(d, a, { type: "setDial", v: 100 + i }, 150).ok).toBe(true);
    const sixth = actEffects(d, a, { type: "setDial", v: 900 }, 50);
    expect(sixth.ok).toBe(false);
    expect(fxNames(sixth.effects)).toContain("illegal");
    expect(actEffects(d, b, { type: "setDial", v: 901 }, 10).ok).toBe(true);
    expect(actEffects(d, a, { type: "setDial", v: 902 }, 400).ok).toBe(true);
  });

  it("R6: any member can lock; otherwise the dial locks at the deadline", () => {
    const d = teamsAtGuess(13, { steal: false });
    const [a, b] = teamGuessers(d.state) as [string, string];
    d.act(a, { type: "setDial", v: 777 }).act(b, { type: "lock" });
    expect(d.state.locked).toBe(true);
    expect(d.state.awaitingDial).toBe(true);

    const e = teamsAtGuess(13, { steal: false });
    e.act(teamGuessers(e.state)[0] as string, { type: "setDial", v: 222 });
    e.toDeadline();
    expect(e.state.locked).toBe(true);
    e.dialResult(0, 0);
    expect(e.state.phase).toBe("reveal");
    expect(e.state.last?.dial).toBe(222);
  });

  it("T13: lock is rejected before the dial moved and before 5 s, accepted after either", () => {
    const d = teamsAtGuess(14);
    const [a] = teamGuessers(d.state) as [string];
    expect(tuneIn.legalActions(d.state, a).some((x) => x.type === "lock")).toBe(false);
    expect(actEffects(d, a, { type: "lock" }, 1_000).ok).toBe(false);
    expect(actEffects(d, a, { type: "lock" }, 3_000).ok).toBe(false);
    expect(actEffects(d, a, { type: "lock" }, 1_000).ok).toBe(true);

    const e = teamsAtGuess(14);
    const [x] = teamGuessers(e.state) as [string];
    e.act(x, { type: "setDial", v: 500 }, 200);
    expect(tuneIn.legalActions(e.state, x).some((y) => y.type === "lock")).toBe(true);
    expect(actEffects(e, x, { type: "lock" }, 100).ok).toBe(true);

    const f = ffaAtGuess(3, 14);
    const g = Object.keys(f.state.hidden.ffaDials)[0] as string;
    expect(actEffects(f, g, { type: "lock" }, 1_000).ok).toBe(false);
    expect(actEffects(f, g, { type: "lock" }, 4_500).ok).toBe(true);
  });

  it("R6: a team of only the psychic takes the audience mean, else locks at 500", () => {
    // Room teams 3 vs 1: the lone Sky player is always Sky's psychic.
    const seats: Seat[] = scenarioSeats(4).map((s, i) => ({
      ...s,
      teamId: i === 3 ? "sky" : "tomato",
    }));
    const find = (d: TableDriver): TableDriver => {
      for (let i = 0; i < 3 && d.state.activeTeam !== "sky"; i++) d.playTeamTurn(0);
      return d;
    };
    const d = find(
      new TableDriver({ seed: 2, players: seats, options: { steal: false } }).skipIntro(),
    );
    expect(d.state.activeTeam).toBe("sky");
    d.voteCard([5, 5]).clue();
    expect(teamGuessers(d.state)).toEqual([]);
    d.toDeadline();
    expect(d.state.awaitingDial).toBe(true);
    d.dialResult(300, 612);
    expect(d.state.dial).toBe(612);
    expect(d.state.phase).toBe("reveal");

    const e = find(
      new TableDriver({ seed: 2, players: seats, options: { steal: false } }).skipIntro(),
    );
    e.voteCard([5, 5]).clue();
    e.toDeadline();
    e.dialResult(2, 612); // below the audience minimum: no mean
    expect(e.state.dial).toBe(500);

    const f = find(
      new TableDriver({ seed: 2, players: seats, options: { steal: false } }).skipIntro(),
    );
    f.voteCard([5, 5]).clue();
    f.toDeadline();
    f.wait(POLL_GRACE_MS); // the result never arrives
    expect(f.state.dial).toBe(500);
    expect(f.state.phase).toBe("reveal");
  });

  it("R6: with no audience at all, a lone psychic's dial locks at 500 at once (edge case)", () => {
    const seats: Seat[] = scenarioSeats(4).map((s, i) => ({
      ...s,
      teamId: i === 3 ? "sky" : "tomato",
    }));
    const d = new TableDriver({
      seed: 2,
      players: seats,
      options: { steal: false, audiencePicksCard: false },
      audience: 0,
    }).skipIntro();
    for (let i = 0; i < 3 && d.state.activeTeam !== "sky"; i++) {
      d.act(d.state.psychic, { type: "pickCard", idx: 0 }).clue();
      d.teamGuess(d.dialFor(0));
      d.wait(DIAL_WAIT_MS);
      d.toDeadline().toDeadline();
    }
    expect(d.state.activeTeam).toBe("sky");
    d.act(d.state.psychic, { type: "pickCard", idx: 0 }).clue();
    expect(d.state.locked).toBe(true);
    expect(d.state.dial).toBe(500);
  });
});

describe("R7 steal", () => {
  it("R7: after the lock the other team picks; plurality decides; a correct steal scores 1", () => {
    const d = teamsAtGuess(15);
    const target = d.state.hidden.target;
    const dial = target > 500 ? target - 200 : target + 200;
    d.teamGuess(dial);
    expect(d.state.phase).toBe("steal");
    const [s1, s2, s3] = d.state.teams.find((t) => t.id !== d.state.activeTeam)?.members as [
      string,
      string,
      string,
    ];
    const right: "left" | "right" = target > dial ? "right" : "left";
    const wrong = right === "left" ? "right" : "left";
    const other = d.state.teams.find((t) => t.id !== d.state.activeTeam)?.id as string;
    d.act(s1, { type: "steal", side: right }).act(s2, { type: "steal", side: wrong });
    expect(actEffects(d, s1, { type: "steal", side: wrong }).ok).toBe(false); // picks are final
    d.act(s3, { type: "steal", side: right });
    if (d.state.awaitingDial) d.dialResult(0, 0);
    expect(d.state.last?.steal).toEqual({ side: right, ok: true });
    expect(d.state.scores[other]).toBe(1);
  });

  it("T4: steal logic: tie means no steal, a wrong side scores nothing, dial = target skips the steal", () => {
    expect(stealSide({ a: "left", b: "right" })).toBeNull();
    expect(stealSide({})).toBeNull();
    expect(stealSide({ a: "left", b: "left", c: "right" })).toBe("left");
    expect(stealCorrect("left", 500, 499)).toBe(true);
    expect(stealCorrect("left", 500, 501)).toBe(false);
    expect(stealCorrect("right", 500, 501)).toBe(true);
    expect(stealCorrect("right", 500, 500)).toBe(false);

    const d = teamsAtGuess(16);
    d.teamGuess(d.state.hidden.target);
    expect(d.state.phase).not.toBe("steal");
    d.dialResult(0, 0);
    expect(d.state.phase).toBe("reveal");
    expect(d.state.last?.steal).toBeUndefined();

    const e = teamsAtGuess(16);
    e.teamGuess(e.dialFor(0));
    const [x, y] = e.state.teams.find((t) => t.id !== e.state.activeTeam)?.members as [
      string,
      string,
    ];
    e.act(x, { type: "steal", side: "left" }).act(y, { type: "steal", side: "right" });
    e.toDeadline();
    e.dialResult(0, 0);
    expect(e.state.last?.steal).toBeUndefined();

    const f = teamsAtGuess(16);
    const t = f.state.hidden.target;
    f.teamGuess(t > 500 ? t - 300 : t + 300);
    const wrongSide = t > f.state.dial ? "left" : "right";
    for (const m of f.state.teams.find((q) => q.id !== f.state.activeTeam)?.members ?? []) {
      f.act(m, { type: "steal", side: wrongSide });
    }
    f.dialResult(0, 0);
    expect(f.state.last?.steal).toEqual({ side: wrongSide, ok: false });
    expect(Object.values(f.state.scores).every((v) => v === 0)).toBe(true);
  });
});

describe("R8 catch-up", () => {
  it("T5: catch-up triggers only when the team is still behind or tied, and only once in a row", () => {
    const d = new TableDriver({ seed: 21, players: 4, options: { steal: false } }).skipIntro();
    const first = d.state.activeTeam as string;
    d.playTeamTurn(4); // 4–0: ahead, no catch-up
    expect(d.state.last?.catchUp).toBe(false);
    expect(d.state.activeTeam).not.toBe(first);
    const second = d.state.activeTeam as string;
    d.playTeamTurn(4); // 4–4: tied after scoring → catch-up
    expect(d.state.last?.catchUp).toBe(true);
    expect(d.state.activeTeam).toBe(second);
    d.playTeamTurn(0);
    expect(d.state.activeTeam).toBe(first);
    d.playTeamTurn(3); // first 7, second 4
    d.playTeamTurn(4); // second 8: game over (not a catch-up: ahead)
    expect(d.state.phase).toBe("final");
  });

  it("R8: a catch-up is never granted twice in a row", () => {
    const d = new TableDriver({
      seed: 22,
      players: 4,
      options: { steal: false, scoreToWin: 15 },
    }).skipIntro();
    const a = d.state.activeTeam as string;
    d.playTeamTurn(3); // a 3
    const b = d.state.activeTeam as string;
    d.playTeamTurn(2); // b 2
    d.playTeamTurn(4); // a 7
    d.playTeamTurn(4); // b 6, behind → catch-up
    expect(d.state.activeTeam).toBe(b);
    expect(d.state.catchUpUsed).toBe(true);
    d.playTeamTurn(0); // b's catch-up turn scores 0 → back to a
    expect(d.state.activeTeam).toBe(a);
    expect(d.state.catchUpUsed).toBe(false);
    // b behind again after a 4: catch-up allowed once more (not "in a row")
    d.playTeamTurn(0); // a 7
    d.playTeamTurn(4); // b 10 ahead → no catch-up
    expect(d.state.activeTeam).toBe(a);
    const e = new TableDriver({
      seed: 23,
      players: 4,
      options: { steal: false, scoreToWin: 15 },
    }).skipIntro();
    e.playTeamTurn(3);
    const lagging = e.state.activeTeam as string;
    e.playTeamTurn(0);
    e.playTeamTurn(4); // leader 7
    e.playTeamTurn(4); // lagging 4 → catch-up
    expect(e.state.activeTeam).toBe(lagging);
    e.playTeamTurn(3); // lagging 7 = tied, but only 3 points → no second catch-up
    expect(e.state.activeTeam).not.toBe(lagging);
  });
});

describe("R9 FFA guess", () => {
  it("R9: each guesser sets and locks their own dial; open dials lock at the deadline", () => {
    const d = ffaAtGuess(4, 30);
    const [a, b, c] = Object.keys(d.state.hidden.ffaDials) as [string, string, string];
    d.act(a, { type: "setDial", v: 100 }).act(a, { type: "lock" });
    expect(actEffects(d, a, { type: "setDial", v: 200 }).ok).toBe(false);
    expect(d.state.hidden.ffaDials[a]).toEqual({ v: 100, locked: true, moved: true });
    d.act(b, { type: "setDial", v: 900 });
    expect(tuneIn.view(d.state, { role: "stage" }).ffaLocked).toEqual([a]);
    d.toDeadline();
    expect(d.state.locked).toBe(true);
    d.dialResult(0, 0);
    expect(d.state.last?.dials).toEqual({ [a]: 100, [b]: 900, [c]: 500 });
  });

  it("T7: the psychic scores the rounded mean of the guessers' points", () => {
    const d = ffaAtGuess(4, 31);
    const [a, b, c] = Object.keys(d.state.hidden.ffaDials) as [string, string, string];
    d.act(a, { type: "setDial", v: d.dialFor(4) }).act(a, { type: "lock" });
    d.act(b, { type: "setDial", v: d.dialFor(3, -1) }).act(b, { type: "lock" });
    d.act(c, { type: "setDial", v: d.dialFor(0) }).act(c, { type: "lock" });
    d.dialResult(0, 0);
    expect(d.state.last?.ffa).toEqual({ [a]: 4, [b]: 3, [c]: 0, [d.state.psychic]: 2 });
    expect(d.state.scores[d.state.psychic]).toBe(2);
    expect(roundedMean([4, 3, 0])).toBe(2);
    expect(roundedMean([4, 3])).toBe(4);
    expect(roundedMean([])).toBe(0);
  });
});

describe("R10 audience dial", () => {
  it("R10: the dial poll opens with the guess, closes at the lock and resolves with the bands", () => {
    const d = new TableDriver({ seed: 40, players: 6, options: { steal: false } })
      .skipIntro()
      .voteCard([5, 5]);
    const r = actEffects(d, d.state.psychic, { type: "clue", text: botClue(d.state, null) }, 9_000);
    const dial = effectsOf(r.effects, "audience.open").find((e) => e.poll.kind === "dial")?.poll;
    expect(dial?.closesAtMs).toBe(d.state.deadline);
    const g = teamGuessers(d.state)[0] as string;
    d.act(g, { type: "setDial", v: 400 }, 9_000);
    const lock = actEffects(d, g, { type: "lock" });
    expect(effectsOf(lock.effects, "audience.close").map((e) => e.pollId)).toContain(dial?.pollId);
    const res = d.runner.audienceResult(
      {
        pollId: dial?.pollId as string,
        kind: "dial",
        total: 100,
        tallies: {},
        mean: d.state.hidden.target,
      },
      d.now,
    );
    const resolve = effectsOf(res.effects, "audience.resolve").find(
      (e) => e.pollId === dial?.pollId,
    );
    expect(resolve?.target).toBe(d.state.hidden.target);
    expect(resolve?.bands).toEqual([
      { within: 25, points: 100 },
      { within: 75, points: 60 },
      { within: 125, points: 30 },
    ]);
  });

  it("T12: with liveHeatmap off the dial poll hides live results; on, it does not", () => {
    for (const live of [false, true]) {
      const d = new TableDriver({ seed: 41, players: 4, options: { liveHeatmap: live } })
        .skipIntro()
        .voteCard([5, 5]);
      const r = actEffects(d, d.state.psychic, { type: "clue", text: botClue(d.state, null) });
      const dial = effectsOf(r.effects, "audience.open").find((e) => e.poll.kind === "dial");
      expect(dial?.poll.hideLive).toBe(!live);
    }
  });

  it("R10: 'Chat beat you!' plays when the audience mean's band beats the team's", () => {
    const d = teamsAtGuess(42, { steal: false });
    d.teamGuess(d.dialFor(2));
    const res = d.runner.audienceResult(
      {
        pollId: d.state.polls.dial as string,
        kind: "dial",
        total: 50,
        tallies: {},
        mean: d.state.hidden.target + 5,
      },
      d.now,
    );
    expect(fxNames(res.effects)).toContain("chatBeatYou");
    expect(d.state.last).toMatchObject({ points: 2, audBand: 4, chatBeatYou: true });

    const e = teamsAtGuess(42, { steal: false });
    e.teamGuess(e.dialFor(4));
    e.dialResult(50, e.state.hidden.target + 5);
    expect(e.state.last?.chatBeatYou).toBe(false);

    const f = teamsAtGuess(42, { steal: false });
    f.teamGuess(f.dialFor(0));
    f.dialResult(AUDIENCE_MIN - 1, f.state.hidden.target);
    expect(f.state.last?.audMean).toBeUndefined();
    expect(f.state.last?.chatBeatYou).toBe(false);
  });

  it("R10: the reveal waits for the (possibly held) dial result, at most until the wait bound", () => {
    const d = teamsAtGuess(43, { steal: false });
    d.teamGuess(d.dialFor(3));
    expect(d.state.awaitingDial).toBe(true);
    expect(d.state.deadline).toBeNull();
    d.wait(DIAL_WAIT_MS);
    expect(d.state.phase).toBe("reveal");
    expect(d.state.last?.audMean).toBeUndefined();
  });
});

describe("R11 end", () => {
  it("T9: teams mode ends when a team reaches scoreToWin", () => {
    const d = new TableDriver({
      seed: 50,
      players: 4,
      options: { steal: false, scoreToWin: 5 },
    }).skipIntro();
    d.playTeamTurn(3);
    d.playTeamTurn(3);
    d.playTeamTurn(2);
    expect(d.state.phase).toBe("final");
    const win = d.state.winners?.[0] as string;
    expect(d.state.scores[win]).toBe(5);
    d.toDeadline();
    expect(d.runner.ended).toBe(true);
    expect(d.runner.result?.ranking[0]).toMatchObject({ id: win, score: 5, place: 1 });
  });

  it("T9: teams mode is capped at 12 turns; the higher score wins", () => {
    const d = new TableDriver({ seed: 51, players: 4, options: { steal: false } }).skipIntro();
    for (let i = 0; i < 12; i++) d.playTeamTurn(i === 0 ? 2 : 0);
    expect(d.state.turn).toBe(12);
    expect(d.state.phase).toBe("final");
    expect(d.runner.state.winners).toHaveLength(1);
  });

  it("R11: a tie at the cap plays one sudden-death turn per team, then may be shared", () => {
    const d = new TableDriver({ seed: 52, players: 4, options: { steal: false } }).skipIntro();
    for (let i = 0; i < 12; i++) d.playTeamTurn(0);
    expect(d.state.suddenDeath).not.toBeNull();
    expect(d.state.turn).toBe(13);
    expect(d.state.maxTurns).toBe(14);
    const sdFirst = d.state.activeTeam;
    d.playTeamTurn(4); // no catch-up in sudden death, no early end
    expect(d.state.turn).toBe(14);
    expect(d.state.activeTeam).not.toBe(sdFirst);
    d.playTeamTurn(4);
    expect(d.state.phase).toBe("final");
    expect(d.state.winners).toHaveLength(2);
    const ranking = finalRanking(d.state);
    expect(ranking.map((r) => r.place)).toEqual([1, 1]);
  });

  it("R11: if both teams reach scoreToWin on the same turn, the higher score wins, then the last scorer", () => {
    const d = new TableDriver({ seed: 53, players: 4, options: { scoreToWin: 5 } }).skipIntro();
    const a = d.state.activeTeam as string;
    d.playTeamTurn(4); // a 4 (steal phase skipped by the driver's deadline wait: no picks)
    const b = d.state.activeTeam as string;
    d.playTeamTurn(4); // b 4 → tied → catch-up for b
    expect(d.state.activeTeam).toBe(b);
    d.voteCard([5, 5]).clue();
    const t = d.state.hidden.target;
    const dial = t > 500 ? t - 70 : t + 70; // 3 points: b reaches 7
    d.teamGuess(dial);
    for (const m of d.state.teams.find((x) => x.id === a)?.members ?? []) {
      d.act(m, { type: "steal", side: t > dial ? "right" : "left" });
    }
    d.dialResult(0, 0).toDeadline().toDeadline();
    expect(d.state.scores).toMatchObject({ [a]: 5, [b]: 7 });
    expect(d.state.winners).toEqual([b]);

    // Equal scores: the team that scored last (the stealing team) wins.
    const tied: TiState = { ...d.state, scores: { [a]: 8, [b]: 8 }, lastScorer: a };
    expect(finalRanking(tied)).toEqual([
      { id: a, score: 8, place: 1 },
      { id: b, score: 8, place: 2 },
    ]);
  });

  it("R11: FFA ends after its cycles, ranked by score with ties sharing the place", () => {
    const d = new TableDriver({ seed: 54, players: 2, options: { mode: "ffa" } }).skipIntro();
    for (let turn = 0; turn < 4; turn++) {
      expect(d.state.phase).toBe("card-pick");
      d.voteCard([5, 5]).clue();
      const g = Object.keys(d.state.hidden.ffaDials)[0] as string;
      d.act(g, { type: "setDial", v: d.dialFor(turn % 2 === 0 ? 3 : 2) }).act(g, { type: "lock" });
      d.dialResult(0, 0).toDeadline().toDeadline();
    }
    expect(d.state.phase).toBe("final");
    expect(rankByScore(["a", "b", "c"], { a: 5, b: 7, c: 5 })).toEqual([
      { id: "b", score: 7, place: 1 },
      { id: "a", score: 5, place: 2 },
      { id: "c", score: 5, place: 2 },
    ]);
    d.toDeadline();
    expect(d.runner.result?.ranking).toHaveLength(2);
  });
});

describe("R12 disconnects", () => {
  it("R12: if the psychic disconnects, the bot gives the clue", () => {
    const d = new TableDriver({ seed: 60, players: 4, content: testContent() })
      .skipIntro()
      .voteCard([5, 5]);
    const psychic = d.state.psychic;
    d.runner.playerLeave(psychic, d.now);
    expect(d.state.phase).toBe("guess");
    expect(d.state.card?.examples).toContain(d.state.clue);
    expect(d.state.players.find((p) => p.id === psychic)?.connected).toBe(false);
    d.runner.playerRejoin(psychic, d.now);
    expect(d.state.players.find((p) => p.id === psychic)?.connected).toBe(true);
  });

  it("R12: a psychic already gone at clue time is replaced at once; a picking psychic takes card 1", () => {
    const d = new TableDriver({
      seed: 61,
      players: 4,
      options: { audiencePicksCard: false },
    }).skipIntro();
    const first = d.state.cardChoices[0].id;
    d.runner.playerLeave(d.state.psychic, d.now);
    expect(d.state.card?.id).toBe(first);
    expect(d.state.phase).toBe("guess");
  });

  it("R12: leaving guessers and stealers no longer hold up the phase", () => {
    const d = ffaAtGuess(3, 62);
    const [a, b] = Object.keys(d.state.hidden.ffaDials) as [string, string];
    d.act(a, { type: "setDial", v: 10 }).act(a, { type: "lock" });
    d.runner.playerLeave(b, d.now);
    expect(d.state.locked).toBe(true);

    const e = teamsAtGuess(62);
    e.teamGuess(e.dialFor(2));
    const [s1, s2, s3] = e.state.teams.find((t) => t.id !== e.state.activeTeam)?.members as [
      string,
      string,
      string,
    ];
    e.act(s1, { type: "steal", side: "left" });
    e.runner.playerLeave(s2, e.now);
    expect(e.state.phase).toBe("steal");
    e.runner.playerLeave(s3, e.now);
    expect(e.state.awaitingDial || e.state.phase === "reveal").toBe(true);
    // A seat that is gone during an unrelated phase just changes its flag.
    const before = e.state.phase;
    e.runner.playerLeave(e.state.psychic, e.now);
    expect(e.state.phase).toBe(before);
    expect(tuneIn.onPlayerLeave?.(e.state, "nobody", ctxAt(e.now)).state).toBe(e.state);
    expect(tuneIn.onPlayerRejoin?.(e.state, "nobody", ctxAt(e.now)).state).toBe(e.state);
    expect(tuneIn.onPlayerRejoin?.(e.state, s1, ctxAt(e.now)).state).toBe(e.state);
  });
});

describe("T6 secrecy", () => {
  it("T6: the target is absent from every view but the psychic's before the reveal", () => {
    for (const [players, options] of [
      [4, {}],
      [6, { mode: "ffa" }],
      [2, {}],
      [12, {}],
    ] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        simulateGame(tuneIn, {
          seed,
          players,
          options,
          content: testContent,
          onStep: ({ state }) => {
            const problems = secrecyProblems(state);
            if (problems.length > 0) throw new Error(problems.slice(0, 3).join("; "));
          },
        });
      }
    }
  }, 60_000);

  it("T6: every scenario, for every role, keeps the secrets", () => {
    for (const [id, sc] of Object.entries(scenarios)) {
      const { state } = sc.build({ seed: 3, rng: createRng(3), players: 2, role: "stage" });
      expect(secrecyProblems(state), id).toEqual([]);
    }
  });
});

describe("T10 bots", () => {
  it("T10: bots complete games with 2–12 players in both modes, with no illegal action", () => {
    for (let players = 2; players <= 12; players++) {
      for (const mode of ["teams", "ffa"] as const) {
        const r = simulateGame(tuneIn, {
          seed: players * 7,
          players,
          options: { mode },
          content: testContent,
        });
        expect(r.ended, `${players}p ${mode}: ${r.failure ?? ""}`).toBe(true);
        expect(r.illegalActions).toBe(0);
        expect(r.finalState.mode).toBe(players >= 4 ? mode : "ffa");
      }
    }
  }, 60_000);

  it("T10: the bot plays fair and sensibly in every phase", () => {
    const d = teamsAtGuess(70, {}, 800);
    const card = d.state.card as Card;
    const [g1, g2] = teamGuessers(d.state) as [string, string];
    const rng = createRng(1);
    const first = botAction(d.state, g1, rng);
    expect(first?.type).toBe("setDial");
    d.act(g1, first as never);
    expect(botAction(d.state, g2, rng)).toEqual({ type: "lock" });
    expect(botAction(d.state, d.state.psychic, rng)).toBeNull();
    d.act(g2, { type: "lock" });
    const stealer = d.state.teams.find((t) => t.id !== d.state.activeTeam)?.members[0] as string;
    const pick = botAction(d.state, stealer, rng);
    const est = estimateFromClue(card, d.state.clue);
    expect(pick).toEqual({
      type: "steal",
      side:
        est < d.state.dial
          ? "left"
          : est > d.state.dial
            ? "right"
            : (pick as { side: string }).side,
    });
    expect(estimateFromClue(COLD_HOT, "Lava")).toBe(833);
    expect(estimateFromClue(COLD_HOT, "Tap water")).toBe(500);
    expect(estimateFromClue(COLD_HOT, "Something else")).toBe(500);
    expect(estimateFromClue({ id: "x", left: "A1", right: "B2" }, "Lava")).toBe(500);
    expect(estimateFromClue(COLD_HOT, undefined)).toBe(500);
  });

  it("T10: the bot's card pick, clue and fallbacks", () => {
    const d = new TableDriver({
      seed: 71,
      players: 4,
      options: { audiencePicksCard: false },
    }).skipIntro();
    const pick = botAction(d.state, d.state.psychic, createRng(2));
    expect(pick?.type).toBe("pickCard");
    d.act(d.state.psychic, pick as never);
    const clue = botAction(d.state, d.state.psychic, createRng(2));
    expect(clue?.type).toBe("clue");
    expect(checkClue((clue as { text: string }).text, d.state.card as Card).ok).toBe(true);
    expect(
      botAction(
        d.state,
        d.state.players.find((p) => p.id !== d.state.psychic)?.id as string,
        createRng(2),
      ),
    ).toBeNull();
    // Cards whose examples are unusable fall back to neutral words, then to "Mm".
    const bare: TiState = { ...d.state, card: { id: "b", left: "Sauna", right: "Grandma" } };
    const word = botClue(bare, null);
    expect(BOT_CLUES).toContain(word);
    expect(word).not.toBe("Sauna");
    const hostile: TiState = {
      ...d.state,
      card: {
        id: "h",
        left: BOT_CLUES.join(" "),
        right: "Lava Ice",
        examples: ["Lava", "Ice", "Lava ice"],
      },
    };
    expect(botClue(hostile, createRng(1))).toBe("Mm");
    expect(tuneIn.legalActions(hostile, hostile.psychic)).toEqual([{ type: "clue", text: "Mm" }]);
    expect(exampleSlot(0, 3)).toBe(0);
    expect(exampleSlot(1000, 3)).toBe(2);
    expect(exampleSlot(500, 3)).toBe(1);
  });

  it("T10: steal bot flips a coin when its reading equals the dial", () => {
    const d = teamsAtGuess(72, {}, 800);
    const est = estimateFromClue(d.state.card as Card, d.state.clue);
    if (est === d.state.hidden.target) return; // (dial = target skips the steal)
    d.teamGuess(est);
    if (d.state.phase !== "steal") return;
    const stealer = d.state.teams.find((t) => t.id !== d.state.activeTeam)?.members[0] as string;
    const sides = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const a = botAction(d.state, stealer, createRng(seed));
      if (a?.type === "steal") sides.add(a.side);
    }
    expect([...sides].sort()).toEqual(["left", "right"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("setup, content and modes", () => {
  it("resolves the mode: auto → teams with 4+, ffa below; teams needs 4 players", () => {
    expect(resolveMode("auto", 3)).toBe("ffa");
    expect(resolveMode("auto", 4)).toBe("teams");
    expect(resolveMode("teams", 3)).toBe("ffa");
    expect(resolveMode("ffa", 8)).toBe("ffa");
    expect(new TableDriver({ seed: 1, players: 3, options: { mode: "teams" } }).state.mode).toBe(
      "ffa",
    );
  });

  it("uses the room's two teams when every seat has one, else splits Tomato vs Sky", () => {
    const seats = scenarioSeats(5).map((s, i) => ({ ...s, teamId: i < 2 ? "red" : "blue" }));
    const d = new TableDriver({ seed: 1, players: seats });
    expect(d.state.teams.map((t) => [t.id, t.name, t.members])).toEqual([
      ["red", "Tomato", ["p1", "p2"]],
      ["blue", "Sky", ["p3", "p4", "p5"]],
    ]);
    const runnerTeams = tuneIn.setup({
      players: seats,
      teams: [
        { id: "red", name: "Reds", colorSlot: 0 },
        { id: "blue", name: "Blues", colorSlot: 1 },
      ],
      options: defaultOptions(tuneIn.optionSpecs) as unknown as TiOptions,
      rng: createRng(1),
      now: 0,
      timing: createTiming({ timerScale: 1, streamDelaySec: 0 }),
      content: EMPTY_CONTENT,
      audienceCount: 0,
    }).state;
    expect(runnerTeams.teams.map((t) => t.name)).toEqual(["Reds", "Blues"]);
    const three = scenarioSeats(6).map((s, i) => ({
      ...s,
      teamId: ["a", "b", "c"][i % 3] as string,
    }));
    expect(new TableDriver({ seed: 1, players: three }).state.teams.map((t) => t.id)).toEqual([
      "tomato",
      "sky",
    ]);
  });

  it("builds the deck from the packs (unused first), deduplicated, with a fallback", () => {
    const content = fakeContent([TEST_PACK], {
      used: { spectrum: ["t-dry-wet", "t-dark-bright"] },
    });
    const deck = buildDeck(content, ["spectrum-core"], createRng(1));
    expect(deck).toHaveLength(30);
    expect(
      deck
        .slice(-2)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["t-dark-bright", "t-dry-wet"]);
    expect(buildDeck(EMPTY_CONTENT, ["spectrum-core"], createRng(1))).toHaveLength(
      FALLBACK_CARDS.length,
    );
    const dupes = fakeContent([
      { ...TEST_PACK, id: "one", items: TEST_PACK.items.slice(0, 1) },
      { ...TEST_PACK, id: "two", items: TEST_PACK.items.slice(0, 1) },
    ] as never);
    expect(buildDeck(dupes, ["one", "two"], createRng(1))).toHaveLength(FALLBACK_CARDS.length);
  });

  it("draws pairs of two different cards and rotates the ring (edge case)", () => {
    const a: Card = { id: "a", left: "X", right: "Y" };
    const a2: Card = { id: "a2", left: "x", right: "y!" };
    const b: Card = { id: "b", left: "P", right: "Q" };
    const { pair, deck } = drawPair([a, a2, b]);
    expect(pair).toEqual([a, b]);
    expect(deck).toEqual([a2, a, b]);
    expect(() => drawPair([])).toThrow();
    expect(() => drawPair([a, a2])).toThrow();
    // Every fallback card's examples pass the clue filter for their card.
    for (const card of FALLBACK_CARDS) {
      for (const ex of card.examples ?? [])
        expect(checkClue(ex, card).ok, `${card.id}: ${ex}`).toBe(true);
    }
  });

  it("parseAction never throws and accepts exactly the action shapes", () => {
    expect(parseAction({ type: "pickCard", idx: 1 })).toEqual({ type: "pickCard", idx: 1 });
    expect(parseAction({ type: "pickCard", idx: 2 })).toBeNull();
    expect(parseAction({ type: "clue", text: "hi" })).toEqual({ type: "clue", text: "hi" });
    expect(parseAction({ type: "clue", text: "" })).toBeNull();
    expect(parseAction({ type: "clue", text: "x".repeat(201) })).toBeNull();
    expect(parseAction({ type: "lock" })).toEqual({ type: "lock" });
    expect(parseAction({ type: "steal", side: "right" })).toEqual({ type: "steal", side: "right" });
    expect(parseAction({ type: "steal", side: "up" })).toBeNull();
    expect(parseAction([{ type: "lock" }])).toBeNull();
    expect(parseAction(null)).toBeNull();
    expect(parseAction("lock")).toBeNull();
    const evil = {};
    Object.defineProperty(evil, "type", {
      get: () => {
        throw new Error("boom");
      },
    });
    expect(parseAction(evil)).toBeNull();
  });

  it("clamps any number onto the dial", () => {
    expect(clampDial(-5)).toBe(0);
    expect(clampDial(1234)).toBe(1000);
    expect(clampDial(12.6)).toBe(13);
    expect(clampDial(Number.NaN)).toBe(500);
  });

  it("refuses actions from non-seats and non-player roles", () => {
    const d = teamsAtGuess(80);
    expect(tuneIn.onAction(d.state, { type: "lock" }, actx(d.now, "stranger")).state).toBe(d.state);
    const host = {
      ...actx(d.now, d.state.psychic),
      actor: { id: d.state.psychic, role: "host" as const },
    };
    expect(tuneIn.onAction(d.state, { type: "clue", text: "x" }, host).state).toBe(d.state);
  });

  it("ignores stale timers and unknown polls", () => {
    const d = teamsAtGuess(81);
    expect(tuneIn.onTimer?.(d.state, "reveal@1", ctxAt(d.now)).state).toBe(d.state);
    const weird = { ...d.state, timers: [...d.state.timers, "bogus@1"] };
    expect(tuneIn.onTimer?.(weird, "bogus@1", ctxAt(d.now)).state).toBe(weird);
    expect(
      tuneIn.onAudienceResult?.(
        d.state,
        { pollId: "nope", kind: "vote", total: 1, tallies: {} },
        ctxAt(d.now),
      ).state,
    ).toBe(d.state);
  });

  it("a dial result without a mean counts as the middle; timerScale 0 has no deadlines", () => {
    const d = teamsAtGuess(82, { steal: false });
    d.teamGuess(d.dialFor(3));
    d.audience({ pollId: d.state.polls.dial, kind: "dial", total: 40, tallies: {} });
    expect(d.state.last?.audMean).toBe(500);

    const z = new TableDriver({ seed: 82, players: 4, timerScale: 0 });
    z.wait(10_000);
    expect(z.state.phase).toBe("card-pick");
    expect(z.state.deadline).toBeNull();
    expect(z.state.timers).toEqual([]);
    z.voteCard([5, 1]);
    expect(z.state.deadline).toBeNull();
    z.runner.hostCommand({ c: "forceAdvance" }, z.now);
    expect(z.state.phase).toBe("guess");
    expect(z.state.deadline).toBeNull();
  });
});

describe("host commands", () => {
  it("forceAdvance moves every phase along", () => {
    const d = new TableDriver({ seed: 90, players: 6 });
    const fa = (): void => {
      d.runner.hostCommand({ c: "forceAdvance" }, d.now);
    };
    fa();
    expect(d.state.phase).toBe("card-pick");
    fa();
    expect(d.state.phase).toBe("clue");
    expect(d.state.card?.id).toBe(d.state.cardChoices[0].id);
    fa();
    expect(d.state.phase).toBe("guess");
    fa();
    expect(d.state.phase).toBe("steal");
    fa();
    expect(d.state.awaitingDial).toBe(true);
    fa();
    expect(d.state.phase).toBe("reveal");
    fa();
    expect(d.state.phase).toBe("turn-score");
    fa();
    expect(d.state.phase).toBe("card-pick");
    expect(d.state.turn).toBe(2);
    d.voteCard([1, 1]);
    expect(d.state.cardPicker).toBe("psychic");
    fa();
    expect(d.state.phase).toBe("clue");
    fa();
    fa(); // guess → steal (or reveal wait)
    if (d.state.phase === "steal") fa();
    fa();
    expect(d.state.phase).toBe("reveal");
  });

  it("forceAdvance ends the game from final and resolves waits in guess", () => {
    const d = new TableDriver({
      seed: 91,
      players: 4,
      options: { steal: false, scoreToWin: 5 },
    }).skipIntro();
    d.playTeamTurn(3);
    d.playTeamTurn(0);
    d.playTeamTurn(3);
    expect(d.state.phase).toBe("final");
    d.runner.hostCommand({ c: "forceAdvance" }, d.now);
    expect(d.runner.ended).toBe(true);

    const e = teamsAtGuess(91, { steal: false });
    e.teamGuess(e.dialFor(2));
    expect(e.state.awaitingDial).toBe(true);
    e.runner.hostCommand({ c: "forceAdvance" }, e.now);
    expect(e.state.phase).toBe("reveal");

    const f = ffaAtGuess(3, 91);
    f.runner.hostCommand({ c: "forceAdvance" }, f.now);
    expect(f.state.locked).toBe(true);
  });

  it("skipItem redraws the offered cards during the card pick only", () => {
    const d = new TableDriver({ seed: 92, players: 4 }).skipIntro();
    const before = d.state.cardChoices.map((c) => c.id);
    const oldPoll = d.state.polls.card;
    const early = d.runner.hostCommand({ c: "skipItem", itemId: before[0] as string }, d.now);
    // Within the minimum audience window the runner holds the close (SPEC §4)...
    expect(effectsOf(early.effects, "audience.close")).toEqual([]);
    const held = d.runner.advance(d.now + 8_000);
    expect(effectsOf(held.effects, "audience.close").map((e) => e.pollId)).toEqual([oldPoll]);
    d.wait(8_000);
    const second = d.state.polls.card;
    const r = d.runner.hostCommand({ c: "skipItem", itemId: d.state.cardChoices[1].id }, d.now);
    // ...after it, the close goes out at once.
    expect(effectsOf(r.effects, "audience.close").map((e) => e.pollId)).toEqual([second]);
    expect(d.state.cardChoices.map((c) => c.id)).not.toEqual(before);
    expect(d.state.polls.card).not.toBe(oldPoll);
    const same = d.state;
    d.runner.hostCommand({ c: "skipItem", itemId: "not-offered" }, d.now);
    expect(d.state).toBe(same);
    d.voteCard([5, 1]);
    const inClue = d.state;
    d.runner.hostCommand({ c: "skipItem", itemId: inClue.card?.id as string }, d.now);
    expect(d.state).toBe(inClue);
  });
});

describe("views and legal actions", () => {
  it("each role sees what the spec allows, with a `you` slice only for players", () => {
    const d = teamsAtGuess(100);
    const psychic = d.state.psychic;
    const [g] = teamGuessers(d.state) as [string];
    const opp = d.state.teams.find((t) => t.id !== d.state.activeTeam)?.members[0] as string;
    expect(tuneIn.view(d.state, { role: "player", id: psychic }).you?.role).toBe("psychic");
    expect(tuneIn.view(d.state, { role: "player", id: g }).you?.role).toBe("guesser");
    expect(tuneIn.view(d.state, { role: "player", id: opp }).you?.role).toBe("waiting");
    expect(tuneIn.view(d.state, { role: "player", id: "ghost" }).you).toBeNull();
    for (const v of [
      { role: "host" },
      { role: "moderator" },
      { role: "audience", restricted: true },
    ] as const) {
      const view = tuneIn.view(d.state, v);
      expect(view.target).toBeNull();
      expect(view.you).toBeNull();
      expect(view.card?.id).toBe(d.state.card?.id);
      expect(JSON.stringify(view)).not.toContain("examples");
    }
    d.teamGuess(d.dialFor(2));
    expect(tuneIn.view(d.state, { role: "player", id: opp }).you?.role).toBe("stealer");
    expect(tuneIn.view(d.state, { role: "player", id: psychic }).you?.role).toBe("psychic");
    expect(tuneIn.view(d.state, { role: "player", id: g }).you?.role).toBe("guesser");
    expect(tuneIn.view(d.state, { role: "player", id: psychic }).target).toBeNull();
    expect(tuneIn.view(d.state, { role: "stage" }).stealTeam).not.toBeNull();
    expect(tuneIn.legalActions(d.state, opp)).toHaveLength(2);
    expect(tuneIn.legalActions(d.state, g)).toEqual([]);
  });

  it("the target and results become public at the reveal", () => {
    const d = teamsAtGuess(101, { steal: false });
    d.teamGuess(d.dialFor(3));
    d.dialResult(0, 0);
    const stage = tuneIn.view(d.state, { role: "stage" });
    expect(stage.target).toBe(d.state.hidden.target);
    expect(stage.last?.points).toBe(3);
    expect(stage.lockOpensAt).toBe((d.state.guessStartedAt as number) + 5_000);
    d.toDeadline();
    expect(tuneIn.view(d.state, { role: "audience" }).target).toBe(d.state.last?.target);
    d.toDeadline();
    expect(tuneIn.view(d.state, { role: "stage" }).target).toBeNull();
    expect(tuneIn.view(d.state, { role: "stage" }).last?.target).toBe(d.state.last?.target);
  });

  it("legal actions match each phase", () => {
    const d = new TableDriver({ seed: 102, players: 4 });
    expect(d.state.players.every((p) => tuneIn.legalActions(d.state, p.id).length === 0)).toBe(
      true,
    );
    d.skipIntro().voteCard([1, 1]);
    expect(tuneIn.legalActions(d.state, d.state.psychic).map((a) => a.type)).toEqual([
      "pickCard",
      "pickCard",
    ]);
    d.act(d.state.psychic, { type: "pickCard", idx: 0 });
    const clues = tuneIn.legalActions(d.state, d.state.psychic);
    expect(clues.length).toBeGreaterThan(0);
    for (const c of clues)
      expect(checkClue((c as { text: string }).text, d.state.card as Card).ok).toBe(true);
    d.clue();
    const g = teamGuessers(d.state)[0] as string;
    expect(tuneIn.legalActions(d.state, g).filter((a) => a.type === "setDial")).toHaveLength(9);
  });
});
