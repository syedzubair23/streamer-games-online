/**
 * Identifier types and room-code helpers shared by the server, the client and every game.
 *
 * Ids are plain strings on the wire (views are JSON), so the aliases below are documentation
 * rather than brands: `Record<PlayerId, number>` stays a normal JSON object.
 *
 * @module
 */

/** A seated player's room-local id (stable across reconnects for the life of the seat). */
export type PlayerId = string;
/** A room-level team id (SPEC §5). */
export type TeamId = string;
/**
 * A room-local audience identity (SPEC §4). Twitch chat members use `tw:<userId>`
 * (see {@link twitchAudId}).
 */
export type AudId = string;

/** The 20 consonants room codes are drawn from (SPEC §3 step 1): no vowels, so no accidental words. */
export const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
/** Room codes are exactly 4 letters (SPEC §3). */
export const ROOM_CODE_LENGTH = 4;

const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/**
 * True when `code` is a syntactically valid room code: exactly {@link ROOM_CODE_LENGTH}
 * uppercase letters from {@link ROOM_CODE_ALPHABET}. It does not check the blocklist or
 * whether the room exists; the server owns both.
 */
export function isRoomCode(code: unknown): code is string {
  return typeof code === "string" && ROOM_CODE_RE.test(code);
}

/**
 * Normalises what a viewer typed into the join box ("  abcd " → "ABCD", "ab-cd" → "ABCD").
 * Returns `null` when the result is not a valid room code.
 */
export function normalizeRoomCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s\-_.]/g, "");
  return isRoomCode(code) ? code : null;
}

/** Prefix used for audience ids that come from Twitch chat (SPEC §4, M10-02). */
export const TWITCH_AUD_PREFIX = "tw:";

/** The audience id for a Twitch chat user: `tw:<userId>`. */
export function twitchAudId(userId: string): AudId {
  if (userId.length === 0) throw new RangeError("twitchAudId: userId must be non-empty");
  return `${TWITCH_AUD_PREFIX}${userId}`;
}

/** True when `id` is a Twitch-chat audience id (`tw:<userId>`). */
export function isTwitchAudId(id: AudId): boolean {
  return id.length > TWITCH_AUD_PREFIX.length && id.startsWith(TWITCH_AUD_PREFIX);
}
