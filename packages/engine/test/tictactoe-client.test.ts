// @vitest-environment happy-dom
/**
 * The tictactoe fixture client against a fake shell context: it renders every board state,
 * uses only ctx.materials / ctx.theme, honours reduced motion, and dispose() frees everything.
 */
import {
  Group,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshToonMaterial,
  type InstancedMesh,
} from "three";
import { describe, expect, it, vi } from "vitest";
import type {
  ControllerContext,
  IdentityColor,
  StageContext,
  ThemeApi,
  ThemeTokens,
} from "../src/client-module.ts";
import { resolveScenario } from "../src/scenario.ts";
import { tictactoeClient } from "./fixtures/tictactoe/client.ts";
import { tictactoe, tictactoeScenarios, type TttAction } from "./fixtures/tictactoe/index.ts";

// Test-only token values (the real ones live in @sg/ui, M1-05).
const identity: IdentityColor[] = Array.from({ length: 8 }, (_, slot) => ({
  slot,
  name: `c${slot}`,
  base: `hsl(${slot * 45} 70% 60%)`,
  deep: `hsl(${slot * 45} 70% 35%)`,
  glyph: "circle",
}));
const tokens = {
  mode: {
    wood: "hsl(25 45% 50%)",
    uiInk: "hsl(0 0% 20%)",
    uiSurface: "hsl(0 0% 98%)",
    uiBg: "hsl(30 60% 96%)",
    uiLine: "hsl(30 30% 80%)",
  },
  identity,
  radius: { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 },
  space: [4, 8, 12, 16, 24, 32, 48],
} as unknown as ThemeTokens;

function fakeTheme(): ThemeApi & { fire(): void; listeners: number } {
  const subs = new Set<() => void>();
  return {
    mode: "dusk",
    tokens,
    identity: (slot) => identity[((slot % 8) + 8) % 8] as IdentityColor,
    onModeChange(cb) {
      const f = (): void => cb("night", tokens);
      subs.add(f);
      return () => subs.delete(f);
    },
    fire: () => subs.forEach((f) => f()),
    get listeners() {
      return subs.size;
    },
  };
}

function fakeStage(reducedMotion = false) {
  const made: { dispose: () => void; disposed?: boolean }[] = [];
  const track = <T extends { dispose: () => void }>(m: T): T => {
    const orig = m.dispose.bind(m);
    const rec = m as T & { disposed?: boolean };
    rec.dispose = () => {
      rec.disposed = true;
      orig();
    };
    made.push(rec);
    return m;
  };
  const theme = fakeTheme();
  const springs: { onUpdate?: () => void; target: { k: number } }[] = [];
  const ctx = {
    scene: new Group(),
    camera: { state: "play", setState: vi.fn(), focusOn: vi.fn() },
    hud: document.createElement("div"),
    theme,
    quality: "low",
    loop: { invalidate: vi.fn(), beginAnim: () => () => undefined },
    tween: {
      to: vi.fn(),
      spring: vi.fn(
        (target: { k: number }, to: { k: number }, _s: unknown, o?: { onUpdate?: () => void }) => {
          springs.push({ target, ...(o?.onUpdate ? { onUpdate: o.onUpdate } : {}) });
          target.k = to.k;
          o?.onUpdate?.();
          return { cancel: () => undefined, finished: Promise.resolve() };
        },
      ),
      cancelAll: vi.fn(),
    },
    springs: {},
    fx: { confetti: vi.fn(), puff: vi.fn(), halo: vi.fn(), reactions: vi.fn(), shake: vi.fn() },
    mats: { setMat: vi.fn() },
    /* eslint-disable no-restricted-syntax -- test double: this fake plays the @sg/render material factories, the one place allowed to construct materials */
    materials: {
      makeToon: () => track(new MeshToonMaterial()),
      makeMatcap: () => track(new MeshMatcapMaterial()),
      makeLambertVC: () => track(new MeshLambertMaterial()),
      makeBasic: () => track(new MeshBasicMaterial()),
    },
    /* eslint-enable no-restricted-syntax -- end of the material-factory test double */
    textures: {},
    sfx: vi.fn(),
    pick: { plane: () => null, instance: () => null, object: () => null },
    reducedMotion,
  } as unknown as StageContext;
  return { ctx, made, theme, springs };
}

const scenarioView = (state: string, role: "stage" | "player" = "stage") =>
  resolveScenario(tictactoe, tictactoeScenarios, { state, seed: 2, role }).view;

describe("tictactoe stage", () => {
  it("renders the board, pieces and HUD through a game, then disposes everything", () => {
    const { ctx, made, theme } = fakeStage();
    const stage = tictactoeClient.stage(ctx);
    const root = ctx.scene.children[0] as Group;
    expect(root.name).toBe("tictactoe");
    stage.update(scenarioView("intro"), null);
    const mid = scenarioView("midgame");
    stage.update(mid, scenarioView("intro"));
    const [, xBars, rings] = root.children as InstancedMesh[];
    expect(xBars?.count).toBe(4); // 2 X marks × 2 bars
    expect(rings?.count).toBe(2);
    expect(ctx.sfx).toHaveBeenCalledWith("pop");
    expect(ctx.hud.textContent).toMatch(/to move/);

    stage.update(scenarioView("win"), mid);
    expect(ctx.fx.confetti).toHaveBeenCalledTimes(1);
    expect(ctx.sfx).toHaveBeenCalledWith("win");
    expect(ctx.camera.focusOn).toHaveBeenCalled();
    expect(ctx.hud.textContent).toMatch(/wins!/);

    stage.onFx?.({ name: "illegal" });
    expect(ctx.sfx).toHaveBeenCalledWith("fail");
    stage.seek?.("place", 0.5);
    theme.fire();
    expect(ctx.loop.invalidate).toHaveBeenCalled();

    stage.dispose();
    expect(ctx.scene.children).toHaveLength(0);
    expect(ctx.hud.childElementCount).toBe(0);
    expect(made.length).toBe(3);
    expect(made.every((m) => m.disposed === true)).toBe(true);
    expect(theme.listeners).toBe(0);
  });

  it("announces a draw and skips the pop-in spring with reduced motion", () => {
    const { ctx } = fakeStage(true);
    const stage = tictactoeClient.stage(ctx);
    const before = scenarioView("midgame");
    stage.update(scenarioView("draw"), before);
    expect(ctx.tween.spring).not.toHaveBeenCalled();
    expect(ctx.sfx).toHaveBeenCalledWith("chime");
    expect(ctx.hud.textContent).toBe("A draw!");
    stage.dispose();
  });
});

describe("tictactoe controller", () => {
  it("enables only empty cells on your turn and sends moves", async () => {
    const sent: TttAction[] = [];
    const theme = fakeTheme();
    const ctx: ControllerContext<TttAction> = {
      root: document.createElement("div"),
      theme,
      send: async (a) => {
        sent.push(a);
        return { ok: false, err: "ILLEGAL" };
      },
      sfx: vi.fn(),
      haptic: vi.fn(),
      requestBoard: () => Promise.reject(new Error("no 3D board in the fixture")),
      me: { id: "p1", colorSlot: 0 },
    };
    const ctl = tictactoeClient.controller(ctx);
    const view = scenarioView("midgame", "player");
    ctl.update(view, null);
    const buttons = [...ctx.root.querySelectorAll("button")];
    expect(buttons).toHaveLength(9);
    const yourTurn = view.you?.yourTurn === true;
    expect(yourTurn).toBe(true); // seed 2 seats p1 as X, and X is to move
    const enabled = buttons.filter((b) => !b.disabled).length;
    expect(enabled).toBe(yourTurn ? view.board.filter((c) => c === null).length : 0);
    expect(ctx.root.textContent).toMatch(/Secret line: /);
    const target = buttons.find((b) => !b.disabled);
    target?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ type: "move", cell: buttons.indexOf(target as HTMLButtonElement) }]);
    expect(ctx.haptic).toHaveBeenCalled();
    expect(ctx.sfx).toHaveBeenCalledWith("fail");
    buttons.find((b) => b.disabled)?.click();
    expect(sent).toHaveLength(1);
    theme.fire();
    ctl.dispose();
    expect(ctx.root.childElementCount).toBe(0);
    expect(theme.listeners).toBe(0);
  });
});
