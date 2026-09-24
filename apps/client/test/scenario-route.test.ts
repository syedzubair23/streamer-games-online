// @vitest-environment happy-dom
import { tictactoe } from "@sg/engine/fixtures/tictactoe";
import { tictactoeClient } from "@sg/engine/fixtures/tictactoe/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPlaceholderShell } from "../src/dev/placeholder-shell.ts";
import { createPlaceholderTheme } from "../src/dev/placeholder-theme.ts";
import { bootScenario, viewPlayerIds } from "../src/dev/scenario.tsx";
import { mountController } from "../src/dev/scenario-controller.tsx";
import {
  assembleGame,
  isClientModule,
  isGameModule,
  isScenarioRegistry,
  loadScenarioGame,
  pickExport,
  SCENARIO_GAMES,
} from "../src/dev/scenario-games.ts";
import { fakeRenderer, installCanvasStub, manualScheduler } from "./helpers.ts";

beforeAll(() => installCanvasStub());

function root(w = 1280, h = 720): HTMLElement {
  document.body.replaceChildren();
  const el = document.createElement("main");
  Object.defineProperty(el, "clientWidth", { value: w });
  Object.defineProperty(el, "clientHeight", { value: h });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  delete window.__SCENE__;
  delete window.__SCENE_ERROR__;
  delete window.__SCENE_INFO__;
  window.__SCENE_READY__ = false;
  vi.restoreAllMocks();
});

describe("scenario game map", () => {
  it("lists the fixture and the eight launch games, each lazily loaded", () => {
    expect(Object.keys(SCENARIO_GAMES).sort()).toEqual(
      ["chess", "doodle", "ludo", "marble-rally", "odd-one-out", "quip-clash", "tictactoe", "trivia-night", "tune-in"].sort(),
    );
  });

  it("recognises modules by shape and prefers the conventional export names", () => {
    expect(isGameModule(tictactoe)).toBe(true);
    expect(isGameModule({ manifest: {} })).toBe(false);
    expect(isClientModule(tictactoeClient)).toBe(true);
    expect(isScenarioRegistry({})).toBe(false);
    expect(isScenarioRegistry({ a: { id: "b", build: () => null } })).toBe(false);
    expect(isScenarioRegistry([])).toBe(false);
    expect(pickExport({ logic: tictactoe, other: 1 }, "logic", isGameModule, "x")).toBe(tictactoe);
    expect(pickExport({ tictactoe }, "logic", isGameModule, "x")).toBe(tictactoe);
    expect(pickExport({ a: 1 }, "logic", isGameModule, "x")).toBeNull();
    expect(() => pickExport({ a: tictactoe, b: tictactoe }, "logic", isGameModule, "x")).toThrow(/several exports/);
  });

  it("explains which roadmap item a game is waiting for", async () => {
    await expect(loadScenarioGame("quip-clash")).rejects.toThrow(/no logic yet.*Mx-01/);
    await expect(loadScenarioGame("pong")).rejects.toThrow(/unknown game "pong"/);
    expect(() => assembleGame("tictactoe", { logic: tictactoe }, { nothing: 1 }, null)).toThrow(/no scenarios yet/);
    expect(() => assembleGame("chess", { logic: tictactoe }, {}, null)).toThrow(/manifest.id is "tictactoe"/);
    const g = await loadScenarioGame("tictactoe");
    expect(g.logic.manifest.id).toBe("tictactoe");
    expect(Object.keys(g.scenarios)).toEqual(["intro", "midgame", "win", "draw"]);
    expect(g.client).not.toBeNull();
  });

  it("reads player ids from a view", () => {
    expect(viewPlayerIds({ players: [{ id: "p1" }, { id: 2 }, null, { id: "p2" }] })).toEqual(["p1", "p2"]);
    expect(viewPlayerIds(null)).toEqual([]);
    expect(viewPlayerIds({ players: "x" })).toEqual([]);
  });
});

describe("/dev/scenario boot (SPEC §14)", () => {
  it("mounts the stage with no network and signals __SCENE_READY__ with __SCENE_INFO__", async () => {
    const renderer = fakeRenderer();
    const el = root();
    const handle = await bootScenario(el, "?game=tictactoe&state=midgame&mode=night&seed=3&quality=low", { renderer });
    expect(window.__SCENE_ERROR__).toBeUndefined();
    expect(window.__SCENE_READY__).toBe(true);
    expect(window.__SCENE__).toBe(handle);
    expect(window.__SCENE_INFO__).toMatchObject({ drawCalls: expect.any(Number), tris: expect.any(Number), programs: expect.any(Number), textures: expect.any(Number), geometries: expect.any(Number) });
    expect(window.__SCENE_INFO__!.drawCalls).toBeGreaterThan(3);
    expect(document.documentElement.dataset["mode"]).toBe("night");
    expect(document.title).toBe("Tic-tac-toe · midgame · stage");
    expect(el.querySelector("#sg-hud")?.textContent).toMatch(/to move/);
    expect(handle!.scenario).toEqual({ id: "midgame", description: expect.any(String), anim: { name: "place", durationMs: 320 } });
    expect([...handle!.players].sort()).toEqual(["p1", "p2"]);
    expect(handle!.tokens().mode.uiBg).toBe("#1F1D33");
    expect(handle!.sent()).toEqual([]);
    expect(handle!.fx()).toEqual([]);
    expect(handle!.sfx()).toEqual([]);
    // a frozen still: stepping is refused and nothing renders any more
    const renders = handle!.renders();
    expect(() => handle!.step(16)).toThrow(/frozen/);
    expect(handle!.renders()).toBe(renders);
    const leak = handle!.unmount();
    expect(leak.leakedGeometries).toBe(0);
    expect(leak.leakedTextures).toBe(0);
    expect(handle!.unmount().after).toEqual(leak.after);
    expect(el.querySelector("#sg-hud")?.textContent).toBe("");
  });

  it("is deterministic: the same query builds the same frame state", async () => {
    const q = "?game=tictactoe&state=draw&seed=5";
    const a = await bootScenario(root(), q, { renderer: fakeRenderer() });
    const infoA = a!.info();
    const b = await bootScenario(root(), q, { renderer: fakeRenderer() });
    expect(b!.info()).toEqual(infoA);
  });

  it("seeks the hero animation to t, and refuses t for a scenario without one", async () => {
    const ok = await bootScenario(root(), "?game=tictactoe&state=midgame&t=0.5", { renderer: fakeRenderer() });
    expect(ok).not.toBeNull();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = await bootScenario(root(), "?game=tictactoe&state=draw&t=0.5", { renderer: fakeRenderer() });
    expect(bad).toBeNull();
    expect(window.__SCENE_ERROR__).toMatch(/has no anim to seek/);
    expect(err).toHaveBeenCalled();
  });

  it("play=anim with freeze=1 runs on a manual clock driven by step()", async () => {
    const renderer = fakeRenderer();
    const h = await bootScenario(root(), "?game=tictactoe&state=win&play=anim&ambient=1&freeze=1", { renderer });
    const before = h!.renders();
    h!.step(40);
    h!.step(40);
    expect(h!.renders()).toBe(before + 2);
    expect(() => h!.step(0)).toThrow(/ms must be > 0/);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await bootScenario(root(), "?game=tictactoe&state=draw&play=anim", { renderer: fakeRenderer() })).toBeNull();
    expect(window.__SCENE_ERROR__).toMatch(/play=anim: scenario "draw" has no anim/);
  });

  it("play=perf runs the named animations back to back on the wall clock", async () => {
    const h = await bootScenario(root(), "?game=tictactoe&state=midgame&play=perf&perf=place,win&freeze=0&quality=high", { renderer: fakeRenderer() });
    expect(h).not.toBeNull();
    const frames = await h!.sample(60);
    expect(frames.length).toBeGreaterThan(0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = await bootScenario(root(), "?game=tictactoe&state=midgame&play=perf&perf=zoom&freeze=0", { renderer: fakeRenderer() });
    expect(bad).toBeNull();
    expect(window.__SCENE_ERROR__).toMatch(/no scenario of "tictactoe" has anim "zoom"/);
  });

  it("mounts the player controller (no WebGL) and records keyboard/touch sends", async () => {
    const el = root(360, 800);
    const h = await bootScenario(el, "?game=tictactoe&state=midgame&role=player&player=p2", { renderer: fakeRenderer() });
    expect(window.__SCENE_READY__).toBe(true);
    expect(window.__SCENE_INFO__).toEqual({ drawCalls: 0, tris: 0, programs: 0, textures: 0, geometries: 0, texMB: 0 });
    expect(el.querySelector("canvas")).toBeNull();
    const enabled = [...el.querySelectorAll("button")].filter((b) => !b.disabled);
    expect(enabled.length).toBeGreaterThan(0); // p2 is to move in this scenario
    enabled[0]!.click();
    await Promise.resolve();
    expect(h!.sent()).toEqual([{ action: { type: "move", cell: expect.any(Number) }, ok: true }]);
    expect(() => h!.step(16)).toThrow(/phone roles/);
    expect(h!.renders()).toBe(0);
    expect(h!.info().drawCalls).toBe(0);
    expect(h!.fx()).toEqual([]);
    expect(h!.sfx()).toEqual([]);
    expect(h!.unmount().leakedGeometries).toBe(0);
  });

  it("gives the audience the generic panel when a game has no custom one", async () => {
    const el = root(360, 800);
    await bootScenario(el, "?game=tictactoe&state=intro&role=audience&mode=night");
    expect(el.querySelector("section[aria-label=Audience] h1")?.textContent).toBe("Tic-tac-toe");
  });

  it("fails loudly on a bad query or an unknown scenario", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const el = root();
    expect(await bootScenario(el, "?game=tictactoe&state=nope")).toBeNull();
    expect(window.__SCENE_ERROR__).toMatch(/no scenario "nope"/);
    expect(el.querySelector("[role=alert]")?.textContent).toMatch(/\/dev\/scenario failed/);
    expect(await bootScenario(root(), "?state=x")).toBeNull();
    expect(window.__SCENE_ERROR__).toMatch(/game= is required/);
    expect(window.__SCENE_READY__).toBe(false);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe("controller host", () => {
  it("validates sends through parseAction, records haptics/sfx, and builds the opt-in 3D board lazily", async () => {
    const game = await loadScenarioGame("tictactoe");
    const theme = createPlaceholderTheme("dusk");
    const el = root(360, 800);
    const sched = manualScheduler();
    const board = vi.fn(async (host: HTMLElement) =>
      createPlaceholderShell({ host, mode: "dusk", quality: "low", reducedMotion: false, seed: 1, hud: true, ambient: false, preserveDrawingBuffer: false, renderer: fakeRenderer(), schedule: sched.schedule, unschedule: sched.unschedule }),
    );
    let ctxSeen: Parameters<NonNullable<typeof game.client>["controller"]>[0] | null = null;
    const spyClient = { ...game.client!, controller: (ctx: Parameters<NonNullable<typeof game.client>["controller"]>[0]) => ((ctxSeen = ctx), game.client!.controller(ctx)) };
    const m = mountController({ game: { ...game, client: spyClient }, role: "player", root: el, theme, me: { id: "p1", colorSlot: 0 }, description: "d", seed: 1, mode: "dusk", reducedMotion: false, boardFactory: board });
    expect(ctxSeen).not.toBeNull();
    const ctx = ctxSeen!;
    expect(await ctx.send({ type: "move", cell: 4 })).toEqual({ ok: true });
    expect(await ctx.send({ junk: true })).toEqual({ ok: false, err: "invalid action" });
    ctx.haptic(12);
    ctx.sfx("tick");
    expect(m.haptics).toEqual([12]);
    expect(m.sfx).toEqual(["tick"]);
    const stage = await ctx.requestBoard();
    expect(stage.quality).toBe("low");
    expect(board).toHaveBeenCalledTimes(1);
    m.dispose();
    expect(el.querySelector("canvas")).toBeNull();
  });

  it("refuses a phone role for a game without a client, and uses a custom audience panel when there is one", async () => {
    const game = await loadScenarioGame("tictactoe");
    const theme = createPlaceholderTheme("day");
    const base = { role: "player" as const, root: root(), theme, me: { id: "p1", colorSlot: 0 }, description: "", seed: 1, mode: "day" as const, reducedMotion: true };
    expect(() => mountController({ ...base, game: { ...game, client: null } })).toThrow(/no client yet/);
    const audience = vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() }));
    mountController({ ...base, role: "audience", game: { ...game, client: { ...game.client!, audience } } });
    expect(audience).toHaveBeenCalledTimes(1);
  });
});
