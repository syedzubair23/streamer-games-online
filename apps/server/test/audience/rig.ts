/**
 * A minimal rig for AudienceAggregator unit tests: a fake clock, a recording fan-out, a room
 * with a config and audience sessions, and the result callbacks. Every outgoing message is
 * serialized exactly as the wire would carry it, so tests can grep the frames.
 */
import { DEFAULT_ROOM_CONFIG, encodeMessage, type RoomConfig, type S2C } from "@sg/shared";
import type { PollResult, PollSpec } from "@sg/engine";
import {
  AudienceAggregator,
  type AggregatorOptions,
  type AudienceContext,
  type Fanout,
  type ManagedRoom,
  type PollSource,
  type Session,
} from "../../src/index.ts";
import { FakeClock } from "../fake-clock.ts";

/** One recorded send. `to` is `aud` (audience + stage topics), `all` (broadcast) or a member id. */
export interface Sent {
  to: string;
  msg: S2C;
  /** The serialized frame. */
  wire: string;
  /** Server ms it was sent. */
  at: number;
}

/** A fake audience session. */
export interface FakeSession {
  id: string;
  name: string;
  teamId: string | undefined;
  role: "audience";
  connected: boolean;
}

export class Rig {
  readonly clock = new FakeClock();
  readonly sent: Sent[] = [];
  readonly results: { result: PollResult; source: PollSource }[] = [];
  readonly enrolled: { audId: string; name: string; skin: number }[][] = [];
  readonly actions: { audId: string; action: unknown }[] = [];
  readonly config: RoomConfig;
  readonly byId = new Map<string, FakeSession>();
  readonly agg: AudienceAggregator;

  constructor(config: Partial<RoomConfig> = {}, o: AggregatorOptions = {}) {
    this.config = { ...structuredClone(DEFAULT_ROOM_CONFIG), ...config };
    const record =
      (to: string) =>
      (msg: S2C): void => {
        this.sent.push({ to, msg, wire: encodeMessage(msg), at: this.clock.now() });
      };
    const fanout = {
      toAudience: record("aud"),
      broadcast: record("all"),
      toMember: (id: string, msg: S2C) => record(id)(msg),
    } as unknown as Fanout;
    const room = { config: this.config, byId: this.byId } as unknown as ManagedRoom;
    const ctx: AudienceContext = {
      room,
      fanout,
      clock: this.clock,
      onResult: (result, source) => this.results.push({ result, source }),
      onEnroll: (entrants) => this.enrolled.push(entrants),
      onAction: (audId, action) => this.actions.push({ audId, action }),
    };
    this.agg = new AudienceAggregator(ctx, o);
  }

  /** Adds `n` audience members `a1..an` (optionally on teams, round robin). */
  members(n: number, teams: string[] = []): Session[] {
    const out: Session[] = [];
    for (let i = 0; i < n; i++) {
      const id = `a${this.byId.size + 1}`;
      const s: FakeSession = {
        id,
        name: `Viewer ${id}`,
        teamId: teams.length > 0 ? teams[i % teams.length] : undefined,
        role: "audience",
        connected: true,
      };
      this.byId.set(id, s);
      out.push(s as unknown as Session);
    }
    return out;
  }

  open(
    spec: Partial<PollSpec> & Pick<PollSpec, "pollId" | "kind">,
    source: PollSource = "game",
  ): void {
    this.agg.open(
      {
        prompt: "Prompt?",
        closesAtMs: this.clock.now() + 20_000,
        ...(spec.kind === "vote" || spec.kind === "predict" || spec.kind === "quiz"
          ? {
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
                { id: "c", label: "C" },
              ],
            }
          : {}),
        ...spec,
      },
      source,
    );
  }

  vote(s: Session, pollId: string, choice: string | number): void {
    this.agg.input(s, { t: "aud", pollId, choice });
  }

  /** Messages of a type, in order. */
  of<T extends S2C["t"]>(t: T, to?: string): Extract<S2C, { t: T }>[] {
    return this.sent
      .filter((x) => x.msg.t === t && (to === undefined || x.to === to))
      .map((x) => x.msg as Extract<S2C, { t: T }>);
  }

  /** Send times of messages of a type. */
  times(t: S2C["t"]): number[] {
    return this.sent.filter((x) => x.msg.t === t).map((x) => x.at);
  }

  /** Every serialized frame, joined. */
  wire(): string {
    return this.sent.map((x) => x.wire).join("\n");
  }

  /** The last aggregate result the game received. */
  lastResult(): (PollResult & { counted?: boolean }) | undefined {
    return this.results.at(-1)?.result;
  }
}
