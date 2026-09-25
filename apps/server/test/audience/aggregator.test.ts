/**
 * AudienceAggregator (ROADMAP M1-03) unit tests on a fake clock and a recording fan-out.
 * Each Accept bullet has a test named after it; the rest cover every poll kind's behaviour.
 */
import { describe, expect, it } from "vitest";
import {
  DIAL_BINS,
  GUESS_COOLDOWN_MS,
  QUIZ_POINTS,
  SEEDS_FLOOR,
  SEEDS_START,
  TALLY_INTERVAL_MS,
  type Session,
} from "../../src/index.ts";
import { createTiming } from "@sg/engine";
import { Rig } from "./rig.ts";

describe("AudienceAggregator: accept criteria", () => {
  it("one vote per audId, which can be changed until close (a quiz vote locks on the first answer)", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const [x, y] = r.members(2) as [Session, Session];
    r.open({ pollId: "v", kind: "vote" });
    r.vote(x, "v", "a");
    r.vote(x, "v", "a");
    r.vote(x, "v", "b"); // changed
    r.vote(y, "v", "b");
    r.vote(y, "v", "nope"); // not an option: ignored, keeps "b"
    r.agg.close("v");
    expect(r.lastResult()).toMatchObject({ total: 2, tallies: { a: 0, b: 2, c: 0 } });
    // After close nothing changes.
    r.vote(x, "v", "a");
    expect(r.results).toHaveLength(1);

    r.open({ pollId: "q", kind: "quiz" });
    r.vote(x, "q", "a");
    r.vote(x, "q", "b"); // locked: still "a"
    r.vote(y, "q", "c");
    r.agg.close("q");
    expect(r.lastResult()).toMatchObject({ total: 2, tallies: { a: 1, b: 0, c: 1 } });

    // predict and dial are changeable too.
    r.open({ pollId: "p", kind: "predict" });
    r.vote(x, "p", "a");
    r.vote(x, "p", "c");
    r.open({ pollId: "d", kind: "dial" });
    r.vote(x, "d", 10);
    r.vote(x, "d", 990);
    r.agg.close("p");
    expect(r.lastResult()).toMatchObject({ total: 1, tallies: { a: 0, c: 1 } });
    r.agg.close("d");
    expect(r.lastResult()?.mean).toBe(990);
  });

  it("tallies go out at no more than 4 Hz, and reactions every 500 ms", () => {
    const r = new Rig({ streamDelaySec: 0 });
    const members = r.members(200);
    r.open({ pollId: "v", kind: "vote", closesAtMs: r.clock.now() + 60_000 });
    // 10 s of constant voting: someone changes their vote every 10 ms.
    for (let t = 0; t < 10_000; t += 10) {
      const m = members[(t / 10) % members.length] as Session;
      r.vote(m, "v", ["a", "b", "c"][(t / 10) % 3] as string);
      r.clock.advance(10);
    }
    const tallyTimes = r.times("tally");
    expect(tallyTimes.length).toBeGreaterThan(30);
    expect(tallyTimes.length).toBeLessThanOrEqual(41); // 10 s at 4 Hz, +1 for the first
    for (let i = 1; i < tallyTimes.length; i++)
      expect((tallyTimes[i] as number) - (tallyTimes[i - 1] as number)).toBeGreaterThanOrEqual(
        TALLY_INTERVAL_MS,
      );
    // No change, no tally.
    const before = r.of("tally").length;
    r.clock.advance(5_000);
    expect(r.of("tally")).toHaveLength(before);

    // Reactions: 1,000 reactions over 3 s go out as batches 500 ms apart, counts preserved.
    for (let t = 0; t < 3_000; t += 3) {
      r.agg.input(members[t % 200] as Session, { t: "react", e: t % 2 === 0 ? "heart" : "fire" });
      r.clock.advance(3);
    }
    r.clock.advance(1_000);
    const batchTimes = r.times("reactions");
    const all = r.of("reactions", "all");
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.length).toBeLessThanOrEqual(7);
    for (let i = 1; i < batchTimes.length; i++)
      expect((batchTimes[i] as number) - (batchTimes[i - 1] as number)).toBeGreaterThanOrEqual(500);
    const sum = all.reduce((n, m) => n + (m.counts.heart ?? 0) + (m.counts.fire ?? 0), 0);
    expect(sum).toBe(1_000);
    // Unknown emotes are dropped; a quiet room sends nothing.
    r.agg.input(members[0] as Session, { t: "react", e: "poop" as "heart" });
    r.clock.advance(2_000);
    expect(r.of("reactions")).toHaveLength(all.length);
  });

  it("a guess poll matches accept[] after normalisation, and the accept values never appear in any outgoing frame", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const [a, b, c, d, e] = r.members(5) as [Session, Session, Session, Session, Session];
    r.open({ pollId: "g", kind: "guess", accept: ["Crème Brûlée", "flan"] });
    r.vote(a, "g", "  CREME   brulee!! "); // correct after normalisation
    r.vote(b, "g", "creme brulle"); // Levenshtein 1 on a 5+ letter answer: close, not correct
    r.clock.advance(GUESS_COOLDOWN_MS - 1);
    r.vote(b, "g", "crème brûlée"); // too soon: dropped
    r.clock.advance(1);
    r.vote(b, "g", "Crème-Brûlée"); // now correct
    r.vote(c, "g", "FLAN");
    r.vote(d, "g", "flam"); // 4 letters: wrong, not close
    r.vote(e, "g", "x".repeat(33)); // too long: dropped
    r.clock.advance(1_000);
    // Private cues to the guesser only.
    expect(r.of("fx", b.id).map((m) => m.events[0]?.name)).toEqual([
      "guess.close",
      "guess.correct",
    ]);
    expect(r.of("fx", d.id)).toEqual([]);
    // Live: the count of correct guessers.
    expect(r.of("tally").at(-1)).toMatchObject({ tallies: { correct: 3 }, total: 4 });
    r.agg.close("g");
    const res = r.lastResult();
    expect(res).toMatchObject({ kind: "guess", total: 4, tallies: { correct: 3 } });
    expect(res?.firstCorrect?.map((f) => f.audId)).toEqual([a.id, b.id, c.id]);
    // Points 100 → 20 by order.
    expect(r.agg.leaderboard.points(a.id)).toBe(100);
    expect(r.agg.leaderboard.points(b.id)).toBe(90);
    expect(r.agg.leaderboard.points(c.id)).toBe(80);
    expect(r.of("pollEnd", a.id).at(-1)?.you).toMatchObject({ correct: true, points: 100 });
    expect(r.of("pollEnd", d.id).at(-1)?.you).toMatchObject({ correct: false, points: 0 });
    // The grep: no accepted answer (raw or normalised) and no guess text in any frame.
    const wire = r.wire().toLowerCase();
    for (const secret of [
      "crème brûlée",
      "creme brulee",
      "brûlée",
      "brulee",
      "flan",
      "creme brulle",
    ])
      expect(wire).not.toContain(secret);
    expect(wire).not.toContain('"accept"');
    expect(r.of("poll")[0]?.poll).not.toHaveProperty("accept");
  });

  it("a dial poll produces a 50-bin histogram", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const ms = r.members(6);
    r.open({ pollId: "d", kind: "dial" });
    const values = [0, 19, 21, 500, 999, 1000];
    ms.forEach((m, i) => r.vote(m, "d", values[i] as number));
    r.vote(ms[0] as Session, "d", 1001); // out of range: ignored
    r.vote(ms[0] as Session, "d", 3.5); // not an integer: ignored
    r.clock.advance(TALLY_INTERVAL_MS);
    const live = r.of("tally").at(-1);
    expect(Object.keys(live?.tallies ?? {})).toHaveLength(DIAL_BINS);
    r.agg.close("d");
    const res = r.lastResult();
    const bins = res?.tallies ?? {};
    expect(Object.keys(bins)).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
    expect(Object.values(bins).reduce((a, b) => a + b, 0)).toBe(6);
    expect(bins["0"]).toBe(2); // 0 and 19 (each bin spans ~20 values)
    expect(bins["1"]).toBe(1); // 21
    expect(bins["24"]).toBe(1); // 500
    expect(bins["49"]).toBe(2); // 999 and 1000
    expect(res?.mean).toBeCloseTo(values.reduce((a, b) => a + b, 0) / 6);
    // Band scoring on resolve: the tightest band wins.
    r.agg.resolve({
      type: "audience.resolve",
      pollId: "d",
      target: 500,
      bands: [
        { within: 500, points: 10 },
        { within: 0, points: 100 },
        { within: 25, points: 50 },
      ],
    });
    expect(ms.map((m) => r.agg.leaderboard.points(m.id))).toEqual([10, 10, 10, 100, 10, 10]);
  });

  it("predict pays out pari-mutuel, and a balance never drops below 100", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const [w1, w2, l1, l2, l3, l4] = r.members(6) as Session[] as [
      Session,
      Session,
      Session,
      Session,
      Session,
      Session,
    ];
    r.open({ pollId: "p", kind: "predict" });
    for (const m of [w1, w2]) r.vote(m, "p", "a");
    for (const m of [l1, l2, l3, l4]) r.vote(m, "p", "b");
    r.agg.close("p");
    r.agg.resolve({ type: "audience.resolve", pollId: "p", correct: "a" });
    // Pool 600, winning pool 200: each winner gets 300 back for a 100 stake (+200 net).
    const seeds = r.agg.leaderboard.seeds;
    expect(seeds.balance(w1.id)).toBe(SEEDS_START + 200);
    expect(seeds.balance(w2.id)).toBe(SEEDS_START + 200);
    expect(seeds.balance(l1.id)).toBe(SEEDS_START - 100);
    const end = r.of("pollEnd", "aud").at(-1);
    expect(end?.result.correct).toBe("a");
    expect(r.of("pollEnd", w1.id).at(-1)?.you).toEqual({ correct: true, seeds: 1200 });
    expect(r.of("pollEnd", l1.id).at(-1)?.you).toEqual({ correct: false, seeds: 900 });
    // A second resolve does not pay twice.
    r.agg.resolve({ type: "audience.resolve", pollId: "p", correct: "a" });
    expect(seeds.balance(w1.id)).toBe(1200);
    // Keep losing: l1 bottoms out at the floor and stays there.
    for (let i = 0; i < 20; i++) {
      r.open({ pollId: `p${i}`, kind: "predict" });
      r.vote(l1, `p${i}`, "b");
      r.vote(w1, `p${i}`, "a");
      r.agg.resolve({ type: "audience.resolve", pollId: `p${i}`, correct: "a" });
      expect(seeds.balance(l1.id)).toBeGreaterThanOrEqual(SEEDS_FLOOR);
    }
    expect(seeds.balance(l1.id)).toBe(SEEDS_FLOOR);
    // Nobody backed the winner: everyone is refunded.
    const before = [l2, l3].map((m) => seeds.balance(m.id));
    r.open({ pollId: "none", kind: "predict" });
    r.vote(l2, "none", "b");
    r.vote(l3, "none", "b");
    r.agg.resolve({ type: "audience.resolve", pollId: "none", correct: "c" });
    expect([l2, l3].map((m) => seeds.balance(m.id))).toEqual(before);
  });

  it("predict never creates Seeds: a member at the floor stakes nothing and a resolve never raises the total", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const [w, l, x] = r.members(3) as [Session, Session, Session];
    const seeds = r.agg.leaderboard.seeds;
    const total = (): number => [w, l, x].reduce((n, m) => n + seeds.balance(m.id), 0);
    // Drive l to the floor: 9 losing 100-Seed stakes against w.
    for (let i = 0; i < 9; i++) {
      r.open({ pollId: `down${i}`, kind: "predict" });
      r.vote(l, `down${i}`, "b");
      r.vote(w, `down${i}`, "a");
      const before = total();
      r.agg.resolve({ type: "audience.resolve", pollId: `down${i}`, correct: "a" });
      expect(total()).toBeLessThanOrEqual(before);
    }
    expect(seeds.balance(l.id)).toBe(SEEDS_FLOOR);
    const wBefore = seeds.balance(w.id);
    // l bets from the floor and loses: nothing to lose, so nothing enters w's winnings.
    r.open({ pollId: "floor", kind: "predict" });
    r.vote(l, "floor", "b");
    r.vote(w, "floor", "a");
    const before = total();
    r.agg.resolve({ type: "audience.resolve", pollId: "floor", correct: "a" });
    expect(seeds.balance(l.id)).toBe(SEEDS_FLOOR);
    expect(seeds.balance(w.id)).toBe(wBefore);
    expect(total()).toBeLessThanOrEqual(before);
    // l still counted in the tally (they voted), just with a zero stake.
    expect(r.lastResult()).toMatchObject({ pollId: "floor", total: 2 });
    // Two overlapping polls: x stakes in both, but the second settles only what is left
    // above the floor, so x never goes below it and the total never rises.
    for (let i = 0; i < 8; i++) {
      r.open({ pollId: `x${i}`, kind: "predict" });
      r.vote(x, `x${i}`, "b");
      r.vote(w, `x${i}`, "a");
      r.agg.resolve({ type: "audience.resolve", pollId: `x${i}`, correct: "a" });
    }
    expect(seeds.balance(x.id)).toBe(SEEDS_START - 800);
    r.open({ pollId: "o1", kind: "predict" });
    r.open({ pollId: "o2", kind: "predict" });
    r.vote(x, "o1", "b");
    r.vote(x, "o2", "b");
    r.vote(w, "o1", "a");
    r.vote(w, "o2", "a");
    for (const id of ["o1", "o2"]) {
      const b = total();
      r.agg.resolve({ type: "audience.resolve", pollId: id, correct: "a" });
      expect(total()).toBeLessThanOrEqual(b);
    }
    expect(seeds.balance(x.id)).toBe(SEEDS_FLOOR);
    expect(seeds.balance(w.id)).toBe(SEEDS_START + 900 + 800 + 100);
  });

  it("below audienceMin, the flag says the vote doesn't count", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 5 });
    const ms = r.members(5);
    r.open({ pollId: "few", kind: "vote" });
    for (const m of ms.slice(0, 4)) r.vote(m, "few", "a");
    r.agg.close("few");
    expect(r.lastResult()).toMatchObject({ total: 4, counted: false });
    expect(r.of("pollEnd").at(-1)?.result).toMatchObject({ counted: false });
    r.open({ pollId: "enough", kind: "vote" });
    for (const m of ms) r.vote(m, "enough", "b");
    r.agg.close("enough");
    expect(r.lastResult()).toMatchObject({ total: 5, counted: true });
    expect(r.of("pollEnd").at(-1)?.result).toMatchObject({ counted: true });
  });

  it("stream delay is added to closesAtMs for deadline polls; event polls ignore it and discard inputs received after the close event", () => {
    const r = new Rig({ streamDelaySec: 3, audienceMin: 1 });
    const [x, y] = r.members(2) as [Session, Session];
    const t0 = r.clock.now();
    // A game builds the window with ctx.timing.input, which adds the delay once; the
    // aggregator must announce and honour that deadline as-is, never add the delay again.
    const timing = createTiming({ timerScale: 1, streamDelaySec: 3 });
    r.open({ pollId: "dl", kind: "vote", closesAtMs: t0 + (timing.input(10_000) as number) });
    expect(r.of("poll").at(-1)?.poll.closesAtMs).toBe(t0 + 13_000);
    r.clock.advance(10_500);
    r.vote(x, "dl", "a"); // inside the delayed window: counts
    r.clock.advance(2_400);
    expect(r.agg.isOpen("dl")).toBe(true);
    r.clock.advance(100);
    expect(r.agg.isOpen("dl")).toBe(false);
    expect(r.lastResult()).toMatchObject({ pollId: "dl", total: 1 });

    // closeOn: "event": no delay, no deadline timer; closed by the game, late input discarded.
    const t1 = r.clock.now();
    r.open({ pollId: "ev", kind: "vote", closesAtMs: t1 + 10_000, closeOn: "event" });
    expect(r.of("poll").at(-1)?.poll.closesAtMs).toBe(t1 + 10_000);
    r.vote(x, "ev", "b");
    r.clock.advance(30_000);
    expect(r.agg.isOpen("ev")).toBe(true); // the deadline never closes it
    r.agg.close("ev"); // the closing event (e.g. the move is made)
    r.vote(y, "ev", "b"); // same instant, but after the event: discarded
    r.clock.advance(1);
    r.vote(y, "ev", "c");
    expect(r.agg.stats.late).toBe(2);
    expect(r.lastResult()).toMatchObject({ pollId: "ev", total: 1, tallies: { b: 1 } });

    // Room polls (the next-game vote) carry the delay in their window too.
    const t2 = r.clock.now();
    r.open({ pollId: "next", kind: "vote", closesAtMs: t2 + 18_000 }, "room");
    expect(r.of("poll").at(-1)?.poll.closesAtMs).toBe(t2 + 18_000);
  });

  it("a hideLive poll broadcasts only total until close (frame grep: no per-option tallies before pollEnd)", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const ms = r.members(30);
    r.open({
      pollId: "h",
      kind: "vote",
      hideLive: true,
      options: [
        { id: "optRed", label: "Red" },
        { id: "optBlue", label: "Blue" },
      ],
    });
    for (let i = 0; i < 30; i++) {
      r.vote(ms[i] as Session, "h", i % 3 === 0 ? "optRed" : "optBlue");
      r.clock.advance(100);
    }
    const endIdx = (): number => r.sent.findIndex((s) => s.msg.t === "pollEnd");
    expect(endIdx()).toBe(-1);
    const liveTallies = r.of("tally");
    expect(liveTallies.length).toBeGreaterThan(3);
    for (const t of liveTallies) expect(t.tallies).toEqual({});
    expect(liveTallies.at(-1)?.total).toBe(30);
    // Grep every frame before pollEnd: option ids only appear in the poll announcement.
    const before = r.sent
      .filter((s) => s.msg.t !== "poll")
      .map((s) => s.wire)
      .join("\n");
    expect(before).not.toContain("optRed");
    expect(before).not.toContain("optBlue");
    r.agg.close("h");
    const end = r.of("pollEnd").at(-1);
    expect(end?.result.tallies).toEqual({ optRed: 10, optBlue: 20 });
  });
});

describe("AudienceAggregator: behaviour", () => {
  it("quiz shows only the answered count until resolve, then scores 100 plus a speed bonus", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const [fast, slow, wrong] = r.members(3) as [Session, Session, Session];
    const t0 = r.clock.now();
    r.open({ pollId: "q", kind: "quiz", closesAtMs: t0 + 10_000, speedBonus: true });
    r.vote(fast, "q", "b");
    r.clock.advance(5_000);
    r.vote(slow, "q", "b");
    r.vote(wrong, "q", "a");
    r.clock.advance(300);
    expect(r.of("tally").at(-1)).toEqual({ t: "tally", pollId: "q", tallies: {}, total: 3 });
    r.clock.advance(4_700); // deadline closes it
    const closed = r.of("pollEnd", "aud").at(-1);
    expect(closed?.result.tallies).toEqual({});
    expect(closed?.result.total).toBe(3);
    // The game gets the full tallies at close.
    expect(r.lastResult()?.tallies).toEqual({ a: 1, b: 2, c: 0 });
    r.agg.resolve({ type: "audience.resolve", pollId: "q", correct: "b" });
    const resolved = r.of("pollEnd", "aud").at(-1);
    expect(resolved?.result).toMatchObject({ correct: "b", tallies: { a: 1, b: 2, c: 0 } });
    const lb = r.agg.leaderboard;
    expect(lb.points(fast.id)).toBe(QUIZ_POINTS + 50);
    expect(lb.points(slow.id)).toBe(QUIZ_POINTS + 25);
    expect(lb.points(wrong.id)).toBe(0);
    expect(r.of("pollEnd", fast.id).at(-1)?.you).toMatchObject({ correct: true, points: 150 });
    expect(r.of("pollEnd", wrong.id).at(-1)?.you).toMatchObject({ correct: false, points: 0 });
    // The leaderboard ranks by points (+ Seeds won).
    expect(lb.top(2).map((row) => [row.audId, row.place])).toEqual([
      [fast.id, 1],
      [slow.id, 2],
    ]);
  });

  it("tap counts at most 5 taps per second per member", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const [x, y] = r.members(2) as [Session, Session];
    r.open({ pollId: "t", kind: "tap" });
    r.agg.input(x, { t: "tap", pollId: "t", n: 10 }); // bucket holds 5
    r.agg.input(x, { t: "tap", pollId: "t", n: 3 }); // empty: dropped
    r.clock.advance(400); // +2 tokens
    r.agg.input(x, { t: "tap", pollId: "t", n: 3 });
    r.agg.input(y, { t: "tap", pollId: "t", n: 11 }); // over the batch cap: dropped
    r.agg.input(y, { t: "tap", pollId: "t", n: 1 });
    r.vote(y, "t", "a"); // not a tap message: ignored
    r.clock.advance(300);
    expect(r.of("tally").at(-1)).toMatchObject({ tallies: { taps: 8 }, total: 2 });
    r.agg.close("t");
    expect(r.lastResult()).toMatchObject({ tallies: { taps: 8 }, total: 2 });
  });

  it("teamSplit polls report per-team tallies", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const ms = r.members(4, ["t1", "t2"]);
    r.open({ pollId: "v", kind: "vote", teamSplit: true });
    for (const m of ms) r.vote(m, "v", "a");
    r.agg.close("v");
    expect(r.lastResult()?.byTeam).toEqual({ t1: { a: 2 }, t2: { a: 2 } });
  });

  it("pause freezes deadlines and re-announces them on resume", () => {
    const r = new Rig({ streamDelaySec: 0, audienceMin: 1 });
    const t0 = r.clock.now();
    r.open({ pollId: "v", kind: "vote", closesAtMs: t0 + 10_000 });
    r.clock.advance(4_000);
    r.agg.pause();
    r.clock.advance(30_000);
    expect(r.agg.isOpen("v")).toBe(true);
    r.agg.resume();
    expect(r.of("poll").at(-1)?.poll.closesAtMs).toBe(r.clock.now() + 6_000);
    r.clock.advance(5_990);
    expect(r.agg.isOpen("v")).toBe(true);
    r.clock.advance(10);
    expect(r.agg.isOpen("v")).toBe(false);
  });

  it("enrolment, direct actions and awards pass through; closeAll and dispose clean up", () => {
    const r = new Rig({ streamDelaySec: 0 });
    const [x, y, z] = r.members(3) as [Session, Session, Session];
    r.agg.enroll({
      type: "audience.enroll",
      open: true,
      cap: 2,
      closesAtMs: r.clock.now() + 1_000,
    });
    r.agg.input(x, { t: "enroll", skin: 3 });
    r.agg.input(x, { t: "enroll", skin: 4 }); // already in
    r.agg.input(y, { t: "enroll", skin: 5 });
    r.agg.input(z, { t: "enroll", skin: 6 }); // over the cap
    r.clock.advance(1_000);
    expect(r.enrolled).toEqual([
      [
        { audId: x.id, name: x.name, skin: 3 },
        { audId: y.id, name: y.name, skin: 5 },
      ],
    ]);
    r.agg.input(x, { t: "audAct", a: { nudge: 1 } });
    expect(r.actions).toEqual([{ audId: x.id, action: { nudge: 1 } }]);
    r.agg.award({ type: "audience.award", points: { [x.id]: 40, [y.id]: 25 } });
    expect(r.agg.leaderboard.rowOf(x.id)).toMatchObject({ points: 40, place: 1, name: x.name });
    r.open({ pollId: "g1", kind: "vote" });
    r.open({ pollId: "r1", kind: "vote" }, "room");
    r.agg.closeAll("game");
    expect(r.agg.isOpen("g1")).toBe(false);
    expect(r.agg.isOpen("r1")).toBe(true);
    r.agg.dispose();
    expect(r.clock.pending).toBe(0);
  });
});
