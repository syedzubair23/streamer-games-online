/**
 * Sessions (SPEC §2, §9.5, §9.7): who a socket is, what it may do, and how fast.
 *
 * - A {@link Session} is an identity in one room: a 128-bit token, a role, a seat, a name. It
 *   survives socket loss for the reconnect grace period; `hello { token }` rebinds it.
 * - The session decides the role. A client message never can: {@link gate} checks every
 *   message against the session's role before anything else sees it.
 * - {@link parseC2S} validates every client frame against the protocol (SPEC §9.6); anything
 *   that does not match is rejected before routing.
 * - {@link TokenBucket} (per socket, 20 msg/s players, 5 msg/s audience) and
 *   {@link SlidingWindow} (per IP join attempts) are the rate limiters.
 *
 * @module
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  GAME_IDS,
  REACTION_IDS,
  type AudId,
  type C2S,
  type C2SType,
  type HostCommand,
  type ModCommand,
  type PlayerId,
  type Role,
  type TeamId,
} from "@sg/shared";
import { z } from "zod";
import { roomConfigPatchSchema, type TimerHandle } from "./config.ts";
import type { SessionRecord } from "./store/memory.ts";
import type { Conn } from "./transport/types.ts";

// ---------------------------------------------------------------------------------------------
// Secrets and hashes
// ---------------------------------------------------------------------------------------------

/** Session tokens carry 128 bits of entropy (SPEC §9.5). */
export const SESSION_TOKEN_BYTES = 16;
/** Overlay keys carry 96 bits of entropy (SPEC §9.7). */
export const OVERLAY_KEY_BYTES = 12;

/** A fresh session token: 16 random bytes, base64url (22 characters). */
export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** A fresh overlay key: 12 random bytes, base64url (16 characters). */
export function newOverlayKey(): string {
  return randomBytes(OVERLAY_KEY_BYTES).toString("base64url");
}

/** Constant-time string comparison for passwords and keys. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Compare against itself on length mismatch so timing does not depend on where they differ.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Salted SHA-256 of an IP, truncated to 16 hex characters: enough to key bans, not reversible. */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(salt).update("\0").update(ip).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/**
 * Which window a socket is. The host session has two: the captured Stage (`stage`, receives
 * only the `stage` view) and the host panel pop-out (`panel`, receives the `host` view). A host
 * token says `want: "moderator"` in `hello` to open the panel; any other `want` is the Stage.
 */
export type Surface = "stage" | "panel" | "controller" | "overlay";

/** An identity in one room. */
export class Session {
  readonly token: string;
  readonly id: PlayerId | AudId;
  role: Role;
  name: string;
  seat: number | null;
  teamId: TeamId | undefined;
  readonly ipHash: string;
  readonly joinedAt: number;
  /** The room epoch this session belongs to; a token from an older epoch is rejected. */
  readonly epoch: number;
  /** Audience member asked to join the next round. */
  queued = false;
  /** The tab is hidden: cosmetic traffic may be dropped (`bg` message). */
  background = false;
  /** Present while a bot plays this seat (set by the room actor). */
  bot = false;
  /** Server ms the last socket closed, while no socket is open. */
  disconnectedAt: number | null = null;
  /** Pending reconnect-grace expiry. */
  graceTimer: TimerHandle | null = null;
  readonly #conns = new Map<Surface, Conn>();

  constructor(init: {
    token: string;
    id: PlayerId | AudId;
    role: Role;
    name: string;
    seat: number | null;
    ipHash: string;
    joinedAt: number;
    epoch: number;
    teamId?: TeamId;
  }) {
    this.token = init.token;
    this.id = init.id;
    this.role = init.role;
    this.name = init.name;
    this.seat = init.seat;
    this.teamId = init.teamId;
    this.ipHash = init.ipHash;
    this.joinedAt = init.joinedAt;
    this.epoch = init.epoch;
  }

  /** Whether at least one socket is open. */
  get connected(): boolean {
    return this.#conns.size > 0;
  }

  /** Open sockets, by surface. */
  get conns(): ReadonlyMap<Surface, Conn> {
    return this.#conns;
  }

  /** Binds a socket to a surface and returns the socket it replaces, if any. */
  attach(surface: Surface, conn: Conn): Conn | undefined {
    const previous = this.#conns.get(surface);
    this.#conns.set(surface, conn);
    this.disconnectedAt = null;
    return previous === conn ? undefined : previous;
  }

  /** Unbinds a socket. Returns true when it was bound. */
  detach(conn: Conn): boolean {
    for (const [surface, c] of this.#conns)
      if (c === conn) {
        this.#conns.delete(surface);
        return true;
      }
    return false;
  }

  /** The persisted form. */
  toRecord(): SessionRecord {
    return {
      token: this.token,
      id: this.id,
      role: this.role,
      name: this.name,
      seat: this.seat,
      ...(this.teamId !== undefined ? { teamId: this.teamId } : {}),
      ipHash: this.ipHash,
      joinedAt: this.joinedAt,
      ...(this.queued ? { queued: true } : {}),
    };
  }

  /** Rebuilds a session from its persisted form (disconnected, awaiting its owner). */
  static fromRecord(r: SessionRecord, epoch: number): Session {
    const s = new Session({ ...r, epoch });
    s.queued = r.queued === true;
    return s;
  }
}

// ---------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------

/**
 * A token bucket: `ratePerSec` sustained, bursts up to `burst`. Used per socket for message
 * rates (SPEC §9.5: players 20 msg/s, audience 5 msg/s).
 */
export class TokenBucket {
  #tokens: number;
  #last: number;

  constructor(
    private ratePerSec: number,
    private burst: number,
    now: number,
  ) {
    this.#tokens = burst;
    this.#last = now;
  }

  /**
   * Starts over with a new rate and a full bucket. Used when a socket joins: the role's budget
   * starts fresh instead of inheriting what the pre-join handshake used.
   */
  reset(ratePerSec: number, burst: number, now: number): void {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.#tokens = burst;
    this.#last = now;
  }

  /** Takes one token; false when the bucket is empty (the message must be dropped). */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.#last) / 1000;
    this.#last = now;
    this.#tokens = Math.min(this.burst, this.#tokens + elapsed * this.ratePerSec);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/**
 * A per-key sliding-window counter: at most `limit` events per `windowMs` per key. Used for
 * join attempts per IP (SPEC §9.5: 40/min). Memory is bounded: each key keeps at most `limit`
 * timestamps, and {@link sweep} drops idle keys.
 */
export class SlidingWindow {
  readonly #events = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  #recent(key: string, now: number): number[] {
    const list = this.#events.get(key) ?? [];
    let drop = 0;
    while (drop < list.length && (list[drop] ?? 0) <= now - this.windowMs) drop++;
    if (drop > 0) list.splice(0, drop);
    return list;
  }

  /** Records an event for `key`; false (and nothing recorded) when the key is over the limit. */
  hit(key: string, now: number): boolean {
    const list = this.#recent(key, now);
    if (list.length >= this.limit) {
      this.#events.set(key, list);
      return false;
    }
    list.push(now);
    this.#events.set(key, list);
    return true;
  }

  /** Events counted for `key` in the current window. */
  count(key: string, now: number): number {
    return this.#recent(key, now).length;
  }

  /** Forgets keys with no events in the window. */
  sweep(now: number): void {
    for (const key of [...this.#events.keys()])
      if (this.#recent(key, now).length === 0) this.#events.delete(key);
  }

  /** Number of tracked keys. */
  get size(): number {
    return this.#events.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Message validation (SPEC §9.6)
// ---------------------------------------------------------------------------------------------

const id64 = z.string().min(1).max(64);
const pollId = z.string().min(1).max(64);

const hostCommandSchema = z.discriminatedUnion("c", [
  z.object({ c: z.literal("config"), patch: roomConfigPatchSchema }),
  z.object({
    c: z.literal("playlist.set"),
    items: z
      .array(
        z.object({
          gameId: z.enum(GAME_IDS),
          options: z.record(z.string().max(64), z.unknown()).default({}),
          label: z.string().max(40).optional(),
        }),
      )
      .max(32),
  }),
  z.object({ c: z.literal("start") }),
  z.object({ c: z.literal("next") }),
  z.object({ c: z.literal("pause") }),
  z.object({ c: z.literal("resume") }),
  z.object({ c: z.literal("endGame") }),
  z.object({ c: z.literal("forceAdvance") }),
  z.object({ c: z.literal("kick"), id: id64, ban: z.boolean().optional() }),
  z.object({
    c: z.literal("promote"),
    id: id64,
    role: z.enum(["moderator", "player", "audience"]),
  }),
  z.object({ c: z.literal("team.assign"), id: id64, teamId: id64.nullable() }),
  z.object({ c: z.literal("revealCode"), on: z.boolean() }),
  z.object({ c: z.literal("ambient"), mode: z.enum(["day", "dusk", "night", "rain", "snow"]) }),
  z.object({ c: z.literal("transferHost"), id: id64 }),
  z.object({ c: z.literal("raffle"), n: z.number().int().min(1).max(12) }),
  z.object({ c: z.literal("bench"), ids: z.array(id64).max(12) }),
  z.object({ c: z.literal("fillBots"), on: z.boolean() }),
]);

const modCommandSchema = z.discriminatedUnion("c", [
  z.object({ c: z.literal("approve"), itemId: id64 }),
  z.object({ c: z.literal("reject"), itemId: id64 }),
  z.object({
    c: z.literal("mute"),
    id: id64,
    minutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
  }),
  z.object({ c: z.literal("rename"), id: id64, name: z.string().min(1).max(64) }),
]);

const c2sSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.number(),
    code: z.string().max(16),
    token: z.string().max(64).optional(),
    name: z.string().max(64).optional(),
    want: z.enum(["player", "audience", "overlay", "moderator"]),
    overlayKey: z.string().max(64).optional(),
    password: z.string().max(128).optional(),
  }),
  z.object({
    t: z.literal("create"),
    v: z.number(),
    name: z.string().max(64),
    config: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("act"),
    id: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31),
    a: z.unknown(),
  }),
  z.object({
    t: z.literal("aud"),
    pollId,
    choice: z.union([z.string().max(200), z.number().finite()]),
  }),
  z.object({ t: z.literal("tap"), pollId, n: z.number().int().min(1).max(10) }),
  z.object({ t: z.literal("audAct"), a: z.unknown() }),
  z.object({ t: z.literal("enroll"), skin: z.number().int().min(0).max(47) }),
  z.object({ t: z.literal("react"), e: z.enum(REACTION_IDS) }),
  z.object({ t: z.literal("queue"), join: z.boolean() }),
  z.object({ t: z.literal("host"), cmd: hostCommandSchema }),
  z.object({ t: z.literal("mod"), cmd: modCommandSchema }),
  z.object({ t: z.literal("resync"), lastSeq: z.number().int().min(0) }),
  z.object({ t: z.literal("bg"), on: z.boolean() }),
  z.object({ t: z.literal("ping"), ts: z.number().finite() }),
]);

/**
 * `hello`/`create` with `v` left as a number, so a client on another protocol version gets a
 * `VERSION` error instead of a generic parse failure.
 */
export type ParsedC2S =
  | Exclude<C2S, { t: "hello" } | { t: "create" }>
  | (Omit<Extract<C2S, { t: "hello" }>, "v"> & { v: number })
  | (Omit<Extract<C2S, { t: "create" }>, "v" | "config"> & { v: number; config?: unknown });

/** Result of {@link parseC2S}. */
export type ParseResult = { ok: true; msg: ParsedC2S } | { ok: false; error: string };

/** Validates a decoded client frame against the protocol. Unknown fields are stripped. */
export function parseC2S(value: unknown): ParseResult {
  const r = c2sSchema.safeParse(value);
  if (r.success) return { ok: true, msg: r.data as ParsedC2S };
  const first = r.error.issues[0];
  return {
    ok: false,
    error: first ? `${first.path.join(".") || "message"}: ${first.message}` : "malformed message",
  };
}

// Compile-time proof that the schemas produce protocol types. The `config` patch is
// the exception: it is validated as a deep partial and merged by `applyRoomConfigPatch`.
type Assert<T extends true> = T;
export type _HostCommandMatches = Assert<
  Exclude<z.output<typeof hostCommandSchema>, { c: "config" }> extends HostCommand ? true : false
>;
export type _ModCommandMatches = Assert<
  z.output<typeof modCommandSchema> extends ModCommand ? true : false
>;

// ---------------------------------------------------------------------------------------------
// Role gate (SPEC §2, §9.7)
// ---------------------------------------------------------------------------------------------

/** Messages a joined socket may send, and the roles allowed to send each. */
export const MESSAGE_ROLES: Readonly<
  Record<Exclude<C2SType, "hello" | "create">, readonly Role[]>
> = {
  act: ["player"],
  aud: ["audience"],
  tap: ["audience"],
  audAct: ["audience"],
  enroll: ["audience"],
  react: ["audience", "player", "moderator"],
  queue: ["audience"],
  host: ["host", "moderator"],
  mod: ["host", "moderator"],
  resync: ["host", "player", "audience", "moderator", "overlay"],
  bg: ["host", "player", "audience", "moderator", "overlay"],
  ping: ["host", "player", "audience", "moderator", "overlay"],
};

/** Host commands a moderator may also send (SPEC §2: kick and pause). */
export const MODERATOR_HOST_COMMANDS: ReadonlySet<HostCommand["c"]> = new Set([
  "kick",
  "pause",
  "resume",
]);

/**
 * Whether a session with `role` may send `msg`. Overlays are read-only: they may only ping,
 * resync and report visibility. Moderators get the moderation commands plus kick/pause.
 */
export function gate(role: Role, msg: ParsedC2S): boolean {
  if (msg.t === "hello" || msg.t === "create") return false;
  if (!MESSAGE_ROLES[msg.t].includes(role)) return false;
  if (msg.t === "host" && role === "moderator") return MODERATOR_HOST_COMMANDS.has(msg.cmd.c);
  return true;
}
