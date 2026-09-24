/** The scenario contract (SPEC §14) and the tictactoe fixture's scenarios. */
import { describe, expect, it } from "vitest";
import { resolveScenario, SCENARIO_ROLES, viewerKeyForRole } from "../src/scenario.ts";
import { tictactoe, tictactoeScenarios } from "./fixtures/tictactoe/index.ts";

describe("viewerKeyForRole", () => {
  it("maps every role", () => {
    expect(SCENARIO_ROLES.map((r) => viewerKeyForRole(r))).toEqual([
      { role: "stage" },
      { role: "host" },
      { role: "player", id: "p1" },
      { role: "audience" },
    ]);
    expect(viewerKeyForRole("player", "p2")).toEqual({ role: "player", id: "p2" });
  });
});

describe("resolveScenario", () => {
  it("builds every tictactoe scenario for every role, deterministically", () => {
    for (const id of Object.keys(tictactoeScenarios)) {
      for (const role of SCENARIO_ROLES) {
        const a = resolveScenario(tictactoe, tictactoeScenarios, { state: id, seed: 5, role });
        const b = resolveScenario(tictactoe, tictactoeScenarios, { state: id, seed: 5, role });
        expect(JSON.stringify(a.view)).toBe(JSON.stringify(b.view));
        expect(typeof a.view.phase).toBe("string");
        expect(a.viewer.role).toBe(role);
        if (role !== "player") expect(a.view.you).toBeUndefined();
      }
    }
  });

  it("uses the scenario's own viewer only for its role", () => {
    const player = resolveScenario(tictactoe, tictactoeScenarios, {
      state: "midgame",
      role: "player",
    });
    expect(player.viewer).toEqual({ role: "player", id: "p1" });
    expect(player.view.you?.id).toBe("p1");
    const stage = resolveScenario(tictactoe, tictactoeScenarios, {
      state: "midgame",
      role: "stage",
    });
    expect(stage.viewer).toEqual({ role: "stage" });
  });

  it("reaches the states the scenario names", () => {
    const get = (state: string) =>
      resolveScenario(tictactoe, tictactoeScenarios, { state, seed: 1 }).state;
    expect(get("intro").phase).toBe("intro");
    expect(get("midgame")).toMatchObject({ phase: "turn", moves: 4, turn: 0 });
    expect(get("win")).toMatchObject({ phase: "result", winner: 0, winLine: "row-top" });
    expect(get("draw")).toMatchObject({ phase: "result", draw: true, winner: null });
    expect(resolveScenario(tictactoe, tictactoeScenarios, { state: "win" }).fx).toEqual([
      { name: "win", data: { line: "row-top" } },
    ]);
  });

  it("throws on an unknown scenario, listing the known ones", () => {
    expect(() => resolveScenario(tictactoe, tictactoeScenarios, { state: "nope" })).toThrow(
      /known: intro, midgame, win, draw/,
    );
    expect(() => resolveScenario(tictactoe, tictactoeScenarios, { state: "toString" })).toThrow(
      /no scenario/,
    );
  });
});
