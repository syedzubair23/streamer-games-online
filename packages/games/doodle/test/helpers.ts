/**
 * Test helpers for Doodle: tables driven through the real runner, effect capture, and direct
 * reducer contexts.
 */
import { createRng, type DoodleWord, type PlayerId } from "@sg/shared";
import { createTiming, type ActionCtx, type Ctx, type Effect, type ViewerKey } from "@sg/engine";
import { allViewers } from "@sg/engine/testing";
import type { DoodleAction, DoodleState, DoodleView } from "../src/logic/index.ts";
import { DoodleDriver, scenarioContent, type DriverOptions } from "../src/scenarios.ts";

/** The test words: one per tier, known in advance. */
export const WORDS: readonly DoodleWord[] = [
  { w: "kitten", alt: ["cat", "kitty"], d: 1 },
  { w: "ice cream", alt: ["ice-cream cone"], d: 2 },
  { w: "haunted house", d: 3 },
];

/** Default draw window at drawSec 70 with the 3 s stream delay. */
export const DRAW_MS = 73_000;

/** A table at the intro (5 seats, 800 viewers, the test words). */
export function table(opts: Partial<DriverOptions> = {}): DoodleDriver {
  return new DoodleDriver({
    seed: 11,
    players: 5,
    content: scenarioContent(WORDS),
    ...opts,
  });
}

/** A table in the draw phase of turn 0 with the tier of `tier` chosen by the audience. */
export function drawing(tier: 1 | 2 | 3 = 1, opts: Partial<DriverOptions> = {}): DoodleDriver {
  const counts: [number, number, number] =
    tier === 1 ? [100, 0, 0] : tier === 2 ? [0, 100, 0] : [0, 0, 100];
  return table(opts).skipIntro().voteTier(counts);
}

/** Runs one action on the driver's runner and returns its result (ok flag and effects). */
export function actFx(
  d: DoodleDriver,
  id: PlayerId,
  action: DoodleAction,
  gapMs = 1_000,
): { ok: boolean; effects: Effect[] } {
  d.now += gapMs;
  const r = d.runner.act(id, action, d.now);
  return { ok: r.ok, effects: r.effects };
}

/** The module view (no runner offset) for a viewer. */
export function viewOf(d: DoodleDriver, viewer: ViewerKey): DoodleView {
  return d.module.view(d.state, viewer);
}

/** The stage view. */
export function stage(d: DoodleDriver): DoodleView {
  return viewOf(d, { role: "stage" });
}

/** A player view. */
export function pv(d: DoodleDriver, id: PlayerId): DoodleView {
  return viewOf(d, { role: "player", id });
}

/** Every viewer key for a state's seats. */
export function viewers(state: DoodleState): ViewerKey[] {
  return allViewers(state.players.map((p) => p.id));
}

/** Effects of a given type. */
export function effectsOf<T extends Effect["type"]>(
  effects: readonly Effect[] | undefined,
  type: T,
): Extract<Effect, { type: T }>[] {
  return (effects ?? []).filter((e): e is Extract<Effect, { type: T }> => e.type === type);
}

/** The fx names in a list of effects. */
export function fxNames(effects: readonly Effect[] | undefined): string[] {
  return effectsOf(effects, "fx").map((e) => e.name);
}

/** A reducer context at `now` (timerScale 1, stream delay 3 s). */
export function ctxAt(now: number, opts: { seed?: number; audience?: number } = {}): Ctx {
  return {
    rng: createRng(opts.seed ?? 7),
    now,
    timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
    audienceCount: opts.audience ?? 50,
  };
}

/** An action context for `actor` at `now`. */
export function actx(
  now: number,
  actor: PlayerId,
  role: ActionCtx["actor"]["role"] = "player",
): ActionCtx {
  return { ...ctxAt(now), actor: { id: actor, role } };
}
