/**
 * The network protocol (SPEC §9.6). `C2S`, `HostCommand`, `ModCommand`, `S2C`, `PatchOp` and
 * `ErrorCode` are copied exactly from the spec (`test/spec-sync.test.ts` fails if they drift).
 * The spec leaves the supporting types (`Me`, `RoomSnapshot`, `PublicPoll`, `PublicPollResult`,
 * `ReactionId`, `ModItem`) to this file; they are defined below the copied block.
 *
 * Each client opens one WebSocket at `/ws`. JSON text frames carry control messages and views
 * (see `codec.ts`); binary frames are used only by Marble Rally.
 *
 * @module
 */
import type { AudId, PlayerId, TeamId } from "./ids.ts";
import type { AmbientMode, GameId, PlaylistItem, RoomConfig } from "./room.ts";

/** Bumped on any breaking change to the messages below; `hello`/`create` carry it as `v`. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Copied exactly from SPEC §9.6.
// ---------------------------------------------------------------------------------------------

// prettier-ignore
export type C2S =
  | { t: "hello"; v: 1; code: string; token?: string; name?: string; want: "player" | "audience" | "overlay" | "moderator"; overlayKey?: string; password?: string }
  | { t: "create"; v: 1; name: string; config?: Partial<RoomConfig> }
  | { t: "act"; id: number; a: unknown }                                   // player game action, acked
  | { t: "aud"; pollId: string; choice: string | number }                   // vote/predict/quiz option id, dial int, guess text
  | { t: "tap"; pollId: string; n: number }                                 // batched taps, n ≤ 10
  | { t: "audAct"; a: unknown }                                             // direct audience action (marble-rally)
  | { t: "enroll"; skin: number }                                           // join an open audience enrolment (marble-rally), skin 0..47
  | { t: "react"; e: ReactionId }
  | { t: "queue"; join: boolean }                                          // audience asks for next-round seat
  | { t: "host"; cmd: HostCommand }
  | { t: "mod"; cmd: ModCommand }
  | { t: "resync"; lastSeq: number }
  | { t: "bg"; on: boolean }                                               // tab hidden: drop cosmetic traffic
  | { t: "ping"; ts: number };

// prettier-ignore
export type HostCommand =
  | { c: "config"; patch: Partial<RoomConfig> } | { c: "playlist.set"; items: PlaylistItem[] }
  | { c: "start" } | { c: "next" } | { c: "pause" } | { c: "resume" } | { c: "endGame" } | { c: "forceAdvance" }
  | { c: "kick"; id: string; ban?: boolean } | { c: "promote"; id: string; role: "moderator" | "player" | "audience" }
  | { c: "team.assign"; id: string; teamId: string | null } | { c: "revealCode"; on: boolean }
  | { c: "ambient"; mode: AmbientMode } | { c: "transferHost"; id: string }
  | { c: "raffle"; n: number } | { c: "bench"; ids: string[] }       // seat raffle (§3.3); hand-pick participants for the next game (§3.4)
  | { c: "fillBots"; on: boolean }; // practice: fill empty seats up to minPlayers with bots
// prettier-ignore
export type ModCommand =
  | { c: "approve"; itemId: string } | { c: "reject"; itemId: string }
  | { c: "mute"; id: string; minutes: number } | { c: "rename"; id: string; name: string };

// prettier-ignore
export type S2C =
  | { t: "welcome"; v: 1; token: string; you: Me; room: RoomSnapshot; serverNow: number }
  | { t: "room"; seq: number; room: RoomSnapshot }                         // members, playlist, scoreboard, config (public parts)
  | { t: "view"; seq: number; game: GameId; full: unknown }
  | { t: "patch"; seq: number; ops: PatchOp[] }                            // if patch > 60% of full size, server sends full
  | { t: "fx"; events: { name: string; data?: unknown }[] }
  | { t: "poll"; poll: PublicPoll }                                        // PollSpec minus `accept`
  | { t: "tally"; pollId: string; tallies: Record<string, number>; total: number }  // ≤ 4 Hz
  | { t: "pollEnd"; pollId: string; result: PublicPollResult; you?: { correct?: boolean; points?: number; seeds?: number } }
  | { t: "reactions"; counts: Partial<Record<ReactionId, number>> }        // every 500 ms
  | { t: "modq"; items: ModItem[] }                                        // host + moderators only
  | { t: "ack"; id: number; ok: boolean; err?: string }
  | { t: "error"; code: ErrorCode; msg: string }
  | { t: "pong"; ts: number; serverNow: number };
// prettier-ignore
export type PatchOp = { op: "set"; path: (string | number)[]; value: unknown } | { op: "del"; path: (string | number)[] };
// prettier-ignore
export type ErrorCode = "BAD_CODE" | "ROOM_FULL" | "BANNED" | "BAD_PASSWORD" | "RATE_LIMIT" | "ILLEGAL" | "VERSION" | "NOT_ALLOWED" | "MUTED";

// ---------------------------------------------------------------------------------------------
// Supporting types referenced by the spec's protocol.
// ---------------------------------------------------------------------------------------------

/** Message tags, for exhaustive switches and routing tables. */
export type C2SType = C2S["t"];
/** Message tags, for exhaustive switches and routing tables. */
export type S2CType = S2C["t"];

/** Every error code, in spec order. */
export const ERROR_CODES = [
  "BAD_CODE",
  "ROOM_FULL",
  "BANNED",
  "BAD_PASSWORD",
  "RATE_LIMIT",
  "ILLEGAL",
  "VERSION",
  "NOT_ALLOWED",
  "MUTED",
] as const satisfies readonly ErrorCode[];

/** The 6 fixed audience emotes (SPEC §4 "Reactions"). */
export const REACTION_IDS = ["heart", "laugh", "wow", "clap", "fire", "sad"] as const;
/** One of the 6 fixed audience emotes. */
export type ReactionId = (typeof REACTION_IDS)[number];

/** True when `e` is one of the 6 fixed reaction ids. */
export function isReactionId(e: unknown): e is ReactionId {
  return typeof e === "string" && (REACTION_IDS as readonly string[]).includes(e);
}

/**
 * The role a session holds in a room (SPEC §2). The session decides roles; a client message
 * never can (SPEC §9.7). `host` is the Stage / host-panel owner.
 */
export type Role = "host" | "player" | "audience" | "moderator" | "overlay";

/** The identity the server hands back in `welcome`. */
export interface Me {
  /** `PlayerId` for host/player/moderator sessions, `AudId` for audience, a socket id for overlays. */
  id: PlayerId | AudId;
  role: Role;
  /** Display name after filtering and the 16-character cap (SPEC §3 step 3). */
  name: string;
  /** Seat index when seated, otherwise `null`. */
  seat: number | null;
  /** Identity colour slot 0..7 when seated (SPEC §13.3), otherwise `null`. */
  colorSlot: number | null;
  teamId?: TeamId;
}

/** Where the room is in its game loop (SPEC §3 step 6). */
export type RoomPhase = "lobby" | "intro" | "game" | "results" | "scoreboard" | "ended";

/** A seated member (host, player or moderator) as every client sees them. */
export interface MemberInfo {
  id: PlayerId;
  name: string;
  role: "host" | "player" | "moderator";
  /** Seat index, or `null` for a host/moderator who is not playing. */
  seat: number | null;
  /** Identity colour slot 0..7 (SPEC §13.3). */
  colorSlot: number;
  teamId?: TeamId;
  /** `false` while the member is inside the reconnect grace period (SPEC §3). */
  connected: boolean;
  /** Present when a bot currently plays this seat (takeover or "Fill with bots"). */
  bot?: true;
  /** Present when the member sits out the current game (SPEC §3 step 4). */
  benched?: true;
}

/** A room-level team (SPEC §5). */
export interface TeamInfo {
  id: TeamId;
  name: string;
  /** Default team colours are Tomato, Sky, Sunflower and Mint (SPEC §5). */
  colorSlot: number;
}

/** One row of the Night Champion standings (SPEC §5). */
export interface StandingRow {
  id: PlayerId | TeamId;
  name: string;
  points: number;
  /** 1-based; ties share the higher placement. */
  place: number;
}

/** `RoomConfig` minus its secrets: the password becomes a flag. */
export type PublicRoomConfig = Omit<RoomConfig, "password"> & { hasPassword: boolean };

/** The public room state sent in `welcome` and `room` (members, playlist, scoreboard, config). */
export interface RoomSnapshot {
  code: string;
  /** Increments whenever the room is recreated under the same code; invalidates old tokens (SPEC §9.5). */
  epoch: number;
  phase: RoomPhase;
  /** BRB is on (SPEC §3 step 7). */
  paused: boolean;
  hostId: PlayerId;
  members: MemberInfo[];
  audienceCount: number;
  /** Audience members asking to join the next round (SPEC §3 step 3). */
  queueCount: number;
  teams: TeamInfo[];
  config: PublicRoomConfig;
  /** Index into `config.playlist` of the current or next game; `-1` before the first game. */
  playlistIndex: number;
  /** The game being played, or `null` outside a game. */
  current: GameId | null;
  standings: StandingRow[];
}

/** Audience poll kinds (SPEC §4). */
export type PollKind = "vote" | "predict" | "quiz" | "dial" | "guess" | "tap";

/** What clients see of a poll: the engine's `PollSpec` minus the secret `accept` list. */
export interface PublicPoll {
  pollId: string;
  kind: PollKind;
  prompt: string;
  options?: { id: string; label: string }[];
  /** Server ms; clients convert with the `pong` clock offset. */
  closesAtMs: number;
  speedBonus?: boolean;
  teamSplit?: boolean;
  hideLive?: boolean;
  closeOn?: "deadline" | "event";
}

/** The broadcast result of a closed poll. */
export interface PublicPollResult {
  pollId: string;
  kind: PollKind;
  total: number;
  /** optionId → count; dial: bin index → count; tap: `{ taps }`. */
  tallies: Record<string, number>;
  byTeam?: Record<TeamId, Record<string, number>>;
  /** dial only. */
  mean?: number;
  /** guess only: the first 3 correct guessers. */
  firstCorrect?: { audId: AudId; name: string }[];
  /** The winning/correct option once the game resolves it (quiz, predict). */
  correct?: string;
}

/** An item waiting in the moderation queue (SPEC §9.7); sent to host panel and moderators only. */
export interface ModItem {
  itemId: string;
  kind: "text" | "drawing";
  ownerId: PlayerId | AudId;
  ownerName: string;
  /** Text, or a data URL / stroke preview for drawings. */
  preview: string;
  gameId: GameId | null;
  /** Server ms the item entered the queue. */
  createdAt: number;
  /** Server ms after which it resolves as rejected (the 20 s review-wait timeout). */
  expiresAt: number;
}
