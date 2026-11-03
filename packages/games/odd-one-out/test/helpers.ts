/**
 * Test helpers for Odd One Out: a thin driver over a real `GameRunner` with a virtual clock,
 * plus scripted round helpers (everyone taps, every clue, every vote).
 */
import { GameRunner, type Effect, type RunnerResult, type Seat, type ViewerKey } from "@sg/engine";
import { fakeContent, makeSeats } from "@sg/engine/testing";
import type { AnyPack, PlayerId } from "@sg/shared";
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
  type OooView,
} from "../src/logic/index.ts";
import { FIXTURE_CORE_PACK, FIXTURE_PAIRS_PACK } from "../src/scenarios.ts";

export const T0 = 1_000_000;

/** The fixture content packs as a fresh content access. */
export const content = (packs: readonly AnyPack[] = [FIXTURE_CORE_PACK, FIXTURE_PAIRS_PACK]) =>
  fakeContent(packs);

/** Options of {@link Game}. */
export interface GameOpts {
  players?: number | Seat[];
  seed?: number;
  options?: Partial<OooOptions>;
  room?: Partial<OooRoomSettings>;
  timerScale?: 0 | 0.75 | 1 | 1.5 | 2;
  streamDelaySec?: number;
  packs?: readonly AnyPack[];
  used?: { categories?: string[]; pairs?: string[] };
}

/** A game on a real runner with a virtual clock. */
export class Game {
  readonly runner: GameRunner<OooState, OooAction, OooOptions, OooView>;
  readonly module: OddOneOutModule;
  now = T0;
  readonly effects: Effect[] = [];

  constructor(opts: GameOpts = {}) {
    this.module = createOddOneOut(opts.room ?? {});
    const c = fakeContent(opts.packs ?? [FIXTURE_CORE_PACK, FIXTURE_PAIRS_PACK], {
      used: {
        "ooo-categories": opts.used?.categories ?? [],
        "ooo-pairs": opts.used?.pairs ?? [],
      },
    });
    const players = opts.players ?? 5;
    this.runner = new GameRunner(this.module, {
      players: typeof players === "number" ? makeSeats(players) : players,
      seed: opts.seed ?? 1,
      now: T0,
      ...(opts.options !== undefined ? { options: opts.options } : {}),
      timerScale: opts.timerScale ?? 1,
      streamDelaySec: opts.streamDelaySec ?? 3,
      content: c,
      audienceCount: 100,
      botDelayMs: 0,
    });
    this.effects.push(...this.runner.setupEffects);
  }

  get s(): OooState {
    return this.runner.state;
  }

  #record(r: RunnerResult): RunnerResult {
    this.effects.push(...r.effects);
    return r;
  }

  /** Effects emitted since index `from`. */
  since(from: number): Effect[] {
    return this.effects.slice(from);
  }

  /** Lets `ms` pass, firing whatever falls due. */
  wait(ms: number): RunnerResult {
    this.now += ms;
    return this.#record(this.runner.advance(this.now));
  }

  /** Jumps to the next runner event and fires it. */
  step(): RunnerResult {
    const at = this.runner.nextEventAt();
    if (at === null) throw new Error(`nothing scheduled in ${this.s.phase}`);
    this.now = Math.max(this.now, at);
    return this.#record(this.runner.advance(this.now));
  }

  /** The due time of the phase timer. */
  timerAt(id: string = TIMER.phase): number | undefined {
    return this.runner.timers().find((t) => t.id === id)?.atMs;
  }

  /** Fires runner events until `phase` (and optionally round) is on. */
  until(phase: OooState["phase"], round?: number): this {
    for (let i = 0; i < 500; i++) {
      if (this.s.phase === phase && (round === undefined || this.s.round === round)) return this;
      if (this.runner.ended) break;
      this.step();
    }
    throw new Error(`never reached ${phase} (at ${this.s.phase} r${this.s.round})`);
  }

  act(player: PlayerId, action: unknown): RunnerResult {
    return this.#record(this.runner.act(player, action, this.now));
  }

  /** Acts and expects success. */
  ok(player: PlayerId, action: OooAction): this {
    const r = this.act(player, action);
    if (!r.ok) throw new Error(`${player} ${JSON.stringify(action)} refused: ${r.err}`);
    return this;
  }

  /** Acts and expects a refusal. */
  no(player: PlayerId, action: unknown): this {
    const before = JSON.stringify(this.s);
    const r = this.act(player, action);
    if (r.ok) throw new Error(`${player} ${JSON.stringify(action)} was accepted`);
    if (JSON.stringify(this.s) !== before) throw new Error("a refused action changed the state");
    return this;
  }

  host(): RunnerResult {
    return this.#record(this.runner.hostCommand({ c: "forceAdvance" }, this.now));
  }

  audience(pollId: string, tallies: Record<string, number>): RunnerResult {
    const total = Object.values(tallies).reduce((a, b) => a + b, 0);
    return this.#record(
      this.runner.audienceResult({ pollId, kind: "predict", total, tallies }, this.now),
    );
  }

  leave(p: PlayerId): RunnerResult {
    return this.#record(this.runner.playerLeave(p, this.now));
  }

  rejoin(p: PlayerId): RunnerResult {
    return this.#record(this.runner.playerRejoin(p, this.now));
  }

  view(viewer: ViewerKey): OooView {
    return this.runner.view(viewer);
  }

  /** Player ids in seat order. */
  get ids(): PlayerId[] {
    return this.s.players.map((p) => p.id);
  }

  get odd(): PlayerId[] {
    return this.s.hidden.odd;
  }

  get regulars(): PlayerId[] {
    return this.ids.filter((id) => !this.odd.includes(id));
  }

  get secret(): string {
    return this.s.hidden.secret;
  }

  /** Everyone taps "Got it" (from the deal on). */
  gotAll(): this {
    this.until("reveal");
    for (const id of this.ids) if (this.s.phase === "reveal") this.ok(id, { type: "gotIt" });
    return this;
  }

  /** `count` clue turns; `text(giver)` defaults to the bot's first choice. */
  clues(count = 999, text?: (giver: PlayerId) => string): this {
    for (let i = 0; i < count && this.s.phase === "clues"; i++) {
      const giver = currentGiver(this.s) as PlayerId;
      this.now += 1_000;
      this.ok(giver, {
        type: "clue",
        text: text?.(giver) ?? (clueCandidates(this.s, giver)[0] as string),
      });
    }
    return this;
  }

  /** Everyone connected taps "Ready to vote". */
  readyAll(): this {
    for (const id of this.ids) {
      if (this.s.phase === "discuss" && !this.s.ready.includes(id) && !this.s.away.includes(id)) {
        this.ok(id, { type: "ready" });
      }
    }
    return this;
  }

  /** Deal → reveal → clues → discussion → the vote. */
  toVote(): this {
    this.gotAll().clues().readyAll();
    if (this.s.phase !== "vote") throw new Error(`expected vote, at ${this.s.phase}`);
    return this;
  }

  /** Everyone connected votes for `target(voter)` (skipped when it returns null). */
  voteAll(target: (voter: PlayerId) => PlayerId | null): this {
    const phase = this.s.phase;
    for (const id of this.ids) {
      if (this.s.phase !== phase || this.s.away.includes(id)) continue;
      const t = target(id);
      if (t !== null) this.ok(id, { type: "vote", target: t });
    }
    return this;
  }

  /** Everyone votes for `accused` (who votes for someone else). */
  accuse(accused: PlayerId): this {
    const other = this.ids.find((id) => id !== accused) as PlayerId;
    return this.voteAll((v) => (v === accused ? other : accused));
  }
}

/** Some player other than `ids`. */
export const otherThan = (all: readonly PlayerId[], ...ids: PlayerId[]): PlayerId =>
  all.find((id) => !ids.includes(id)) as PlayerId;
