/**
 * Test helpers for Trivia Night: a table driver over the real runner, direct reducer contexts,
 * effect filters and the secrecy walker (T9).
 */
import { createRng, type PlayerId } from "@sg/shared";
import { createTiming, type ActionCtx, type Ctx, type Effect, type ViewerKey } from "@sg/engine";
import { allViewers } from "@sg/engine/testing";
import { triviaNight, type TnState, type TnView } from "../src/logic/index.ts";

/** A reducer context at `now` (timerScale 1, stream delay 3 s, 50 viewers). */
export function ctxAt(now: number, opts: { seed?: number; timerScale?: 0 | 1 | 1.5 } = {}): Ctx {
  return {
    rng: createRng(opts.seed ?? 7),
    now,
    timing: createTiming({ timerScale: opts.timerScale ?? 1, streamDelaySec: 3 }),
    audienceCount: 50,
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
export function viewers(state: TnState): ViewerKey[] {
  return allViewers(state.players.map((p) => p.id));
}

/** Keys that must never appear in any view. */
const SERVER_ONLY_KEYS = [
  "hidden",
  "queue",
  "spares",
  "showdownQueue",
  "timers",
  "answers",
  "quizResult",
];

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

/** Phases before the current question's reveal. */
const PRE_REVEAL = new Set<TnState["phase"]>(["category", "read", "answer"]);

/**
 * T9 secrecy for one state: the current question's correct option (and the showdown's) in no
 * view before its reveal, options not before `answer`, other players' locks never, the
 * lifeline's removed options only on the recipient's phone, and no server-only key anywhere.
 */
export function secrecyProblems(state: TnState): string[] {
  const problems: string[] = [];
  for (const viewer of viewers(state)) {
    const view: TnView = triviaNight.view(state, viewer);
    const who = viewer.role === "player" ? viewer.id : viewer.role;
    const keys = keysOf(view);
    for (const k of SERVER_ONLY_KEYS) if (keys.has(k)) problems.push(`${who} view has key ${k}`);
    if (
      PRE_REVEAL.has(state.phase) &&
      view.lastReveal !== null &&
      view.lastReveal.index >= state.index
    ) {
      problems.push(`${who} sees the result of Q${state.index} in ${state.phase}`);
    }
    if (state.phase !== "answer" && state.phase !== "reveal" && view.options !== null) {
      problems.push(`${who} sees options in ${state.phase}`);
    }
    if ((state.phase === "category" || state.phase === "intro") && view.q !== null) {
      problems.push(`${who} sees the question in ${state.phase}`);
    }
    if (state.phase !== "showdown-verdict" && view.showdown?.correct !== undefined) {
      problems.push(`${who} sees the showdown answer in ${state.phase}`);
    }
    if (state.phase !== "showdown-verdict" && view.showdown?.results !== undefined) {
      problems.push(`${who} sees showdown locks in ${state.phase}`);
    }
    const own = viewer.role === "player" ? viewer.id : null;
    if (viewer.role !== "player" && view.you !== null) problems.push(`${who} has a you slice`);
    if (view.you !== null && own !== null) {
      const lock =
        state.phase === "showdown-answer" || state.phase === "showdown-verdict"
          ? state.hidden.showdownAnswers[own]
          : state.phase === "answer" || state.phase === "reveal"
            ? state.hidden.answers[own]
            : undefined;
      if ((lock?.choice ?? null) !== view.you.choice)
        problems.push(`${who} sees a choice that is not its own`);
      const rem = state.hidden.lifelineRemoved;
      if (view.you.removed !== null && (rem === undefined || rem.player !== own)) {
        problems.push(`${who} sees removed options that are not theirs`);
      }
    }
  }
  return problems;
}
