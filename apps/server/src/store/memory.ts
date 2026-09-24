/**
 * Room persistence (SPEC §9.5). `MemoryStore` is the default; `SqliteStore` (M10-03,
 * `STORE=sqlite`) implements the same {@link Store} interface for crash restore.
 *
 * The interface is synchronous on purpose: both backends are synchronous (a `Map`, and
 * better-sqlite3), and a synchronous write keeps the room actor's ordering trivial.
 *
 * Records are deep-copied on the way in and out, so callers can never mutate stored state by
 * accident, and a memory-backed test behaves like the SQLite one.
 *
 * @module
 */
import type { AudId, PlayerId, RoomConfig, RoomPhase, TeamId } from "@sg/shared";

/** A persisted session (identity, role, seat) for reconnects and crash restore. */
export interface SessionRecord {
  /** The 128-bit session token (base64url). */
  token: string;
  id: PlayerId | AudId;
  role: "host" | "player" | "audience" | "moderator" | "overlay";
  name: string;
  seat: number | null;
  teamId?: TeamId;
  /** Salted hash of the joining IP (kick/ban, anti-snipe). */
  ipHash: string;
  /** Server ms the session was created. */
  joinedAt: number;
  /** Whether the audience member asked to join the next round. */
  queued?: boolean;
}

/** A persisted room: everything needed to rebuild membership after a restart. */
export interface RoomRecord {
  code: string;
  epoch: number;
  createdAt: number;
  config: RoomConfig;
  /** The 96-bit overlay key (base64url). */
  overlayKey: string;
  hostId: PlayerId;
  phase: RoomPhase;
  sessions: SessionRecord[];
  /**
   * Opaque state owned by the room actor (M1-02): the running game's snapshot, playlist
   * position and scoreboard. The store never looks inside.
   */
  actor?: unknown;
  /** Server ms of this write. */
  savedAt: number;
}

/** A finished game's result, for the optional server leaderboards (SqliteStore only). */
export interface ResultRecord {
  code: string;
  epoch: number;
  gameId: string;
  finishedAt: number;
  /** Opaque `GameResult` plus placement points. */
  result: unknown;
}

/** Where rooms are persisted. */
export interface Store {
  readonly kind: "memory" | "sqlite";
  /** Inserts or replaces a room. */
  saveRoom(record: RoomRecord): void;
  /** The stored room, or `null`. */
  loadRoom(code: string): RoomRecord | null;
  /** Every stored room (crash restore on boot). */
  listRooms(): RoomRecord[];
  /** Removes a room. */
  deleteRoom(code: string): void;
  /**
   * The next `roomEpoch` for a code: one more than any epoch this store has handed out for it
   * (SPEC §9.5), so a recreated room invalidates old tokens even across restarts.
   */
  nextEpoch(code: string): number;
  /** Appends a finished game's result. */
  saveResult(record: ResultRecord): void;
  /** Releases resources. */
  close(): void;
}

/** The in-process store: fast, and forgets everything when the process exits. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  readonly #rooms = new Map<string, RoomRecord>();
  readonly #epochs = new Map<string, number>();
  readonly #results: ResultRecord[] = [];
  /** Cap on kept results so a long-running process cannot grow without bound. */
  static readonly MAX_RESULTS = 10_000;

  saveRoom(record: RoomRecord): void {
    this.#rooms.set(record.code, structuredClone(record));
    if ((this.#epochs.get(record.code) ?? 0) < record.epoch)
      this.#epochs.set(record.code, record.epoch);
  }

  loadRoom(code: string): RoomRecord | null {
    const r = this.#rooms.get(code);
    return r === undefined ? null : structuredClone(r);
  }

  listRooms(): RoomRecord[] {
    return [...this.#rooms.values()].map((r) => structuredClone(r));
  }

  deleteRoom(code: string): void {
    this.#rooms.delete(code);
  }

  nextEpoch(code: string): number {
    const e = (this.#epochs.get(code) ?? 0) + 1;
    this.#epochs.set(code, e);
    return e;
  }

  saveResult(record: ResultRecord): void {
    this.#results.push(structuredClone(record));
    if (this.#results.length > MemoryStore.MAX_RESULTS) this.#results.shift();
  }

  /** Stored results, oldest first (copies). */
  results(): ResultRecord[] {
    return this.#results.map((r) => structuredClone(r));
  }

  close(): void {
    this.#rooms.clear();
  }
}
