/**
 * Server configuration (SPEC §9.5): `server.config.json` plus environment overrides, validated
 * with zod. Also the validator for the `Partial<RoomConfig>` a host sends in `create` and
 * `config` commands (SPEC §7), and the injectable {@link Clock}.
 *
 * Precedence: built-in defaults < `server.config.json` < environment variables.
 *
 * | Env var | Field |
 * |---|---|
 * | `PORT`, `HOST` | `port`, `host` |
 * | `TRANSPORT` (`uws`/`ws`) | `transport` |
 * | `STORE` (`memory`/`sqlite`) | `store` |
 * | `ADMIN_KEY` | `adminKey` |
 * | `STATIC_DIR` | `staticDir` |
 * | `TRUST_PROXY` (`1`/`true`) | `trustProxy` |
 * | `SG_CONFIG` | path of the config file (default `./server.config.json`) |
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AMBIENT_MODES,
  DEFAULT_ROOM_CONFIG,
  GAME_IDS,
  ROOM_LIMITS,
  type GameId,
  type RoomConfig,
} from "@sg/shared";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------------------------

const serverConfigSchema = z
  .object({
    /** TCP port for HTTP + WebSocket (the client dev proxy expects 8787). */
    port: z.number().int().min(0).max(65535).default(8787),
    host: z.string().min(1).default("0.0.0.0"),
    transport: z.enum(["uws", "ws"]).default("uws"),
    store: z.enum(["memory", "sqlite"]).default("memory"),
    /** SPEC §9.5: at most 200 concurrent rooms by default. */
    maxRooms: z.number().int().min(1).max(100_000).default(200),
    /** Games hosts may put in a playlist. */
    allowedGames: z
      .array(z.enum(GAME_IDS))
      .min(1)
      .default(() => [...GAME_IDS]),
    /** The content filter new rooms start with. */
    defaultContentFilter: z.enum(["family", "standard"]).default("standard"),
    /** Whether `GET /api/rooms` lists public rooms. */
    publicListing: z.boolean().default(false),
    /** Enables `/api/admin/*` when set (at least 16 characters). */
    adminKey: z.string().min(16).optional(),
    /** SPEC §9.5: 64 sockets per IP (a Chromebook lab behind one NAT IP must fit). */
    perIpConnections: z.number().int().min(1).max(100_000).default(64),
    /** SPEC §9.5: 40 join attempts per minute per IP (room-code brute force protection). */
    perIpJoinsPerMin: z.number().int().min(1).max(100_000).default(40),
    /** SPEC §9.5: 16 KB `maxPayloadLength`. */
    maxPayloadBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024)
      .default(16 * 1024),
    /** SPEC §9.5: uWS `idleTimeout` 30 s (clients ping every 10 s). 0 disables. */
    idleTimeoutSec: z.number().int().min(0).max(960).default(30),
    /** Per-socket send buffer; frames beyond it are dropped for that socket. */
    maxBackpressureBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .default(1024 * 1024),
    /** SPEC §9.5: players 20 msg/s. Also used for host and moderator sockets. */
    playerMsgPerSec: z.number().int().min(1).max(1000).default(20),
    /** SPEC §9.5: audience 5 msg/s. Also used for overlay sockets and sockets not yet joined. */
    audienceMsgPerSec: z.number().int().min(1).max(1000).default(5),
    /** A socket that sends no `hello`/`create` within this time is closed. */
    helloTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    /** SPEC §9.5: rooms are cleaned up 10 minutes after they empty. */
    roomCleanupMs: z
      .number()
      .int()
      .min(0)
      .default(10 * 60_000),
    /** SPEC §9.5: a room code is released 30 minutes after the room ends. */
    codeReleaseMs: z
      .number()
      .int()
      .min(0)
      .default(30 * 60_000),
    /** Take client IPs from `X-Forwarded-For` (only behind a trusted reverse proxy). */
    trustProxy: z.boolean().default(false),
    /** Serve the built client (`apps/client/dist`) from this directory; unset = API only. */
    staticDir: z.string().min(1).optional(),
    /**
     * Salt for IP hashes (kick/ban, anti-snipe). Unset = random per process, so hashes cannot
     * be reversed from logs; set it when bans must survive restarts (SqliteStore).
     */
    ipHashSalt: z.string().min(16).optional(),
  })
  .strict();

/** The validated server configuration. */
export type ServerConfig = z.output<typeof serverConfigSchema>;
/** What a config file or caller may provide. */
export type ServerConfigInput = z.input<typeof serverConfigSchema>;

/** Validates a config object and fills in defaults. Throws with every problem listed. */
export function parseServerConfig(input: unknown): ServerConfig {
  const result = serverConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid server config: ${problems}`);
  }
  return result.data;
}

/** Environment variables → config fields (only the ones that are set). */
export function envOverrides(env: NodeJS.ProcessEnv): Partial<ServerConfigInput> {
  const out: Partial<ServerConfigInput> = {};
  const port = env["PORT"];
  if (port !== undefined && port !== "") out.port = Number(port);
  if (env["HOST"]) out.host = env["HOST"];
  const transport = env["TRANSPORT"];
  if (transport === "uws" || transport === "ws") out.transport = transport;
  else if (transport) throw new Error(`invalid TRANSPORT "${transport}" (uws | ws)`);
  const store = env["STORE"];
  if (store === "memory" || store === "sqlite") out.store = store;
  else if (store) throw new Error(`invalid STORE "${store}" (memory | sqlite)`);
  if (env["ADMIN_KEY"]) out.adminKey = env["ADMIN_KEY"];
  if (env["STATIC_DIR"]) out.staticDir = env["STATIC_DIR"];
  const trust = env["TRUST_PROXY"];
  if (trust !== undefined && trust !== "") out.trustProxy = trust === "1" || trust === "true";
  return out;
}

/**
 * Loads `server.config.json` (or `SG_CONFIG`) if present, applies env overrides and validates.
 * A missing file is fine (defaults); an unreadable or invalid one throws.
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const named = env["SG_CONFIG"] !== undefined && env["SG_CONFIG"] !== "";
  const path = resolve(cwd, named ? (env["SG_CONFIG"] ?? "") : "server.config.json");
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  } else if (named) {
    throw new Error(`SG_CONFIG points to a missing file: ${path}`);
  }
  return parseServerConfig({ ...file, ...envOverrides(env) });
}

// ---------------------------------------------------------------------------------------------
// Room config patches (SPEC §7)
// ---------------------------------------------------------------------------------------------

/** Longest room password accepted. */
export const PASSWORD_MAX_LENGTH = 64;

const int = (lo: number, hi: number) => z.number().int().min(lo).max(hi);
const level = z.number().min(ROOM_LIMITS.audioLevel.min).max(ROOM_LIMITS.audioLevel.max);

const playlistItemSchema = z.object({
  gameId: z.enum(GAME_IDS),
  options: z.record(z.string().max(64), z.unknown()).default({}),
  label: z.string().max(40).optional(),
});

/** Validates a `Partial<RoomConfig>`; unknown keys are rejected, nested objects may be partial. */
export const roomConfigPatchSchema = z
  .object({
    visibility: z.enum(["private", "public"]),
    /** `""` removes the password. */
    password: z.string().max(PASSWORD_MAX_LENGTH),
    maxPlayers: int(ROOM_LIMITS.maxPlayers.min, ROOM_LIMITS.maxPlayers.max),
    maxAudience: int(ROOM_LIMITS.maxAudience.min, ROOM_LIMITS.maxAudience.max),
    lateJoin: z.enum(["audience", "queue", "deny"]),
    seatPick: z.enum(["fifo", "raffle"]),
    playlistMode: z.enum(["fixed", "audience-vote"]),
    antiSnipe: z.boolean(),
    contentFilter: z.enum(["family", "standard"]),
    moderation: z.enum(["off", "reveal-review"]),
    hideCode: z.boolean(),
    timerScale: z.union([
      z.literal(0),
      z.literal(0.75),
      z.literal(1),
      z.literal(1.5),
      z.literal(2),
    ]),
    streamDelaySec: int(ROOM_LIMITS.streamDelaySec.min, ROOM_LIMITS.streamDelaySec.max),
    audienceMin: int(ROOM_LIMITS.audienceMin.min, ROOM_LIMITS.audienceMin.max),
    reconnectGraceSec: int(ROOM_LIMITS.reconnectGraceSec.min, ROOM_LIMITS.reconnectGraceSec.max),
    teams: z
      .object({
        mode: z.enum(["none", "host", "auto", "self"]),
        count: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      })
      .partial()
      .strict(),
    scoring: z.enum(["placement", "raw"]),
    theme: z
      .object({
        ambient: z.enum(AMBIENT_MODES),
        autoCycleMin: z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(30)]),
        audienceModeVote: z.boolean(),
      })
      .partial()
      .strict(),
    streamLayout: z
      .object({ enabled: z.boolean(), webcam: z.enum(["br", "bl", "tr", "tl", "none"]) })
      .partial()
      .strict(),
    audio: z
      .object({ music: level, sfx: level, ambience: level, streamerSafe: z.boolean() })
      .partial()
      .strict(),
    quality: z.enum(["auto", "battery", "balanced", "pretty"]),
    playlist: z.array(playlistItemSchema).max(32),
  })
  .partial()
  .strict();

/** A validated room config patch. */
export type RoomConfigPatch = z.output<typeof roomConfigPatchSchema>;

/** Result of {@link parseRoomConfigPatch}. */
export type PatchResult = { ok: true; patch: RoomConfigPatch } | { ok: false; error: string };

/** Validates an untrusted `Partial<RoomConfig>`. */
export function parseRoomConfigPatch(input: unknown): PatchResult {
  const r = roomConfigPatchSchema.safeParse(input ?? {});
  if (r.success) return { ok: true, patch: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    error: first ? `${first.path.join(".") || "config"}: ${first.message}` : "invalid config",
  };
}

/**
 * Applies a validated patch to a config and returns the new config (the input is not
 * modified). Nested objects merge; `password: ""` removes the password; playlist entries for
 * games the server does not allow are dropped.
 */
export function applyRoomConfigPatch(
  base: Readonly<RoomConfig>,
  patch: RoomConfigPatch,
  allowedGames: readonly GameId[],
): RoomConfig {
  const next: RoomConfig = structuredClone(base) as RoomConfig;
  const { teams, theme, streamLayout, audio, password, playlist, ...flat } = patch;
  Object.assign(next, flat);
  if (teams) next.teams = { ...next.teams, ...teams };
  if (theme) next.theme = { ...next.theme, ...theme };
  if (streamLayout) next.streamLayout = { ...next.streamLayout, ...streamLayout };
  if (audio) next.audio = { ...next.audio, ...audio };
  if (password !== undefined) {
    if (password === "") delete next.password;
    else next.password = password;
  }
  if (playlist) {
    const allowed = new Set<GameId>(allowedGames);
    next.playlist = playlist
      .filter((item) => allowed.has(item.gameId))
      .map((item) => ({
        gameId: item.gameId,
        options: item.options,
        ...(item.label !== undefined ? { label: item.label } : {}),
      }));
  }
  return next;
}

/** The config a new room starts with on this server. */
export function initialRoomConfig(server: ServerConfig): RoomConfig {
  const config = structuredClone(DEFAULT_ROOM_CONFIG) as RoomConfig;
  config.contentFilter = server.defaultContentFilter;
  return config;
}

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------

/** An opaque timer handle. */
export type TimerHandle = { readonly __timer: unique symbol } | NodeJS.Timeout;

/** Time and timers, injectable so tests can drive grace periods and windows. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock. Timers are `unref`'d so they never keep the process alive on their own. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
