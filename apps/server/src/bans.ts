/**
 * Room bans (SPEC §9.7, ROADMAP M1-04): `kick { ban: true }` records the kicked session's
 * token, its salted IP hash and (once the Twitch plugin sets one) its Twitch id, and every
 * later join attempt that matches any of them is refused with `BANNED`.
 *
 * Bans are per room *instance*: they are keyed by room code and epoch, so a room code that is
 * released and re-issued (a new epoch) starts with a clean list, and they are forgotten when the
 * room is destroyed. IP hashes are salted per server (`ipHashSalt`), so the list never holds a
 * raw IP.
 *
 * @module
 */
import type { ErrorCode } from "@sg/shared";
import type { JoinAttempt, JoinGuard, ManagedRoom } from "./room-manager.ts";
import type { Session } from "./session.ts";

/** The identity keys a ban matches on. */
export interface BanKeys {
  token?: string | undefined;
  ipHash?: string | undefined;
  twitchId?: string | undefined;
}

/** One room instance's bans. */
interface RoomBans {
  tokens: Set<string>;
  ipHashes: Set<string>;
  twitchIds: Set<string>;
}

/** What a session may carry beyond the base fields (the Twitch plugin adds `twitchId`). */
type MaybeTwitch = Session & { twitchId?: string };

/** Room key: bans never leak into a later room that reuses the code. */
function keyOf(room: Pick<ManagedRoom, "code" | "epoch">): string {
  return `${room.code}#${room.epoch}`;
}

/** Every room's ban list on this server. See the module docs. */
export class BanList {
  readonly #rooms = new Map<string, RoomBans>();

  /** Bans `session` from `room`: its token, IP hash and Twitch id (if any). */
  ban(room: Pick<ManagedRoom, "code" | "epoch">, session: Session): void {
    const twitchId = (session as MaybeTwitch).twitchId;
    this.banKeys(room, {
      token: session.token,
      ipHash: session.ipHash,
      ...(twitchId !== undefined ? { twitchId } : {}),
    });
  }

  /** Bans raw identity keys (restore, admin tooling). Empty strings are ignored. */
  banKeys(room: Pick<ManagedRoom, "code" | "epoch">, keys: BanKeys): void {
    const e = this.#entry(room);
    if (keys.token) e.tokens.add(keys.token);
    if (keys.ipHash) e.ipHashes.add(keys.ipHash);
    if (keys.twitchId) e.twitchIds.add(keys.twitchId);
  }

  /** True when any of `keys` is banned in `room`. */
  isBanned(room: Pick<ManagedRoom, "code" | "epoch">, keys: BanKeys): boolean {
    const e = this.#rooms.get(keyOf(room));
    if (e === undefined) return false;
    return (
      (keys.token !== undefined && e.tokens.has(keys.token)) ||
      (keys.ipHash !== undefined && e.ipHashes.has(keys.ipHash)) ||
      (keys.twitchId !== undefined && e.twitchIds.has(keys.twitchId))
    );
  }

  /** Forgets a destroyed room's bans. */
  forget(room: Pick<ManagedRoom, "code" | "epoch">): void {
    this.#rooms.delete(keyOf(room));
  }

  /** Rooms with at least one ban (memory accounting, tests). */
  get roomCount(): number {
    return this.#rooms.size;
  }

  /**
   * The join guard for {@link RoomManager}: refuses a banned token or IP hash with `BANNED`
   * (the manager then closes the socket). It runs on every new join, including a banned
   * member's old token, which the kick made unknown to the room.
   */
  readonly guard: JoinGuard = (a: JoinAttempt): ErrorCode | null =>
    this.isBanned(a.room, { token: a.token, ipHash: a.ipHash }) ? "BANNED" : null;

  #entry(room: Pick<ManagedRoom, "code" | "epoch">): RoomBans {
    const k = keyOf(room);
    let e = this.#rooms.get(k);
    if (e === undefined) {
      e = { tokens: new Set(), ipHashes: new Set(), twitchIds: new Set() };
      this.#rooms.set(k, e);
    }
    return e;
  }
}
