/** `runScript` / `makeSeats`: scripted rule tests on a real runner with a virtual clock. */
import { describe, expect, it } from "vitest";
import { makeSeats, runScript, SCRIPT_EPOCH } from "../src/testing/run-script.ts";
import { makeProbe } from "./fixtures/probe.ts";
import { tictactoe, type TttState } from "./fixtures/tictactoe/index.ts";

const mover = (s: TttState): string => s.players[s.turn].id;

describe("makeSeats", () => {
  it("makes p1..pN with colour slots and optional teams", () => {
    expect(makeSeats(2)).toEqual([
      { id: "p1", name: "Player 1", seat: 0, colorSlot: 0 },
      { id: "p2", name: "Player 2", seat: 1, colorSlot: 1 },
    ]);
    expect(makeSeats(10)[9]?.colorSlot).toBe(1);
    expect(makeSeats(3, { teams: ["a", "b"] }).map((s) => s.teamId)).toEqual(["a", "b", "a"]);
    expect(() => makeSeats(-1)).toThrow(RangeError);
  });
});

describe("runScript", () => {
  it("plays a scripted tictactoe game to the end", () => {
    const run = runScript(
      tictactoe,
      [
        { timer: "intro" },
        {
          check: ({ state }) => {
            expect(state.phase).toBe("turn");
          },
        },
      ],
      { players: 2, seed: 3 },
    );
    const r = run.runner;
    const first = mover(r.state);
    for (const cell of [0, 3, 1, 4, 2]) {
      expect(r.act(mover(r.state), { type: "move", cell }, SCRIPT_EPOCH + 4_000).ok).toBe(true);
    }
    expect(r.state.winner).toBe(0);
    r.advance(SCRIPT_EPOCH + 10_000);
    expect(r.ended).toBe(true);
    expect(r.result?.ranking[0]).toMatchObject({ id: first, place: 1 });
  });

  it("checks act expectations and reports the failing step", () => {
    expect(() =>
      runScript(tictactoe, [{ act: "p1", action: { type: "move", cell: 4 } }], { players: 2 }),
    ).toThrow(/step 0 \(act p1\): expected ok, got ILLEGAL/);
    const run = runScript(
      tictactoe,
      [
        { act: "p1", action: { type: "move", cell: 4 }, expect: "ILLEGAL" },
        { act: "p1", action: "garbage", expect: "BAD_ACTION" },
        { act: "zz", action: { type: "move", cell: 1 }, expect: "NOT_SEATED" },
        { act: "p1", action: { type: "move", cell: 1 }, expect: "any" },
      ],
      { players: 2 },
    );
    expect(run.trace.map((t) => t.result.err ?? "ok")).toEqual([
      "ILLEGAL",
      "BAD_ACTION",
      "NOT_SEATED",
      "ILLEGAL",
    ]);
  });

  it("supports every step kind on the probe", () => {
    const timer = { type: "timer.set" as const, id: "t", atMs: SCRIPT_EPOCH + 100 };
    const run = runScript(
      makeProbe(),
      [
        { act: "p1", action: { type: "effects", effects: [timer] } },
        { next: true },
        { wait: 50 },
        { at: 1_000 },
        { audience: { pollId: "q", kind: "vote", total: 1, tallies: { a: 1 } } },
        { moderate: { itemId: "m", approved: false } },
        { leave: "p2" },
        { bot: "p2" },
        { wait: 10 },
        { rejoin: "p2" },
        { host: { c: "forceAdvance" }, expect: "UNSUPPORTED" },
        { enroll: [] },
        { audienceAction: { audId: "a1", action: {} } },
        { pause: true },
        { act: "p1", action: { type: "inc" }, expect: "PAUSED" },
        { resume: true },
        {
          check: ({ state, elapsed, effects, last }) => {
            expect(elapsed).toBe(1_010);
            expect(state.n).toBe(3);
            expect(Array.isArray(effects)).toBe(true);
            expect(last).toEqual([]);
          },
        },
      ],
      { players: 2, now: SCRIPT_EPOCH },
    );
    expect(run.state.log).toEqual([
      `setup@${SCRIPT_EPOCH}:3a`,
      `act:p1:effects@${SCRIPT_EPOCH}`,
      `timer:t@${SCRIPT_EPOCH + 100}`,
      `poll:q@${SCRIPT_EPOCH + 1000}`,
      "mod:m:false",
      `leave:p2@${SCRIPT_EPOCH + 1000}`,
      `act:p2:inc@${SCRIPT_EPOCH + 1000}`,
      `act:p2:inc@${SCRIPT_EPOCH + 1000}`,
      `act:p2:inc@${SCRIPT_EPOCH + 1000}`,
      `rejoin:p2@${SCRIPT_EPOCH + 1010}`,
    ]);
    expect(run.elapsed).toBe(1_010);
  });

  it("fails clearly on a timer that is not pending, nothing scheduled, or a failing check", () => {
    expect(() => runScript(makeProbe(), [{ timer: "x" }])).toThrow(
      /timer not pending \(pending: none\)/,
    );
    expect(() => runScript(makeProbe(), [{ next: true }])).toThrow(/nothing is scheduled/);
    const boom = (): void => {
      throw new Error("boom");
    };
    expect(() => runScript(makeProbe(), [{ check: boom }])).toThrow(/step 0 \(check\): boom/);
  });

  it("accepts explicit seats", () => {
    const run = runScript(tictactoe, [], { players: makeSeats(2), seed: 1 });
    expect(run.runner.players.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(run.effects.map((e) => e.type)).toEqual(["audience.open"]);
  });
});
