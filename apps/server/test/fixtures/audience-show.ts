/**
 * An audience-only fixture for the AudienceAggregator bot test: the game runs one poll of
 * every SPEC §4 kind in turn (vote → predict → quiz → dial → guess → tap → an event-closed
 * vote), resolves the ones that score, and records every aggregate it receives. Players only
 * sit there; the round ends when the last poll's result arrives.
 */
import type { PlayerId, Rng } from "@sg/shared";
import type {
  AnyGameModule,
  Ctx,
  Effect,
  GameModule,
  PollResult,
  PollSpec,
  SetupContext,
  Step,
  ViewerKey,
} from "@sg/engine";

/** The secret guess answer; bots know it, frames must never carry it. */
export const SHOW_SECRET = "Zanzibar Quokka";
/** Base length of each timed poll window, before `ctx.timing.input` scales it and adds the stream delay. */
export const SHOW_POLL_MS = 8_000;

const OPTIONS = [
  { id: "o1", label: "One" },
  { id: "o2", label: "Two" },
  { id: "o3", label: "Three" },
];

/** The polls, in order. */
export const SHOW_POLLS: readonly Omit<PollSpec, "closesAtMs">[] = [
  { pollId: "s-vote", kind: "vote", prompt: "Pick one", options: OPTIONS, teamSplit: true },
  { pollId: "s-predict", kind: "predict", prompt: "Who wins?", options: OPTIONS },
  { pollId: "s-quiz", kind: "quiz", prompt: "2 + 2?", options: OPTIONS, speedBonus: true },
  { pollId: "s-dial", kind: "dial", prompt: "How hot?" },
  { pollId: "s-guess", kind: "guess", prompt: "Name it", accept: [SHOW_SECRET] },
  { pollId: "s-tap", kind: "tap", prompt: "Tap!" },
  { pollId: "s-hidden", kind: "vote", prompt: "Secret ballot", options: OPTIONS, hideLive: true },
  {
    pollId: "s-event",
    kind: "vote",
    prompt: "Before the move",
    options: OPTIONS,
    closeOn: "event",
  },
];

/** What the correct answers resolve to. */
export const SHOW_ANSWERS = { predict: "o2", quiz: "o3", dialTarget: 700 } as const;

export interface ShowState {
  players: PlayerId[];
  index: number;
  results: (PollResult & { counted?: boolean })[];
}
export interface ShowView {
  phase: "polls" | "done";
  deadline: number | null;
  index: number;
  results: { pollId: string; total: number; counted: boolean | null }[];
}

function openPoll(index: number, ctx: Ctx): Effect[] {
  const spec = SHOW_POLLS[index];
  if (spec === undefined) return [];
  // A timed audience window comes from ctx.timing.input (SPEC §4/§9.3): base × timerScale +
  // stream delay, the only place the delay is added. The event-closed poll is exempt from the
  // delay (its closesAtMs is never used as a deadline), so it keeps the bare base.
  const windowMs =
    spec.closeOn === "event" ? SHOW_POLL_MS : (ctx.timing.input(SHOW_POLL_MS) ?? SHOW_POLL_MS);
  const effects: Effect[] = [
    { type: "audience.open", poll: { ...spec, closesAtMs: ctx.now + windowMs } },
  ];
  // The event-closed poll closes when "the move is made": a game timer, not the deadline.
  if (spec.closeOn === "event")
    effects.push({ type: "timer.set", id: "move", atMs: ctx.now + SHOW_POLL_MS / 2 });
  return effects;
}

/** Builds the fixture module under a launch game id. */
export function audienceShow(id = "trivia-night"): AnyGameModule {
  const module: GameModule<ShowState, null, Record<string, never>, ShowView> = {
    manifest: {
      id: id as GameModule<unknown, unknown, unknown, unknown>["manifest"]["id"],
      name: "Audience Show",
      version: "1.0.0",
      minPlayers: 1,
      maxPlayers: 8,
      teamSupport: "none",
      audience: { vote: true, predict: true, quiz: true, dial: true, guess: true, tap: true },
      tickHz: 0,
      renderMode: "on-demand",
      estMinutes: [1, 2],
      tags: ["fixture"],
      contentRating: "all",
      howToPlay: ["Watch", "Vote", "Win"],
    },
    optionSpecs: [],
    parseAction: () => null,
    setup(ctx: SetupContext<Record<string, never>>): Step<ShowState> {
      return {
        state: { players: ctx.players.map((p) => p.id), index: 0, results: [] },
        effects: openPoll(0, ctx),
      };
    },
    onAction: (state) => ({ state }),
    onTimer(state: ShowState, timerId: string): Step<ShowState> {
      const spec = SHOW_POLLS[state.index];
      if (timerId !== "move" || spec === undefined) return { state };
      return { state, effects: [{ type: "audience.close", pollId: spec.pollId }] };
    },
    onAudienceResult(state: ShowState, r: PollResult, ctx: Ctx): Step<ShowState> {
      const effects: Effect[] = [];
      if (r.pollId === "s-predict")
        effects.push({ type: "audience.resolve", pollId: r.pollId, correct: SHOW_ANSWERS.predict });
      if (r.pollId === "s-quiz")
        effects.push({ type: "audience.resolve", pollId: r.pollId, correct: SHOW_ANSWERS.quiz });
      if (r.pollId === "s-dial")
        effects.push({
          type: "audience.resolve",
          pollId: r.pollId,
          target: SHOW_ANSWERS.dialTarget,
          bands: [
            { within: 50, points: 100 },
            { within: 200, points: 40 },
          ],
        });
      const index = state.index + 1;
      const next: ShowState = { ...state, index, results: [...state.results, r] };
      if (index < SHOW_POLLS.length) effects.push(...openPoll(index, ctx));
      else
        effects.push({
          type: "end",
          result: { ranking: state.players.map((p, i) => ({ id: p, score: 0, place: i + 1 })) },
        });
      return { state: next, effects };
    },
    view(state: ShowState, _viewer: ViewerKey): ShowView {
      return {
        phase: state.index < SHOW_POLLS.length ? "polls" : "done",
        deadline: null,
        index: state.index,
        results: state.results.map((r) => ({
          pollId: r.pollId,
          total: r.total,
          counted: typeof r.counted === "boolean" ? r.counted : null,
        })),
      };
    },
    legalActions: () => [],
    bot: (_s: ShowState, _p: PlayerId, _rng: Rng) => null,
    serialize: (s) => JSON.stringify(s),
    deserialize: (d) => JSON.parse(d) as ShowState,
  };
  return module as unknown as AnyGameModule;
}
