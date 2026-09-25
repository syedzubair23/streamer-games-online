/**
 * Test helpers for Tune In: direct reducer contexts and a view walker for secrecy checks.
 */
import { createRng, type PlayerId } from "@sg/shared";
import { createTiming, type ActionCtx, type Ctx, type Effect, type ViewerKey } from "@sg/engine";
import { allViewers } from "@sg/engine/testing";
import { tuneIn, type TiState, type TiView } from "../src/logic/index.ts";

/** A reducer context at `now` (timerScale 1, stream delay 3 s, 50 viewers). */
export function ctxAt(
  now: number,
  opts: { seed?: number; audience?: number; timerScale?: 0 | 1 } = {},
): Ctx {
  return {
    rng: createRng(opts.seed ?? 7),
    now,
    timing: createTiming({ timerScale: opts.timerScale ?? 1, streamDelaySec: 3 }),
    audienceCount: opts.audience ?? 50,
  };
}

/** An action context for `actor` at `now`. */
export function actx(now: number, actor: PlayerId, seed = 7): ActionCtx {
  return { ...ctxAt(now, { seed }), actor: { id: actor, role: "player" } };
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

/** Every viewer key for a state's seats. */
export function viewers(state: TiState): ViewerKey[] {
  return allViewers(state.players.map((p) => p.id));
}

/** Whether a viewer may see the target in this state (spec "Views"). */
export function maySeeTarget(state: TiState, viewer: ViewerKey): boolean {
  if (state.phase === "reveal" || state.phase === "turn-score" || state.phase === "final") {
    return true;
  }
  return (
    viewer.role === "player" &&
    viewer.id === state.psychic &&
    (state.phase === "clue" || state.phase === "guess")
  );
}

/** Keys that must never appear in any view. */
const SERVER_ONLY_KEYS = ["hidden", "deck", "ffaDials", "examples", "dialRate", "timers"];

/** Collects every key name in a JSON value. */
function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

/**
 * T6 secrecy for one state: the target only where the spec allows it, FFA dials only to their
 * owner before the reveal, and no server-only key in any view. Returns the problems found.
 */
export function secrecyProblems(state: TiState): string[] {
  const problems: string[] = [];
  const revealDone =
    state.phase === "reveal" || state.phase === "turn-score" || state.phase === "final";
  for (const viewer of viewers(state)) {
    const view: TiView = tuneIn.view(state, viewer);
    const who = viewer.role === "player" ? viewer.id : viewer.role;
    const keys = keysOf(view);
    for (const k of SERVER_ONLY_KEYS) if (keys.has(k)) problems.push(`${who} view has key ${k}`);
    if (view.target !== null && !maySeeTarget(state, viewer)) {
      problems.push(`${who} sees target ${view.target} in ${state.phase}`);
    }
    if (maySeeTarget(state, viewer) && !revealDone && view.target !== state.hidden.target) {
      problems.push(`${who} (psychic) does not see the target in ${state.phase}`);
    }
    if (viewer.role === "player") {
      const own = state.hidden.ffaDials[viewer.id];
      const shown = view.you?.ffaDial ?? null;
      if (
        (own === undefined) !== (shown === null) ||
        (own !== undefined && shown !== null && own.v !== shown.v)
      ) {
        problems.push(`${who} sees a dial that is not its own`);
      }
    } else if (view.you !== null) {
      problems.push(`${who} has a you slice`);
    }
  }
  return problems;
}
