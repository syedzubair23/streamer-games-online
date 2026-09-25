/**
 * The room manager (SPEC §3, §9.5, §9.7): owns every room on this server and everything about
 * membership. It is the {@link TransportHandlers} implementation, so every socket event lands
 * here first.
 *
 * Per socket: per-IP connection cap, `hello` timeout, per-socket message rate
 * ({@link TokenBucket}), protocol validation ({@link parseC2S}) and the role gate ({@link gate}).
 *
 * Per room: codes and epochs, the host session, seats (lowest free seat, colour slot =
 * seat % 8), the audience and its next-round queue, passwords, the overlay key, reconnect grace,
 * `room` snapshot broadcasts (coalesced per event-loop turn; audience-count-only changes are
 * throttled to 2 Hz so 10,000 viewers joining do not cause 10,000 broadcasts), persistence to
 * the {@link Store}, and cleanup 10 minutes after the room empties.
 *
 * Game play is not handled here. Each room has a {@link RoomDriver}; the room actor (M1-02,
 * `room.ts`) runs the playlist through `GameRunner`, and the audience aggregator (M1-03) and
 * moderation (M1-04) hang off it. `createServer` installs the room actor; a bare manager
 * falls back to the lobby driver, which answers game traffic truthfully: no game is running,
 * so actions are illegal and polls do not exist. The actor changes membership through
 * {@link RoomManager.setMember} and {@link RoomManager.removeMember}.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import {
  cleanName,
  decodeMessage,
  encodeMessage,
  filterText,
  normalizeRoomCode,
  PROTOCOL_VERSION,
  type ErrorCode,
  type HostCommand,
  type Me,
  type MemberInfo,
  type PublicRoomConfig,
  type RoomConfig,
  type RoomPhase,
  type RoomSnapshot,
  type S2C,
} from "@sg/shared";
import { CodeRegistry, type RandomIndex } from "./codes.ts";
import {
  applyRoomConfigPatch,
  initialRoomConfig,
  parseRoomConfigPatch,
  systemClock,
  type Clock,
  type ServerConfig,
  type TimerHandle,
} from "./config.ts";
import {
  gate,
  hashIp,
  newOverlayKey,
  newSessionToken,
  parseC2S,
  safeEqual,
  Session,
  SlidingWindow,
  TokenBucket,
  type ParsedC2S,
  type Surface,
} from "./session.ts";
import type { RoomRecord, Store } from "./store/memory.ts";
import {
  CLOSE,
  type Conn,
  type HttpReply,
  type HttpRequestInfo,
  type Transport,
  type TransportHandlers,
} from "./transport/types.ts";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** Pub/sub topics for a room (SPEC §9.5). */
export function roomTopics(code: string): { room: string; aud: string; stage: string } {
  return { room: `r:${code}:room`, aud: `r:${code}:aud`, stage: `r:${code}:stage` };
}

/** Game traffic the manager hands to a room's driver after the role gate. */
export type DriverMessage = Exclude<ParsedC2S, { t: "hello" } | { t: "create" } | { t: "ping" }>;

/** Why a member event fired. */
export type MemberEvent = "join" | "reconnect" | "disconnect" | "leave";

/**
 * The game-side half of a room. The manager owns membership; the driver owns what happens in
 * a game. Every method is optional except {@link onMessage}.
 */
export interface RoomDriver {
  /** A gated message from a member (`act`, `aud`, `host`, `mod`, `resync`, …). */
  onMessage(session: Session, conn: Conn, msg: DriverMessage): void;
  /** A member joined, reconnected, lost their last socket, or left for good. */
  onMember?(session: Session, event: MemberEvent): void;
  /**
   * The reconnect grace period ran out. Return true to keep the session (for example a bot now
   * plays the seat); false lets the manager release the seat and forget the session.
   */
  onGraceExpired?(session: Session): boolean;
  /** Adds game-owned fields (phase, playlist position, standings, …) to the room snapshot. */
  snapshot?(base: RoomSnapshot): RoomSnapshot;
  /** The config changed through a host `config` command. */
  onConfig?(config: Readonly<RoomConfig>): void;
  /** Opaque state to persist with the room (restored through {@link DriverFactory}). */
  persist?(): unknown;
  /** The room is being destroyed. */
  dispose?(): void;
}

/** Creates a room's driver; `restored` is the driver's persisted state after a restart. */
export type DriverFactory = (room: ManagedRoom, restored?: unknown) => RoomDriver;

/** What a join guard sees about a join attempt. */
export interface JoinAttempt {
  room: ManagedRoom;
  ip: string;
  ipHash: string;
  /** The token the client presented, if any (it may be unknown to the room). */
  token: string | undefined;
  want: "player" | "audience" | "overlay" | "moderator";
  name: string;
}

/**
 * A check run on every new join (not on token reconnects of a live session). Returning an
 * error code refuses the join; `BANNED` also closes the socket. Moderation (M1-04) installs the
 * ban check here.
 */
export type JoinGuard = (attempt: JoinAttempt) => ErrorCode | null;

/** Options for {@link RoomManager}. */
export interface RoomManagerOptions {
  config: ServerConfig;
  store: Store;
  clock?: Clock;
  /** Creates each room's driver; defaults to the lobby driver. */
  driver?: DriverFactory;
  /** Extra join checks (bans). */
  guards?: JoinGuard[];
  /** Random source for room codes (tests inject one). */
  random?: RandomIndex;
  /** Answers HTTP requests; set by `createServer` (http.ts). */
  http?: (req: HttpRequestInfo) => HttpReply | Promise<HttpReply>;
}

// ---------------------------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------------------------

/** One room's membership state. The driver reads it and may change `phase`/`paused`. */
export class ManagedRoom {
  readonly code: string;
  readonly epoch: number;
  readonly createdAt: number;
  readonly overlayKey: string;
  config: RoomConfig;
  hostId: string;
  /** Where the room is in its game loop; the driver moves it. */
  phase: RoomPhase = "lobby";
  /** BRB is on; the driver sets it. */
  paused = false;
  /** Sessions by token. */
  readonly sessions = new Map<string, Session>();
  /** Sessions by member/audience id. */
  readonly byId = new Map<string, Session>();
  /** Open sockets joined to this room. */
  readonly conns = new Set<Conn>();
  /** The room's driver (installed right after construction). */
  driver!: RoomDriver;
  /** Sequence number of the last `room` broadcast. */
  seq = 0;
  /** @internal */ nextPlayer = 1;
  /** @internal */ nextAudience = 1;
  /** @internal */ emptyTimer: TimerHandle | null = null;
  /** @internal */ broadcastTimer: TimerHandle | null = null;
  /** @internal */ broadcastImmediate: NodeJS.Immediate | null = null;
  /** @internal */ lastBroadcastAt = 0;
  /** @internal */ persistPending = false;

  constructor(init: {
    code: string;
    epoch: number;
    createdAt: number;
    overlayKey: string;
    config: RoomConfig;
    hostId: string;
  }) {
    this.code = init.code;
    this.epoch = init.epoch;
    this.createdAt = init.createdAt;
    this.overlayKey = init.overlayKey;
    this.config = init.config;
    this.hostId = init.hostId;
  }

  /** The pub/sub topics of this room. */
  get topics(): ReturnType<typeof roomTopics> {
    return roomTopics(this.code);
  }

  /** The host session. */
  get host(): Session | undefined {
    return this.byId.get(this.hostId);
  }

  /** Seated sessions (players, and anyone else holding a seat), by seat. */
  seated(): Session[] {
    const out: Session[] = [];
    for (const s of this.byId.values()) if (s.seat !== null) out.push(s);
    return out.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
  }

  /** The lowest free seat index, or `null` when all `maxPlayers` seats are taken. */
  freeSeat(): number | null {
    const taken = new Set<number>();
    for (const s of this.byId.values()) if (s.seat !== null) taken.add(s.seat);
    for (let i = 0; i < this.config.maxPlayers; i++) if (!taken.has(i)) return i;
    return null;
  }

  /** Connected audience members. */
  audienceCount(): number {
    let n = 0;
    for (const s of this.byId.values()) if (s.role === "audience" && s.connected) n++;
    return n;
  }

  /** Audience members asking to join the next round. */
  queueCount(): number {
    let n = 0;
    for (const s of this.byId.values()) if (s.role === "audience" && s.queued) n++;
    return n;
  }

  /** The identity a session sees in `welcome`. */
  me(s: Session): Me {
    return {
      id: s.id,
      role: s.role,
      name: s.name,
      seat: s.seat,
      colorSlot: s.seat === null ? null : s.seat % 8,
      ...(s.teamId !== undefined ? { teamId: s.teamId } : {}),
    };
  }

  /** The public snapshot every member receives (no password, no tokens, no overlay key). */
  snapshot(): RoomSnapshot {
    const members: MemberInfo[] = [];
    for (const s of this.byId.values()) {
      if (s.role !== "host" && s.role !== "player" && s.role !== "moderator") continue;
      members.push({
        id: s.id,
        name: s.name,
        role: s.role,
        seat: s.seat,
        // Unseated members (the host at the Stage, moderators) have no identity colour of their
        // own; they report slot 0 and clients render them by `seat === null`.
        colorSlot: s.seat === null ? 0 : s.seat % 8,
        ...(s.teamId !== undefined ? { teamId: s.teamId } : {}),
        connected: s.connected,
        ...(s.bot ? { bot: true as const } : {}),
      });
    }
    const rank = (m: MemberInfo): number => (m.role === "host" ? -1 : (m.seat ?? 1000));
    members.sort((a, b) => rank(a) - rank(b));
    const { password, ...rest } = this.config;
    const config: PublicRoomConfig = { ...structuredClone(rest), hasPassword: !!password };
    const base: RoomSnapshot = {
      code: this.code,
      epoch: this.epoch,
      phase: this.phase,
      paused: this.paused,
      hostId: this.hostId,
      members,
      audienceCount: this.audienceCount(),
      queueCount: this.queueCount(),
      teams: [],
      config,
      playlistIndex: -1,
      current: null,
      standings: [],
    };
    return this.driver.snapshot ? this.driver.snapshot(base) : base;
  }

  /** The persisted form. */
  toRecord(savedAt: number): RoomRecord {
    const actor = this.driver.persist?.();
    return {
      code: this.code,
      epoch: this.epoch,
      createdAt: this.createdAt,
      config: structuredClone(this.config),
      overlayKey: this.overlayKey,
      hostId: this.hostId,
      phase: this.phase,
      sessions: [...this.sessions.values()].map((s) => s.toRecord()),
      ...(actor !== undefined ? { actor } : {}),
      savedAt,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Lobby driver
// ---------------------------------------------------------------------------------------------

/**
 * The driver a room has before a room actor is installed: the room sits in the lobby. With no
 * game running an `act` is illegal, audience inputs have no poll to land in (dropped, as the
 * aggregator does after a poll closes), and game/moderation commands have nothing to act on.
 */
export function lobbyDriver(room: ManagedRoom, send: (conn: Conn, msg: S2C) => void): RoomDriver {
  return {
    onMessage(_session, conn, msg) {
      switch (msg.t) {
        case "act":
          send(conn, { t: "ack", id: msg.id, ok: false, err: "ILLEGAL" });
          return;
        case "host":
          send(conn, {
            t: "error",
            code: "ILLEGAL",
            msg: `"${msg.cmd.c}" needs a running game room; room ${room.code} is in the lobby`,
          });
          return;
        case "mod":
          send(conn, { t: "error", code: "ILLEGAL", msg: "nothing is waiting for moderation" });
          return;
        default:
          // aud / tap / audAct / enroll / react / resync / bg / queue: nothing to do in the lobby.
          return;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------

interface ConnState {
  conn: Conn;
  bucket: TokenBucket;
  room: ManagedRoom | null;
  session: Session | null;
  surface: Surface | null;
  helloTimer: TimerHandle | null;
}

/** Commands the manager itself handles because they only touch room config. */
const CONFIG_COMMANDS: ReadonlySet<HostCommand["c"]> = new Set(["config", "revealCode", "ambient"]);

/** `room` broadcasts caused only by audience/queue counts go out at most this often. */
export const COUNT_BROADCAST_MS = 500;

/** Owns every room on the server and implements the transport callbacks. */
export class RoomManager implements TransportHandlers {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly clock: Clock;
  readonly codes: CodeRegistry;
  readonly rooms = new Map<string, ManagedRoom>();
  readonly #states = new Map<Conn, ConnState>();
  readonly #ipConns = new Map<string, number>();
  readonly #joins: SlidingWindow;
  readonly #salt: string;
  readonly #driverFactory: DriverFactory;
  readonly #guards: JoinGuard[];
  readonly #http: RoomManagerOptions["http"];
  #transport: Transport | null = null;
  #sweepTimer: TimerHandle | null = null;
  #closed = false;

  constructor(o: RoomManagerOptions) {
    this.config = o.config;
    this.store = o.store;
    this.clock = o.clock ?? systemClock;
    this.codes = new CodeRegistry({
      clock: this.clock,
      releaseMs: o.config.codeReleaseMs,
      ...(o.random ? { random: o.random } : {}),
      nextEpoch: (code) => this.store.nextEpoch(code),
    });
    this.#joins = new SlidingWindow(o.config.perIpJoinsPerMin, 60_000);
    this.#salt = o.config.ipHashSalt ?? randomBytes(16).toString("hex");
    this.#driverFactory = o.driver ?? ((room) => lobbyDriver(room, (c, m) => this.send(c, m)));
    this.#guards = [...(o.guards ?? [])];
    this.#http = o.http;
    this.#scheduleSweep();
  }

  /** Connects the transport used for topic publishes. */
  attachTransport(transport: Transport): void {
    this.#transport = transport;
  }

  /** Adds a join guard (moderation installs the ban check). */
  addGuard(guard: JoinGuard): void {
    this.#guards.push(guard);
  }

  /** Salted hash of an IP, as stored on sessions. */
  ipHash(ip: string): string {
    return hashIp(ip, this.#salt);
  }

  /** Open sockets on this server. */
  get connectionCount(): number {
    return this.#states.size;
  }

  /** Counts a join attempt for `ip`; false when the IP is over `perIpJoinsPerMin`. */
  countJoinAttempt(ip: string): boolean {
    return this.#joins.hit(ip, this.clock.now());
  }

  // -------------------------------------------------------------------------------------------
  // Transport callbacks
  // -------------------------------------------------------------------------------------------

  http(req: HttpRequestInfo): HttpReply | Promise<HttpReply> {
    if (this.#http) return this.#http(req);
    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }

  admit(ip: string): boolean {
    if (this.#closed) return false;
    const n = this.#ipConns.get(ip) ?? 0;
    if (n >= this.config.perIpConnections) return false;
    this.#ipConns.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = (this.#ipConns.get(ip) ?? 0) - 1;
    if (n <= 0) this.#ipConns.delete(ip);
    else this.#ipConns.set(ip, n);
  }

  open(conn: Conn): void {
    const now = this.clock.now();
    const rate = this.config.audienceMsgPerSec;
    const st: ConnState = {
      conn,
      bucket: new TokenBucket(rate, rate, now),
      room: null,
      session: null,
      surface: null,
      helloTimer: null,
    };
    st.helloTimer = this.clock.setTimeout(() => {
      st.helloTimer = null;
      if (st.room === null && conn.isOpen) conn.close(CLOSE.HELLO_TIMEOUT, "no hello");
    }, this.config.helloTimeoutMs);
    this.#states.set(conn, st);
  }

  message(conn: Conn, data: ArrayBuffer, isBinary: boolean): void {
    const st = this.#states.get(conn);
    if (st === undefined) return;
    if (isBinary) {
      this.#error(conn, "ILLEGAL", "binary frames are not accepted from clients");
      return;
    }
    const decoded = decodeMessage(data, this.config.maxPayloadBytes);
    if (!decoded.ok) {
      this.#error(conn, "ILLEGAL", decoded.error);
      return;
    }
    const raw = decoded.value as { t?: unknown; id?: unknown };
    if (!st.bucket.take(this.clock.now())) {
      // Over the socket's message rate: drop. Acked actions learn why; the rest drop silently.
      if (raw.t === "act" && typeof raw.id === "number")
        this.send(conn, { t: "ack", id: raw.id, ok: false, err: "RATE_LIMIT" });
      return;
    }
    const parsed = parseC2S(decoded.value);
    if (!parsed.ok) {
      if (raw.t === "act" && typeof raw.id === "number" && Number.isInteger(raw.id))
        this.send(conn, { t: "ack", id: raw.id, ok: false, err: "ILLEGAL" });
      else this.#error(conn, "ILLEGAL", parsed.error);
      return;
    }
    const msg = parsed.msg;
    if (msg.t === "ping") {
      this.send(conn, { t: "pong", ts: msg.ts, serverNow: this.clock.now() });
      return;
    }
    if (st.room === null || st.session === null) {
      if (msg.t === "hello") this.#hello(st, msg);
      else if (msg.t === "create") this.#create(st, msg);
      else this.#error(conn, "NOT_ALLOWED", "join a room first");
      return;
    }
    if (msg.t === "hello" || msg.t === "create") {
      this.#error(conn, "NOT_ALLOWED", "this socket already joined a room");
      return;
    }
    const { room, session } = st;
    if (!gate(session.role, msg)) {
      if (msg.t === "act") this.send(conn, { t: "ack", id: msg.id, ok: false, err: "NOT_ALLOWED" });
      else this.#error(conn, "NOT_ALLOWED", `a ${session.role} may not send "${msg.t}"`);
      return;
    }
    this.#dispatch(room, session, st, msg);
  }

  close(conn: Conn, _code: number): void {
    const st = this.#states.get(conn);
    this.release(conn.ip);
    if (st === undefined) return;
    this.#states.delete(conn);
    if (st.helloTimer !== null) this.clock.clearTimeout(st.helloTimer);
    const { room, session } = st;
    if (room === null) return;
    room.conns.delete(conn);
    if (session !== null && session.detach(conn) && !session.connected) {
      session.disconnectedAt = this.clock.now();
      this.#startGrace(room, session);
      room.driver.onMember?.(session, "disconnect");
      this.#changed(room, session.role !== "audience");
    }
    if (room.conns.size === 0) this.#scheduleCleanup(room);
  }

  // -------------------------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------------------------

  /** Sends one message to one socket. */
  send(conn: Conn, msg: S2C): boolean {
    return conn.send(encodeMessage(msg));
  }

  /** Publishes one pre-serialized message to a topic. */
  publish(topic: string, msg: S2C): void {
    this.#transport?.publish(topic, encodeMessage(msg));
  }

  /**
   * Publishes an already-encoded frame (a view buffer shared by every subscriber, or a Marble
   * Rally binary frame) to a topic: one buffer, native fan-out on uWS.
   */
  publishRaw(topic: string, data: string | Uint8Array): void {
    this.#transport?.publish(topic, data);
  }

  // -------------------------------------------------------------------------------------------
  // Membership changes made by the room actor (M1-02)
  // -------------------------------------------------------------------------------------------

  /**
   * Changes a member's role, seat and team (seat raffle, bench, promote, transfer host).
   * The session's sockets get the new role's message rate; topic subscriptions are the
   * actor's business (it knows which view each socket receives). Broadcasts the room.
   */
  setMember(
    room: ManagedRoom,
    s: Session,
    change: { role?: Session["role"]; seat?: number | null; teamId?: string | null },
  ): void {
    if (change.role !== undefined) s.role = change.role;
    if (change.seat !== undefined) s.seat = change.seat;
    if (change.teamId !== undefined) s.teamId = change.teamId ?? undefined;
    if (change.role !== undefined) {
      const rate =
        s.role === "audience" || s.role === "overlay"
          ? this.config.audienceMsgPerSec
          : this.config.playerMsgPerSec;
      const now = this.clock.now();
      for (const conn of s.conns.values()) this.#states.get(conn)?.bucket.reset(rate, rate, now);
      if (s.role === "audience") s.queued = false;
    }
    this.#changed(room, true);
  }

  /**
   * Removes a member for good (kick, or a seat released after its bot finished the game):
   * closes its sockets with `code`, forgets the session and broadcasts the room. The host
   * cannot be removed.
   */
  removeMember(
    room: ManagedRoom,
    s: Session,
    code: number = CLOSE.KICKED,
    reason = "removed",
  ): void {
    if (s.id === room.hostId || room.sessions.get(s.token) !== s) return;
    for (const conn of [...s.conns.values()]) {
      s.detach(conn);
      room.conns.delete(conn);
      const st = this.#states.get(conn);
      if (st !== undefined) {
        st.room = null;
        st.session = null;
      }
      conn.close(code, reason);
    }
    this.#removeSession(room, s);
    room.driver.onMember?.(s, "leave");
    this.#changed(room, true);
    if (room.conns.size === 0) this.#scheduleCleanup(room);
  }

  /** Writes the room to the store now (the actor's every-20-actions / every-10-s snapshots). */
  persistNow(room: ManagedRoom): void {
    if (this.rooms.get(room.code) === room) this.store.saveRoom(room.toRecord(this.clock.now()));
  }

  #error(conn: Conn, code: ErrorCode, msg: string): void {
    this.send(conn, { t: "error", code, msg });
  }

  // -------------------------------------------------------------------------------------------
  // create / hello
  // -------------------------------------------------------------------------------------------

  #create(st: ConnState, msg: Extract<ParsedC2S, { t: "create" }>): void {
    const { conn } = st;
    if (msg.v !== PROTOCOL_VERSION) return this.#versionMismatch(conn, msg.v);
    if (!this.countJoinAttempt(conn.ip))
      return this.#error(conn, "RATE_LIMIT", "too many join attempts; wait a minute");
    if (this.rooms.size >= this.config.maxRooms)
      return this.#error(conn, "ROOM_FULL", "this server has no room for another room");
    const patch = parseRoomConfigPatch(msg.config);
    if (!patch.ok) return this.#error(conn, "ILLEGAL", patch.error);
    const issued = this.codes.issue();
    if (issued === null) return this.#error(conn, "ROOM_FULL", "no room codes left");

    const now = this.clock.now();
    const config = applyRoomConfigPatch(
      initialRoomConfig(this.config),
      patch.patch,
      this.config.allowedGames,
    );
    const room = new ManagedRoom({
      code: issued.code,
      epoch: issued.epoch,
      createdAt: now,
      overlayKey: newOverlayKey(),
      config,
      hostId: "host",
    });
    room.driver = this.#driverFactory(room);
    this.rooms.set(room.code, room);
    const host = new Session({
      token: newSessionToken(),
      id: "host",
      role: "host",
      name: this.#displayName(room, msg.name, "Host"),
      seat: null,
      ipHash: this.ipHash(conn.ip),
      joinedAt: now,
      epoch: room.epoch,
    });
    this.#addSession(room, host);
    this.#bind(st, room, host, "stage");
    this.#welcome(conn, room, host);
    room.driver.onMember?.(host, "join");
    this.#changed(room, true);
  }

  #hello(st: ConnState, msg: Extract<ParsedC2S, { t: "hello" }>): void {
    const { conn } = st;
    if (msg.v !== PROTOCOL_VERSION) return this.#versionMismatch(conn, msg.v);
    const code = normalizeRoomCode(msg.code);
    const room = code === null ? undefined : this.rooms.get(code);

    // A live session's token proves an earlier successful join: it skips the join-attempt
    // limit (a classroom reloading together must not lock itself out) and the password.
    const known =
      room !== undefined && msg.token !== undefined ? room.sessions.get(msg.token) : undefined;
    if (room !== undefined && known !== undefined && known.epoch === room.epoch)
      return this.#reconnect(st, room, known, msg.want);

    if (!this.countJoinAttempt(conn.ip))
      return this.#error(conn, "RATE_LIMIT", "too many join attempts; wait a minute");
    if (room === undefined) return this.#error(conn, "BAD_CODE", "no room with that code");

    if (msg.want === "overlay") {
      if (msg.overlayKey === undefined || !safeEqual(msg.overlayKey, room.overlayKey))
        return this.#error(conn, "NOT_ALLOWED", "wrong overlay key");
    } else if (room.config.password !== undefined && room.config.password !== "") {
      if (msg.password === undefined || !safeEqual(msg.password, room.config.password))
        return this.#error(conn, "BAD_PASSWORD", "this room needs the right password");
    }

    const ipHash = this.ipHash(conn.ip);
    const name = this.#displayName(room, msg.name ?? "", "");
    for (const guard of this.#guards) {
      const refused = guard({ room, ip: conn.ip, ipHash, token: msg.token, want: msg.want, name });
      if (refused !== null) {
        this.#error(conn, refused, refused === "BANNED" ? "you cannot join this room" : "refused");
        if (refused === "BANNED") conn.close(CLOSE.KICKED, "banned");
        return;
      }
    }

    const now = this.clock.now();
    if (msg.want === "overlay") {
      const s = new Session({
        token: newSessionToken(),
        id: `o${room.nextAudience++}`,
        role: "overlay",
        name: "Overlay",
        seat: null,
        ipHash,
        joinedAt: now,
        epoch: room.epoch,
      });
      this.#addSession(room, s);
      this.#bind(st, room, s, "overlay");
      this.#welcome(conn, room, s);
      room.driver.onMember?.(s, "join");
      return;
    }

    // Seat if one is free and the room is between games (or late joining is not restricted
    // because the room is still in the lobby); otherwise the audience (SPEC §3 step 3).
    const midGame = room.phase !== "lobby";
    const seat = msg.want === "player" && !midGame ? room.freeSeat() : null;
    if (seat === null && room.audienceCount() >= room.config.maxAudience)
      return this.#error(conn, "ROOM_FULL", "the room is full");

    const s =
      seat !== null
        ? new Session({
            token: newSessionToken(),
            id: `p${room.nextPlayer++}`,
            role: "player",
            name: name || `Player ${seat + 1}`,
            seat,
            ipHash,
            joinedAt: now,
            epoch: room.epoch,
          })
        : new Session({
            token: newSessionToken(),
            id: `a${room.nextAudience}`,
            role: "audience",
            name: name || `Viewer ${room.nextAudience}`,
            seat: null,
            ipHash,
            joinedAt: now,
            epoch: room.epoch,
          });
    if (seat === null) room.nextAudience++;
    if (seat === null && midGame && msg.want === "player" && room.config.lateJoin === "queue")
      s.queued = true;
    this.#addSession(room, s);
    this.#bind(st, room, s, "controller");
    this.#welcome(conn, room, s);
    room.driver.onMember?.(s, "join");
    this.#changed(room, s.role !== "audience");
  }

  #reconnect(st: ConnState, room: ManagedRoom, s: Session, want: string): void {
    const surface: Surface =
      s.role === "host"
        ? want === "moderator"
          ? "panel"
          : "stage"
        : s.role === "overlay"
          ? "overlay"
          : "controller";
    if (s.graceTimer !== null) {
      this.clock.clearTimeout(s.graceTimer);
      s.graceTimer = null;
    }
    const wasConnected = s.connected;
    this.#bind(st, room, s, surface);
    this.#welcome(st.conn, room, s);
    if (!wasConnected) {
      room.driver.onMember?.(s, "reconnect");
      this.#changed(room, s.role !== "audience");
    }
  }

  #versionMismatch(conn: Conn, v: number): void {
    this.#error(
      conn,
      "VERSION",
      `protocol v${v} is not supported; this server speaks v${PROTOCOL_VERSION}`,
    );
    conn.close(CLOSE.VERSION, "protocol version");
  }

  /** Cleans a display name (16 characters) and, in family mode, masks profanity. */
  #displayName(room: ManagedRoom, raw: string, fallback: string): string {
    const name = cleanName(raw);
    if (name === "") return fallback;
    return room.config.contentFilter === "family" ? filterText(name, "family").text : name;
  }

  #addSession(room: ManagedRoom, s: Session): void {
    room.sessions.set(s.token, s);
    room.byId.set(s.id, s);
  }

  #removeSession(room: ManagedRoom, s: Session): void {
    if (s.graceTimer !== null) this.clock.clearTimeout(s.graceTimer);
    s.graceTimer = null;
    room.sessions.delete(s.token);
    room.byId.delete(s.id);
  }

  /** Binds a socket to a session and surface, subscribes its topics, retunes its rate limit. */
  #bind(st: ConnState, room: ManagedRoom, s: Session, surface: Surface): void {
    const { conn } = st;
    if (st.helloTimer !== null) {
      this.clock.clearTimeout(st.helloTimer);
      st.helloTimer = null;
    }
    const replaced = s.attach(surface, conn);
    if (replaced !== undefined) {
      const old = this.#states.get(replaced);
      if (old !== undefined) {
        old.session = null;
        old.room = null;
      }
      room.conns.delete(replaced);
      replaced.close(CLOSE.REPLACED, "opened elsewhere");
    }
    st.room = room;
    st.session = s;
    st.surface = surface;
    room.conns.add(conn);
    if (room.emptyTimer !== null) {
      this.clock.clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }
    const rate =
      s.role === "audience" || s.role === "overlay"
        ? this.config.audienceMsgPerSec
        : this.config.playerMsgPerSec;
    st.bucket.reset(rate, rate, this.clock.now());
    const t = room.topics;
    conn.subscribe(t.room);
    if (s.role === "audience") conn.subscribe(t.aud);
    if (surface === "stage" || surface === "overlay") conn.subscribe(t.stage);
  }

  #welcome(conn: Conn, room: ManagedRoom, s: Session): void {
    this.send(conn, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      token: s.token,
      you: room.me(s),
      room: room.snapshot(),
      serverNow: this.clock.now(),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Messages after join
  // -------------------------------------------------------------------------------------------

  #dispatch(room: ManagedRoom, s: Session, st: ConnState, msg: DriverMessage): void {
    const { conn } = st;
    switch (msg.t) {
      case "resync":
        this.send(conn, { t: "room", seq: room.seq, room: room.snapshot() });
        break;
      case "bg":
        s.background = msg.on;
        break;
      case "queue":
        if (msg.join && room.phase !== "lobby" && room.config.lateJoin === "deny")
          return this.#error(conn, "NOT_ALLOWED", "late joining is off until this game ends");
        if (s.queued !== msg.join) {
          s.queued = msg.join;
          this.#changed(room, false);
        }
        break;
      case "host":
        if (CONFIG_COMMANDS.has(msg.cmd.c)) return this.#configCommand(room, conn, msg.cmd);
        break;
      default:
        break;
    }
    room.driver.onMessage(s, conn, msg);
  }

  #configCommand(room: ManagedRoom, conn: Conn, cmd: HostCommand): void {
    let next: RoomConfig;
    if (cmd.c === "config") {
      const patch = parseRoomConfigPatch(cmd.patch);
      if (!patch.ok) return this.#error(conn, "ILLEGAL", patch.error);
      const seated = room.seated();
      const highest = seated.length === 0 ? -1 : (seated[seated.length - 1]?.seat ?? -1);
      if (patch.patch.maxPlayers !== undefined && patch.patch.maxPlayers <= highest)
        return this.#error(
          conn,
          "ILLEGAL",
          `maxPlayers ${patch.patch.maxPlayers} is below the seated players; move players to the audience first`,
        );
      next = applyRoomConfigPatch(room.config, patch.patch, this.config.allowedGames);
    } else if (cmd.c === "revealCode") {
      next = { ...room.config, hideCode: !cmd.on };
    } else if (cmd.c === "ambient") {
      next = { ...room.config, theme: { ...room.config.theme, ambient: cmd.mode } };
    } else return;
    room.config = next;
    room.driver.onConfig?.(room.config);
    this.#changed(room, true);
  }

  // -------------------------------------------------------------------------------------------
  // Grace, cleanup, broadcast, persistence
  // -------------------------------------------------------------------------------------------

  #startGrace(room: ManagedRoom, s: Session): void {
    if (s.graceTimer !== null) this.clock.clearTimeout(s.graceTimer);
    // The host session lives as long as the room; cleanup handles an abandoned room.
    if (s.role === "host") return;
    const ms = room.config.reconnectGraceSec * 1000;
    s.graceTimer = this.clock.setTimeout(() => {
      s.graceTimer = null;
      if (s.connected || room.sessions.get(s.token) !== s) return;
      if (room.driver.onGraceExpired?.(s) === true) return;
      // Moderators keep their role across long phone locks; everyone else gives the seat back.
      if (s.role === "moderator") return;
      this.#removeSession(room, s);
      room.driver.onMember?.(s, "leave");
      this.#changed(room, s.role !== "audience" && s.role !== "overlay");
    }, ms);
  }

  #scheduleCleanup(room: ManagedRoom): void {
    if (room.emptyTimer !== null || this.#closed) return;
    room.emptyTimer = this.clock.setTimeout(() => {
      room.emptyTimer = null;
      if (room.conns.size === 0) this.destroyRoom(room.code);
    }, this.config.roomCleanupMs);
  }

  /** Ends a room: closes its sockets, forgets it, and reserves its code (SPEC §9.5). */
  destroyRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room === undefined) return;
    this.rooms.delete(code);
    if (room.emptyTimer !== null) this.clock.clearTimeout(room.emptyTimer);
    if (room.broadcastTimer !== null) this.clock.clearTimeout(room.broadcastTimer);
    if (room.broadcastImmediate !== null) clearImmediate(room.broadcastImmediate);
    for (const s of room.sessions.values())
      if (s.graceTimer !== null) this.clock.clearTimeout(s.graceTimer);
    room.driver.dispose?.();
    for (const conn of [...room.conns]) {
      const st = this.#states.get(conn);
      if (st !== undefined) {
        st.room = null;
        st.session = null;
      }
      conn.close(CLOSE.ROOM_CLOSED, "room closed");
    }
    room.conns.clear();
    this.store.deleteRoom(code);
    this.codes.release(code);
  }

  /**
   * Membership or config changed: schedule a `room` broadcast and a store write. `urgent`
   * changes (members, config) go out at the end of this event-loop turn, coalesced; count-only
   * changes (audience joins, the queue) are throttled to one per {@link COUNT_BROADCAST_MS}.
   */
  #changed(room: ManagedRoom, urgent: boolean): void {
    this.#schedulePersist(room);
    if (room.broadcastImmediate !== null) return;
    if (urgent) {
      if (room.broadcastTimer !== null) {
        this.clock.clearTimeout(room.broadcastTimer);
        room.broadcastTimer = null;
      }
      room.broadcastImmediate = setImmediate(() => this.#broadcast(room));
      return;
    }
    if (room.broadcastTimer !== null) return;
    const wait = Math.max(0, room.lastBroadcastAt + COUNT_BROADCAST_MS - this.clock.now());
    room.broadcastTimer = this.clock.setTimeout(() => this.#broadcast(room), wait);
  }

  /** Marks the room changed from outside (the room actor after a phase change). */
  roomChanged(room: ManagedRoom): void {
    this.#changed(room, true);
  }

  #broadcast(room: ManagedRoom): void {
    room.broadcastImmediate = null;
    if (room.broadcastTimer !== null) {
      this.clock.clearTimeout(room.broadcastTimer);
      room.broadcastTimer = null;
    }
    if (this.rooms.get(room.code) !== room) return;
    room.lastBroadcastAt = this.clock.now();
    room.seq++;
    this.publish(room.topics.room, { t: "room", seq: room.seq, room: room.snapshot() });
  }

  #schedulePersist(room: ManagedRoom): void {
    if (room.persistPending) return;
    room.persistPending = true;
    setImmediate(() => {
      room.persistPending = false;
      if (this.rooms.get(room.code) === room) this.store.saveRoom(room.toRecord(this.clock.now()));
    });
  }

  #scheduleSweep(): void {
    this.#sweepTimer = this.clock.setTimeout(() => {
      this.#joins.sweep(this.clock.now());
      if (!this.#closed) this.#scheduleSweep();
    }, 60_000);
  }

  // -------------------------------------------------------------------------------------------
  // Restore and shutdown
  // -------------------------------------------------------------------------------------------

  /**
   * Rebuilds rooms from the store after a restart (M10-03 crash restore). Every session comes
   * back disconnected with a fresh grace period, so clients reconnecting with their token get
   * their role and seat back. Returns the number of rooms restored.
   */
  restoreFromStore(): number {
    let n = 0;
    for (const record of this.store.listRooms()) {
      if (this.rooms.has(record.code) || !this.codes.adopt(record.code)) continue;
      const room = new ManagedRoom({
        code: record.code,
        epoch: record.epoch,
        createdAt: record.createdAt,
        overlayKey: record.overlayKey,
        config: record.config,
        hostId: record.hostId,
      });
      room.phase = record.phase;
      for (const r of record.sessions) {
        const s = Session.fromRecord(r, record.epoch);
        s.disconnectedAt = this.clock.now();
        this.#addSession(room, s);
        const num = Number(s.id.slice(1));
        if (Number.isInteger(num)) {
          if (s.id.startsWith("p")) room.nextPlayer = Math.max(room.nextPlayer, num + 1);
          else room.nextAudience = Math.max(room.nextAudience, num + 1);
        }
      }
      room.driver = this.#driverFactory(room, record.actor);
      this.rooms.set(room.code, room);
      for (const s of room.sessions.values()) this.#startGrace(room, s);
      this.#scheduleCleanup(room);
      n++;
    }
    return n;
  }

  /** Stops timers. Rooms stay in the store (a SqliteStore restores them on the next boot). */
  shutdown(): void {
    this.#closed = true;
    if (this.#sweepTimer !== null) this.clock.clearTimeout(this.#sweepTimer);
    for (const room of this.rooms.values()) {
      if (room.emptyTimer !== null) this.clock.clearTimeout(room.emptyTimer);
      if (room.broadcastTimer !== null) this.clock.clearTimeout(room.broadcastTimer);
      if (room.broadcastImmediate !== null) clearImmediate(room.broadcastImmediate);
      for (const s of room.sessions.values())
        if (s.graceTimer !== null) this.clock.clearTimeout(s.graceTimer);
      room.driver.dispose?.();
    }
    for (const st of this.#states.values())
      if (st.helloTimer !== null) this.clock.clearTimeout(st.helloTimer);
    this.codes.dispose();
  }
}
