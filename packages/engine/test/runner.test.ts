/**
 * GameRunner behaviour (ROADMAP M0-04 "Runner behaviour"): effects and the timer table, score
 * aggregation, end, bot takeover, dev deep-freeze cadence, per-viewer-key view memoisation,
 * the minimum audience window, pause/resume, snapshots and refusals.
 */
import { describe, expect, it } from "vitest";
import type { Effect, PollSpec } from "../src/game-module.ts";
import { GameRunner, deepFreeze, viewerKeyId, type RunnerOptions } from "../src/runner.ts";
import { makeSeats } from "../src/testing/run-script.ts";
import {
  makeProbe,
  type ProbeAction,
  type ProbeOptions,
  type ProbeState,
  type ProbeView,
} from "./fixtures/probe.ts";
import { tictactoe } from "./fixtures/tictactoe/index.ts";

const T0 = 1_000_000;

type Probe = GameRunner<ProbeState, ProbeAction, ProbeOptions, ProbeView>;

function start(module = makeProbe(), opts: Partial<RunnerOptions<ProbeOptions>> = {}): Probe {
  return new GameRunner(module, { players: makeSeats(2), seed: 1, now: T0, ...opts });
}

const poll = (pollId: string, closesAtMs: number, extra: Partial<PollSpec> = {}): PollSpec => ({
  pollId,
  kind: "vote",
  prompt: "Pick",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  closesAtMs,
  ...extra,
});

const fx = (effects: Effect[], deadline?: number | null) => ({
  type: "effects",
  effects,
  deadline,
});
const types = (effects: readonly Effect[]) => effects.map((e) => e.type);

describe("setup and options", () => {
  it("resolves options over the spec defaults (clamped, snapped, validated)", () => {
    const r = start(makeProbe(), { options: { rounds: 6, mode: "zzz" } as never });
    expect(r.options).toEqual({ rounds: 7, mode: "a" });
    const log = (r.state as { log: string[] }).log;
    expect(log[0]).toBe(`setup@${T0}:7a`);
  });

  it("rejects a player count outside the manifest and duplicate seats", () => {
    expect(() => start(makeProbe(), { players: makeSeats(5) })).toThrow(RangeError);
    expect(() => start(makeProbe(), { players: [...makeSeats(1), ...makeSeats(1)] })).toThrow(
      /unique/,
    );
  });

  it("returns setup effects without the internal timer effects", () => {
    const module = makeProbe({
      setupEffects: (ctx) => [
        { type: "timer.set", id: "t", atMs: ctx.now + 500 },
        { type: "fx", name: "hello" },
      ],
    });
    const r = start(module);
    expect(types(r.setupEffects)).toEqual(["fx"]);
    expect(r.timers()).toEqual([{ id: "t", atMs: T0 + 500, remainingMs: 500 }]);
  });
});

describe("timer table", () => {
  it("fires timers in time order, each with ctx.now = its own atMs, whatever the advance cadence", () => {
    const run = (cadence: number[]) => {
      const r = start();
      r.act(
        "p1",
        fx([
          { type: "timer.set", id: "late", atMs: T0 + 900 },
          { type: "timer.set", id: "early", atMs: T0 + 300 },
          { type: "timer.set", id: "gone", atMs: T0 + 400 },
        ]),
        T0,
      );
      r.act("p1", fx([{ type: "timer.clear", id: "gone" }]), T0 + 10);
      for (const t of cadence) r.advance(t);
      return (r.state as { log: string[] }).log.filter((l) => l.startsWith("timer"));
    };
    const expected = [`timer:early@${T0 + 300}`, `timer:late@${T0 + 900}`];
    expect(run([T0 + 5000])).toEqual(expected);
    expect(run([T0 + 299, T0 + 300, T0 + 301, T0 + 899, T0 + 950])).toEqual(expected);
  });

  it("replaces a timer set twice with the same id and fires overdue timers before an action", () => {
    const r = start();
    r.act("p1", fx([{ type: "timer.set", id: "t", atMs: T0 + 100 }]), T0);
    r.act("p1", fx([{ type: "timer.set", id: "t", atMs: T0 + 200 }]), T0);
    r.act("p1", { type: "inc" }, T0 + 1000);
    const log = (r.state as { log: string[] }).log;
    expect(log.filter((l) => l.startsWith("timer"))).toEqual([`timer:t@${T0 + 200}`]);
    expect(log.indexOf(`timer:t@${T0 + 200}`)).toBeLessThan(log.indexOf(`act:p1:inc@${T0 + 1000}`));
  });

  it("reports the next event time", () => {
    const r = start();
    expect(r.nextEventAt()).toBeNull();
    r.act("p1", fx([{ type: "timer.set", id: "t", atMs: T0 + 250 }]), T0);
    expect(r.nextEventAt()).toBe(T0 + 250);
  });
});

describe("score and end", () => {
  it("aggregates score deltas and passes them through", () => {
    const r = start();
    r.act("p1", fx([{ type: "score", deltas: { p1: 3, p2: 1 } }]), T0);
    const res = r.act("p1", fx([{ type: "score", deltas: { p1: 2, teamA: 5 } }]), T0 + 1);
    expect(types(res.effects)).toEqual(["score"]);
    expect(r.scores).toEqual({ p1: 5, p2: 1, teamA: 5 });
  });

  it("records end, clears timers and refuses further input", () => {
    const r = start();
    r.act("p1", fx([{ type: "timer.set", id: "t", atMs: T0 + 100 }]), T0);
    const result = { ranking: [{ id: "p1", score: 1, place: 1 }] };
    const res = r.act(
      "p1",
      fx([
        { type: "end", result },
        { type: "timer.set", id: "x", atMs: T0 + 5 },
      ]),
      T0 + 1,
    );
    expect(types(res.effects)).toEqual(["end"]);
    expect(r.ended).toBe(true);
    expect(r.result).toEqual(result);
    expect(r.timers()).toEqual([]);
    expect(r.act("p1", { type: "inc" }, T0 + 2)).toMatchObject({ ok: false, err: "ENDED" });
    expect(r.hostCommand({ c: "forceAdvance" }, T0 + 2)).toMatchObject({ ok: false, err: "ENDED" });
  });
});

describe("action results", () => {
  it("refuses unparseable, unseated and illegal actions", () => {
    const r = start();
    expect(r.act("p1", { type: "???" }, T0)).toMatchObject({ ok: false, err: "BAD_ACTION" });
    expect(r.act("stranger", { type: "inc" }, T0)).toMatchObject({ ok: false, err: "NOT_SEATED" });
    const illegal = r.act("p1", { type: "noop" }, T0);
    expect(illegal).toMatchObject({ ok: false, err: "ILLEGAL" });
    expect(types(illegal.effects)).toEqual(["fx"]);
    expect(r.act("host", { type: "inc" }, T0, "host")).toMatchObject({ ok: true });
    expect(r.hostCommand({ c: "forceAdvance" }, T0)).toMatchObject({
      ok: false,
      err: "UNSUPPORTED",
    });
  });

  it("passes the seat's team to ctx.actor", () => {
    const seats = makeSeats(2, { teams: ["red", "blue"] });
    const seen: unknown[] = [];
    const module = makeProbe();
    const spy = {
      ...module,
      onAction: (s: never, a: never, ctx: { actor: unknown }) => {
        seen.push(ctx.actor);
        return module.onAction(s, a, ctx as never);
      },
    };
    const r = new GameRunner(spy as typeof module, { players: seats, seed: 1, now: T0 });
    r.act("p2", { type: "inc" }, T0);
    expect(seen).toEqual([{ id: "p2", role: "player", teamId: "blue" }]);
  });

  it("delivers platform events (audience result, moderation, leave, rejoin)", () => {
    const r = start();
    r.audienceResult({ pollId: "q", kind: "vote", total: 2, tallies: { a: 2 } }, T0 + 5);
    r.moderation("item1", true, T0 + 6);
    r.playerLeave("p2", T0 + 7);
    r.playerRejoin("p2", T0 + 8);
    expect(r.playerLeave("nobody", T0 + 9)).toMatchObject({ ok: false, err: "NOT_SEATED" });
    expect((r.state as { log: string[] }).log.slice(1)).toEqual([
      `poll:q@${T0 + 5}`,
      "mod:item1:true",
      `leave:p2@${T0 + 7}`,
      `rejoin:p2@${T0 + 8}`,
    ]);
  });
});

describe("bot takeover", () => {
  it("plays a disconnected seat with bot() after botDelayMs, until the player rejoins", () => {
    const r = start(makeProbe(), { botDelayMs: 1000 });
    r.playerLeave("p1", T0);
    r.setBot("p1", true, T0);
    expect(r.isBot("p1")).toBe(true);
    r.advance(T0 + 999);
    expect((r.state as { n: number }).n).toBe(0);
    r.advance(T0 + 1000);
    expect((r.state as { n: number }).n).toBe(1);
    r.playerRejoin("p1", T0 + 1500);
    r.advance(T0 + 10_000);
    expect((r.state as { n: number }).n).toBe(1);
    expect(r.isBot("p1")).toBe(false);
    expect(r.stats.botActions).toBe(1);
  });

  it("keeps acting after each state change and stops when bot() returns null", () => {
    const r = start(makeProbe(), { botDelayMs: 500 });
    r.setBot("p2", true, T0);
    r.advance(T0 + 60_000);
    expect((r.state as { n: number }).n).toBe(3); // probe bot stops at n = 3
    expect(r.stats.botActions).toBe(3);
    expect(r.nextEventAt()).toBeNull();
  });

  it("takes over a real game: a tictactoe seat bot finishes the game", () => {
    const r = new GameRunner(tictactoe, {
      players: makeSeats(2),
      seed: 9,
      now: T0,
      botDelayMs: 800,
    });
    r.setBot("p1", true, T0);
    r.setBot("p2", true, T0);
    for (let t = T0; !r.ended && t < T0 + 600_000; t += 250) {
      const res = r.advance(t);
      for (const e of res.effects) {
        if (e.type === "audience.close") {
          r.audienceResult({ pollId: e.pollId, kind: "vote", total: 0, tallies: {} }, t);
        }
      }
    }
    expect(r.ended).toBe(true);
    expect(r.stats.botIllegal).toBe(0);
  });
});

describe("dev deep-freeze", () => {
  it("freezes every step for tickHz 0: a mutating module throws at once", () => {
    const r = start();
    expect(Object.isFrozen(r.state)).toBe(true);
    expect(() => r.act("p1", { type: "mutate" }, T0)).toThrow(TypeError);
  });

  it("does not freeze in production mode", () => {
    const r = start(makeProbe(), { dev: false });
    expect(Object.isFrozen(r.state)).toBe(false);
    expect(r.act("p1", { type: "mutate" }, T0).ok).toBe(true);
  });

  it("freezes every 60th step for tickHz 60", () => {
    const module = makeProbe({ tickHz: 60, onTick: true, mutateOnTick: true });
    const r = start(module);
    // Setup is step 1; ticks are steps 2, 3, …; step 60 is frozen after it commits.
    expect(Object.isFrozen(r.state)).toBe(false);
    r.advance(T0 + 59 * (1000 / 60)); // 59 ticks: steps 2..60
    expect(r.stats.steps).toBe(60);
    expect(Object.isFrozen(r.state)).toBe(true);
    expect(() => r.advance(T0 + 60 * (1000 / 60))).toThrow(TypeError);
  });

  it("deepFreeze freezes nested JSON in place", () => {
    const v = deepFreeze({ a: [{ b: 1 }], c: { d: "x" } });
    expect(Object.isFrozen(v.a[0])).toBe(true);
    expect(Object.isFrozen(v.c)).toBe(true);
  });
});

describe("ticks", () => {
  it("runs onTick at a fixed dt interleaved with timers", () => {
    const module = makeProbe({ tickHz: 10, onTick: true });
    const r = start(module);
    r.act("p1", fx([{ type: "timer.set", id: "t", atMs: T0 + 250 }]), T0);
    r.advance(T0 + 300);
    const log = (r.state as { log: string[] }).log.filter(
      (l) => !l.startsWith("setup") && !l.startsWith("act"),
    );
    expect(log).toEqual([
      `tick:100.000@${(T0 + 100).toFixed(1)}`,
      `tick:100.000@${(T0 + 200).toFixed(1)}`,
      `timer:t@${T0 + 250}`,
      `tick:100.000@${(T0 + 300).toFixed(1)}`,
    ]);
  });
});

describe("views", () => {
  it("computes one view per distinct viewer key per step (1 or 1,000 audience members)", () => {
    const module = makeProbe();
    const r = start(module);
    module.viewCalls = 0;
    r.view({ role: "audience" });
    for (let i = 0; i < 1000; i++) r.view({ role: "audience" });
    r.view({ role: "stage" });
    r.view({ role: "player", id: "p1" });
    r.view({ role: "player", id: "p1" });
    r.view({ role: "audience", restricted: true });
    expect(module.viewCalls).toBe(4);
    expect(r.stats.viewCalls).toBe(4);
    r.act("p1", { type: "inc" }, T0);
    for (let i = 0; i < 1000; i++) r.view({ role: "audience" });
    expect(module.viewCalls).toBe(5);
  });

  it("keeps the memo when a step leaves the state unchanged", () => {
    const module = makeProbe();
    const r = start(module);
    r.view({ role: "stage" });
    r.act("p1", { type: "noop" }, T0);
    r.view({ role: "stage" });
    expect(r.stats.viewCalls).toBe(1);
  });

  it("names viewer keys stably", () => {
    expect(viewerKeyId({ role: "player", id: "p9" })).toBe("player:p9");
    expect(viewerKeyId({ role: "audience" })).toBe("audience");
    expect(viewerKeyId({ role: "audience", restricted: true })).toBe("audience:restricted");
    expect(viewerKeyId({ role: "host" })).toBe("host");
    expect(viewerKeyId({ role: "moderator" })).toBe("moderator");
    expect(viewerKeyId({ role: "stage" })).toBe("stage");
  });
});

describe("minimum audience window (SPEC §4)", () => {
  it("defers an early close 1 s after a poll opens to 8 s with streamDelaySec = 3", () => {
    const r = start(makeProbe(), { streamDelaySec: 3 });
    const opened = r.act("p1", fx([{ type: "audience.open", poll: poll("q1", T0 + 20_000) }]), T0);
    expect(types(opened.effects)).toEqual(["audience.open"]);
    const early = r.act("p1", fx([{ type: "audience.close", pollId: "q1" }]), T0 + 1_000);
    expect(types(early.effects)).toEqual([]);
    expect(r.openPolls()).toMatchObject([{ closing: true, openedAtMs: T0 }]);
    expect(r.nextEventAt()).toBe(T0 + 8_000);
    expect(types(r.advance(T0 + 7_999).effects)).toEqual([]);
    const released = r.advance(T0 + 8_000);
    expect(released.effects).toEqual([{ type: "audience.close", pollId: "q1" }]);
    expect(r.openPolls()).toEqual([]);
  });

  it("scales with the stream delay and lets a close after the window through at once", () => {
    const r = start(makeProbe(), { streamDelaySec: 0 });
    r.act("p1", fx([{ type: "audience.open", poll: poll("q", T0 + 30_000) }]), T0);
    expect(
      types(r.act("p1", fx([{ type: "audience.close", pollId: "q" }]), T0 + 4_000).effects),
    ).toEqual([]);
    expect(types(r.advance(T0 + 5_000).effects)).toEqual(["audience.close"]);

    const r2 = start(makeProbe(), { streamDelaySec: 3 });
    r2.act("p1", fx([{ type: "audience.open", poll: poll("q", T0 + 30_000) }]), T0);
    const late = r2.act("p1", fx([{ type: "audience.close", pollId: "q" }]), T0 + 9_000);
    expect(types(late.effects)).toEqual(["audience.close"]);
  });

  it("exempts event-closed polls", () => {
    const r = start(makeProbe(), { streamDelaySec: 8 });
    r.act(
      "p1",
      fx([{ type: "audience.open", poll: poll("g", T0 + 60_000, { closeOn: "event" }) }]),
      T0,
    );
    const closed = r.act("p1", fx([{ type: "audience.close", pollId: "g" }]), T0 + 500);
    expect(types(closed.effects)).toEqual(["audience.close"]);
  });

  it("queues a resolve for a held poll behind its close, in order", () => {
    const r = start(makeProbe(), { streamDelaySec: 3 });
    r.act(
      "p1",
      fx([{ type: "audience.open", poll: poll("p", T0 + 20_000, { kind: "predict" }) }]),
      T0,
    );
    const early = r.act(
      "p1",
      fx([
        { type: "audience.close", pollId: "p" },
        { type: "audience.resolve", pollId: "p", correct: "a" },
        { type: "fx", name: "reveal" },
      ]),
      T0 + 2_000,
    );
    expect(types(early.effects)).toEqual(["fx"]);
    expect(types(r.advance(T0 + 8_000).effects)).toEqual(["audience.close", "audience.resolve"]);
  });

  it("holds the game's early close in a real game (tictactoe move 1 s after the turn poll opens)", () => {
    const r = new GameRunner(tictactoe, {
      players: makeSeats(2),
      seed: 4,
      now: T0,
      streamDelaySec: 3,
    });
    r.advance(T0 + 3_000); // intro ends, turn 1 opens chat-1 at T0 + 3000
    const mover = (r.state as { players: { id: string }[]; turn: number }).players[
      (r.state as { turn: number }).turn
    ]?.id as string;
    const res = r.act(mover, { type: "move", cell: 4 }, T0 + 4_000);
    expect(res.effects.some((e) => e.type === "audience.close" && e.pollId === "chat-1")).toBe(
      false,
    );
    const released = r.advance(T0 + 11_000);
    expect(released.effects).toContainEqual({ type: "audience.close", pollId: "chat-1" });
  });
});

describe("pause / resume", () => {
  it("freezes timers and re-arms them with the same remaining time", () => {
    const r = start();
    r.act("p1", fx([{ type: "timer.set", id: "t", atMs: T0 + 10_000 }], T0 + 10_000), T0);
    r.advance(T0 + 4_000);
    r.pause(T0 + 4_000);
    expect(r.paused).toBe(true);
    expect(r.nextEventAt()).toBeNull();
    r.advance(T0 + 40_000);
    expect(r.act("p1", { type: "inc" }, T0 + 20_000)).toMatchObject({ ok: false, err: "PAUSED" });
    r.resume(T0 + 34_000); // paused 30 s
    expect(r.timers()).toEqual([{ id: "t", atMs: T0 + 40_000, remainingMs: 6_000 }]);
    expect(r.view({ role: "stage" }).deadline).toBe(T0 + 40_000);
    r.advance(T0 + 39_999);
    expect((r.state as { log: string[] }).log.some((l) => l.startsWith("timer"))).toBe(false);
    r.advance(T0 + 40_000);
    // The module sees game time: the timer fires at its original game-time instant.
    expect((r.state as { log: string[] }).log).toContain(`timer:t@${T0 + 10_000}`);
  });

  it("translates emitted poll deadlines and holds to server time after a pause", () => {
    const r = start(makeProbe(), { streamDelaySec: 3 });
    r.pause(T0);
    r.resume(T0 + 5_000);
    const res = r.act(
      "p1",
      fx([{ type: "audience.open", poll: poll("q", T0 + 20_000) }]),
      T0 + 5_000,
    );
    // The module wrote a game-time deadline (T0 + 20 000 is 15 s of game time after "now").
    expect(res.effects[0]).toMatchObject({
      type: "audience.open",
      poll: { closesAtMs: T0 + 25_000 },
    });
    r.act("p1", fx([{ type: "audience.close", pollId: "q" }]), T0 + 6_000);
    expect(r.nextEventAt()).toBe(T0 + 13_000);
  });

  it("accepts platform events while paused, at the frozen game time", () => {
    const r = start();
    r.pause(T0 + 1_000);
    r.audienceResult({ pollId: "z", kind: "vote", total: 0, tallies: {} }, T0 + 9_000);
    expect((r.state as { log: string[] }).log).toContain(`poll:z@${T0 + 1_000}`);
    expect(r.hostCommand({ c: "forceAdvance" }, T0 + 9_000)).toMatchObject({ err: "PAUSED" });
  });
});

describe("snapshots", () => {
  it("restores a mid-game tictactoe runner that continues identically", () => {
    const drive = (r: GameRunner<unknown, unknown, unknown, unknown>, from: number, to: number) => {
      const out: string[] = [];
      for (let t = from; t <= to && !r.ended; t += 500) {
        for (const e of r.advance(t).effects) out.push(JSON.stringify(e));
        const s = r.state as {
          phase: string;
          turn: number;
          players: { id: string }[];
          board: (number | null)[];
        };
        if (s.phase === "turn" && t % 3000 === 0) {
          const cell = s.board.findIndex((c) => c === null);
          out.push(JSON.stringify(r.act(s.players[s.turn]?.id ?? "", { type: "move", cell }, t)));
        }
      }
      return out;
    };
    const a = new GameRunner(tictactoe, { players: makeSeats(2), seed: 21, now: T0 });
    drive(a as never, T0, T0 + 12_000);
    a.pause(T0 + 12_000);
    a.resume(T0 + 15_000);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = GameRunner.restore(tictactoe, snap);
    expect(b.state).toEqual(a.state);
    expect(b.options).toEqual(a.options);
    const tailA = drive(a as never, T0 + 15_000, T0 + 200_000);
    const tailB = drive(b as never, T0 + 15_000, T0 + 200_000);
    expect(tailB).toEqual(tailA);
    expect(b.ended).toBe(a.ended);
    expect(b.scores).toEqual(a.scores);
  });

  it("refuses a snapshot of another game", () => {
    const a = new GameRunner(tictactoe, { players: makeSeats(2), seed: 1, now: T0 });
    const snap = { ...a.snapshot(), game: "chess" as const };
    expect(() => GameRunner.restore(tictactoe, snap)).toThrow(TypeError);
  });
});

describe("room timing", () => {
  it("applies setTiming and setAudienceCount to later steps", () => {
    const seen: number[] = [];
    const module = makeProbe();
    const spy = {
      ...module,
      onAction: (
        s: never,
        a: never,
        ctx: { timing: { input(ms: number): number | null }; audienceCount: number },
      ) => {
        seen.push(ctx.timing.input(1000) ?? -1, ctx.audienceCount);
        return module.onAction(s, a, ctx as never);
      },
    };
    const r = new GameRunner(spy as typeof module, { players: makeSeats(1), seed: 1, now: T0 });
    r.act("p1", { type: "inc" }, T0);
    r.setTiming({ timerScale: 0, streamDelaySec: 3 });
    r.setAudienceCount(42);
    r.act("p1", { type: "inc" }, T0);
    expect(seen).toEqual([4000, 0, -1, 42]);
    expect(r.timing).toEqual({ timerScale: 0, streamDelaySec: 3 });
  });
});
