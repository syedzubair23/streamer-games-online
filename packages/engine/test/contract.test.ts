/**
 * ROADMAP M0-04 Accept: tictactoe passes the full contract suite; a deliberately leaky fixture
 * fails the secrecy check and a non-deterministic fixture fails the determinism check (both
 * are expected-to-fail tests, asserted on the report). Plus the suite's building blocks.
 */
import { createRng } from "@sg/shared";
import { describe, expect, it } from "vitest";
import type { GameModule } from "../src/game-module.ts";
import {
  allViewers,
  checkContract,
  collectSecrets,
  CONTRACT_CHECKS,
  findLeaks,
  garbagePayload,
  jsonDiff,
  plainJsonProblem,
  runContractSuite,
} from "../src/testing/contract.ts";
import { leakyTictactoe, makeNondeterministicTictactoe } from "./fixtures/broken.ts";
import {
  tictactoe,
  type TttAction,
  type TttOptions,
  type TttState,
  type TttView,
} from "./fixtures/tictactoe/index.ts";

// The Accept criterion: the full suite at the DoD G4 sizes.
runContractSuite(tictactoe, { seeds: 20, fuzzGames: 200, garbage: 1000 });

type Ttt = GameModule<TttState, TttAction, TttOptions, TttView>;

describe("expected-to-fail fixtures", () => {
  it("a leaky fixture fails the secrecy check (and only that)", () => {
    const report = checkContract(leakyTictactoe, { seeds: 4, fuzzGames: 20, garbage: 200 });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(report.ok).toBe(false);
    expect(byName["secrecy"]?.ok).toBe(false);
    expect(byName["secrecy"]?.failures.join("\n")).toMatch(/sees "(row|col|diag)-\w+"/);
    for (const name of CONTRACT_CHECKS.filter((c) => c !== "secrecy")) {
      expect(byName[name]?.ok, name).toBe(true);
    }
  });

  it("a non-deterministic fixture fails the determinism check", () => {
    const report = checkContract(makeNondeterministicTictactoe(), {
      seeds: 4,
      checks: ["determinism"],
    });
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual(["determinism"]);
    expect(report.checks[0]?.failures[0]).toMatch(/two runs diverged at event \d+/);
  });

  it("catches a throwing parseAction, a lax onAction, a bad view and non-JSON state", () => {
    const throwing: Ttt = {
      ...tictactoe,
      parseAction: (raw) => {
        if (typeof raw === "string" && raw.length > 1000) throw new Error("too long");
        return tictactoe.parseAction(raw);
      },
    };
    const parse = checkContract(throwing, { seeds: 2, checks: ["parseAction"] }).checks[0];
    expect(parse?.failures[0]).toMatch(/parseAction threw/);

    const lax: Ttt = {
      ...tictactoe,
      onAction: (s, a, ctx) =>
        tictactoe.onAction(s, a, { ...ctx, actor: { ...ctx.actor, id: s.players[s.turn].id } }),
    };
    const illegal = checkContract(lax, { seeds: 2, checks: ["illegal"] }).checks[0];
    expect(illegal?.ok).toBe(false);
    expect(illegal?.failures[0]).toMatch(/changed the state/);

    const noDeadline: Ttt = {
      ...tictactoe,
      view: (s, v) => ({ ...tictactoe.view(s, v), deadline: undefined as unknown as null }),
    };
    const views = checkContract(noDeadline, { seeds: 2, checks: ["views"] }).checks[0];
    expect(views?.failures[0]).toMatch(/deadline is undefined/);

    const notJson: Ttt = {
      ...tictactoe,
      setup: (ctx) => {
        const step = tictactoe.setup(ctx);
        return { ...step, state: { ...step.state, draw: undefined as unknown as boolean } };
      },
    };
    const ser = checkContract(notJson, { seeds: 2, checks: ["serialize"] }).checks[0];
    expect(ser?.failures[0]).toMatch(/state is not plain JSON: state\.draw is undefined/);
  });

  it("catches a game that never ends and a bot that plays illegal moves", () => {
    const onTimer = tictactoe.onTimer;
    if (onTimer === undefined) throw new Error("tictactoe has onTimer");
    const endless: Ttt = {
      ...tictactoe,
      onTimer: (s, id, ctx) => (id === "result" ? { state: s } : onTimer(s, id, ctx)),
    };
    const t1 = checkContract(endless, { seeds: 2, checks: ["termination"] }).checks[0];
    expect(t1?.failures[0]).toMatch(/did not end/);

    const cheat: Ttt = {
      ...tictactoe,
      bot: (s) => (s.phase === "turn" ? { type: "move", cell: 4 } : null),
    };
    const t2 = checkContract(cheat, { seeds: 3, checks: ["termination"] }).checks[0];
    expect(t2?.failures.join("\n")).toMatch(/illegal bot action/);
  });

  it("reports a module exception as a failure of that check instead of throwing", () => {
    const broken: Ttt = {
      ...tictactoe,
      setup: () => {
        throw new Error("kaput");
      },
    };
    const report = checkContract(broken, { seeds: 1, checks: ["termination"] });
    expect(report.checks[0]?.failures[0]).toMatch(/threw: .*kaput/);
  });
});

describe("secrecy building blocks", () => {
  const ids = new Set(["p1", "p2", "red"]);

  it("collects hidden values with their owners and skips revealed ones", () => {
    const state = {
      players: [
        { id: "p1", secret: { word: "banana", n: 42 } },
        { id: "p2", secret: { word: "cherry" } },
      ],
      hidden: {
        answers: { p1: { text: "my answer" }, red: { text: "team answer" } },
        deck: ["apple"],
      },
      revealed: ["cherry"],
      hint: "ok",
    };
    const secrets = collectSecrets(state, ids);
    const byValue = Object.fromEntries(secrets.map((s) => [String(s.value), s.owners]));
    expect(byValue).toEqual({
      banana: ["p1"],
      "42": ["p1"],
      "my answer": ["p1"],
      "team answer": ["red"],
      apple: [],
    });
  });

  it("supports secretPaths (JSONPath-lite)", () => {
    const state = {
      chains: [
        { owner: "p1", steps: ["zebra", "llama"] },
        { owner: "p2", steps: ["koala"] },
      ],
    };
    const secrets = collectSecrets(state, ids, ["chains[*].steps"]);
    expect(secrets.map((s) => [s.value, s.owners])).toEqual([
      ["zebra", ["p1"]],
      ["llama", ["p1"]],
      ["koala", ["p2"]],
    ]);
    expect(collectSecrets(state, ids, ["$.chains.*.steps"])).toHaveLength(3);
    expect(collectSecrets(state, ids, ["chains['0'].steps"])).toHaveLength(2);
    expect(collectSecrets(state, ids, ["nope.path"])).toHaveLength(0);
  });

  it("finds leaks per viewer, allowing owners and moderation previews for staff", () => {
    const state = { players: [{ id: "p1" }, { id: "p2" }], hidden: { p1: { text: "rude words" } } };
    const module = {
      view: (_s: unknown, v: { role: string }) =>
        v.role === "host" || v.role === "player" ? { text: "rude words" } : { text: "" },
    };
    const players = [{ id: "p1" }, { id: "p2" }];
    expect(findLeaks(module as never, state, players)).toEqual([
      'host sees "rude words" from state.hidden.p1.text (owned by p1)',
      'player:p2 sees "rude words" from state.hidden.p1.text (owned by p1)',
    ]);
    const moderated = findLeaks(module as never, state, players, {
      moderated: new Set(["rude words"]),
    });
    expect(moderated).toEqual([
      'player:p2 sees "rude words" from state.hidden.p1.text (owned by p1)',
    ]);
  });

  it("checks numeric secrets by path", () => {
    const state = { players: [{ id: "p1" }], hidden: { target: 777 } };
    const leaky = { view: () => ({ hidden: { target: 777 } }) };
    const safe = { view: () => ({ shown: 777 }) };
    expect(findLeaks(leaky as never, state, [{ id: "p1" }])[0]).toMatch(
      /sees 777 at hidden.target/,
    );
    expect(findLeaks(safe as never, state, [{ id: "p1" }])).toEqual([]);
  });

  it("checks every viewer kind", () => {
    expect(allViewers(["p1"]).map((v) => JSON.stringify(v))).toEqual([
      '{"role":"stage"}',
      '{"role":"audience"}',
      '{"role":"audience","restricted":true}',
      '{"role":"host"}',
      '{"role":"moderator"}',
      '{"role":"player","id":"p1"}',
    ]);
  });
});

describe("JSON helpers", () => {
  it("plainJsonProblem finds non-JSON values with a path", () => {
    expect(plainJsonProblem({ a: [1, "x", null, { b: true }] })).toBeNull();
    expect(plainJsonProblem({ a: new Map() })).toBe("$.a is a Map, not a plain object");
    expect(plainJsonProblem({ a: [1, Number.NaN] })).toBe("$.a[1] is NaN");
    expect(plainJsonProblem({ a: () => 1 })).toBe("$.a is a function");
    expect(plainJsonProblem({ a: undefined })).toBe("$.a is undefined");
    const holey: number[] = [1];
    holey[2] = 3;
    expect(plainJsonProblem(holey)).toBe("$[1] is a hole");
    expect(plainJsonProblem(Object.create(null) as object)).toBeNull();
  });

  it("jsonDiff reports the first differing path", () => {
    expect(jsonDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeNull();
    expect(jsonDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe("$.a[1].b");
    expect(jsonDiff({ a: 1 }, { a: 1, b: 2 })).toBe("$.b");
    expect(jsonDiff([1], [1, 2])).toBe("$.length");
    expect(jsonDiff([1], { 0: 1 })).toBe("$");
  });

  it("garbagePayload is deterministic and varied", () => {
    const a = createRng(5);
    const b = createRng(5);
    const seedAction = [{ type: "move", cell: 3 }];
    const xs = Array.from({ length: 300 }, () => garbagePayload(a, 0, seedAction));
    const ys = Array.from({ length: 300 }, () => garbagePayload(b, 0, seedAction));
    expect(JSON.stringify(xs)).toBe(JSON.stringify(ys));
    const kinds = new Set(
      xs.map((x) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x)),
    );
    expect([...kinds].sort()).toEqual([
      "array",
      "boolean",
      "null",
      "number",
      "object",
      "string",
      "undefined",
    ]);
  });
});
