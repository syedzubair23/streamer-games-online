/**
 * HTTP routes, served on the same port as `/ws` by either transport (SPEC §9.5, research 02
 * §15). Read-only JSON endpoints plus the built client for self-hosting:
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /health` | liveness and load: rooms, sockets, uptime, memory |
 * | `GET /api/rooms` | public rooms, when `publicListing` is on (404 otherwise) |
 * | `GET /api/rooms/:code` | join-box pre-check: exists, needs a password, has a free seat (counts as a join attempt) |
 * | `GET /api/rooms/:code/overlay-key` | the OBS overlay key, for `Authorization: Bearer <host token>` only |
 * | `GET /api/admin/rooms` | every room, for `Authorization: Bearer <adminKey>` (404 when no key is configured) |
 * | anything else | a file from `staticDir`, falling back to `index.html` for app routes |
 *
 * @module
 */
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { normalizeRoomCode, PROTOCOL_VERSION } from "@sg/shared";
import type { ServerConfig } from "./config.ts";
import type { ManagedRoom, RoomManager } from "./room-manager.ts";
import { safeEqual } from "./session.ts";
import type { HttpReply, HttpRequestInfo, TransportKind } from "./transport/types.ts";

/** Headers on every reply. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Content types for the files the client build emits. */
export const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

/** A JSON reply (never cached). */
export function json(status: number, body: unknown): HttpReply {
  return {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

/** The bearer token of a request, if any. */
export function bearer(req: HttpRequestInfo): string | null {
  const h = req.headers["authorization"];
  if (h === undefined) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/** Options for {@link createHttpHandler}. */
export interface HttpOptions {
  manager: RoomManager;
  config: ServerConfig;
  transport: TransportKind;
  /** Server ms the process started. */
  startedAt: number;
}

/** A room as the public listing shows it. */
function listing(room: ManagedRoom): Record<string, unknown> {
  const host = room.host;
  return {
    code: room.config.hideCode ? null : room.code,
    host: host?.name ?? "",
    players: room.seated().length,
    maxPlayers: room.config.maxPlayers,
    audience: room.audienceCount(),
    hasPassword: !!room.config.password,
    phase: room.phase,
  };
}

/** Builds the request handler the transports call for every non-WebSocket request. */
export function createHttpHandler(o: HttpOptions): (req: HttpRequestInfo) => Promise<HttpReply> {
  const staticRoot = o.config.staticDir !== undefined ? resolve(o.config.staticDir) : null;

  return async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      const reply = json(405, { error: "method not allowed" });
      return { ...reply, headers: { ...reply.headers, allow: "GET, HEAD" } };
    }

    if (req.path === "/health") {
      const mem = process.memoryUsage();
      return json(200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        transport: o.transport,
        uptimeSec: Math.round((o.manager.clock.now() - o.startedAt) / 1000),
        rooms: o.manager.rooms.size,
        maxRooms: o.config.maxRooms,
        connections: o.manager.connectionCount,
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      });
    }

    if (req.path === "/api/rooms" || req.path === "/api/rooms/") {
      if (!o.config.publicListing) return json(404, { error: "public listing is off" });
      const rooms = [...o.manager.rooms.values()]
        .filter((r) => r.config.visibility === "public")
        .map(listing);
      return json(200, { rooms });
    }

    const roomMatch = /^\/api\/rooms\/([^/]+)(\/overlay-key)?\/?$/.exec(req.path);
    if (roomMatch) {
      const code = normalizeRoomCode(roomMatch[1] ?? "");
      if (roomMatch[2] !== undefined) {
        const token = bearer(req);
        const room = code === null ? undefined : o.manager.rooms.get(code);
        const host = room?.host;
        if (
          room === undefined ||
          host === undefined ||
          token === null ||
          !safeEqual(token, host.token)
        )
          return json(403, { error: "host token required" });
        return json(200, { code: room.code, key: room.overlayKey });
      }
      // Probing codes over HTTP is a join attempt, so it cannot bypass the brute-force limit.
      if (!o.manager.countJoinAttempt(req.ip)) return json(429, { error: "RATE_LIMIT" });
      const room = code === null ? undefined : o.manager.rooms.get(code);
      if (room === undefined) return json(404, { error: "BAD_CODE" });
      return json(200, {
        code: room.code,
        hasPassword: !!room.config.password,
        seatFree: room.phase === "lobby" && room.freeSeat() !== null,
        phase: room.phase,
      });
    }

    if (req.path === "/api/admin/rooms") {
      if (o.config.adminKey === undefined) return json(404, { error: "not found" });
      const token = bearer(req);
      if (token === null || !safeEqual(token, o.config.adminKey))
        return json(403, { error: "admin key required" });
      const rooms = [...o.manager.rooms.values()].map((r) => ({
        ...listing(r),
        code: r.code,
        epoch: r.epoch,
        createdAt: r.createdAt,
        sessions: r.sessions.size,
        sockets: r.conns.size,
      }));
      return json(200, { rooms });
    }

    if (req.path.startsWith("/api/")) return json(404, { error: "not found" });
    if (staticRoot === null) return json(404, { error: "not found" });
    return serveStatic(staticRoot, req.path);
  };
}

/**
 * Serves a file from the client build. Paths are confined to `root` (no `..` escape); a path
 * without a file extension that does not exist is an app route and gets `index.html`. Hashed
 * assets under `/assets/` are cached for a year; everything else must revalidate.
 */
export async function serveStatic(root: string, path: string): Promise<HttpReply> {
  const rel = normalize(path).replace(/^[/\\]+/, "");
  const target = resolve(root, rel === "" ? "index.html" : rel);
  const inside = relative(root, target);
  if (inside.startsWith("..") || isAbsolute(inside)) return json(404, { error: "not found" });

  const file = await readIfFile(target);
  if (file !== null) return fileReply(target, file, path.startsWith("/assets/"));
  if (extname(target) !== "") return json(404, { error: "not found" });
  const index = join(root, "index.html");
  const html = await readIfFile(index);
  return html === null ? json(404, { error: "not found" }) : fileReply(index, html, false);
}

async function readIfFile(path: string): Promise<Uint8Array | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

function fileReply(path: string, body: Uint8Array, immutable: boolean): HttpReply {
  return {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
    body,
  };
}
