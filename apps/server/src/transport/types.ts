/**
 * The transport seam (SPEC §9.5, research 02 §3): one interface over uWebSockets.js
 * (`uws.ts`, the production default) and `ws` (`ws.ts`, for platforms without a uWS prebuilt
 * binary and for tests). Everything above this file (sessions, rooms, HTTP routes) is
 * transport-neutral: it sees {@link Conn}s, text/binary frames, topics and plain HTTP requests.
 *
 * Both transports serve HTTP and WebSocket on one port. The WebSocket endpoint is `/ws`; every
 * other path is an HTTP request handed to {@link TransportHandlers.http}.
 *
 * @module
 */

/** Which WebSocket library backs a transport. */
export type TransportKind = "uws" | "ws";

/** Close codes the server uses (4000–4999 is the application range). */
export const CLOSE = {
  /** Normal shutdown. */
  NORMAL: 1000,
  /** The server is going away (process shutdown). */
  GOING_AWAY: 1001,
  /** A frame exceeded `maxPayloadLength` (RFC 6455 "message too big"). */
  TOO_BIG: 1009,
  /** The same session opened a newer socket for the same surface (a second tab). */
  REPLACED: 4000,
  /** Removed from the room by the host or a moderator. */
  KICKED: 4001,
  /** The client speaks another protocol version. */
  VERSION: 4003,
  /** The room was closed. */
  ROOM_CLOSED: 4004,
  /** No `hello`/`create` arrived in time after the socket opened. */
  HELLO_TIMEOUT: 4008,
  /** The client stopped answering (no traffic within the idle timeout). */
  IDLE: 4010,
} as const;

/** One WebSocket connection, as the layers above the transport see it. */
export interface Conn {
  /** Process-unique, increasing id. */
  readonly id: number;
  /** The client IP after proxy resolution (see {@link resolveClientIp}). */
  readonly ip: string;
  /** False once the socket is closing or closed; sends are then dropped. */
  readonly isOpen: boolean;
  /**
   * Sends one frame: a string as a text frame, bytes as a binary frame. Returns false when the
   * frame was dropped (socket closed, or backpressure over the limit).
   */
  send(data: string | Uint8Array): boolean;
  /** Joins a pub/sub topic (for example `r:ABCD:aud`). Idempotent. */
  subscribe(topic: string): void;
  /** Leaves a topic. Idempotent. */
  unsubscribe(topic: string): void;
  /** Starts a graceful close with an application close code and a short reason. */
  close(code: number, reason: string): void;
  /** Bytes queued for sending but not yet written to the network. */
  bufferedAmount(): number;
}

/** A parsed HTTP request (GET/HEAD bodies are ignored; the server exposes no write routes). */
export interface HttpRequestInfo {
  /** Upper-case method, e.g. `GET`. */
  method: string;
  /** Decoded path without the query string, always starting with `/`. */
  path: string;
  /** Query parameters (first value wins). */
  query: Record<string, string>;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The client IP after proxy resolution. */
  ip: string;
}

/** What an HTTP handler answers. */
export interface HttpReply {
  status: number;
  headers?: Record<string, string>;
  /** Text or bytes; omitted for an empty body. */
  body?: string | Uint8Array;
}

/** Callbacks a transport drives. All of them run on the event loop thread. */
export interface TransportHandlers {
  /** Answers an HTTP request on any path other than `/ws`. */
  http(req: HttpRequestInfo): HttpReply | Promise<HttpReply>;
  /**
   * Called before a WebSocket upgrade. Returning false refuses it with HTTP 429 (the per-IP
   * connection cap). A `true` must be balanced by exactly one {@link close} call later, or by
   * {@link release} when the upgrade does not complete.
   */
  admit(ip: string): boolean;
  /** Undoes an {@link admit} whose upgrade never produced an open socket. */
  release(ip: string): void;
  /** A socket opened. */
  open(conn: Conn): void;
  /** A frame arrived. `data` is only valid during the call (uWS neuters it afterwards). */
  message(conn: Conn, data: ArrayBuffer, isBinary: boolean): void;
  /** A socket closed, for any reason (the peer, the server, an oversized frame, idleness). */
  close(conn: Conn, code: number): void;
}

/** Options every transport accepts. */
export interface TransportOptions {
  /** Frames larger than this close the connection (SPEC §9.5: 16 KB). */
  maxPayloadBytes: number;
  /** Seconds without any traffic before the socket is closed (SPEC §9.5: 30 s). */
  idleTimeoutSec: number;
  /** Per-socket send buffer limit in bytes; frames beyond it are dropped. */
  maxBackpressureBytes: number;
  /** Take the client IP from `X-Forwarded-For` (only behind a trusted reverse proxy). */
  trustProxy: boolean;
}

/** A running (or ready to run) transport. */
export interface Transport {
  readonly kind: TransportKind;
  /** Starts listening. `port` 0 picks a free port; the actual port is returned. */
  listen(host: string, port: number): Promise<number>;
  /** Sends one pre-serialized frame to every subscriber of `topic` (one buffer, native fan-out on uWS). */
  publish(topic: string, data: string | Uint8Array): void;
  /** How many sockets are subscribed to `topic`. */
  subscriberCount(topic: string): number;
  /** Closes the listen socket and every connection. */
  close(): Promise<void>;
}

/** Creates a transport around a set of handlers. */
export type TransportFactory = (
  handlers: TransportHandlers,
  options: TransportOptions,
) => Transport;

/** The WebSocket endpoint path (SPEC §9.6). */
export const WS_PATH = "/ws";

/**
 * Normalises an address string: strips the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` and the
 * fully expanded `0000:…:ffff:7f00:0001` form uWS reports) and lower-cases IPv6.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  const expanded = /^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (expanded) {
    const hi = parseInt(expanded[1] ?? "0", 16);
    const lo = parseInt(expanded[2] ?? "0", 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (ip === "0000:0000:0000:0000:0000:0000:0000:0001") return "::1";
  return ip;
}

/**
 * The client IP for a request. Behind a trusted proxy the right-most `X-Forwarded-For` entry is
 * the address the proxy saw (entries further left are client-controlled); otherwise it is the
 * socket's remote address.
 */
export function resolveClientIp(
  remote: string,
  forwardedFor: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor !== undefined && forwardedFor.trim() !== "") {
    const parts = forwardedFor.split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last !== undefined && last !== "") return normalizeIp(last);
  }
  return normalizeIp(remote);
}

/** Splits a raw URL (`/a%20b?x=1`) into a decoded path and a query map. */
export function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const q = url.indexOf("?");
  const rawPath = q === -1 ? url : url.slice(0, q);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  if (!path.startsWith("/")) path = `/${path}`;
  const query: Record<string, string> = {};
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(url.slice(q + 1))) if (!(k in query)) query[k] = v;
  }
  return { path, query };
}

/** Standard reason phrases for the statuses the server sends (uWS wants "200 OK" strings). */
export const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  204: "No Content",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  426: "Upgrade Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** `"404 Not Found"` style status line text. */
export function statusLine(status: number): string {
  return `${status} ${STATUS_TEXT[status] ?? "Unknown"}`;
}
