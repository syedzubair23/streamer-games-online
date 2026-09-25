/**
 * A small party-game fixture for the room actor tests. Configurable seat range; exercises
 * host-only view fields, hidden per-player text, `moderate`, `private`, `stream`,
 * `streamEach`, `fx`, a `vote` poll, input deadlines, `forceAdvance` and bots.
 *
 * Rules: every seat submits one line of text; the round ends when all submitted or the input
 * window closes (missing seats auto-submit). Ranking: submission order (first = place 1).
 */
import type { PlayerId, Rng } from "@sg/shared";
import type {
  ActionCtx,
  AnyGameModule,
  Ctx,
  Effect,
  GameModule,
  GameResult,
  PollResult,
  SetupContext,
  Step,
  ViewerKey,
} from "@sg/engine";

/** The host-only marker every host view carries; the stage must never see it. */
export const HOST_ONLY_MARK = "HOSTONLY-7c1f";

export interface PartyState {
  phase: "write" | "done";
  deadline: number | null;
  players: { id: PlayerId; name: string; teamId?: string }[];
  order: PlayerId[];
  hidden: { notes: Record<PlayerId, string> };
  moderation: Record<string, "pending" | "approved" | "rejected">;
  chat: PollResult | null;
  roundMs: number;
}
export type PartyAction = { type: "submit"; text: string };
export interface PartyView {
  phase: PartyState["phase"];
  deadline: number | null;
  players: { id: PlayerId; name: string }[];
  submitted: PlayerId[];
  moderation: Record<string, "pending" | "approved" | "rejected">;
  chatTotal: number;
  hostOnly?: string;
  you?: { id: PlayerId; note: string | null };
}

export interface PartyOptions {
  id?: string;
  min?: number;
  max?: number;
  teamSupport?: "none" | "optional" | "required";
  roundSec?: number;
  tickHz?: 0 | 10;
  /** Reveal pause between the last submission and `end` (default 0: end at once). */
  revealMs?: number;
}

function ranking(order: readonly PlayerId[]): GameResult["ranking"] {
  return order.map((id, i) => ({ id, score: order.length - i, place: i + 1 }));
}

function finish(state: PartyState, ctx: Ctx, revealMs: number): Step<PartyState> {
  const order = [...state.order];
  const notes = { ...state.hidden.notes };
  for (const p of state.players)
    if (!order.includes(p.id)) {
      order.push(p.id);
      notes[p.id] = "(auto)";
    }
  const effects: Effect[] = [
    { type: "timer.clear", id: "write" },
    { type: "audience.close", pollId: "chat" },
  ];
  if (revealMs > 0)
    effects.push({ type: "timer.set", id: "end", atMs: ctx.now + ctx.timing.pace(revealMs) });
  else effects.push({ type: "end", result: { ranking: ranking(order) } });
  return { state: { ...state, phase: "done", deadline: null, order, hidden: { notes } }, effects };
}

/** Builds a party game module. */
export function partyGame(o: PartyOptions = {}): AnyGameModule {
  const revealMs = o.revealMs ?? 0;
  const module: GameModule<PartyState, PartyAction, { roundSec: number }, PartyView> = {
    manifest: {
      id: (o.id ?? "quip-clash") as GameModule<
        unknown,
        unknown,
        unknown,
        unknown
      >["manifest"]["id"],
      name: `Party ${o.min ?? 2}-${o.max ?? 8}`,
      version: "1.0.0",
      minPlayers: o.min ?? 2,
      maxPlayers: o.max ?? 8,
      teamSupport: o.teamSupport ?? "none",
      audience: { vote: true },
      tickHz: o.tickHz ?? 0,
      renderMode: "on-demand",
      estMinutes: [1, 2],
      tags: ["fixture"],
      contentRating: "all",
      howToPlay: ["Write a line", "Be quick", "First wins"],
    },
    optionSpecs: [
      {
        kind: "seconds",
        key: "roundSec",
        label: "Round",
        min: 5,
        max: 120,
        default: o.roundSec ?? 30,
      },
    ],
    parseAction(raw: unknown): PartyAction | null {
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      if (r["type"] !== "submit" || typeof r["text"] !== "string" || r["text"].length > 80)
        return null;
      return { type: "submit", text: r["text"] };
    },
    setup(ctx: SetupContext<{ roundSec: number }>): Step<PartyState> {
      const window = ctx.timing.input(ctx.options.roundSec * 1000);
      const deadline = window === null ? null : ctx.now + window;
      const effects: Effect[] = [
        {
          type: "audience.open",
          poll: {
            pollId: "chat",
            kind: "vote",
            prompt: "Who is fastest?",
            options: ctx.players.map((p) => ({ id: p.id, label: p.name })),
            closesAtMs: deadline ?? ctx.now + 60_000,
          },
        },
      ];
      if (deadline !== null) effects.push({ type: "timer.set", id: "write", atMs: deadline });
      return {
        state: {
          phase: "write",
          deadline,
          players: ctx.players.map((p) => ({
            id: p.id,
            name: p.name,
            ...(p.teamId !== undefined ? { teamId: p.teamId } : {}),
          })),
          order: [],
          hidden: { notes: {} },
          moderation: {},
          chat: null,
          roundMs: ctx.options.roundSec * 1000,
        },
        effects,
      };
    },
    onAction(state: PartyState, action: PartyAction, ctx: ActionCtx): Step<PartyState> {
      const id = ctx.actor.id;
      if (
        state.phase !== "write" ||
        state.order.includes(id) ||
        !state.players.some((p) => p.id === id)
      )
        return { state, effects: [{ type: "fx", name: "illegal" }] };
      const itemId = `note-${id}`;
      const next: PartyState = {
        ...state,
        order: [...state.order, id],
        hidden: { notes: { ...state.hidden.notes, [id]: action.text } },
        moderation: { ...state.moderation, [itemId]: "pending" },
      };
      const effects: Effect[] = [
        { type: "moderate", itemId, kind: "text", ownerId: id, preview: action.text },
        { type: "fx", name: "submitted", data: { id } },
        { type: "private", to: id, name: "thanks", data: { n: next.order.length } },
        { type: "stream", channel: "stage", frame: new Uint8Array([0x02, next.order.length]) },
        {
          type: "streamEach",
          frames: [{ to: id, frame: new Uint8Array([0x03, next.order.length]) }],
        },
      ];
      if (next.order.length === state.players.length) {
        const done = finish(next, ctx, revealMs);
        return { state: done.state, effects: [...effects, ...(done.effects ?? [])] };
      }
      return { state: next, effects };
    },
    onTimer(state: PartyState, id: string, ctx: Ctx): Step<PartyState> {
      if (id === "write" && state.phase === "write") return finish(state, ctx, revealMs);
      if (id === "end" && state.phase === "done")
        return { state, effects: [{ type: "end", result: { ranking: ranking(state.order) } }] };
      return { state };
    },
    onAudienceResult(state: PartyState, r: PollResult): Step<PartyState> {
      return { state: { ...state, chat: r } };
    },
    onModeration(state: PartyState, itemId: string, approved: boolean): Step<PartyState> {
      if (state.moderation[itemId] === undefined) return { state };
      return {
        state: {
          ...state,
          moderation: { ...state.moderation, [itemId]: approved ? "approved" : "rejected" },
        },
      };
    },
    onHostCommand(state: PartyState, cmd, ctx: Ctx): Step<PartyState> {
      if (cmd.c === "forceAdvance" && state.phase === "write") return finish(state, ctx, 0);
      if (cmd.c === "forceAdvance" && state.phase === "done")
        return { state, effects: [{ type: "end", result: { ranking: ranking(state.order) } }] };
      return { state };
    },
    view(state: PartyState, viewer: ViewerKey): PartyView {
      const v: PartyView = {
        phase: state.phase,
        deadline: state.deadline,
        players: state.players.map((p) => ({ id: p.id, name: p.name })),
        submitted: [...state.order],
        moderation: { ...state.moderation },
        chatTotal: state.chat?.total ?? 0,
      };
      if (viewer.role === "host")
        v.hostOnly = `${HOST_ONLY_MARK}:${Object.keys(state.hidden.notes).length}`;
      if (viewer.role === "player")
        v.you = { id: viewer.id, note: state.hidden.notes[viewer.id] ?? null };
      return v;
    },
    legalActions(state: PartyState, player: PlayerId): PartyAction[] {
      return state.phase === "write" && !state.order.includes(player)
        ? [{ type: "submit", text: "hi" }]
        : [];
    },
    bot(state: PartyState, player: PlayerId, rng: Rng): PartyAction | null {
      if (state.phase !== "write" || state.order.includes(player)) return null;
      return { type: "submit", text: `bot line ${rng.int(100)}` };
    },
    serialize: (s) => JSON.stringify(s),
    deserialize: (d) => JSON.parse(d) as PartyState,
  };
  return module;
}
