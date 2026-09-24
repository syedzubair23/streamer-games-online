/// <reference lib="dom" />
/**
 * The tictactoe fixture's minimal client (SPEC §9.4): a small Stage (a 3×3 tile board with
 * instanced X and O pieces) and a DOM phone controller. It exists so the scenario route and
 * harness (M0-05) and the client shell (M1-09) can be validated before any real game, and it
 * follows the same rules a game client must: materials only from `ctx.materials`, colours only
 * from `ctx.theme`, instanced repeated pieces, no per-frame allocation, no own render loop,
 * reduced motion honoured, and `dispose()` frees everything it created.
 */
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector3,
  type Material,
} from "three";
import type {
  ControllerContext,
  ControllerInstance,
  GameClientModule,
  StageContext,
  StageInstance,
} from "../../../src/client-module.ts";
import { LINES, type TttAction, type TttView } from "./logic.ts";

const CELL = 1.1;
const TILE_H = 0.12;
const PIECE_Y = TILE_H + 0.12;

/** Board-space position of a cell (x, z), centred on the table. */
function cellPos(cell: number, out: Vector3): Vector3 {
  return out.set(((cell % 3) - 1) * CELL, PIECE_Y, (Math.floor(cell / 3) - 1) * CELL);
}

function statusText(view: TttView): string {
  const name = (mark: number): string => view.players[mark]?.name ?? "?";
  if (view.phase === "intro") return "Tic-tac-toe";
  if (view.phase === "result") {
    return view.winner !== null ? `${name(view.winner)} wins!` : "A draw!";
  }
  return `${name(view.turn)} to move`;
}

function createStage(ctx: StageContext): StageInstance<TttView> {
  const root = new Group();
  root.name = "tictactoe";
  ctx.scene.add(root);

  const tileGeo = new BoxGeometry(CELL * 0.94, TILE_H, CELL * 0.94);
  const barGeo = new BoxGeometry(0.78, 0.14, 0.18);
  const ringGeo = new TorusGeometry(0.3, 0.09, 10, 28);
  const tileMat = ctx.materials.makeLambertVC({ color: ctx.theme.tokens.mode.wood });
  const xMat = ctx.materials.makeToon({ color: ctx.theme.identity(0).base, rim: true });
  const oMat = ctx.materials.makeToon({ color: ctx.theme.identity(1).base, rim: true });
  const materials: Material[] = [tileMat, xMat, oMat];

  const tiles = new InstancedMesh(tileGeo, tileMat, 9);
  const xBars = new InstancedMesh(barGeo, xMat, 10); // 5 X marks × 2 bars
  const rings = new InstancedMesh(ringGeo, oMat, 5);
  root.add(tiles, xBars, rings);

  // Scratch objects: nothing is allocated per frame or per update.
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  const up = new Vector3(0, 1, 0);
  const mid = new Vector3();
  const flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  const scale = new Float32Array(9).fill(1);

  for (let i = 0; i < 9; i++) {
    cellPos(i, p).setY(TILE_H / 2);
    tiles.setMatrixAt(i, m.compose(p, q.identity(), s.set(1, 1, 1)));
  }
  tiles.instanceMatrix.needsUpdate = true;

  const hud = document.createElement("div");
  hud.setAttribute("role", "status");
  hud.style.cssText =
    "position:absolute;left:50%;top:6%;transform:translateX(-50%);font-weight:700";
  ctx.hud.appendChild(hud);

  let last: TttView | null = null;
  const applyTheme = (): void => {
    const t = ctx.theme.tokens;
    tileMat.color.set(t.mode.wood);
    hud.style.color = t.mode.uiInk;
    hud.style.background = t.mode.uiSurface;
    hud.style.borderRadius = `${t.radius.md}px`;
    hud.style.padding = `${t.space[1] ?? 8}px ${t.space[3] ?? 16}px`;
    ctx.loop.invalidate();
  };
  const unsubscribe = ctx.theme.onModeChange(applyTheme);
  applyTheme();

  const layout = (view: TttView): void => {
    let x = 0;
    let o = 0;
    view.board.forEach((mark, cell) => {
      if (mark === null) return;
      const k = scale[cell] ?? 1;
      cellPos(cell, p);
      if (mark === 0) {
        for (const angle of [Math.PI / 4, -Math.PI / 4]) {
          q.setFromAxisAngle(up, angle);
          xBars.setMatrixAt(x++, m.compose(p, q, s.set(k, k, k)));
        }
      } else {
        rings.setMatrixAt(o++, m.compose(p, flat, s.set(k, k, k)));
      }
    });
    xBars.count = x;
    rings.count = o;
    xBars.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    ctx.loop.invalidate();
  };

  const popIn = (cell: number, view: TttView): void => {
    if (ctx.reducedMotion) return;
    const target = { k: 0 };
    scale[cell] = 0;
    ctx.tween.spring(target, { k: 1 }, "bouncy", {
      onUpdate: () => {
        scale[cell] = target.k;
        layout(last ?? view);
      },
    });
  };

  return {
    update(view: TttView, prev: TttView | null): void {
      last = view;
      hud.textContent = statusText(view);
      if (prev !== null) {
        view.board.forEach((mark, cell) => {
          if (mark !== null && prev.board[cell] === null) {
            popIn(cell, view);
            ctx.sfx("pop");
          }
        });
        if (view.phase === "result" && prev.phase !== "result") {
          if (view.winner !== null) {
            const winner = view.players[view.winner];
            ctx.fx.confetti([ctx.theme.identity(winner?.colorSlot ?? view.winner).base]);
            ctx.sfx("win");
          } else {
            ctx.sfx("chime");
          }
        }
      }
      if (view.winLine !== null) {
        const [a, , c] = LINES[view.winLine];
        cellPos(a, p);
        ctx.camera.focusOn(cellPos(c, mid).add(p).multiplyScalar(0.5));
      }
      layout(view);
    },
    onFx(e): void {
      if (e.name === "illegal") ctx.sfx("fail");
    },
    seek(anim: string, t: number): void {
      if (anim !== "place" || last === null) return;
      const cell = last.board.findLastIndex((mark) => mark !== null);
      if (cell >= 0) scale[cell] = Math.min(1, Math.max(0, t));
      layout(last);
    },
    dispose(): void {
      unsubscribe();
      ctx.tween.cancelAll(root);
      ctx.scene.remove(root);
      tiles.dispose();
      xBars.dispose();
      rings.dispose();
      for (const g of [tileGeo, barGeo, ringGeo]) g.dispose();
      for (const mat of materials) mat.dispose();
      hud.remove();
    },
  };
}

function createController(ctx: ControllerContext<TttAction>): ControllerInstance<TttView> {
  const wrap = document.createElement("div");
  const title = document.createElement("p");
  const secret = document.createElement("p");
  const grid = document.createElement("div");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", "Board");
  const buttons: HTMLButtonElement[] = [];

  const style = (): void => {
    const t = ctx.theme.tokens;
    wrap.style.cssText = `display:grid;gap:${t.space[3] ?? 16}px;padding:${t.space[3] ?? 16}px;color:${t.mode.uiInk};background:${t.mode.uiBg}`;
    grid.style.cssText = `display:grid;grid-template-columns:repeat(3,1fr);gap:${t.space[1] ?? 8}px`;
    for (const b of buttons) {
      b.style.cssText = `min-height:72px;min-width:44px;font-size:2rem;font-weight:700;border-radius:${t.radius.md}px;border:3px solid ${t.mode.uiLine};background:${t.mode.uiSurface};color:${t.mode.uiInk}`;
    }
  };

  for (let cell = 0; cell < 9; cell++) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", `Cell ${cell + 1}`);
    b.addEventListener("click", () => {
      if (b.disabled) return;
      ctx.haptic(10);
      void ctx.send({ type: "move", cell }).then((res) => {
        if (!res.ok) ctx.sfx("fail");
      });
    });
    buttons.push(b);
    grid.appendChild(b);
  }
  wrap.append(title, grid, secret);
  ctx.root.appendChild(wrap);
  const unsubscribe = ctx.theme.onModeChange(style);
  style();

  return {
    update(view: TttView): void {
      const you = view.you;
      title.textContent = you?.yourTurn === true ? "Your move" : statusText(view);
      secret.textContent = you !== undefined ? `Secret line: ${you.secretLine}` : "";
      view.board.forEach((mark, cell) => {
        const b = buttons[cell];
        if (b === undefined) return;
        b.textContent = mark === null ? "" : mark === 0 ? "X" : "O";
        b.disabled = !(you?.yourTurn === true && mark === null);
      });
    },
    dispose(): void {
      unsubscribe();
      wrap.remove();
      buttons.length = 0;
    },
  };
}

/** The tictactoe fixture client. */
export const tictactoeClient: GameClientModule<TttView, TttAction> = {
  id: "tictactoe" as GameClientModule<TttView, TttAction>["id"],
  mat: "wood-board",
  stage: createStage,
  controller: createController,
};
