/**
 * "Slow Think": a fixture with a 60 s phase and no audience interaction at all (ROADMAP M0-04
 * Accept: the pacing report's audience-idle check must fail on it). Players each lock in a
 * number during a 60 s `think` phase; the phase always runs its full length.
 */
import type { PlayerId, Rng } from "@sg/shared";
import type {
  ActionCtx,
  Ctx,
  GameModule,
  SetupContext,
  Step,
  ViewerKey,
} from "../../src/game-module.ts";

interface SlowState {
  phase: "intro" | "think" | "final";
  deadline: number | null;
  players: PlayerId[];
  locked: Record<PlayerId, boolean>;
  hidden: { picks: Record<PlayerId, number> };
}
type SlowAction = { type: "lock"; n: number };
interface SlowView {
  phase: SlowState["phase"];
  deadline: number | null;
  locked: Record<PlayerId, boolean>;
}

/** The think phase length. */
export const THINK_MS = 60_000;

export const slowThink: GameModule<SlowState, SlowAction, Record<string, never>, SlowView> = {
  manifest: {
    id: "slow-think" as GameModule<unknown, unknown, unknown, unknown>["manifest"]["id"],
    name: "Slow Think",
    version: "1.0.0",
    minPlayers: 2,
    maxPlayers: 4,
    teamSupport: "none",
    audience: {},
    tickHz: 0,
    renderMode: "on-demand",
    estMinutes: [1, 2],
    tags: ["fixture"],
    contentRating: "all",
    howToPlay: ["Think of a number", "Lock it in", "Wait for the reveal"],
  },
  optionSpecs: [],
  parseAction(raw: unknown): SlowAction | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const n = r["n"];
    if (r["type"] !== "lock" || typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 9) {
      return null;
    }
    return { type: "lock", n };
  },
  setup(ctx: SetupContext<Record<string, never>>): Step<SlowState> {
    const locked: Record<PlayerId, boolean> = {};
    for (const p of ctx.players) locked[p.id] = false;
    return {
      state: {
        phase: "intro",
        deadline: null,
        players: ctx.players.map((p) => p.id),
        locked,
        hidden: { picks: {} },
      },
      effects: [{ type: "timer.set", id: "intro", atMs: ctx.now + ctx.timing.pace(2_000) }],
    };
  },
  onAction(state: SlowState, action: SlowAction, ctx: ActionCtx): Step<SlowState> {
    if (state.phase !== "think" || state.locked[ctx.actor.id] !== false) {
      return { state, effects: [{ type: "fx", name: "illegal" }] };
    }
    return {
      state: {
        ...state,
        locked: { ...state.locked, [ctx.actor.id]: true },
        hidden: { picks: { ...state.hidden.picks, [ctx.actor.id]: action.n } },
      },
    };
  },
  onTimer(state: SlowState, id: string, ctx: Ctx): Step<SlowState> {
    if (id === "intro") {
      const deadline = ctx.now + ctx.timing.pace(THINK_MS);
      return {
        state: { ...state, phase: "think", deadline },
        effects: [{ type: "timer.set", id: "think", atMs: deadline }],
      };
    }
    if (id === "think") {
      return {
        state: { ...state, phase: "final", deadline: null },
        effects: [{ type: "timer.set", id: "final", atMs: ctx.now + ctx.timing.pace(3_000) }],
      };
    }
    return {
      state,
      effects: [
        {
          type: "end",
          result: { ranking: state.players.map((id) => ({ id, score: 0, place: 1 })) },
        },
      ],
    };
  },
  view(state: SlowState, _viewer: ViewerKey): SlowView {
    return { phase: state.phase, deadline: state.deadline, locked: { ...state.locked } };
  },
  legalActions(state: SlowState, player: PlayerId): SlowAction[] {
    if (state.phase !== "think" || state.locked[player] !== false) return [];
    return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ type: "lock", n }));
  },
  bot(state: SlowState, player: PlayerId, rng: Rng): SlowAction | null {
    if (state.phase !== "think" || state.locked[player] !== false) return null;
    return { type: "lock", n: 1 + rng.int(9) };
  },
  serialize: (s) => JSON.stringify(s),
  deserialize: (d) => JSON.parse(d) as SlowState,
};
