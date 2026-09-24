/// <reference lib="dom" />
/**
 * Phone roles of the scenario route (`role=player|audience`): mounts the game's controller or
 * custom audience panel with **no network** (SPEC §14).
 *
 * `send` validates through the game's own `parseAction` and records the action, so the harness
 * can prove a controller is keyboard-playable (DOD G9) without a server. `requestBoard()` lazily
 * builds a placeholder Stage shell inside the controller, like the opt-in 3D board toggle
 * (SPEC §9.4); three.js is only fetched when it is called.
 *
 * Games without a custom audience panel get a generic one here; the real generic poll UI is the
 * shell's audience lite route (M1-09).
 *
 * @module
 */
import type { ControllerContext, ControllerInstance, StageContext } from "@sg/engine/client";
import type { AmbientMode } from "@sg/shared";
import { render } from "preact";
import type { PlaceholderShell } from "./placeholder-shell.ts";
import type { PlaceholderTheme } from "./placeholder-theme.ts";
import type { ScenarioGame } from "./scenario-games.ts";

/** An action a controller sent, as the harness sees it. */
export interface SentAction {
  action: unknown;
  ok: boolean;
  err?: string;
}

/** Options of {@link mountController}. */
export interface ControllerMountOptions {
  game: ScenarioGame;
  role: "player" | "audience";
  root: HTMLElement;
  theme: PlaceholderTheme;
  me: { id: string; colorSlot: number };
  /** Title of the scenario, for the generic audience panel. */
  description: string;
  seed: number;
  mode: AmbientMode;
  reducedMotion: boolean;
  /** Builds the opt-in 3D board (tests inject one; default: a placeholder Stage shell). */
  boardFactory?: (host: HTMLElement) => Promise<PlaceholderShell>;
}

/** A mounted phone role. */
export interface MountedController {
  instance: ControllerInstance<unknown>;
  sent: SentAction[];
  haptics: number[];
  sfx: string[];
  dispose(): void;
}

/** The generic audience panel for games without a custom one. */
function GenericAudiencePanel(props: {
  name: string;
  description: string;
  theme: PlaceholderTheme;
}) {
  const t = props.theme.tokens;
  return (
    <section
      aria-label="Audience"
      style={{
        margin: `${t.space[3]}px`,
        padding: `${t.space[4]}px`,
        borderRadius: `${t.radius.lg}px`,
        background: t.mode.uiSurface,
        color: t.mode.uiInk,
        border: `3px solid ${t.semantic.audience}`,
      }}
    >
      <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{props.name}</h1>
      <p style={{ margin: `${t.space[1]}px 0 0`, fontSize: "1rem" }}>{props.description}</p>
    </section>
  );
}

/** The default opt-in board: a low-tier placeholder Stage shell, loaded lazily. */
function defaultBoard(o: ControllerMountOptions): (host: HTMLElement) => Promise<PlaceholderShell> {
  return async (host) => {
    const { createPlaceholderShell } = await import("./placeholder-shell.ts");
    const shell = createPlaceholderShell({
      host,
      mode: o.mode,
      quality: "low",
      reducedMotion: o.reducedMotion,
      seed: o.seed,
      hud: true,
      ambient: false,
      preserveDrawingBuffer: false,
    });
    shell.start();
    return shell;
  };
}

/** Mounts the controller (or audience panel) for `role` into `root`. */
export function mountController(o: ControllerMountOptions): MountedController {
  const sent: SentAction[] = [];
  const haptics: number[] = [];
  const sfx: string[] = [];
  const boards: PlaceholderShell[] = [];
  const t = o.theme.tokens;
  o.root.style.cssText = `min-height:100%;background:${t.mode.uiBg};color:${t.mode.uiInk}`;

  const ctx: ControllerContext<unknown> = {
    root: o.root,
    theme: o.theme,
    send(action: unknown) {
      const parsed = o.game.logic.parseAction(action);
      const res = parsed === null ? { ok: false, err: "invalid action" } : { ok: true };
      sent.push({ action, ...res });
      return Promise.resolve(res);
    },
    sfx: (name) => {
      sfx.push(name);
    },
    haptic: (ms) => {
      haptics.push(ms);
    },
    async requestBoard(): Promise<StageContext> {
      const host = o.root.ownerDocument.createElement("div");
      host.style.cssText = "position:relative;width:100%;height:60vh";
      o.root.appendChild(host);
      const shell = await (o.boardFactory ?? defaultBoard(o))(host);
      boards.push(shell);
      return shell.ctx;
    },
    me: o.me,
  };

  let instance: ControllerInstance<unknown>;
  const client = o.game.client;
  if (o.role === "audience" && client?.audience !== undefined) {
    instance = client.audience(ctx as ControllerContext<never>);
  } else if (o.role === "player" && client !== null) {
    instance = client.controller(ctx);
  } else if (o.role === "audience") {
    const host = o.root.ownerDocument.createElement("div");
    o.root.appendChild(host);
    render(
      <GenericAudiencePanel
        name={o.game.logic.manifest.name}
        description={o.description}
        theme={o.theme}
      />,
      host,
    );
    instance = {
      update: () => undefined,
      dispose: () => {
        render(null, host);
        host.remove();
      },
    };
  } else {
    throw new Error(`game "${o.game.logic.manifest.id}" has no client yet (its Mx-04 item)`);
  }

  return {
    instance,
    sent,
    haptics,
    sfx,
    dispose(): void {
      instance.dispose();
      for (const b of boards.splice(0)) b.dispose();
    },
  };
}
