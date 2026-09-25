/**
 * AudienceAggregator through the real RoomManager and room actor (ROADMAP M1-03 "bot test"):
 * 200 seeded audience bots play through one poll of every kind, and the per-socket 5 msg/s
 * audience rate limit is exercised end to end.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRng, type Rng, type S2C } from "@sg/shared";
import {
  AudienceAggregator,
  SEEDS_FLOOR,
  SEEDS_START,
  TALLY_INTERVAL_MS,
  type AudienceFactory,
} from "../../src/index.ts";
import {
  audienceShow,
  SHOW_ANSWERS,
  SHOW_POLL_MS,
  SHOW_POLLS,
  SHOW_SECRET,
  type ShowView,
} from "../fixtures/audience-show.ts";
import { RoomHarness, type FakeClient } from "../room-harness.ts";

const harnesses: RoomHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.shutdown();
});

const FAST = { introMs: 1_000, resultsMs: 1_000, scoreboardMs: 1_000 };

/** Builds a harness whose rooms use the aggregator, exposing the last one created. */
function setup(): { h: RoomHarness; agg: () => AudienceAggregator } {
  let last: AudienceAggregator | null = null;
  const audience: AudienceFactory = (ctx) => (last = new AudienceAggregator(ctx));
  const h = new RoomHarness({
    games: { "trivia-night": audienceShow() },
    actor: { timings: FAST, audience },
  });
  harnesses.push(h);
  return {
    h,
    agg: () => {
      if (last === null) throw new Error("no aggregator yet");
      return last;
    },
  };
}

type Poll = Extract<S2C, { t: "poll" }>["poll"];

/** A scripted audience member: answers each poll once (sometimes twice) after a random delay. */
class AudienceBot {
  #poll: Poll | null = null;
  #plan: { at: number; msg: Record<string, unknown> }[] = [];
  #lastSend = Number.NEGATIVE_INFINITY;
  sent = 0;

  constructor(
    readonly c: FakeClient,
    readonly rng: Rng,
    readonly smart: boolean,
  ) {}

  tick(now: number): void {
    for (const m of this.c.take("poll")) this.#onPoll(m.poll, now);
    // Stay polite: one message per 250 ms keeps us under the 5 msg/s socket limit.
    const next = this.#plan[0];
    if (next !== undefined && next.at <= now && now - this.#lastSend >= 250) {
      this.#plan.shift();
      this.#lastSend = now;
      this.sent++;
      this.c.send(next.msg);
    }
  }

  #onPoll(poll: Poll, now: number): void {
    if (this.#poll?.pollId === poll.pollId) return; // re-announced after a pause
    this.#poll = poll;
    this.#plan = [];
    // Event-closed polls close early ("the move is made"): answer anywhere in the window so
    // some answers arrive after the closing event.
    const at = now + 200 + this.rng.int(poll.closeOn === "event" ? SHOW_POLL_MS : 3_000);
    const option = (): string =>
      (poll.options?.[this.rng.int(poll.options.length)]?.id ?? "") as string;
    const aud = (choice: string | number): Record<string, unknown> => ({
      t: "aud",
      pollId: poll.pollId,
      choice,
    });
    switch (poll.kind) {
      case "vote":
      case "predict":
      case "quiz":
        this.#plan.push({ at, msg: aud(option()) });
        // Some change their mind (a quiz answer is locked and the change must be ignored).
        if (this.rng.int(3) === 0) this.#plan.push({ at: at + 500, msg: aud(option()) });
        break;
      case "dial":
        this.#plan.push({ at, msg: aud(this.rng.int(1001)) });
        break;
      case "guess":
        this.#plan.push({ at, msg: aud("banana split") });
        if (this.smart)
          this.#plan.push({ at: at + 1_600, msg: aud(`  ${SHOW_SECRET.toUpperCase()}!`) });
        break;
      case "tap":
        for (let i = 0; i < 4; i++)
          this.#plan.push({ at: at + i * 300, msg: { t: "tap", pollId: poll.pollId, n: 5 } });
        break;
    }
    if (this.rng.int(4) === 0) this.#plan.push({ at: at + 100, msg: { t: "react", e: "heart" } });
  }
}

describe("AudienceAggregator: bot test", () => {
  it("200 audience bots play one poll of every kind through a real room", async () => {
    const { h, agg } = setup();
    const host = h.create({
      playlistMode: "fixed",
      audienceMin: 5,
      streamDelaySec: 3,
      playlist: [{ gameId: "trivia-night", options: {} }],
    });
    const code = host.room?.code as string;
    const player = h.join(code, { name: "P1" });
    const rng = createRng(20260925);
    const bots: AudienceBot[] = [];
    for (let i = 0; i < 200; i++) {
      const c = h.join(code, { want: "audience", name: `Bot${i}`, ip: `10.7.${i >> 6}.${i & 63}` });
      bots.push(new AudienceBot(c, rng, i % 2 === 0));
    }
    const watcher = bots[0]?.c as FakeClient;
    h.host(host, { c: "start" });

    // Track every frame a bot receives per poll, with the time it arrived.
    const seen = new Map<string, { t: string; at: number; msg: S2C }[]>();
    let read = 0;
    let doneAt: number | null = null;
    const deadline = h.clock.now() + 5 * 60_000;
    while (h.clock.now() < deadline) {
      await h.advance(100, 100);
      const now = h.clock.now();
      for (const b of bots) b.tick(now);
      watcher.pump();
      for (; read < watcher.all.length; read++) {
        const m = watcher.all[read] as S2C;
        const id =
          m.t === "poll" ? m.poll.pollId : m.t === "tally" || m.t === "pollEnd" ? m.pollId : null;
        if (id !== null)
          (seen.get(id) ?? seen.set(id, []).get(id))?.push({ t: m.t, at: now, msg: m });
      }
      host.pump();
      if ((host.view as ShowView | null)?.phase === "done" && doneAt === null) doneAt = now;
      if (doneAt !== null && now - doneAt >= SHOW_POLL_MS) break; // let late answers arrive
    }

    // The game received one aggregate per poll, each counted (200 ≫ audienceMin).
    const view = host.view as ShowView;
    expect(view.phase).toBe("done");
    expect(view.results.map((r) => r.pollId)).toEqual(SHOW_POLLS.map((p) => p.pollId));
    for (const r of view.results) expect(r.counted).toBe(true);

    for (const spec of SHOW_POLLS) {
      const frames = seen.get(spec.pollId) ?? [];
      const open = frames.find((f) => f.t === "poll")?.msg as Extract<S2C, { t: "poll" }>;
      const endIdx = frames.findIndex((f) => f.t === "pollEnd");
      expect(open, spec.pollId).toBeDefined();
      expect(endIdx, spec.pollId).toBeGreaterThan(0);
      // Stream delay on deadline polls only: 8 s window + 3 s.
      const openedAt = frames[0]?.at as number;
      const window = open.poll.closesAtMs - openedAt;
      if (spec.closeOn === "event") expect(window).toBeLessThanOrEqual(SHOW_POLL_MS);
      else expect(window).toBeGreaterThan(SHOW_POLL_MS + 2_800);
      // Tallies at ≤ 4 Hz: consecutive tally frames at least 250 ms apart (100 ms sampling).
      const tallies = frames.slice(0, endIdx).filter((f) => f.t === "tally");
      expect(tallies.length, spec.pollId).toBeGreaterThan(0);
      for (let i = 1; i < tallies.length; i++)
        expect((tallies[i]?.at as number) - (tallies[i - 1]?.at as number)).toBeGreaterThanOrEqual(
          TALLY_INTERVAL_MS - 100,
        );
      // hideLive and quiz: no distribution before pollEnd.
      if (spec.hideLive === true || spec.kind === "quiz")
        for (const f of tallies)
          expect((f.msg as Extract<S2C, { t: "tally" }>).tallies).toEqual({});
    }

    // No accepted answer ever reached any socket: bots, the player, the Stage.
    const secret = SHOW_SECRET.toLowerCase();
    for (const c of [host, player, ...bots.map((b) => b.c)]) {
      const text = c.rawText().toLowerCase();
      expect(text).not.toContain(secret);
      expect(text).not.toContain('"accept"');
    }

    const a = agg();
    // Event-closed poll: inputs after the closing event were discarded.
    expect(a.stats.late).toBeGreaterThan(0);
    expect(a.stats.reactionBatches).toBeGreaterThan(0);
    // Seeds: everyone ≥ the floor; predict winners gained, losers lost exactly a stake.
    const lb = a.leaderboard;
    const rows = lb.rows();
    expect(rows.length).toBe(200);
    for (const r of rows) expect(r.seeds).toBeGreaterThanOrEqual(SEEDS_FLOOR);
    const predictEnds = bots
      .map((b) => b.c.all.filter((m) => m.t === "pollEnd" && m.pollId === "s-predict" && m.you))
      .map((ms) => ms.at(-1) as Extract<S2C, { t: "pollEnd" }> | undefined);
    const winners = predictEnds.filter((m) => m?.you?.correct === true);
    const losers = predictEnds.filter((m) => m?.you?.correct === false);
    expect(winners.length).toBeGreaterThan(0);
    expect(losers.length).toBeGreaterThan(0);
    for (const m of winners) expect(m?.you?.seeds).toBeGreaterThan(SEEDS_START);
    for (const m of losers) expect(m?.you?.seeds).toBe(SEEDS_START - 100);
    // Pari-mutuel conserves the pool (rounding down never pays out more than was staked).
    const net = predictEnds.reduce((n, m) => n + ((m?.you?.seeds ?? SEEDS_START) - SEEDS_START), 0);
    expect(net).toBeLessThanOrEqual(0);
    expect(net).toBeGreaterThan(-winners.length);
    // Guess: every smart bot guessed right; the first 3 names reached the game's result.
    const guessEnd = watcher.all.find((m) => m.t === "pollEnd" && m.pollId === "s-guess");
    expect(guessEnd?.t === "pollEnd" && guessEnd.result.tallies["correct"]).toBe(100);
    expect(guessEnd?.t === "pollEnd" && guessEnd.result.firstCorrect?.length).toBe(3);
    // Quiz correct answers and dial bands produced play-along points; the top 5 is ranked.
    const top = lb.top(5);
    expect(top).toHaveLength(5);
    expect(top[0]?.place).toBe(1);
    for (let i = 1; i < top.length; i++)
      expect((top[i - 1]?.score as number) >= (top[i]?.score as number)).toBe(true);
    const quizEnd = watcher.all.filter((m) => m.t === "pollEnd" && m.pollId === "s-quiz").at(-1);
    expect(quizEnd?.t === "pollEnd" && quizEnd.result.correct).toBe(SHOW_ANSWERS.quiz);
  });

  it("audience sockets are limited to 5 msg/s", async () => {
    const { h, agg } = setup();
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "trivia-night", options: {} }],
    });
    const code = host.room?.code as string;
    h.join(code, { name: "P1" });
    const p = h.join(code, { name: "P2" });
    const viewer = h.join(code, { want: "audience", name: "Spammer" });
    h.host(host, { c: "start" });
    await h.advance(1_500, 100);
    const a = agg();
    expect(a.isOpen("s-vote")).toBe(true);
    const before = a.stats.inputs;
    // A burst of 20 messages in the same instant: only the bucket's 5 get through.
    for (let i = 0; i < 20; i++)
      viewer.send({ t: "aud", pollId: "s-vote", choice: i % 2 === 0 ? "o1" : "o2" });
    expect(a.stats.inputs - before).toBe(5);
    // Over one second the bucket refills at 5 msg/s.
    for (let i = 0; i < 10; i++) {
      await h.advance(100, 100);
      viewer.send({ t: "react", e: "clap" });
    }
    expect(a.stats.inputs - before).toBeGreaterThanOrEqual(9);
    expect(a.stats.inputs - before).toBeLessThanOrEqual(11);
    // A player socket gets the higher player limit (20 msg/s), so the cap is audience-specific.
    const mid = a.stats.inputs;
    await h.advance(2_000, 100);
    for (let i = 0; i < 20; i++) p.send({ t: "react", e: "wow" });
    expect(a.stats.inputs - mid).toBeGreaterThan(5);
  });
});
