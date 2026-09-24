/**
 * "Probe": a tiny, fully scriptable module for the runner's unit tests. Every action maps to
 * one runner feature (open/close polls, set timers, score, end, mutate state illegally…), and
 * the state records every callback the runner made, with the `ctx.now` it saw.
 */
import type { PlayerId, Rng } from "@sg/shared";
import type {
  ActionCtx,
  Ctx,
  Effect,
  GameManifest,
  GameModule,
  PollResult,
  SetupContext,
  Step,
  ViewerKey,
} from "../../src/game-module.ts";

export interface ProbeState {
  phase: string;
  deadline: number | null;
  n: number;
  log: string[];
  results: PollResult[];
  hidden: { note: string };
}

export type ProbeAction =
  | { type: "inc" }
  | { type: "noop" }
  | { type: "effects"; effects: Effect[]; deadline?: number | null }
  | { type: "mutate" };

export interface ProbeOptions {
  rounds: number;
  mode: string;
}

export interface ProbeView {
  phase: string;
  deadline: number | null;
  n: number;
  viewer: string;
}

/** Builds a probe module; `tickHz` and `setupEffects` vary per test. */
export function makeProbe(
  opts: {
    tickHz?: GameManifest["tickHz"];
    setupEffects?: (ctx: SetupContext<ProbeOptions>) => Effect[];
    onTick?: boolean;
    mutateOnTick?: boolean;
  } = {},
): GameModule<ProbeState, ProbeAction, ProbeOptions, ProbeView> & { viewCalls: number } {
  const probe = {
    viewCalls: 0,
    manifest: {
      id: "probe" as GameManifest["id"],
      name: "Probe",
      version: "0.1.0",
      minPlayers: 1,
      maxPlayers: 4,
      teamSupport: "optional",
      audience: { vote: true },
      tickHz: opts.tickHz ?? 0,
      renderMode: "on-demand",
      estMinutes: [1, 2],
      tags: [],
      contentRating: "all",
      howToPlay: ["a", "b", "c"],
    } satisfies GameManifest,
    optionSpecs: [
      { kind: "int", key: "rounds", label: "Rounds", min: 1, max: 9, step: 2, default: 3 },
      {
        kind: "enum",
        key: "mode",
        label: "Mode",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        default: "a",
      },
    ],
    parseAction(raw: unknown): ProbeAction | null {
      if (typeof raw !== "object" || raw === null) return null;
      const t = (raw as { type?: unknown }).type;
      if (t === "inc" || t === "noop" || t === "mutate") return { type: t };
      if (t === "effects") return raw as ProbeAction;
      return null;
    },
    setup(ctx: SetupContext<ProbeOptions>): Step<ProbeState> {
      return {
        state: {
          phase: "play",
          deadline: null,
          n: 0,
          log: [`setup@${ctx.now}:${ctx.options.rounds}${ctx.options.mode}`],
          results: [],
          hidden: { note: "secret-note" },
        },
        effects: opts.setupEffects?.(ctx) ?? [],
      };
    },
    onAction(state: ProbeState, action: ProbeAction, ctx: ActionCtx): Step<ProbeState> {
      const log = [...state.log, `act:${ctx.actor.id}:${action.type}@${ctx.now}`];
      switch (action.type) {
        case "inc":
          return { state: { ...state, n: state.n + 1, log } };
        case "noop":
          return { state, effects: [{ type: "fx", name: "illegal" }] };
        case "effects":
          return {
            state: {
              ...state,
              log,
              deadline: action.deadline === undefined ? state.deadline : action.deadline,
            },
            effects: action.effects,
          };
        case "mutate":
          state.n++; // deliberately mutates frozen state
          return { state: { ...state } };
      }
    },
    onTimer(state: ProbeState, id: string, ctx: Ctx): Step<ProbeState> {
      return { state: { ...state, log: [...state.log, `timer:${id}@${ctx.now}`] } };
    },
    onAudienceResult(state: ProbeState, r: PollResult, ctx: Ctx): Step<ProbeState> {
      return {
        state: {
          ...state,
          results: [...state.results, r],
          log: [...state.log, `poll:${r.pollId}@${ctx.now}`],
        },
      };
    },
    onPlayerLeave(state: ProbeState, id: PlayerId, ctx: Ctx): Step<ProbeState> {
      return { state: { ...state, log: [...state.log, `leave:${id}@${ctx.now}`] } };
    },
    onPlayerRejoin(state: ProbeState, id: PlayerId, ctx: Ctx): Step<ProbeState> {
      return { state: { ...state, log: [...state.log, `rejoin:${id}@${ctx.now}`] } };
    },
    onModeration(state: ProbeState, itemId: string, approved: boolean): Step<ProbeState> {
      return { state: { ...state, log: [...state.log, `mod:${itemId}:${approved}`] } };
    },
    view(state: ProbeState, viewer: ViewerKey): ProbeView {
      probe.viewCalls++;
      return {
        phase: state.phase,
        deadline: state.deadline,
        n: state.n,
        viewer: viewer.role === "player" ? viewer.id : viewer.role,
      };
    },
    legalActions(state: ProbeState): ProbeAction[] {
      return state.n < 3 ? [{ type: "inc" }] : [];
    },
    bot(state: ProbeState, _player: PlayerId, _rng: Rng): ProbeAction | null {
      return state.n < 3 ? { type: "inc" } : null;
    },
    serialize: (s: ProbeState) => JSON.stringify(s),
    deserialize: (d: string) => JSON.parse(d) as ProbeState,
  } satisfies GameModule<ProbeState, ProbeAction, ProbeOptions, ProbeView> & { viewCalls: number };
  if (opts.onTick === true) {
    return {
      ...probe,
      onTick(state: ProbeState, dtMs: number, ctx: Ctx): Step<ProbeState> {
        if (opts.mutateOnTick === true) {
          state.n++; // deliberately mutates (possibly frozen) state
          return { state: { ...state } };
        }
        return {
          state: {
            ...state,
            n: state.n + 1,
            log: [...state.log, `tick:${dtMs.toFixed(3)}@${ctx.now.toFixed(1)}`],
          },
        };
      },
      get viewCalls() {
        return probe.viewCalls;
      },
    };
  }
  return probe;
}
