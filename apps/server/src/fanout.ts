/**
 * View fan-out (SPEC §9.5, §9.6): turns the running game's views into as few frames as
 * possible and puts each frame on exactly the sockets allowed to see it.
 *
 * - **One buffer per viewer key per flush.** Every socket maps to one `ViewerKey` (see
 *   {@link ViewRouting}); all sockets on the same key share one pre-serialized frame. The
 *   shared audience view goes out once on `r:CODE:aud` and the stage view once on
 *   `r:CODE:stage` (uWS topics, native fan-out); player, host-panel, moderator and
 *   restricted-audience views are direct sends.
 * - **Patches with a seq.** Each viewer key is a stream with its own `seq`. A flush sends a
 *   `patch` against the last frame of that stream, or the full `view` when the encoded patch
 *   is larger than 60 % of the full view (`viewUpdate` in `@sg/shared`). A new socket or a
 *   `resync` gets the stream's last frame as a full view at the stream's current seq, so the
 *   next patch applies to it exactly.
 * - **Coalescing.** The actor marks the fan-out dirty after every runner step and calls
 *   {@link Fanout.flush} once per event-loop turn, so several steps in one turn produce one
 *   message per key; the runner's per-step memo means `view()` runs once per key.
 * - **The Stage window only ever receives the `stage` view.** The host's Stage socket is on
 *   the stage key; the `host` view goes only to the host-panel pop-out, and moderation
 *   traffic only to the panel and moderators.
 * - Cosmetic `fx` events are batched per turn into one message per destination and skipped
 *   for direct sockets whose tab is hidden (`bg`); `private` effects go to one player; binary
 *   `stream` / `streamEach` frames (Marble Rally) are published as-is.
 *
 * @module
 */
import { encodeMessage, viewUpdate, type GameId, type S2C } from "@sg/shared";
import { viewerKeyId, type ViewerKey } from "@sg/engine";
import type { ManagedRoom } from "./room-manager.ts";
import type { Session, Surface } from "./session.ts";
import type { Conn } from "./transport/types.ts";

/** Something that produces memoised views (a `GameRunner`). */
export interface ViewSource {
  view(viewer: ViewerKey): unknown;
}

/** Decides which view a socket receives. Implemented by the room actor. */
export interface ViewRouting {
  /** The viewer key for one socket of `session` on `surface`, or `null` for no views. */
  keyFor(session: Session, surface: Surface): ViewerKey | null;
}

/** Sends frames. Implemented by the room manager. */
export interface FanoutIO {
  /** One frame to one socket. */
  send(conn: Conn, data: string | Uint8Array): void;
  /** One frame to every subscriber of a topic. */
  publish(topic: string, data: string | Uint8Array): void;
}

/** A per-viewer-key stream: the last frame's view and its seq. */
interface Stream {
  seq: number;
  last: unknown;
  viewer: ViewerKey;
}

/** Counters for tests and perf checks. */
export interface FanoutStats {
  /** Flushes that sent at least one frame. */
  flushes: number;
  /** View frames written (one per key per flush; a topic publish counts once). */
  frames: number;
  /** Full views sent by flushes (not joins/resyncs). */
  fullViews: number;
  /** Patches sent. */
  patches: number;
}

const SHARED_TOPIC_KEYS: ReadonlySet<string> = new Set(["audience", "stage"]);

/**
 * One room's fan-out. The actor owns it; it holds no timers of its own.
 */
export class Fanout {
  readonly #room: ManagedRoom;
  readonly #io: FanoutIO;
  readonly #routing: ViewRouting;
  readonly #streams = new Map<string, Stream>();
  #game: GameId | null = null;
  #source: ViewSource | null = null;
  #fx: { name: string; data?: unknown }[] = [];
  readonly stats: FanoutStats = { flushes: 0, frames: 0, fullViews: 0, patches: 0 };

  constructor(room: ManagedRoom, io: FanoutIO, routing: ViewRouting) {
    this.#room = room;
    this.#io = io;
    this.#routing = routing;
  }

  /** The game whose views are fanned out, or `null` between games. */
  get game(): GameId | null {
    return this.#game;
  }

  /**
   * Switches the view source. A new game makes every stream start over with a full view
   * (seqs keep counting up, so a client never sees a seq go backwards).
   */
  setSource(game: GameId | null, source: ViewSource | null): void {
    if (game !== this.#game || source !== this.#source)
      for (const s of this.#streams.values()) s.last = null;
    this.#game = game;
    this.#source = source;
  }

  /** The current seq of a viewer key's stream (0 before its first frame). */
  seqOf(viewer: ViewerKey): number {
    return this.#streams.get(viewerKeyId(viewer))?.seq ?? 0;
  }

  // -------------------------------------------------------------------------------------------
  // Routing and topics
  // -------------------------------------------------------------------------------------------

  /**
   * Makes a session's sockets subscribe to exactly the topics of their viewer key: the
   * shared audience key listens on `r:CODE:aud`, the stage key on `r:CODE:stage`, and
   * every other key on neither (restricted audience and players get direct sends).
   */
  syncTopics(session: Session): void {
    const { aud, stage } = this.#room.topics;
    for (const [surface, conn] of session.conns) {
      const key = this.#routing.keyFor(session, surface);
      const id = key === null ? null : viewerKeyId(key);
      if (id === "audience") conn.subscribe(aud);
      else conn.unsubscribe(aud);
      if (id === "stage") conn.subscribe(stage);
      else conn.unsubscribe(stage);
    }
  }

  /** Re-syncs the topics of every session (after participants or restrictions change). */
  syncAllTopics(): void {
    for (const s of this.#room.byId.values()) if (s.connected) this.syncTopics(s);
  }

  /**
   * Sends one socket the full view of its key (a join, reconnect or `resync`): the stream's
   * last frame at the stream's seq, so the next patch applies to it. With no frame yet, the
   * current view becomes the stream's baseline.
   */
  sendFull(session: Session, surface: Surface, conn: Conn): void {
    if (this.#game === null || this.#source === null) return;
    const key = this.#routing.keyFor(session, surface);
    if (key === null) return;
    const stream = this.#stream(key);
    if (stream.last === null) stream.last = this.#source.view(key);
    this.#io.send(
      conn,
      encodeMessage({ t: "view", seq: stream.seq, game: this.#game, full: stream.last }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------------------------

  /**
   * Sends every changed view (one frame per viewer key) and the batched fx. Called once per
   * event-loop turn by the actor.
   */
  flush(): void {
    let sent = 0;
    if (this.#game !== null && this.#source !== null)
      sent = this.#flushViews(this.#game, this.#source);
    if (this.#fx.length > 0) {
      const events = this.#fx;
      this.#fx = [];
      this.broadcast({ t: "fx", events }, { cosmetic: true });
    }
    if (sent > 0) this.stats.flushes++;
  }

  #flushViews(game: GameId, source: ViewSource): number {
    // Group direct sockets by viewer key; shared keys only need to know someone listens.
    const direct = new Map<string, { viewer: ViewerKey; conns: Conn[] }>();
    const shared = new Map<string, ViewerKey>();
    for (const s of this.#room.byId.values()) {
      for (const [surface, conn] of s.conns) {
        const key = this.#routing.keyFor(s, surface);
        if (key === null) continue;
        const id = viewerKeyId(key);
        if (SHARED_TOPIC_KEYS.has(id)) {
          shared.set(id, key);
          continue;
        }
        let group = direct.get(id);
        if (group === undefined) {
          group = { viewer: key, conns: [] };
          direct.set(id, group);
        }
        group.conns.push(conn);
      }
    }
    let sent = 0;
    const { aud, stage } = this.#room.topics;
    for (const [id, viewer] of shared) {
      const text = this.#next(game, source, viewer);
      if (text === null) continue;
      this.#io.publish(id === "audience" ? aud : stage, text);
      sent++;
    }
    for (const { viewer, conns } of direct.values()) {
      const text = this.#next(game, source, viewer);
      if (text === null) continue;
      for (const conn of conns) this.#io.send(conn, text);
      sent++;
    }
    this.stats.frames += sent;
    return sent;
  }

  /** The next frame of one stream, or `null` when its view did not change. */
  #next(game: GameId, source: ViewSource, viewer: ViewerKey): string | null {
    const stream = this.#stream(viewer);
    const view = source.view(viewer);
    if (view === stream.last) return null;
    const update = viewUpdate(stream.seq + 1, game, stream.last, view);
    if (update === null) {
      stream.last = view;
      return null;
    }
    stream.seq++;
    stream.last = view;
    if (update.message.t === "view") this.stats.fullViews++;
    else this.stats.patches++;
    return update.text;
  }

  #stream(viewer: ViewerKey): Stream {
    const id = viewerKeyId(viewer);
    let s = this.#streams.get(id);
    if (s === undefined) {
      s = { seq: 0, last: null, viewer };
      this.#streams.set(id, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------------------------
  // Events and side channels
  // -------------------------------------------------------------------------------------------

  /** Queues cosmetic fx for the end of this turn (one `fx` message per destination). */
  queueFx(events: readonly { name: string; data?: unknown }[]): void {
    for (const e of events) this.#fx.push(e.data === undefined ? { name: e.name } : e);
  }

  /**
   * Sends one message to everyone in the game: the stage topic (Stage + overlays), the
   * audience topic, and every direct socket (players, host panel, moderators, restricted
   * audience). With `cosmetic`, direct sockets whose tab is hidden are skipped.
   */
  broadcast(msg: S2C, o: { cosmetic?: boolean } = {}): void {
    const text = encodeMessage(msg);
    const { aud, stage } = this.#room.topics;
    this.#io.publish(stage, text);
    this.#io.publish(aud, text);
    this.#eachDirect((s) => !(o.cosmetic === true && s.background), text);
  }

  /**
   * Sends one message to every audience member (the `r:CODE:aud` topic plus restricted
   * audience sockets) and, with `stage`, to the stage topic too. Used for polls and tallies.
   */
  toAudience(msg: S2C, o: { stage?: boolean } = {}): void {
    const text = encodeMessage(msg);
    const { aud, stage } = this.#room.topics;
    this.#io.publish(aud, text);
    if (o.stage === true) this.#io.publish(stage, text);
    this.#eachDirect((s, surface) => {
      const key = this.#routing.keyFor(s, surface);
      return key !== null && key.role === "audience" && key.restricted === true;
    }, text);
  }

  /**
   * Sends one message only to the host-panel pop-out and moderator devices (moderation
   * queue). Never to the Stage window.
   */
  toModerators(msg: S2C): void {
    const text = encodeMessage(msg);
    for (const s of this.#room.byId.values()) {
      if (s.role === "host") {
        const panel = s.conns.get("panel");
        if (panel !== undefined) this.#io.send(panel, text);
      } else if (s.role === "moderator") {
        for (const conn of s.conns.values()) this.#io.send(conn, text);
      }
    }
  }

  /** A one-off private cue to one member's sockets (`private` effect). */
  toMember(id: string, msg: S2C): void {
    const s = this.#room.byId.get(id);
    if (s === undefined) return;
    const text = encodeMessage(msg);
    for (const [surface, conn] of s.conns) if (surface !== "stage") this.#io.send(conn, text);
  }

  /** A binary frame published as-is on the stage or audience topic (`stream` effect). */
  stream(channel: "stage" | "aud", frame: Uint8Array): void {
    this.#io.publish(channel === "stage" ? this.#room.topics.stage : this.#room.topics.aud, frame);
  }

  /** Tiny per-socket binary frames resolved by `AudId`/`PlayerId` (`streamEach` effect). */
  streamEach(frames: readonly { to: string; frame: Uint8Array }[]): void {
    for (const { to, frame } of frames) {
      const s = this.#room.byId.get(to);
      if (s === undefined) continue;
      for (const [surface, conn] of s.conns)
        if (surface === "controller") this.#io.send(conn, frame);
    }
  }

  #eachDirect(pred: (s: Session, surface: Surface) => boolean, text: string): void {
    for (const s of this.#room.byId.values()) {
      for (const [surface, conn] of s.conns) {
        const key = this.#routing.keyFor(s, surface);
        const id = key === null ? null : viewerKeyId(key);
        if (id === null || SHARED_TOPIC_KEYS.has(id)) continue;
        if (pred(s, surface)) this.#io.send(conn, text);
      }
    }
  }
}
