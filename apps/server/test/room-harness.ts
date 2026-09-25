/**
 * In-process room harness: a real {@link RoomManager} + room actor on a {@link FakeClock},
 * with a fake transport whose topics fan frames out to subscribed fake sockets exactly like
 * uWS does. Lets tests drive thousands of members and exact time without real sockets (the
 * real-socket path is covered by room-e2e.test.ts).
 */
import { apply, decodeMessage, type C2S, type PatchOp, type S2C } from "@sg/shared";
import {
  createRoomActorFactory,
  GameRegistry,
  MemoryStore,
  parseServerConfig,
  RoomManager,
  type ManagedRoom,
  type RoomActor,
  type RoomActorOptions,
  type ServerConfigInput,
  type Store,
} from "../src/index.ts";
import type { Conn, Transport } from "../src/transport/types.ts";
import { FakeClock } from "./fake-clock.ts";

/** A socket that records everything sent to it. */
export class FakeConn implements Conn {
  static #next = 1;
  readonly id = FakeConn.#next++;
  readonly topics = new Set<string>();
  readonly frames: (string | Uint8Array)[] = [];
  isOpen = true;
  closedWith: { code: number; reason: string } | null = null;

  constructor(
    readonly ip: string,
    private readonly net: FakeNet,
  ) {}

  send(data: string | Uint8Array): boolean {
    if (!this.isOpen) return false;
    this.frames.push(data);
    return true;
  }
  subscribe(topic: string): void {
    this.topics.add(topic);
  }
  unsubscribe(topic: string): void {
    this.topics.delete(topic);
  }
  close(code: number, reason: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.closedWith = { code, reason };
    this.net.closeConn(this, code);
  }
  bufferedAmount(): number {
    return 0;
  }
}

/** The fake network: conns, topics, publish counters. */
export class FakeNet implements Transport {
  readonly kind = "ws" as const;
  readonly conns = new Set<FakeConn>();
  /** Every publish: topic and frame. */
  readonly publishes: { topic: string; data: string | Uint8Array }[] = [];
  manager!: RoomManager;

  async listen(): Promise<number> {
    return 0;
  }
  publish(topic: string, data: string | Uint8Array): void {
    this.publishes.push({ topic, data });
    for (const c of this.conns) if (c.isOpen && c.topics.has(topic)) c.frames.push(data);
  }
  subscriberCount(topic: string): number {
    let n = 0;
    for (const c of this.conns) if (c.topics.has(topic)) n++;
    return n;
  }
  async close(): Promise<void> {}

  open(ip = "10.0.0.1"): FakeConn {
    const conn = new FakeConn(ip, this);
    if (!this.manager.admit(ip)) throw new Error("admit refused");
    this.conns.add(conn);
    this.manager.open(conn);
    return conn;
  }

  closeConn(conn: FakeConn, code: number): void {
    this.conns.delete(conn);
    this.manager.close(conn, code);
  }
}

/** A protocol client over a {@link FakeConn}, keeping the game view up to date. */
export class FakeClient {
  #read = 0;
  /** Decoded text messages not yet taken with {@link take}. */
  readonly inbox: S2C[] = [];
  /** Every decoded text message ever received. */
  readonly all: S2C[] = [];
  /** Binary frames received. */
  readonly binary: Uint8Array[] = [];
  view: unknown = null;
  viewSeq = -1;
  seqGaps = 0;
  welcome: Extract<S2C, { t: "welcome" }> | null = null;
  room: Extract<S2C, { t: "welcome" }>["room"] | null = null;

  constructor(
    readonly conn: FakeConn,
    private readonly h: RoomHarness,
  ) {}

  get id(): string {
    return this.welcome?.you.id ?? "";
  }

  get token(): string {
    return this.welcome?.token ?? "";
  }

  send(msg: C2S | Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(JSON.stringify(msg));
    this.h.manager.message(this.conn, bytes.buffer as ArrayBuffer, false);
    this.pump();
  }

  /** Reads new frames from the socket into the inbox and applies views/patches. */
  pump(): void {
    while (this.#read < this.conn.frames.length) {
      const f = this.conn.frames[this.#read++] as string | Uint8Array;
      if (typeof f !== "string") {
        this.binary.push(f);
        continue;
      }
      const decoded = decodeMessage(f, 1 << 30);
      if (!decoded.ok) throw new Error(decoded.error);
      const m = decoded.value as S2C;
      this.all.push(m);
      this.inbox.push(m);
      if (m.t === "welcome") {
        this.welcome = m;
        this.room = m.room;
      } else if (m.t === "room") this.room = m.room;
      else if (m.t === "view") {
        this.view = m.full;
        this.viewSeq = m.seq;
      } else if (m.t === "patch") {
        if (m.seq !== this.viewSeq + 1) this.seqGaps++;
        this.view = apply(this.view, m.ops as PatchOp[]);
        this.viewSeq = m.seq;
      }
    }
  }

  /** Removes and returns inbox messages of a type. */
  take<T extends S2C["t"]>(t: T): Extract<S2C, { t: T }>[] {
    this.pump();
    const out: Extract<S2C, { t: T }>[] = [];
    for (let i = 0; i < this.inbox.length;) {
      const m = this.inbox[i] as S2C;
      if (m.t === t) {
        out.push(m as Extract<S2C, { t: T }>);
        this.inbox.splice(i, 1);
      } else i++;
    }
    return out;
  }

  /** Every text frame received so far, raw. */
  rawText(): string {
    return this.conn.frames.filter((f): f is string => typeof f === "string").join("\n");
  }

  close(): void {
    this.conn.close(1000, "bye");
  }
}

/** Options for {@link startHarness}. */
export interface HarnessOptions {
  server?: Partial<ServerConfigInput>;
  games: GameRegistry | ConstructorParameters<typeof GameRegistry>[0];
  actor?: Omit<RoomActorOptions, "manager" | "games">;
  store?: Store;
}

/** A running in-process server. */
export class RoomHarness {
  readonly clock = new FakeClock();
  readonly net = new FakeNet();
  readonly manager: RoomManager;
  readonly store: Store;

  constructor(o: HarnessOptions) {
    const games = o.games instanceof GameRegistry ? o.games : new GameRegistry(o.games, {});
    this.store = o.store ?? new MemoryStore();
    const config = parseServerConfig({ host: "127.0.0.1", port: 0, transport: "ws", ...o.server });
    this.manager = new RoomManager({
      config,
      store: this.store,
      clock: this.clock,
      driver: createRoomActorFactory({
        seed: () => 42,
        dev: true,
        ...o.actor,
        manager: () => this.manager,
        games,
      }),
      random: (max) => Math.floor(Math.random() * max),
    });
    this.net.manager = this.manager;
    this.manager.attachTransport(this.net);
  }

  /** Opens a socket and returns a client. */
  connect(ip?: string): FakeClient {
    return new FakeClient(this.net.open(ip), this);
  }

  /** Creates a room; returns the host Stage client. */
  create(config: Record<string, unknown> = {}, ip?: string): FakeClient {
    const c = this.connect(ip);
    c.send({ t: "create", v: 1, name: "Host", config });
    if (c.welcome === null) throw new Error(`create failed: ${JSON.stringify(c.inbox)}`);
    return c;
  }

  /** Joins a room. */
  join(
    code: string,
    o: {
      name?: string;
      want?: "player" | "audience" | "overlay" | "moderator";
      token?: string;
      overlayKey?: string;
      ip?: string;
    } = {},
  ): FakeClient {
    const c = this.connect(o.ip);
    c.send({
      t: "hello",
      v: 1,
      code,
      want: o.want ?? "player",
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.token !== undefined ? { token: o.token } : {}),
      ...(o.overlayKey !== undefined ? { overlayKey: o.overlayKey } : {}),
    });
    return c;
  }

  room(code: string): ManagedRoom {
    const r = this.manager.rooms.get(code);
    if (r === undefined) throw new Error(`no room ${code}`);
    return r;
  }

  actor(code: string): RoomActor {
    return this.room(code).driver as RoomActor;
  }

  /** Lets setImmediate callbacks (flushes, broadcasts, persists) run. */
  async settle(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  }

  /** Advances fake time in steps, settling between them, and pumps every client. */
  async advance(ms: number, step = 100, clients: FakeClient[] = []): Promise<void> {
    let left = ms;
    while (left > 0) {
      const d = Math.min(step, left);
      this.clock.advance(d);
      left -= d;
      await this.settle();
      for (const c of clients) c.pump();
    }
  }

  /** Sends a host command from a client. */
  host(c: FakeClient, cmd: Record<string, unknown>): void {
    c.send({ t: "host", cmd });
  }

  shutdown(): void {
    this.manager.shutdown();
  }
}
