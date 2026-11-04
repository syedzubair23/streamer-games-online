/**
 * Scenario entry for `@sg/game-odd-one-out/scenarios` (SPEC §14, `docs/specs/odd-one-out.md`
 * "Scenarios"): every visible state as a named scenario that `/dev/scenario` renders with no
 * network. Each builder drives the real module (setup, actions, timers, audience results) so
 * every scenario is a state the game can actually reach.
 *
 * Clock: every scenario state is "as of" {@link SCENARIO_NOW}. A builder is played once to
 * measure how long it takes, then replayed starting that long before `SCENARIO_NOW`, so
 * deadlines and quick-chat bubble ages read naturally.
 *
 * Live audience numbers (the sus meter while the bet is open) come from the platform, not the
 * state; scenarios pass them as fx: `audience-tally` `{ pollId, tallies, total }`.
 *
 * The spec's `reveal-roles` row lists two player variants; the harness renders one player
 * viewer per scenario, so `reveal-roles` shows a regular player's card and `reveal-roles-odd`
 * the odd one's. `midgame` is the DOD G8a perf reference (the clues state).
 *
 * @module
 */
import { createRng, type PlayerId, type Rng } from "@sg/shared";
import {
  createTiming,
  defaultOptions,
  type Effect,
  type ScenarioCtx,
  type ScenarioRegistry,
  type Seat,
  type Timing,
  type ViewerKey,
} from "@sg/engine";
import { fixtureContent } from "./fixtures.ts";
import {
  clueCandidates,
  createOddOneOut,
  currentGiver,
  TIMER,
  type OddOneOutModule,
  type OooAction,
  type OooOptions,
  type OooRoomSettings,
  type OooState,
} from "./logic/index.ts";

export { GAME_ID } from "./logic/index.ts";
export {
  FIXTURE_CATEGORIES,
  FIXTURE_CORE_PACK,
  FIXTURE_PAIRS,
  FIXTURE_PAIRS_PACK,
  fixtureContent,
  packContent,
} from "./fixtures.ts";

/** Scenario clock (server ms): every scenario state is as of this instant. */
export const SCENARIO_NOW = 1_000_000;

/** The seats scenarios use (up to 10). */
export const SCENARIO_SEATS: readonly Seat[] = Object.freeze(
  ["Maple", "Juniper", "Clover", "Basil", "Rowan", "Hazel", "Sage", "Wren", "Olive", "Fern"].map(
    (name, i) => ({ id: `p${i + 1}`, name, seat: i, colorSlot: i % 8 }),
  ),
);

// ---- The scenario driver -------------------------------------------------------------------------

/** Options of a {@link ScenarioDriver}. */
export interface DriverOptions {
  seed: number;
  players: number;
  /** Game ms at setup. */
  start: number;
  options?: Partial<OooOptions>;
  room?: Partial<OooRoomSettings>;
}

/** Drives a real game in scenario time (no runner, no network). */
export class ScenarioDriver {
  state: OooState;
  now: number;
  readonly module: OddOneOutModule;
  readonly rng: Rng;
  readonly timing: Timing;
  /** Pending timers (id → game ms). */
  readonly timers = new Map<string, number>();

  constructor(opts: DriverOptions) {
    this.module = createOddOneOut(opts.room ?? {});
    this.rng = createRng(opts.seed);
    this.timing = createTiming({ timerScale: 1, streamDelaySec: 3 });
    this.now = opts.start;
    const options = {
      ...(defaultOptions(this.module.optionSpecs) as unknown as OooOptions),
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

  /** Fires phase timers until `phase` is on. */
  until(phase: OooState["phase"]): this {
    for (let i = 0; i < 200; i++) {
      if (this.state.phase === phase) return this;
      this.next();
    }
    throw new Error(`scenario: never reached ${phase}`);
  }

  /** A player acts (throws when the game refuses: scenarios only take legal paths). */
  act(player: PlayerId, action: OooAction, afterMs = 1_500): this {
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

  /** Player ids in seat order. */
  get ids(): PlayerId[] {
    return this.state.players.map((p) => p.id);
  }

  /** This round's odd ones. */
  get odd(): PlayerId[] {
    return this.state.hidden.odd;
  }

  /** The first regular player in seat order. */
  get regular(): PlayerId {
    return this.ids.find((id) => !this.odd.includes(id)) as PlayerId;
  }

  /** Everyone taps "Got it" (the reveal ends early). */
  gotAll(): this {
    for (const id of this.ids)
      if (this.state.phase === "reveal") this.act(id, { type: "gotIt" }, 700);
    return this;
  }

  /** The next `count` clue turns, each giver giving the bot's first-choice clue. */
  clues(count: number, afterMs = 3_000): this {
    for (let i = 0; i < count && this.state.phase === "clues"; i++) {
      const giver = currentGiver(this.state) as PlayerId;
      const text = clueCandidates(this.state, giver)[0] as string;
      this.act(giver, { type: "clue", text }, afterMs);
    }
    return this;
  }

  /** Everyone taps "Ready to vote". */
  readyAll(): this {
    for (const id of this.ids) {
      if (this.state.phase === "discuss" && !this.state.ready.includes(id)) {
        this.act(id, { type: "ready" }, 900);
      }
    }
    return this;
  }

  /** Everyone votes for `target(voter)` (the vote ends early once all have voted). */
  voteAll(target: (voter: PlayerId) => PlayerId): this {
    const phase = this.state.phase;
    for (const id of this.ids) {
      if (this.state.phase === phase) this.act(id, { type: "vote", target: target(id) }, 800);
    }
    return this;
  }

  /** Plays deal → reveal → every clue → discussion, leaving the game in the vote. */
  toVote(): this {
    this.until("reveal").gotAll().clues(99).readyAll();
    return this;
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

/** The first seed from `seed` on whose first round satisfies `ok` (scenarios need exact seats). */
function seedWhere(seed: number, players: number, ok: (d: ScenarioDriver) => boolean): number {
  for (let s = seed; s < seed + 500; s++) {
    if (ok(new ScenarioDriver({ seed: s, players, start: 0 }).until("reveal"))) return s;
  }
  throw new Error("scenario: no seed found");
}

/** A plausible sus-meter split over the players (heaviest on `favourite`). */
function susTallies(d: ScenarioDriver, favourite: PlayerId): Record<string, number> {
  const shares = [9, 14, 6, 11, 5, 8, 4, 7, 3, 6];
  return Object.fromEntries(d.ids.map((id, i) => [id, id === favourite ? 38 : (shares[i] ?? 5)]));
}

const tallyFx = (d: ScenarioDriver, favourite: PlayerId) => {
  const tallies = susTallies(d, favourite);
  return {
    name: "audience-tally",
    data: {
      pollId: d.state.predict?.pollId,
      tallies,
      total: Object.values(tallies).reduce((a, b) => a + b, 0),
    },
  };
};

const player = (id: PlayerId): ViewerKey => ({ role: "player", id });

/** A 6-player game where the clue order puts p4 sixth (the spec's "player 4 giving a clue"). */
function cluesScenario(ctx: ScenarioCtx) {
  const seed = seedWhere(ctx.seed, 6, (d) => d.state.order[5] === "p4");
  const d = atScenarioNow((start) =>
    new ScenarioDriver({ seed, players: 6, start }).until("reveal").gotAll().clues(11).wait(4_000),
  );
  const last = d.state.clues.at(-1)?.by;
  const suspect = d.state.order.find((id) => d.odd.includes(id)) ?? "p1";
  return {
    state: d.state,
    fx: [{ name: "lantern", data: { by: last } }, tallyFx(d, suspect)],
  };
}

/** Accuses `pick(d)` in a 6-player round (everyone else votes for them; they vote for p1/p2). */
function accused(ctx: ScenarioCtx, start: number, pick: (d: ScenarioDriver) => PlayerId) {
  const d = new ScenarioDriver({ seed: ctx.seed, players: 6, start }).toVote();
  const target = pick(d);
  const other = d.ids.find((id) => id !== target) as PlayerId;
  return d.voteAll((voter) => (voter === target ? other : target));
}

/** The Odd One Out scenario registry (spec "Scenarios", plus `reveal-roles-odd` and `midgame`). */
export const scenarios: ScenarioRegistry<OooState> = {
  "reveal-roles": {
    id: "reveal-roles",
    description: "Role reveal: plushes around the lantern, 'Check your phone'; a regular's card",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = new ScenarioDriver({ seed: ctx.seed, players: 6, start }).until("reveal");
        return drv.act("p2", { type: "gotIt" }, 1_200).act("p5", { type: "gotIt" }, 900);
      });
      return { state: d.state, viewer: player(d.regular) };
    },
  },
  "reveal-roles-odd": {
    id: "reveal-roles-odd",
    description: "Role reveal as the odd one: 'You are the Odd One 🎭' on the phone",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = new ScenarioDriver({ seed: ctx.seed, players: 6, start }).until("reveal");
        return drv.act("p2", { type: "gotIt" }, 1_200).act("p5", { type: "gotIt" }, 900);
      });
      return { state: d.state, viewer: player(d.odd[0] as PlayerId) };
    },
  },
  clues: {
    id: "clues",
    description: "Pass 2: 11 lanterns placed, player 4 giving a clue, sus clouds over the plushes",
    build: (ctx) => cluesScenario(ctx),
    anim: { name: "lantern", durationMs: 1200 },
  },
  midgame: {
    id: "midgame",
    description: "Perf reference (DOD G8a): the clues state with 11 lanterns and the sus meter",
    build: (ctx) => cluesScenario(ctx),
    anim: { name: "lantern", durationMs: 1200 },
  },
  discuss: {
    id: "discuss",
    description: "Discussion: 3 of 6 ready, chat odds, 4 paw-points and 2 quick-chat bubbles",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = new ScenarioDriver({ seed: ctx.seed, players: 6, start })
          .until("reveal")
          .gotAll()
          .clues(99)
          .wait(6_000);
        const [a, b, c, e, f] = drv.ids as [PlayerId, PlayerId, PlayerId, PlayerId, PlayerId];
        const odd = drv.odd[0] as PlayerId;
        const suspect = odd === a ? b : a;
        drv.act(c, { type: "point", target: odd }, 1_100);
        drv.act(e, { type: "point", target: odd === e ? c : odd }, 900);
        drv.act(odd, { type: "point", target: suspect }, 1_300);
        drv.act(f, { type: "point", target: suspect === f ? c : suspect }, 1_000);
        for (const id of drv.ids.filter((x) => x !== odd).slice(0, 3)) {
          drv.act(id, { type: "ready" }, 1_200);
        }
        drv.act(odd, { type: "quick", line: 6 }, 1_000);
        drv.act(c === odd ? e : c, { type: "quick", line: 0 }, 1_300);
        return drv.wait(700);
      });
      const odd = d.odd[0] as PlayerId;
      const viewer = player(
        d.ids.find((id) => id !== odd && !d.state.ready.includes(id)) ?? d.regular,
      );
      return {
        state: d.state,
        viewer,
        fx: [tallyFx(d, odd), { name: "bubble", data: { by: d.state.chat.at(-1)?.by } }],
      };
    },
    anim: { name: "bubble", durationMs: 600 },
  },
  "vote-reveal": {
    id: "vote-reveal",
    description: "Votes revealed: strings from every voter to the accused, who hops to the centre",
    build: (ctx) => {
      const d = atScenarioNow((start) =>
        accused(ctx, start, (drv) => drv.odd[0] as PlayerId).wait(600),
      );
      return { state: d.state, fx: [{ name: "strings", data: { accused: d.state.accused } }] };
    },
    anim: { name: "strings", durationMs: 2000 },
  },
  "last-guess": {
    id: "last-guess",
    description: "The caught odd one picks the secret from the category's 12 options",
    build: (ctx) => {
      const d = atScenarioNow((start) =>
        accused(ctx, start, (drv) => drv.odd[0] as PlayerId)
          .until("last-guess")
          .wait(5_000),
      );
      return { state: d.state, viewer: player(d.state.accused as PlayerId) };
    },
  },
  "odd-caught": {
    id: "odd-caught",
    description: "Wrong last guess: mask on, the regular players cheer, the result card",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = accused(ctx, start, (x) => x.odd[0] as PlayerId).until("last-guess");
        const secret = drv.state.hidden.secret;
        const wrong = drv.state.category?.options.find((o) => o !== secret) as string;
        return drv
          .act(drv.state.accused as PlayerId, { type: "guess", option: wrong }, 6_000)
          .wait(400);
      });
      return { state: d.state, fx: [{ name: "mask" }, { name: "cheer" }] };
    },
    anim: { name: "mask", durationMs: 1500 },
  },
  "odd-wins": {
    id: "odd-wins",
    description:
      "An innocent player is accused: the 'Wrong!' reveal and confetti in the odd colour",
    build: (ctx) => {
      const d = atScenarioNow((start) =>
        accused(ctx, start, (x) => x.ids.find((id) => !x.odd.includes(id)) as PlayerId)
          .until("round-result")
          .wait(400),
      );
      const odd = d.state.roundResult?.odd[0];
      const colorSlot = d.state.players.find((p) => p.id === odd)?.colorSlot;
      return {
        state: d.state,
        fx: [{ name: "wrong" }, { name: "mask" }, { name: "confetti", data: { colorSlot } }],
      };
    },
    anim: { name: "mask", durationMs: 1500 },
  },
  final: {
    id: "final",
    description: "Match podium with the Master of Disguise highlight",
    build: (ctx) => {
      const d = atScenarioNow((start) => {
        const drv = new ScenarioDriver({ seed: ctx.seed, players: 6, start });
        for (let r = 0; r < 3; r++) {
          drv.toVote();
          const odd = drv.odd[0] as PlayerId;
          // Rounds 1 and 3: an innocent is accused (odd wins); round 2: the odd one is caught.
          const target = r === 1 ? odd : (drv.ids.find((id) => id !== odd) as PlayerId);
          const other = drv.ids.find((id) => id !== target) as PlayerId;
          drv.voteAll((v) => (v === target ? other : target));
          if (r === 1) {
            drv.until("last-guess");
            const wrong = drv.state.category?.options.find((o) => o !== drv.state.hidden.secret);
            drv.act(odd, { type: "guess", option: wrong as string }, 5_000);
          }
          drv.until("round-result");
          drv.next();
        }
        return drv.until("final").wait(500);
      });
      return { state: d.state, fx: [{ name: "win" }] };
    },
    anim: { name: "win", durationMs: 2000 },
  },
};
