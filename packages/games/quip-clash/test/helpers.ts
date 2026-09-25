/**
 * Test helpers for Quip Clash: a thin driver over a real `GameRunner` with a virtual clock.
 */
import { GameRunner, type Effect, type RunnerResult, type Seat, type ViewerKey } from "@sg/engine";
import { fakeContent, makeSeats } from "@sg/engine/testing";
import type { AnyPack, PlayerId } from "@sg/shared";
import {
  createQuipClash,
  roundPrompts,
  TIMER,
  type AuthorId,
  type QcAction,
  type QcOptions,
  type QcRoomSettings,
  type QcState,
  type QcView,
  type QuipClashModule,
} from "../src/logic/index.ts";
import { FIXTURE_CORE_PACK, FIXTURE_SPICY_PACK } from "../src/scenarios.ts";

export const T0 = 1_000_000;

/** The fixture content packs as a fresh content access. */
export const content = (packs: readonly AnyPack[] = [FIXTURE_CORE_PACK, FIXTURE_SPICY_PACK]) =>
  fakeContent(packs);

/** Options of {@link Game}. */
export interface GameOpts {
  players?: number | Seat[];
  seed?: number;
  options?: Partial<QcOptions>;
  room?: Partial<QcRoomSettings>;
  teams?: { id: string; name: string; colorSlot: number }[];
  timerScale?: 0 | 0.75 | 1 | 1.5 | 2;
  streamDelaySec?: number;
  packs?: readonly AnyPack[];
  used?: string[];
}

/** Seats dealt round-robin into `teamIds`. */
export function teamSeats(count: number, teamIds: readonly string[]): Seat[] {
  return makeSeats(count, { teams: teamIds });
}

/** Room teams for ids `t1..tN`. */
export function roomTeams(n: number): { id: string; name: string; colorSlot: number }[] {
  return ["Tomato", "Sky", "Sunflower", "Mint"]
    .slice(0, n)
    .map((name, i) => ({ id: `t${i + 1}`, name, colorSlot: i }));
}

/** A game on a real runner with a virtual clock. */
export class Game {
  readonly runner: GameRunner<QcState, QcAction, QcOptions, QcView>;
  readonly module: QuipClashModule;
  now = T0;
  readonly effects: Effect[] = [];

  constructor(opts: GameOpts = {}) {
    this.module = createQuipClash(opts.room ?? {});
    const c = fakeContent(opts.packs ?? [FIXTURE_CORE_PACK, FIXTURE_SPICY_PACK], {
      used: { "quip-prompts": opts.used ?? [] },
    });
    const players = opts.players ?? 3;
    this.runner = new GameRunner(this.module, {
      players: typeof players === "number" ? makeSeats(players) : players,
      ...(opts.teams !== undefined ? { teams: opts.teams } : {}),
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

  get s(): QcState {
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

  /** The due time of a pending timer. */
  timerAt(id: string = TIMER.phase): number | undefined {
    return this.runner.timers().find((t) => t.id === id)?.atMs;
  }

  /** Fires runner events until `phase` (and round) is on. */
  until(phase: QcState["phase"], round?: QcState["round"]): this {
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
  ok(player: PlayerId, action: QcAction): this {
    const r = this.act(player, action);
    if (!r.ok) throw new Error(`${player} ${JSON.stringify(action)} refused: ${r.err}`);
    return this;
  }

  host(): RunnerResult {
    return this.#record(this.runner.hostCommand({ c: "forceAdvance" }, this.now));
  }

  audience(pollId: string, tallies: Record<string, number>, total?: number): RunnerResult {
    const sum = total ?? Object.values(tallies).reduce((a, b) => a + b, 0);
    return this.#record(
      this.runner.audienceResult(
        { pollId, kind: pollId.startsWith("predict") ? "predict" : "vote", total: sum, tallies },
        this.now,
      ),
    );
  }

  moderate(itemId: string, approved: boolean): RunnerResult {
    return this.#record(this.runner.moderation(itemId, approved, this.now));
  }

  leave(p: PlayerId): RunnerResult {
    return this.#record(this.runner.playerLeave(p, this.now));
  }

  rejoin(p: PlayerId): RunnerResult {
    return this.#record(this.runner.playerRejoin(p, this.now));
  }

  view(viewer: ViewerKey): QcView {
    return this.runner.view(viewer);
  }

  /** The first member of an author. */
  seat(author: AuthorId): PlayerId {
    return this.s.authors.find((a) => a.id === author)?.members[0] as PlayerId;
  }

  /** Every author answers every open prompt with `text(promptId, author)`. */
  answerAll(text: (promptId: string, author: AuthorId) => string | null = defaultText): this {
    for (const p of roundPrompts(this.s)) {
      for (const a of p.authors) {
        if (this.s.phase !== "answer") return this;
        if (this.s.hidden.answers[p.id]?.[a] !== undefined) continue;
        const t = text(p.id, a);
        if (t !== null) this.ok(this.seat(a), { type: "answer", promptId: p.id, text: t });
      }
    }
    return this;
  }

  /** Eligible voters of the current vote, in seat order. */
  voters(): PlayerId[] {
    return this.s.players
      .filter((p) => this.module.legalActions(this.s, p.id).length > 0)
      .map((p) => p.id);
  }
}

/** A distinct default answer per prompt and author. */
export const defaultText = (promptId: string, author: AuthorId): string =>
  `${author} writes on ${promptId}`.slice(0, 45);
