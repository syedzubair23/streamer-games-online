/**
 * The uWebSockets.js transport (the production default, SPEC §9.1/§9.5): HTTP and WebSocket
 * on one port, native pub/sub fan-out (`publish(topic)` sends one pre-serialized buffer to every
 * subscriber in C++), `maxPayloadLength`, `idleTimeout` with automatic pings, and a per-socket
 * backpressure limit.
 *
 * This module imports the native binary, so load it lazily (`index.ts` does) on platforms that
 * may lack a prebuilt binary. It is loaded through `require`: the package's ESM wrapper (v20.71)
 * imports a file the package does not ship.
 *
 * @module
 */
import { createRequire } from "node:module";
import type * as UWS from "uWebSockets.js";
import {
  parseUrl,
  resolveClientIp,
  statusLine,
  WS_PATH,
  type Conn,
  type HttpRequestInfo,
  type Transport,
  type TransportHandlers,
  type TransportOptions,
} from "./types.ts";

const uWS = createRequire(import.meta.url)("uWebSockets.js") as typeof UWS;

interface UserData {
  ip: string;
  conn?: UwsConn;
}

let nextConnId = 1;
const decoder = new TextDecoder();

class UwsConn implements Conn {
  readonly id = nextConnId++;
  #open = true;

  constructor(
    private readonly ws: UWS.WebSocket<UserData>,
    readonly ip: string,
  ) {}

  get isOpen(): boolean {
    return this.#open;
  }

  markClosed(): void {
    this.#open = false;
  }

  send(data: string | Uint8Array): boolean {
    if (!this.#open) return false;
    // 0 = sent, 1 = sent but buffered (backpressure), 2 = dropped (over maxBackpressure).
    return this.ws.send(data, typeof data !== "string") !== 2;
  }

  subscribe(topic: string): void {
    if (this.#open) this.ws.subscribe(topic);
  }

  unsubscribe(topic: string): void {
    if (this.#open) this.ws.unsubscribe(topic);
  }

  close(code: number, reason: string): void {
    if (!this.#open) return;
    this.#open = false;
    this.ws.end(code, reason.slice(0, 120));
  }

  bufferedAmount(): number {
    return this.#open ? this.ws.getBufferedAmount() : 0;
  }
}

class UwsTransport implements Transport {
  readonly kind = "uws" as const;
  readonly #app: UWS.TemplatedApp;
  readonly #conns = new Set<UwsConn>();
  #listenSocket: UWS.us_listen_socket | null = null;

  constructor(
    private readonly handlers: TransportHandlers,
    private readonly options: TransportOptions,
  ) {
    this.#app = uWS.App();
    this.#app.ws<UserData>(WS_PATH, {
      maxPayloadLength: options.maxPayloadBytes,
      // uWS rounds to its 4 s timer granularity and needs at least 8 s; 0 disables.
      idleTimeout: options.idleTimeoutSec <= 0 ? 0 : Math.max(8, options.idleTimeoutSec),
      sendPingsAutomatically: true,
      maxBackpressure: options.maxBackpressureBytes,
      closeOnBackpressureLimit: false,
      compression: uWS.DISABLED,
      upgrade: (res, req, context) => {
        const ip = this.#ipOf(res, req.getHeader("x-forwarded-for"));
        if (!this.handlers.admit(ip)) {
          res.writeStatus(statusLine(429)).writeHeader("connection", "close").end();
          return;
        }
        // The upgrade completes synchronously, so `open` always follows and balances `admit`.
        res.upgrade<UserData>(
          { ip },
          req.getHeader("sec-websocket-key"),
          req.getHeader("sec-websocket-protocol"),
          req.getHeader("sec-websocket-extensions"),
          context,
        );
      },
      open: (ws) => {
        const data = ws.getUserData();
        const conn = new UwsConn(ws, data.ip);
        data.conn = conn;
        this.#conns.add(conn);
        this.handlers.open(conn);
      },
      message: (ws, message, isBinary) => {
        const conn = ws.getUserData().conn;
        if (conn !== undefined && conn.isOpen) this.handlers.message(conn, message, isBinary);
      },
      close: (ws, code) => {
        const conn = ws.getUserData().conn;
        if (conn === undefined) return;
        conn.markClosed();
        this.#conns.delete(conn);
        this.handlers.close(conn, code);
      },
    });
    this.#app.any("/*", (res, req) => this.#onRequest(res, req));
  }

  #ipOf(res: UWS.HttpResponse, forwardedFor: string): string {
    const remote = decoder.decode(res.getRemoteAddressAsText());
    return resolveClientIp(remote, forwardedFor, this.options.trustProxy);
  }

  #onRequest(res: UWS.HttpResponse, req: UWS.HttpRequest): void {
    // HttpRequest is stack allocated: copy everything before the first await.
    const { path, query } = parseUrl(`${req.getUrl()}?${req.getQuery() ?? ""}`);
    const headers: Record<string, string> = {};
    req.forEach((k, v) => {
      headers[k] = v;
    });
    const info: HttpRequestInfo = {
      method: req.getCaseSensitiveMethod().toUpperCase(),
      path,
      query,
      headers,
      ip: this.#ipOf(res, headers["x-forwarded-for"] ?? ""),
    };
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    if (path === WS_PATH) {
      res.writeStatus(statusLine(426)).writeHeader("content-type", "text/plain");
      res.end("WebSocket upgrade required");
      return;
    }
    const respond = (status: number, hdrs: Record<string, string>, body?: string | Uint8Array) => {
      if (aborted) return;
      res.cork(() => {
        res.writeStatus(statusLine(status));
        for (const [k, v] of Object.entries(hdrs)) res.writeHeader(k, v);
        if (info.method === "HEAD") res.endWithoutBody();
        else res.end(body ?? "");
      });
    };
    Promise.resolve()
      .then(() => this.handlers.http(info))
      .then(
        (reply) => respond(reply.status, reply.headers ?? {}, reply.body),
        () => respond(500, { "content-type": "text/plain" }, "internal error"),
      );
  }

  publish(topic: string, data: string | Uint8Array): void {
    this.#app.publish(topic, data, typeof data !== "string");
  }

  subscriberCount(topic: string): number {
    return this.#app.numSubscribers(topic);
  }

  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#app.listen(host, port, (socket) => {
        if (socket === false) {
          reject(new Error(`uWS could not listen on ${host}:${port}`));
          return;
        }
        this.#listenSocket = socket;
        resolve(uWS.us_socket_local_port(socket));
      });
    });
  }

  close(): Promise<void> {
    if (this.#listenSocket !== null) {
      uWS.us_listen_socket_close(this.#listenSocket);
      this.#listenSocket = null;
    }
    for (const conn of [...this.#conns]) conn.markClosed();
    this.#app.close();
    return Promise.resolve();
  }
}

/** Creates the uWebSockets.js-backed transport. */
export function createUwsTransport(
  handlers: TransportHandlers,
  options: TransportOptions,
): Transport {
  return new UwsTransport(handlers, options);
}
