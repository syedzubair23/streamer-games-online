/**
 * The `ws` transport: Node's `http` server plus a `ws` WebSocketServer on the same port.
 * Used where the uWebSockets.js prebuilt binary is unavailable, and by the tests to prove both
 * transports behave the same. Topics are an in-process map (no native fan-out), and the idle
 * timeout is implemented with a sweep that also sends protocol pings, matching uWS's
 * `idleTimeout` + `sendPingsAutomatically`.
 *
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  CLOSE,
  parseUrl,
  resolveClientIp,
  WS_PATH,
  type Conn,
  type HttpRequestInfo,
  type Transport,
  type TransportHandlers,
  type TransportOptions,
} from "./types.ts";

let nextConnId = 1;

class WsConn implements Conn {
  readonly id = nextConnId++;
  readonly topics = new Set<string>();
  lastSeen = Date.now();
  #open = true;

  constructor(
    readonly socket: WebSocket,
    readonly ip: string,
    private readonly owner: WsTransport,
  ) {}

  get isOpen(): boolean {
    return this.#open && this.socket.readyState === this.socket.OPEN;
  }

  markClosed(): void {
    this.#open = false;
  }

  send(data: string | Uint8Array): boolean {
    if (!this.isOpen) return false;
    if (this.socket.bufferedAmount > this.owner.options.maxBackpressureBytes) return false;
    this.socket.send(data, { binary: typeof data !== "string" });
    return true;
  }

  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    this.owner.addSubscriber(topic, this);
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    this.owner.removeSubscriber(topic, this);
  }

  close(code: number, reason: string): void {
    if (!this.#open) return;
    this.#open = false;
    this.socket.close(code, reason.slice(0, 120));
  }

  bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }
}

class WsTransport implements Transport {
  readonly kind = "ws" as const;
  readonly #server: Server;
  readonly #wss: WebSocketServer;
  readonly #topics = new Map<string, Set<WsConn>>();
  readonly #conns = new Set<WsConn>();
  #sweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly handlers: TransportHandlers,
    readonly options: TransportOptions,
  ) {
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#server = createServer((req, res) => void this.#onRequest(req, res));
    this.#server.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
  }

  #ipOf(req: IncomingMessage): string {
    const fwd = req.headers["x-forwarded-for"];
    return resolveClientIp(
      req.socket.remoteAddress ?? "",
      Array.isArray(fwd) ? fwd.join(",") : fwd,
      this.options.trustProxy,
    );
  }

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { path, query } = parseUrl(req.url ?? "/");
    if (path === WS_PATH) {
      res.writeHead(426, { "content-type": "text/plain" }).end("WebSocket upgrade required");
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(",") : v;
    const info: HttpRequestInfo = {
      method: (req.method ?? "GET").toUpperCase(),
      path,
      query,
      headers,
      ip: this.#ipOf(req),
    };
    try {
      const reply = await this.handlers.http(info);
      res.writeHead(reply.status, reply.headers);
      res.end(info.method === "HEAD" ? undefined : reply.body);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    }
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { path } = parseUrl(req.url ?? "/");
    if (path !== WS_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ip = this.#ipOf(req);
    if (!this.handlers.admit(ip)) {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) this.handlers.release(ip);
    });
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      this.#onOpen(ws, ip);
    });
  }

  #onOpen(ws: WebSocket, ip: string): void {
    const conn = new WsConn(ws, ip, this);
    this.#conns.add(conn);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      conn.lastSeen = Date.now();
      if (!conn.isOpen) return;
      this.handlers.message(conn, toArrayBuffer(data), isBinary);
    });
    ws.on("pong", () => {
      conn.lastSeen = Date.now();
    });
    ws.on("error", () => {
      // `ws` emits an error before closing on protocol violations (e.g. an oversized frame);
      // the close handler below does the bookkeeping.
    });
    ws.on("close", (code: number) => {
      conn.markClosed();
      for (const topic of [...conn.topics]) conn.unsubscribe(topic);
      this.#conns.delete(conn);
      this.handlers.close(conn, code);
    });
    this.handlers.open(conn);
  }

  addSubscriber(topic: string, conn: WsConn): void {
    let set = this.#topics.get(topic);
    if (set === undefined) {
      set = new Set();
      this.#topics.set(topic, set);
    }
    set.add(conn);
  }

  removeSubscriber(topic: string, conn: WsConn): void {
    const set = this.#topics.get(topic);
    if (set === undefined) return;
    set.delete(conn);
    if (set.size === 0) this.#topics.delete(topic);
  }

  publish(topic: string, data: string | Uint8Array): void {
    const set = this.#topics.get(topic);
    if (set === undefined) return;
    for (const conn of set) conn.send(data);
  }

  subscriberCount(topic: string): number {
    return this.#topics.get(topic)?.size ?? 0;
  }

  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once("error", onError);
      this.#server.listen(port, host, () => {
        this.#server.off("error", onError);
        const addr = this.#server.address();
        const idleMs = this.options.idleTimeoutSec * 1000;
        if (idleMs > 0) {
          const every = Math.max(250, Math.floor(idleMs / 3));
          this.#sweep = setInterval(() => this.#sweepIdle(idleMs), every);
          this.#sweep.unref();
        }
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  #sweepIdle(idleMs: number): void {
    const now = Date.now();
    for (const conn of this.#conns) {
      if (now - conn.lastSeen > idleMs) conn.close(CLOSE.IDLE, "idle");
      else if (conn.isOpen) conn.socket.ping();
    }
  }

  close(): Promise<void> {
    if (this.#sweep !== null) clearInterval(this.#sweep);
    for (const conn of [...this.#conns]) conn.socket.terminate();
    return new Promise((resolve) => {
      this.#wss.close();
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }
}

function toArrayBuffer(data: RawData): ArrayBuffer {
  const buf = Array.isArray(data) ? Buffer.concat(data) : data;
  if (buf instanceof ArrayBuffer) return buf;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Creates the `ws`-backed transport. */
export function createWsTransport(
  handlers: TransportHandlers,
  options: TransportOptions,
): Transport {
  return new WsTransport(handlers, options);
}
