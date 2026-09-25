/**
 * Scenario entry for `@sg/game-quip-clash/scenarios` (SPEC §14, `docs/specs/quip-clash.md`
 * "Scenarios"): every visible state as a named scenario that `/dev/scenario` renders with no
 * network. Each builder drives the real module (setup, actions, timers, audience results,
 * moderation) so every scenario is a state the game can actually reach.
 *
 * Clock: every scenario state is "as of" {@link SCENARIO_NOW}. A builder is played once to
 * measure how long it takes, then replayed starting that long before `SCENARIO_NOW`, so
 * deadlines read naturally (e.g. `answering` has exactly 42 s left at `SCENARIO_NOW`).
 *
 * Live audience numbers (tallies while a poll is open) come from the platform, not the state;
 * scenarios pass them as fx: `audience-tally` `{ pollId, tallies, total }`.
 *
 * The prompts here are a small original fixture pack (also used by the tests); the shipped
 * packs live in `content/packs/quip-prompts/` (M2-02).
 *
 * @module
 */
import {
  createRng,
  type AnyPack,
  type PackKind,
  type PlayerId,
  type QuipPrompt,
  type Rng,
} from "@sg/shared";
import {
  createTiming,
  defaultOptions,
  type ContentAccess,
  type Effect,
  type PackInfo,
  type ScenarioCtx,
  type ScenarioRegistry,
  type Seat,
  type Timing,
  type ViewerKey,
} from "@sg/engine";
import {
  answerOf,
  authorOf,
  createQuipClash,
  currentPrompt,
  isEligible,
  roundPrompts,
  TIMER,
  type QcAction,
  type QcOptions,
  type QcRoomSettings,
  type QcState,
  type QuipClashModule,
} from "./logic/index.ts";

export { GAME_ID } from "./logic/index.ts";

/** Scenario clock (server ms): every scenario state is as of this instant. */
export const SCENARIO_NOW = 1_000_000;

/** The seats scenarios use (up to 8). */
export const SCENARIO_SEATS: readonly Seat[] = Object.freeze(
  ["Maple", "Juniper", "Clover", "Basil", "Rowan", "Hazel", "Sage", "Wren"].map((name, i) => ({
    id: `p${i + 1}`,
    name,
    seat: i,
    colorSlot: i,
  })),
);

interface FixturePrompt extends QuipPrompt {
  /** Two bespoke answers for scenario matchups. */
  answers: [string, string];
}

const FIXTURE: readonly FixturePrompt[] = [
  {
    id: "fx-dentist",
    text: "The worst thing to hear from your dentist: ___",
    safety: [
      "Let's try the big drill",
      "Is that a tooth or a raisin?",
      "Open wider. Wider. Wider.",
    ],
    answers: ["Whoops.", "I've never seen teeth before"],
  },
  {
    id: "fx-goldfish",
    text: "A terrible name for a pet goldfish: ___",
    safety: ["Bubbles the Destroyer", "Captain Wet", "Gary From Accounting"],
    answers: ["Dinner", "Sir Drowns-a-Lot"],
  },
  {
    id: "fx-chicken",
    text: "The real reason the chicken crossed the road: ___",
    safety: ["To escape the group chat", "It saw a better road", "Free parking on the other side"],
    answers: ["It owed the duck money", "Tax purposes"],
  },
  {
    id: "fx-houseplant",
    text: "What your houseplant says about you behind your back: ___",
    safety: ["He calls me Kevin", "I have seen things", "Their playlist is a crime"],
    answers: ["She talks to me in a baby voice", "Water? Never heard of it"],
  },
  {
    id: "fx-superpower",
    text: "The worst superpower to get at age 40: ___",
    safety: [
      "Knowing every password but mine",
      "Flying, but only downhill",
      "Super hearing for gossip",
    ],
    answers: ["Unlimited back pain", "Talking to pigeons, only pigeons"],
  },
  {
    id: "fx-icecream",
    text: "A rejected flavour of ice cream: ___",
    safety: ["Ketchup Ripple", "Mild Disappointment", "Pickle Fudge Crunch"],
    answers: ["Wet cardboard swirl", "Lasagna Surprise"],
  },
  {
    id: "fx-library",
    text: "Something you should never shout in a library: ___",
    safety: ["The butler did it!", "Books are just long tweets", "MARCO! ... POLO?"],
    answers: ["WHO WANTS NACHOS", "Chapter eleven is a lie"],
  },
  {
    id: "fx-burrito",
    text: "The worst thing to find in your burrito: ___",
    safety: ["A single wet sock", "Your ex's phone number", "The receipt from 2009"],
    answers: ["A tiny, damp contract", "Another smaller burrito"],
  },
  {
    id: "fx-parachute",
    text: "A bad slogan for a parachute company: ___",
    safety: ["Ask for a refund on the way down", "Gravity is a myth", "Some assembly required"],
    answers: ["Mostly works!", "Pull the other one"],
  },
  {
    id: "fx-cat",
    text: "What the cat is actually thinking at 3 a.m.: ___",
    safety: ["I am the night", "Scream now, explain never", "That shadow owes me rent"],
    answers: ["Time for parkour", "The floor needs more cups"],
  },
  {
    id: "fx-gps",
    text: "The least helpful thing a GPS could say: ___",
    safety: ["Turn left into the lake", "Recalculating your life choices", "Are we there yet?"],
    answers: ["You'll figure it out", "Honestly? Just go home"],
  },
  {
    id: "fx-party",
    text: "A terrible theme for a kid's birthday party: ___",
    safety: ["The Meaning of Mortgages", "Fifty Shades of Beige", "Mandatory Spreadsheets"],
    answers: ["Filing Taxes Together", "Quiet Reflection"],
  },
  {
    id: "fx-date",
    text: "The worst thing to say on a first date: ___",
    safety: [
      "I brought my own fork",
      "Do you like spreadsheets?",
      "This is my emotional support ham",
    ],
    answers: ["My mom is outside in the car", "I've named our kids already"],
  },
  {
    id: "fx-cookies",
    text: "The secret ingredient in grandma's cookies: ___",
    safety: [
      "Pure unfiltered regret",
      "Crushed dreams and butter",
      "Whatever fell behind the fridge",
    ],
    answers: ["Spite", "A little bit of the dog"],
  },
  {
    id: "fx-pirate",
    text: "An unexpected item on a pirate's shopping list: ___",
    safety: ["Gluten-free hardtack", "A tiny plank for practice", "Sunscreen for the hook"],
    answers: ["Eye patch, but cute", "Anti-parrot spray"],
  },
  {
    id: "fx-boat",
    text: "The worst name for a boat: ___",
    safety: ["Knot Floating", "S.S. Mistake", "Probably Fine III"],
    answers: ["The Leaky Bucket", "Unsinkable II"],
  },
  {
    id: "fx-wifi",
    text: "What the Wi-Fi password should really be: ___",
    safety: ["password123 obviously", "Ask the dog", "ITSTHEFRIDGEAGAIN"],
    answers: ["stopaskingmom", "GetYourOwnInternet"],
  },
];

/** Last Quip answers for scenarios (they fit any "worst …" prompt). */
const LAST_QUIP_ANSWERS = [
  "A raccoon in a trench coat",
  "Three kids in a trench coat",
  "Sixteen confused ducks",
  "An aggressively polite goose",
  "The ghost of my fax machine",
  "Soup. Just soup.",
  "A kazoo solo, but sad",
  "My landlord, somehow",
] as const;

/** The fixture `quip-core` pack (17 original prompts: enough for 8 players). */
export const FIXTURE_CORE_PACK: AnyPack = {
  id: "quip-core",
  kind: "quip-prompts",
  name: "Fixture core",
  lang: "en",
  rating: "all",
  version: 1,
  items: FIXTURE.map(({ id, text, safety }) => ({ id, text, safety })),
};

/** A tiny fixture teen pack (for the family-filter paths). */
export const FIXTURE_SPICY_PACK: AnyPack = {
  id: "quip-spicy",
  kind: "quip-prompts",
  name: "Fixture spicy",
  lang: "en",
  rating: "teen",
  version: 1,
  items: [
    {
      id: "fx-spicy-roommate",
      text: "The worst thing your roommate could label 'mine': ___",
      safety: ["The couch, all of it", "Your date's hoodie", "The last slice, again"],
    },
    {
      id: "fx-spicy-texts",
      text: "A text you should never send your boss at 2 a.m.: ___",
      safety: ["u up? for spreadsheets?", "I know about the stapler", "New phone who dis"],
    },
    {
      id: "fx-spicy-wedding",
      text: "The worst thing to hear during wedding vows: ___",
      safety: ["Wait, which one is Steve?", "I object, respectfully", "Is the bar open yet?"],
    },
  ],
};

/**
 * A synchronous in-memory {@link ContentAccess} over packs (the scenarios run in the browser, so
 * they cannot use the vitest-based `fakeContent`). `used` lists prompt ids already played.
 */
export function packContent(
  packs: readonly AnyPack[],
  used: readonly string[] = [],
): ContentAccess {
  return {
    packs: (kind: PackKind): readonly PackInfo[] =>
      packs
        .filter((p) => p.kind === kind)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          name: p.name,
          rating: p.rating,
          count: p.items.length,
        })),
    items: (kind, packIds) =>
      packIds.flatMap((id) => {
        const pack = packs.find((p) => p.id === id && p.kind === kind);
        return pack === undefined ? [] : (pack.items as never[]);
      }),
    isUsed: (kind, key) => kind === "quip-prompts" && used.includes(key),
  };
}

/** The fixture content (core + spicy). */
export const fixtureContent = (): ContentAccess =>
  packContent([FIXTURE_CORE_PACK, FIXTURE_SPICY_PACK]);

// ---- The scenario driver -------------------------------------------------------------------------

/** Options of a {@link ScenarioDriver}. */
export interface DriverOptions {
  seed: number;
  players: number;
  /** Game ms at setup. */
  start: number;
  options?: Partial<QcOptions>;
  room?: Partial<QcRoomSettings>;
}

/** Drives a real game in scenario time (no runner, no network). */
export class ScenarioDriver {
  state: QcState;
  now: number;
  readonly module: QuipClashModule;
  readonly rng: Rng;
  readonly timing: Timing;
  /** Pending timers (id → game ms). */
  readonly timers = new Map<string, number>();

  constructor(opts: DriverOptions) {
    this.module = createQuipClash(opts.room ?? {});
    this.rng = createRng(opts.seed);
    this.timing = createTiming({ timerScale: 1, streamDelaySec: 3 });
    this.now = opts.start;
    const options = {
      ...(defaultOptions(this.module.optionSpecs) as unknown as QcOptions),
      ...opts.options,
    };
    const step = this.module.setup({
      players: SCENARIO_SEATS.slice(0, opts.players).map((s) => ({ ...s })),
      teams: [],
      options,
      rng: this.rng,
      now: this.now,
      timing: this.timing,
      content: fixtureContent(),
      audienceCount: 120,
    });
    this.state = step.state;
    this.#apply(step.effects);
  }

  #ctx() {
    return { rng: this.rng, now: this.now, timing: this.timing, audienceCount: 120 };
  }

  #apply(effects: readonly Effect[] | undefined): void {
    for (const e of effects ?? []) {
      if (e.type === "timer.set") this.timers.set(e.id, e.atMs);
      if (e.type === "timer.clear") this.timers.delete(e.id);
    }
  }

  /** Lets `ms` pass (no timers fire). */
  wait(ms: number): this {
    this.now += ms;
    return this;
  }

  /** Jumps to the phase timer and fires it. */
  next(): this {
    const at = this.timers.get(TIMER.phase);
    if (at === undefined) throw new Error(`scenario: no phase timer in ${this.state.phase}`);
    this.timers.delete(TIMER.phase);
    this.now = Math.max(this.now, at);
    const step = this.module.onTimer?.(this.state, TIMER.phase, this.#ctx());
    if (step !== undefined) {
      this.state = step.state;
      this.#apply(step.effects);
    }
    return this;
  }

  /** Fires phase timers until `phase` (and optionally a given round) is on. */
  until(phase: QcState["phase"], round?: QcState["round"]): this {
    for (let i = 0; i < 200; i++) {
      if (this.state.phase === phase && (round === undefined || this.state.round === round)) {
        return this;
      }
      this.next();
    }
    throw new Error(`scenario: never reached ${phase}`);
  }

  /** A player acts (throws when the game refuses: scenarios only take legal paths). */
  act(player: PlayerId, action: QcAction, afterMs = 1_500): this {
    this.now += afterMs;
    const step = this.module.onAction(this.state, action, {
      ...this.#ctx(),
      actor: { id: player, role: "player" },
    });
    if (step.state === this.state) {
      throw new Error(`scenario: illegal ${JSON.stringify(action)} by ${player}`);
    }
    this.state = step.state;
    this.#apply(step.effects);
    return this;
  }

  /** The audience result of the open vote (or predict) poll arrives. */
  audience(pollId: string, tallies: Record<string, number>): this {
    const total = Object.values(tallies).reduce((a, b) => a + b, 0);
    const kind = pollId.startsWith("predict") ? "predict" : "vote";
    const step = this.module.onAudienceResult?.(
      this.state,
      { pollId, kind, total, tallies },
      this.#ctx(),
    );
    if (step !== undefined) {
      this.state = step.state;
      this.#apply(step.effects);
    }
    return this;
  }

  /** A moderation decision. */
  moderate(itemId: string, approved: boolean): this {
    const step = this.module.onModeration?.(this.state, itemId, approved, this.#ctx());
    if (step !== undefined) {
      this.state = step.state;
      this.#apply(step.effects);
    }
    return this;
  }

  /** The members of an author. */
  seatsOf(author: string): PlayerId[] {
    return this.state.authors.find((a) => a.id === author)?.members ?? [];
  }

  /** Answers every open prompt of `author` with its scripted answer. */
  answerAll(author: string): this {
    const player = this.seatsOf(author)[0] as PlayerId;
    for (const p of roundPrompts(this.state)) {
      if (this.state.phase !== "answer") break;
      if (!p.authors.includes(author) || answerOf(this.state, p.id, author) !== undefined) continue;
      this.act(player, { type: "answer", promptId: p.id, text: this.textFor(p.id, author) });
    }
    return this;
  }

  /** The scripted answer of an author to a prompt. */
  textFor(promptId: string, author: string): string {
    const p = this.state.prompts.find((x) => x.id === promptId);
    const index = p?.authors.indexOf(author) ?? 0;
    if (p?.round === 3) return LAST_QUIP_ANSWERS[index % LAST_QUIP_ANSWERS.length] as string;
    const fixture = FIXTURE.find((f) => f.id === promptId);
    return fixture?.answers[index === 0 ? 0 : 1] ?? "A raccoon in a trench coat";
  }

  /** Eligible voters of the current vote, in seat order. */
  voters(): PlayerId[] {
    return this.state.players.filter((p) => isEligible(this.state, p.id)).map((p) => p.id);
  }
}

/**
 * Plays `script` once to measure its length, then again starting that long before
 * {@link SCENARIO_NOW}, so the final state is as of `SCENARIO_NOW`.
 */
export function atScenarioNow(script: (start: number) => ScenarioDriver): ScenarioDriver {
  const probe = script(0);
  return script(SCENARIO_NOW - probe.now);
}

/** A driver advanced into round 1 answering. */
function answering(ctx: ScenarioCtx, start: number, players = 6): ScenarioDriver {
  return new ScenarioDriver({ seed: ctx.seed, players, start }).until("answer");
}

/** Plays out a matchup vote: `split` = [votes for A, votes for B], then the audience result. */
function playVote(
  d: ScenarioDriver,
  split: [number, number],
  tallies: Record<string, number>,
): ScenarioDriver {
  d.voters().forEach((v, i) => {
    const choice = i < split[0] ? "A" : i < split[0] + split[1] ? "B" : null;
    if (choice !== null) d.act(v, { type: "vote", choice }, 900);
  });
  const pollId = d.state.aud?.pollId as string;
  if (d.state.phase === "vote" && !d.state.closing) d.next();
  return d.wait(600).audience(pollId, tallies);
}

/** Everyone answers every round-1 prompt, then the game reaches matchup `index`'s show-prompt. */
function toMatchup(d: ScenarioDriver, index: number): ScenarioDriver {
  for (const a of d.state.authors) d.answerAll(a.id);
  while (!(d.state.phase === "show-prompt" && d.state.matchup === index)) {
    if (d.state.phase === "vote") playVote(d, [3, 1], { A: 55, B: 45 });
    else d.next();
  }
  return d;
}

/** Plays a whole game with scripted answers and split votes up to round 3's show-all. */
function toLastQuip(d: ScenarioDriver): ScenarioDriver {
  for (let guard = 0; guard < 400; guard++) {
    const s = d.state;
    if (s.phase === "show-all") return d;
    if (s.phase === "answer") for (const a of s.authors) d.answerAll(a.id);
    else if (s.phase === "vote") playVote(d, [1, 1], { A: 40, B: 60 });
    else d.next();
  }
  throw new Error("scenario: never reached Last Quip");
}

/** Own-card-free Last Quip slots for a voter. */
function slotsFor(d: ScenarioDriver, voter: PlayerId): string[] {
  const author = authorOf(d.state, voter)?.id;
  return d.state.order.flatMap((a, i) => (a === author ? [] : [`c${i + 1}`]));
}

function votingScenario(ctx: ScenarioCtx) {
  const d = atScenarioNow((start) => {
    const drv = toMatchup(answering(ctx, start), 0).until("vote");
    drv
      .voters()
      .slice(0, 3)
      .forEach((v, i) => drv.act(v, { type: "vote", choice: i === 1 ? "B" : "A" }, 1_100));
    return drv.wait(1_500);
  });
  const waiting = d.voters().find((v) => d.state.votes[v] === undefined) ?? "p1";
  const viewer: ViewerKey = { role: "player", id: waiting };
  return {
    state: d.state,
    viewer,
    fx: [
      {
        name: "audience-tally",
        data: { pollId: d.state.aud?.pollId, tallies: { A: 62, B: 38 }, total: 100 },
      },
    ],
  };
}

function resultsScenario(
  ctx: ScenarioCtx,
  split: [number, number],
  tallies: Record<string, number>,
  fx: string,
) {
  const d = atScenarioNow((start) => {
    const drv = toMatchup(answering(ctx, start), 0).until("vote");
    playVote(drv, split, tallies);
    return drv.until("results").wait(300);
  });
  return { state: d.state, fx: [{ name: fx }] };
}

/** The Quip Clash scenario registry (spec "Scenarios", plus `midgame` for DOD G8a). */
export const scenarios: ScenarioRegistry<QcState> = {
  intro: {
    id: "intro",
    description: "6 players, round 1 intro card: writer tokens around the cork, room code chip",
    build: (ctx) => ({
      state: atScenarioNow((start) =>
        new ScenarioDriver({ seed: ctx.seed, players: 6, start }).wait(2_000),
      ).state,
    }),
  },
  answering: {
    id: "answering",
    description: "Round 1 answering: 4 of 6 writers done, 42 s left; player sees prompt + input",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = answering(ctx, start);
        for (const a of drv.state.authors.slice(0, 4)) drv.answerAll(a.id);
        const deadline = drv.state.deadline as number;
        return drv.wait(Math.max(0, deadline - 42_000 - drv.now));
      });
      const waiting = d.state.authors[4]?.members[0] ?? "p5";
      return {
        state: d.state,
        viewer: { role: "player", id: waiting },
        fx: [{ name: "plane", data: { author: d.state.authors[3]?.id } }],
      };
    },
    anim: { name: "plane", durationMs: 600 },
  },
  reveal: {
    id: "reveal",
    description: "Matchup 2: prompt card and both answers shown under the spotlight",
    build: (ctx) => ({
      state: atScenarioNow((start) => toMatchup(answering(ctx, start), 1).next().wait(400)).state,
      fx: [{ name: "reveal" }],
    }),
    anim: { name: "reveal", durationMs: 900 },
  },
  voting: {
    id: "voting",
    description: "Vote phase: 3 of 4 players voted, chat 62/38, jars filling, timer running",
    build: (ctx) => votingScenario(ctx),
    anim: { name: "hearts", durationMs: 1500 },
  },
  midgame: {
    id: "midgame",
    description: "Perf reference (DOD G8a): the vote phase with jars, hearts and the timer",
    build: (ctx) => votingScenario(ctx),
    anim: { name: "hearts", durationMs: 1500 },
  },
  results: {
    id: "results",
    description: "Matchup results: author chips on the cards, points rolling up, clear winner",
    build: (ctx) => resultsScenario(ctx, [3, 1], { A: 62, B: 38 }, "results"),
    anim: { name: "results", durationMs: 1200 },
  },
  quipout: {
    id: "quipout",
    description: "QUIP-OUT: every player and 85% of chat picked A; banner and confetti",
    build: (ctx) => resultsScenario(ctx, [4, 0], { A: 85, B: 15 }, "quipout"),
    anim: { name: "quipout", durationMs: 1600 },
  },
  jinx: {
    id: "jinx",
    description: "JINX: both writers typed the same answer; cards bonk, banner in warning",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = answering(ctx, start);
        const first = roundPrompts(drv.state)[0] as QcState["prompts"][number];
        const [a, b] = first.authors as [string, string];
        const say = (author: string, text: string) =>
          drv.act(drv.seatsOf(author)[0] as string, { type: "answer", promptId: first.id, text });
        say(a, "A very small horse");
        say(b, "a very small horse!");
        return toMatchup(drv, 0).until("results").wait(300);
      });
      return { state: d.state, fx: [{ name: "jinx" }] };
    },
    anim: { name: "jinx", durationMs: 900 },
  },
  "last-quip": {
    id: "last-quip",
    description: "Round 3 vote: 7 answers in a card fan; player spreads 3 hearts with steppers",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = toLastQuip(new ScenarioDriver({ seed: ctx.seed, players: 7, start }));
        drv.until("vote", 3);
        for (const v of drv.voters().slice(1, 4)) {
          const [x, y] = slotsFor(drv, v) as [string, string];
          drv.act(v, { type: "lastVote", alloc: { [x]: 2, [y]: 1 } }, 1_200);
        }
        return drv.wait(2_000);
      });
      return { state: d.state, viewer: { role: "player", id: "p1" } };
    },
  },
  final: {
    id: "final",
    description: "Final podium: winner celebration and highlight chips",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = toLastQuip(new ScenarioDriver({ seed: ctx.seed, players: 6, start }));
        drv.until("vote", 3);
        for (const v of drv.voters()) {
          const slots = slotsFor(drv, v);
          const pick = slots.includes("c1") ? "c1" : (slots[0] as string);
          drv.act(v, { type: "lastVote", alloc: { [pick]: 3 } }, 800);
        }
        const tallies = Object.fromEntries(
          drv.state.order.map((_, i) => [`c${i + 1}`, i === 0 ? 60 : 8]),
        );
        drv.wait(600).audience("vote-r3", tallies);
        return drv.until("final").wait(500);
      });
      return { state: d.state, fx: [{ name: "win" }] };
    },
    anim: { name: "win", durationMs: 2000 },
  },
  "review-wait": {
    id: "review-wait",
    description: "An answer awaits moderation: blurred card on stage; its text only for the host",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = new ScenarioDriver({
          seed: ctx.seed,
          players: 6,
          start,
          room: { moderation: "reveal-review" },
        }).until("answer");
        for (const a of drv.state.authors) drv.answerAll(a.id);
        const first = currentPrompt(drv.state).id;
        // Approve everything except one answer to the first matchup's prompt.
        const items = Object.entries(drv.state.modItems);
        const hold = items.find(([, item]) => item.promptId === first)?.[0];
        for (const [itemId] of items) if (itemId !== hold) drv.moderate(itemId, true);
        return drv.until("review-wait").wait(4_000);
      });
      return { state: d.state, viewer: { role: "host" } };
    },
  },
  "round-predict": {
    id: "round-predict",
    description: "Round 1 answering with the round-winner bet open; chat odds chips on the tokens",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = answering(ctx, start);
        drv.answerAll(drv.state.authors[0]?.id as string);
        return drv.wait(8_000);
      });
      const odds = [41, 22, 14, 11, 7, 5];
      const tallies = Object.fromEntries(d.state.authors.map((a, i) => [a.id, odds[i] ?? 0]));
      return {
        state: d.state,
        fx: [
          {
            name: "audience-tally",
            data: { pollId: d.state.predict?.pollId, tallies, total: 100 },
          },
        ],
      };
    },
  },
};
