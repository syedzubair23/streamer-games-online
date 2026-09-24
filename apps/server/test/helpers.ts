/**
 * Test helpers: a real server on an ephemeral port and a real `ws` client with an inbox.
 */
import type { C2S, S2C } from "@sg/shared";
import WebSocket from "ws";
import {
  createServer,
  parseServerConfig,
  type CreateServerOptions,
  type RunningServer,
} from "../src/index.ts";
import type { ServerConfigInput, TransportKind } from "../src/index.ts";

/** Starts a server on 127.0.0.1 with an ephemeral port. */
export async function startServer(
  transport: TransportKind,
  overrides: Partial<ServerConfigInput> = {},
  extra: Omit<CreateServerOptions, "config"> = {},
): Promise<RunningServer & { url: string; http: string }> {
  const config = parseServerConfig({ host: "127.0.0.1", port: 0, transport, ...overrides });
  const server = await createServer({ config, ...extra });
  return Object.assign(server, {
    url: `ws://127.0.0.1:${server.port}/ws`,
    http: `http://127.0.0.1:${server.port}`,
  });
}

/** A protocol client with an inbox and awaitable messages. */
export class Client {
  readonly inbox: S2C[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void }[] = [];

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // the lobby never sends binary frames (Marble Rally only)
      const msg = JSON.parse(data.toString()) as S2C;
      const i = this.#waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = this.#waiters.splice(i, 1);
        w?.resolve(msg);
      } else this.inbox.push(msg);
    });
  }

  /** Opens a socket; rejects on HTTP refusal (e.g. 429). */
  static connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once("open", () => resolve(new Client(ws)));
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode ?? "?"}`)),
      );
      ws.once("error", reject);
    });
  }

  send(msg: C2S | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** The next message matching `pred` (already received or future). */
  next<T extends S2C["t"]>(
    t: T,
    pred: (m: Extract<S2C, { t: T }>) => boolean = () => true,
    ms = 4000,
    anyOf?: readonly string[],
  ): Promise<Extract<S2C, { t: T }>> {
    const match = (m: S2C): boolean =>
      anyOf !== undefined ? anyOf.includes(m.t) : m.t === t && pred(m as Extract<S2C, { t: T }>);
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<S2C, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `timed out waiting for "${t}"; inbox: ${JSON.stringify(this.inbox).slice(0, 400)}`,
          ),
        );
      }, ms);
      const waiter = {
        pred: match,
        resolve: (m: S2C) => {
          clearTimeout(timer);
          resolve(m as Extract<S2C, { t: T }>);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  /** The next message whose tag is one of `types`. */
  first<T extends S2C["t"]>(types: readonly T[], ms = 4000): Promise<Extract<S2C, { t: T }>> {
    return this.next(types[0] as T, () => true, ms, types);
  }

  /** Sends `ping` and waits for its `pong`: everything sent before it has been processed. */
  async flush(): Promise<void> {
    const ts = Math.random();
    this.send({ t: "ping", ts });
    await this.next("pong", (m) => m.ts === ts);
  }

  close(): void {
    this.ws.close();
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}

/** Creates a room and returns the host client and its welcome. */
export async function createRoom(
  url: string,
  config: Record<string, unknown> = {},
  name = "Streamer",
): Promise<{ host: Client; welcome: Extract<S2C, { t: "welcome" }> }> {
  const host = await Client.connect(url);
  host.send({ t: "create", v: 1, name, config });
  const welcome = await host.next("welcome");
  return { host, welcome };
}

/** Joins a room and returns the client and its first reply (welcome or error). */
export async function join(
  url: string,
  hello: Partial<Extract<C2S, { t: "hello" }>> & { code: string },
): Promise<{ c: Client; reply: Extract<S2C, { t: "welcome" } | { t: "error" }> }> {
  const c = await Client.connect(url);
  c.send({ t: "hello", v: 1, want: "player", ...hello });
  const reply = await c.first(["welcome", "error"] as const);
  return { c, reply };
}
