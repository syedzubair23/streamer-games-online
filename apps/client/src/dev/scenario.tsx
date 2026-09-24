/// <reference lib="dom" />
/**
 * `/dev/scenario`: renders any registered game state deterministically, with no network
 * (SPEC §14, ROADMAP M0-05).
 *
 * `?game=&state=&mode=&seed=&quality=&vp=&role=&t=&freeze=1&hud=1` (+ `players`, `player`,
 * `play`, `perf`, `reduced`, `ambient`; see `params.ts`). The route:
 *
 * 1. parses the query strictly, loads only that game's chunks and calls
 *    `resolveScenario` (`scenarios[state].build({seed, rng, role, …})`, then
 *    `view(state, viewerKey(role))`);
 * 2. mounts the Stage (`role=stage|host`) into the placeholder shell, or the controller
 *    (`role=player|audience`), replays the scenario's fx and settles every tween with fixed
 *    steps, then seeks the hero animation to `t`;
 * 3. waits for fonts and two composited frames (events, never a timer), freezes, and only then
 *    sets `window.__SCENE_READY__ = true` and `window.__SCENE_INFO__ = {drawCalls, tris,
 *    programs, textures, geometries, texMB}`.
 *
 * Available in dev and non-production builds only: `vite.config.ts` leaves this page out of the
 * production build. On any failure it sets `window.__SCENE_ERROR__`, logs a console error and
 * shows the message, so the harness fails loudly instead of capturing a wrong frame.
 *
 * @module
 */
import { resolveScenario, type ResolvedScenario } from "@sg/engine";
import type { StageInstance } from "@sg/engine/client";
import { render } from "preact";
import { parseScenarioParams, type ScenarioParams } from "./params.ts";
import type { FxRecord, PlaceholderShell, RendererLike, SceneInfo } from "./placeholder-shell.ts";
import { createPlaceholderTheme, type PlaceholderTheme } from "./placeholder-theme.ts";
import {
  mountController,
  type MountedController,
  type SentAction,
} from "./scenario-controller.tsx";
import { loadScenarioGame, type ScenarioGame } from "./scenario-games.ts";

/** What `window.__SCENE__` offers the harness once the scene is ready. */
export interface SceneHandle {
  params: ScenarioParams;
  /** The resolved scenario's metadata. */
  scenario: { id: string; description: string; anim: { name: string; durationMs: number } | null };
  /** Player ids in the rendered view (`view.players[].id`), for `player=` sweeps. */
  players: string[];
  /** Current draw/memory info (re-read after playing). */
  info(): SceneInfo;
  /**
   * Advances the scene clock by `ms` and renders one frame, synchronously (`freeze=1` with a
   * `play` mode: frame-exact clip capture). Throws on a frozen still.
   */
  step(ms: number): void;
  /** Frames rendered so far (idle-render checks). */
  renders(): number;
  /** Every fx call so far (reduced-motion checks). */
  fx(): readonly FxRecord[];
  sfx(): readonly string[];
  /** Actions the controller sent (keyboard-play checks). */
  sent(): readonly SentAction[];
  /** The active theme tokens (contrast checks). */
  tokens(): PlaceholderTheme["tokens"];
  /**
   * Measures the frame cadence for `ms` of page time while the route renders (play modes);
   * resolves with each frame's delta in ms.
   */
  sample(ms: number): Promise<number[]>;
  /**
   * Disposes the mounted Stage and reports GPU memory against the pre-mount baseline
   * (DOD G8a "unmounting returns renderer.info.memory to baseline").
   */
  unmount(): { baseline: Memory; after: Memory; leakedGeometries: number; leakedTextures: number };
}

type Memory = { geometries: number; textures: number };

declare global {
  interface Window {
    __SCENE_READY__?: boolean;
    __SCENE_INFO__?: SceneInfo;
    __SCENE_ERROR__?: string;
    __SCENE__?: SceneHandle;
  }
}

const ZERO_INFO: SceneInfo = {
  drawCalls: 0,
  tris: 0,
  programs: 0,
  textures: 0,
  geometries: 0,
  texMB: 0,
};

/** Resolves on the next animation frame (an event, not a timer). */
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/** Waits for web fonts and two composited frames: the frame on screen is the final one. */
async function stable(): Promise<void> {
  await (document.fonts as FontFaceSet | undefined)?.ready;
  await nextFrame();
  await nextFrame();
}

function sample(ms: number): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let start: number | null = null;
    let last: number | null = null;
    const step = (now: number): void => {
      if (start === null) start = now;
      if (last !== null) deltas.push(now - last);
      last = now;
      if (now - start >= ms) resolve(deltas);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Player ids listed in a view (`players[].id`), when the game's view has them. */
export function viewPlayerIds(view: unknown): string[] {
  const players = (view as { players?: unknown } | null)?.players;
  if (!Array.isArray(players)) return [];
  return players.flatMap((p: unknown) => {
    const id = (p as { id?: unknown } | null)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

function showError(root: HTMLElement, message: string): void {
  window.__SCENE_ERROR__ = message;
  console.error(`[scenario] ${message}`);
  render(
    <div
      role="alert"
      style={{
        position: "fixed",
        inset: "16px",
        padding: "16px",
        borderRadius: "16px",
        background: "#FFF3E4",
        color: "#3D2A33",
        border: "3px solid #EC6A6A",
        font: "600 16px/1.4 system-ui, sans-serif",
        whiteSpace: "pre-wrap",
      }}
    >
      <strong>/dev/scenario failed</strong>
      {"\n"}
      {message}
    </div>,
    root,
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Plays the scenario's hero animation: seek 0→1 over its duration, hold, repeat (clips). */
function animPlayer(
  stage: StageInstance<unknown>,
  resolved: ResolvedScenario<unknown, unknown>,
): (dt: number) => void {
  const anim = resolved.scenario.anim;
  if (anim === undefined) return () => undefined;
  const hold = Math.max(400, anim.durationMs * 0.5);
  const cycle = anim.durationMs + hold;
  let t = 0;
  let loopStart = true;
  return (dt) => {
    if (loopStart) {
      for (const e of resolved.fx) stage.onFx?.(e);
      loopStart = false;
    }
    t += dt;
    if (t >= cycle) {
      t %= cycle;
      loopStart = true;
    }
    stage.seek?.(anim.name, Math.min(1, t / anim.durationMs));
  };
}

/**
 * Plays the game's perf script (DOD G8b): each named animation's scenario in turn, entered
 * through `update(view, prev)` (the real diff-driven path) and scrubbed over its duration.
 */
function perfPlayer(
  stage: StageInstance<unknown>,
  steps: { view: unknown; anim: { name: string; durationMs: number } }[],
  first: unknown,
): (dt: number) => void {
  let i = -1;
  let t = 0;
  let prev: unknown = first;
  const enter = (): void => {
    i = (i + 1) % steps.length;
    t = 0;
    const s = steps[i];
    if (s === undefined) return;
    stage.update(s.view, prev);
    prev = s.view;
  };
  return (dt) => {
    if (i < 0) enter();
    t += dt;
    const s = steps[i];
    if (s === undefined) return;
    if (t >= s.anim.durationMs) {
      enter();
      return;
    }
    stage.seek?.(s.anim.name, t / s.anim.durationMs);
  };
}

/** Test seams of {@link bootScenario}: a fake renderer lets the Stage path run without WebGL. */
export interface ScenarioDeps {
  renderer?: RendererLike;
}

async function mountStage(
  p: ScenarioParams,
  game: ScenarioGame,
  resolved: ResolvedScenario<unknown, unknown>,
  host: HTMLElement,
  reducedMotion: boolean,
  deps: ScenarioDeps,
): Promise<SceneHandle> {
  const client = game.client;
  if (client === null) throw new Error(`game "${p.game}" has no client yet (its Mx-03 item)`);
  // Loaded lazily: the phone roles never fetch three.js (SPEC §10).
  const { createPlaceholderShell } = await import("./placeholder-shell.ts");
  const shell: PlaceholderShell = createPlaceholderShell({
    host,
    mode: p.mode,
    quality: p.quality,
    reducedMotion,
    seed: p.seed,
    hud: p.hud,
    ambient: p.ambient && (!p.freeze || p.play !== "none"),
    preserveDrawingBuffer: p.freeze,
    paused: true,
    ...(deps.renderer !== undefined ? { renderer: deps.renderer } : {}),
  });
  shell.ctx.mats.setMat(client.mat);
  const baseline = shell.prepareBaseline();
  const sharedAtBaseline = shell.sharedTextureCount();

  const stage = client.stage(shell.ctx);
  let mounted = true;
  const players: ((dt: number) => void)[] = [];
  shell.onFrame = (dt) => {
    stage.frame?.(dt);
    for (const play of players) play(dt);
  };
  shell.onResize = (w, h) => stage.resize?.(w, h);
  stage.resize?.(host.clientWidth, host.clientHeight);

  stage.update(resolved.view, null);
  for (const e of resolved.fx) stage.onFx?.(e);
  shell.settle();
  const anim = resolved.scenario.anim;
  if (p.t !== null) {
    if (anim === undefined)
      throw new Error(`t=${p.t} given, but scenario "${p.state}" has no anim to seek`);
    stage.seek?.(anim.name, p.t);
  }

  if (p.play === "anim") {
    if (anim === undefined) throw new Error(`play=anim: scenario "${p.state}" has no anim`);
    players.push(animPlayer(stage, resolved));
  } else if (p.play === "perf") {
    const steps = p.perf.map((name) => {
      const sc = Object.values(game.scenarios).find((s) => s.anim?.name === name);
      if (sc?.anim === undefined)
        throw new Error(`perf script: no scenario of "${p.game}" has anim "${name}"`);
      const r = resolveScenario(game.logic, game.scenarios, {
        state: sc.id,
        seed: p.seed,
        role: p.role,
        ...(p.players !== null ? { players: p.players } : {}),
        ...(p.player !== null ? { playerId: p.player } : {}),
      });
      return { view: r.view, anim: sc.anim };
    });
    players.push(perfPlayer(stage, steps, resolved.view));
  }

  shell.renderNow();
  await stable();
  shell.renderNow();
  await nextFrame();
  if (!p.freeze) {
    // Wall clock: the loop runs on its own (perf measurement, manual viewing).
    if (players.length > 0) shell.ctx.loop.beginAnim();
    shell.start();
  } else if (players.length === 0) {
    shell.freeze();
  }
  // Otherwise (freeze=1 with a play mode) the loop stays paused and `step()` drives the clock.

  return {
    params: p,
    scenario: {
      id: resolved.scenario.id,
      description: resolved.scenario.description,
      anim: anim ?? null,
    },
    players: viewPlayerIds(resolved.view),
    info: () => shell.info(),
    step(ms: number) {
      if (shell.frozen) throw new Error("step: this scene is a frozen still (use play=anim)");
      if (!(ms > 0)) throw new Error("step: ms must be > 0");
      shell.advance(ms);
      shell.renderNow();
    },
    renders: () => shell.renders,
    fx: () => shell.fxLog,
    sfx: () => shell.sfxLog,
    sent: () => [],
    tokens: () => shell.theme.tokens,
    sample,
    unmount() {
      if (mounted) {
        mounted = false;
        players.length = 0;
        stage.dispose();
        shell.onFrame = null;
        shell.onResize = null;
        shell.motion.finishAll();
        shell.renderNow();
        shell.uploadSharedTextures();
      }
      const after = shell.memory();
      return {
        baseline,
        after,
        leakedGeometries: after.geometries - baseline.geometries,
        // Procedural textures are cached and shared (never disposed by games), so textures
        // the game added to that cache are not a leak.
        leakedTextures:
          after.textures - baseline.textures - (shell.sharedTextureCount() - sharedAtBaseline),
      };
    },
  };
}

async function mountPhone(
  p: ScenarioParams,
  game: ScenarioGame,
  resolved: ResolvedScenario<unknown, unknown>,
  host: HTMLElement,
  theme: PlaceholderTheme,
  reducedMotion: boolean,
): Promise<SceneHandle> {
  const viewerId = resolved.viewer.role === "player" ? resolved.viewer.id : "audience";
  const seatSlot = (() => {
    const view = resolved.view as { players?: { id?: unknown; colorSlot?: unknown }[] };
    const me = Array.isArray(view.players)
      ? view.players.find((x) => x.id === viewerId)
      : undefined;
    return typeof me?.colorSlot === "number" ? me.colorSlot : 0;
  })();
  host.style.overflowY = "auto";
  const mounted: MountedController = mountController({
    game,
    role: p.role === "audience" ? "audience" : "player",
    root: host,
    theme,
    me: { id: viewerId, colorSlot: seatSlot },
    description: resolved.scenario.description,
    seed: p.seed,
    mode: p.mode,
    reducedMotion,
  });
  mounted.instance.update(resolved.view, null);
  await stable();
  return {
    params: p,
    scenario: {
      id: resolved.scenario.id,
      description: resolved.scenario.description,
      anim: resolved.scenario.anim ?? null,
    },
    players: viewPlayerIds(resolved.view),
    info: () => ZERO_INFO,
    step: () => {
      throw new Error("step: phone roles have no scene clock");
    },
    renders: () => 0,
    fx: () => [],
    sfx: () => mounted.sfx,
    sent: () => mounted.sent,
    tokens: () => theme.tokens,
    sample,
    unmount() {
      mounted.dispose();
      const zero = { geometries: 0, textures: 0 };
      return { baseline: zero, after: zero, leakedGeometries: 0, leakedTextures: 0 };
    },
  };
}

/** Boots the route into `root`. Exported for tests; the page calls it once on load. */
export async function bootScenario(
  root: HTMLElement,
  search: string,
  deps: ScenarioDeps = {},
): Promise<SceneHandle | null> {
  window.__SCENE_READY__ = false;
  try {
    const p = parseScenarioParams(search);
    const reducedMotion = p.reduced || prefersReducedMotion();
    document.documentElement.dataset["mode"] = p.mode;
    const theme = createPlaceholderTheme(p.mode);
    document.body.style.background = theme.tokens.mode.uiBg;
    document.body.style.color = theme.tokens.mode.uiInk;

    const game = await loadScenarioGame(p.game);
    const resolved = resolveScenario(game.logic, game.scenarios, {
      state: p.state,
      seed: p.seed,
      role: p.role,
      ...(p.players !== null ? { players: p.players } : {}),
      ...(p.player !== null ? { playerId: p.player } : {}),
    });
    // An explicit `player=` wins over the scenario's own viewer ("view as p2").
    if (
      p.role === "player" &&
      p.player !== null &&
      resolved.viewer.role === "player" &&
      resolved.viewer.id !== p.player
    ) {
      resolved.viewer = { role: "player", id: p.player };
      resolved.view = game.logic.view(resolved.state, resolved.viewer);
    }
    document.title = `${game.logic.manifest.name} · ${p.state} · ${p.role}`;

    const handle =
      p.role === "stage" || p.role === "host"
        ? await mountStage(p, game, resolved, root, reducedMotion, deps)
        : await mountPhone(p, game, resolved, root, theme, reducedMotion);
    window.__SCENE__ = handle;
    window.__SCENE_INFO__ = handle.info();
    window.__SCENE_READY__ = true;
    return handle;
  } catch (err) {
    showError(root, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return null;
  }
}

const app = typeof document !== "undefined" ? document.getElementById("app") : null;
if (app !== null) void bootScenario(app, window.location.search);
