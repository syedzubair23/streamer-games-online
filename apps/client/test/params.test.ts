import { describe, expect, it } from "vitest";
import { parseScenarioParams, ScenarioParamError, scenarioUrl } from "../src/dev/params.ts";

describe("/dev/scenario params (SPEC §14)", () => {
  it("parses the full SPEC §14 query and applies the defaults", () => {
    const p = parseScenarioParams("?game=ludo&state=midgame");
    expect(p).toMatchObject({
      game: "ludo",
      state: "midgame",
      mode: "dusk",
      seed: 1,
      quality: "mid",
      role: "stage",
      t: null,
      freeze: true,
      hud: true,
      play: "none",
      reduced: false,
      ambient: false,
    });
    const q = parseScenarioParams(
      "game=chess&state=mate&mode=night&seed=7&quality=low&vp=360x800&role=player&t=0.5&freeze=0&hud=0&players=4&player=p2&reduced=1&ambient=1",
    );
    expect(q).toMatchObject({
      mode: "night",
      seed: 7,
      quality: "low",
      vp: "360x800",
      role: "player",
      t: 0.5,
      freeze: false,
      hud: false,
      players: 4,
      player: "p2",
      reduced: true,
      ambient: true,
    });
  });

  it("rejects typos and bad values instead of defaulting, listing every problem", () => {
    let caught: unknown;
    try {
      parseScenarioParams(
        "game=Bad!&mode=sunset&role=cat&quality=ultra&seed=x&t=2&vp=big&freeze=maybe&players=0&player=a b",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScenarioParamError);
    const problems = (caught as ScenarioParamError).problems.join("\n");
    for (const bit of [
      "game=Bad!",
      "state= is required",
      "mode=sunset",
      "role=cat",
      "quality=ultra",
      "seed=x",
      "t=2",
      "vp=big",
      "freeze=maybe",
      "players=0",
      "player=a b",
    ])
      expect(problems).toContain(bit);
  });

  it("validates play modes", () => {
    expect(() => parseScenarioParams("game=a&state=b&play=perf")).toThrow(/play=perf needs perf=/);
    expect(() => parseScenarioParams("game=a&state=b&play=anim&role=player")).toThrow(
      /stage roles only/,
    );
    expect(() => parseScenarioParams("game=a&state=b&play=perf&perf=Bad")).toThrow(/perf anim/);
    expect(() => parseScenarioParams("game=a&state=b&play=loop")).toThrow(/play=loop/);
    expect(
      parseScenarioParams("game=a&state=b&play=perf&perf=reveal,hearts&freeze=0"),
    ).toMatchObject({ play: "perf", perf: ["reveal", "hearts"] });
    // freeze=1 with a play mode is the manual clock used for frame-exact clips.
    expect(parseScenarioParams("game=a&state=b&play=anim")).toMatchObject({
      play: "anim",
      freeze: true,
    });
  });

  it("scenarioUrl is the inverse of the parser", () => {
    const url = scenarioUrl({
      game: "tictactoe",
      state: "win",
      mode: "rain",
      seed: 3,
      quality: "high",
      vp: "1920x1080",
      role: "stage",
      t: 0.25,
      freeze: false,
      hud: true,
      players: 2,
      player: "p1",
      play: "perf",
      perf: ["place", "win"],
      reduced: true,
      ambient: false,
    });
    expect(url.startsWith("/dev/scenario?")).toBe(true);
    const back = parseScenarioParams(url.slice(url.indexOf("?")));
    expect(back).toMatchObject({
      game: "tictactoe",
      state: "win",
      mode: "rain",
      seed: 3,
      quality: "high",
      t: 0.25,
      freeze: false,
      players: 2,
      player: "p1",
      play: "perf",
      perf: ["place", "win"],
      reduced: true,
    });
    expect(scenarioUrl({ game: "a", state: "b" })).toBe("/dev/scenario?game=a&state=b");
    expect(parseScenarioParams(new URLSearchParams("game=a&state=b")).game).toBe("a");
  });
});
