import { describe, expect, expectTypeOf, it } from "vitest";
import * as shared from "../src/index.ts";
import {
  isRoomCode,
  isTwitchAudId,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  twitchAudId,
} from "../src/ids.ts";
import {
  ERROR_CODES,
  isReactionId,
  PROTOCOL_VERSION,
  REACTION_IDS,
  type C2S,
  type ErrorCode,
  type HostCommand,
  type ReactionId,
  type S2C,
} from "../src/protocol.ts";
import {
  AMBIENT_MODES,
  DEFAULT_ROOM_CONFIG,
  GAME_IDS,
  isGameId,
  ROOM_LIMITS,
  type AmbientMode,
  type GameId,
  type RoomConfig,
} from "../src/room.ts";

describe("room codes (SPEC §3)", () => {
  it("uses the 20 vowel-free consonants and 4 letters", () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(20);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[AEIOUY]/);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(20);
    expect(ROOM_CODE_LENGTH).toBe(4);
  });

  it.each([
    ["BCDF", true],
    ["ZZZZ", true],
    ["bcdf", false],
    ["ABCD", false],
    ["BCD", false],
    ["BCDFG", false],
    ["BC1F", false],
    ["", false],
  ])("isRoomCode(%j) === %s", (code, ok) => {
    expect(isRoomCode(code)).toBe(ok);
  });

  it("rejects non-strings", () => {
    expect(isRoomCode(1234)).toBe(false);
    expect(isRoomCode(null)).toBe(false);
  });

  it("normalizes what viewers type", () => {
    expect(normalizeRoomCode("  bcdf ")).toBe("BCDF");
    expect(normalizeRoomCode("bc-df")).toBe("BCDF");
    expect(normalizeRoomCode("abcd")).toBeNull();
    expect(normalizeRoomCode("")).toBeNull();
  });
});

describe("audience ids", () => {
  it("builds and recognises Twitch audience ids", () => {
    expect(twitchAudId("12345")).toBe("tw:12345");
    expect(isTwitchAudId("tw:12345")).toBe(true);
    expect(isTwitchAudId("tw:")).toBe(false);
    expect(isTwitchAudId("a1")).toBe(false);
    expect(() => twitchAudId("")).toThrow(RangeError);
  });
});

describe("RoomConfig defaults (SPEC §3, §4, §7, §8)", () => {
  it("match the spec's stated defaults", () => {
    expect(DEFAULT_ROOM_CONFIG).toMatchObject({
      maxAudience: 10_000,
      playlistMode: "audience-vote",
      antiSnipe: true,
      streamDelaySec: 3,
      audienceMin: 5,
      reconnectGraceSec: 60,
      theme: { ambient: "dusk" },
      timerScale: 1,
    });
    expect(DEFAULT_ROOM_CONFIG.password).toBeUndefined();
  });

  it("stay within ROOM_LIMITS", () => {
    const c = DEFAULT_ROOM_CONFIG;
    const within = (v: number, r: { min: number; max: number }) => v >= r.min && v <= r.max;
    expect(within(c.maxPlayers, ROOM_LIMITS.maxPlayers)).toBe(true);
    expect(within(c.maxAudience, ROOM_LIMITS.maxAudience)).toBe(true);
    expect(within(c.streamDelaySec, ROOM_LIMITS.streamDelaySec)).toBe(true);
    expect(within(c.audienceMin, ROOM_LIMITS.audienceMin)).toBe(true);
    expect(within(c.reconnectGraceSec, ROOM_LIMITS.reconnectGraceSec)).toBe(true);
    for (const level of [c.audio.music, c.audio.sfx, c.audio.ambience]) {
      expect(within(level, ROOM_LIMITS.audioLevel)).toBe(true);
    }
    expect(ROOM_LIMITS.maxPlayers.max).toBe(12);
    expect(ROOM_LIMITS.streamDelaySec.max).toBe(8);
  });

  it("are deeply frozen and survive structuredClone as a mutable copy", () => {
    expect(Object.isFrozen(DEFAULT_ROOM_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ROOM_CONFIG.theme)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ROOM_CONFIG.playlist)).toBe(true);
    const copy: RoomConfig = structuredClone(DEFAULT_ROOM_CONFIG) as RoomConfig;
    copy.theme.ambient = "night";
    expect(DEFAULT_ROOM_CONFIG.theme.ambient).toBe("dusk");
  });

  it("list every game id and ambient mode", () => {
    expect(GAME_IDS).toEqual([
      "quip-clash",
      "tune-in",
      "trivia-night",
      "doodle",
      "odd-one-out",
      "ludo",
      "chess",
      "marble-rally",
    ]);
    expect(AMBIENT_MODES).toEqual(["day", "dusk", "night", "rain", "snow"]);
    expect(isGameId("chess")).toBe(true);
    expect(isGameId("tictactoe")).toBe(false);
    expect(isGameId(3)).toBe(false);
    expectTypeOf<(typeof GAME_IDS)[number]>().toEqualTypeOf<GameId>();
    expectTypeOf<(typeof AMBIENT_MODES)[number]>().toEqualTypeOf<AmbientMode>();
  });
});

describe("protocol constants (SPEC §4, §9.6)", () => {
  it("PROTOCOL_VERSION is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("has the 6 fixed reactions", () => {
    expect(REACTION_IDS).toEqual(["heart", "laugh", "wow", "clap", "fire", "sad"]);
    expect(isReactionId("fire")).toBe(true);
    expect(isReactionId("poop")).toBe(false);
    expect(isReactionId(undefined)).toBe(false);
  });

  it("ERROR_CODES lists exactly the ErrorCode union", () => {
    expect(ERROR_CODES).toHaveLength(9);
    expectTypeOf<(typeof ERROR_CODES)[number]>().toEqualTypeOf<ErrorCode>();
  });

  it("message unions have the spec's tags", () => {
    expectTypeOf<C2S["t"]>().toEqualTypeOf<
      | "hello"
      | "create"
      | "act"
      | "aud"
      | "tap"
      | "audAct"
      | "enroll"
      | "react"
      | "queue"
      | "host"
      | "mod"
      | "resync"
      | "bg"
      | "ping"
    >();
    expectTypeOf<S2C["t"]>().toEqualTypeOf<
      | "welcome"
      | "room"
      | "view"
      | "patch"
      | "fx"
      | "poll"
      | "tally"
      | "pollEnd"
      | "reactions"
      | "modq"
      | "ack"
      | "error"
      | "pong"
    >();
    expectTypeOf<Extract<C2S, { t: "react" }>["e"]>().toEqualTypeOf<ReactionId>();
    expectTypeOf<Extract<HostCommand, { c: "ambient" }>["mode"]>().toEqualTypeOf<AmbientMode>();
  });
});

describe("package entry", () => {
  it("re-exports every module's runtime API", () => {
    for (const name of [
      "createRng",
      "rngFrom",
      "diff",
      "apply",
      "PatchError",
      "encodeMessage",
      "decodeMessage",
      "viewUpdate",
      "encodeRaceSnapshot",
      "decodeFrame",
      "normalize",
      "levenshtein",
      "filterText",
      "classifyGuess",
      "parsePack",
      "PACK_KINDS",
      "DEFAULT_ROOM_CONFIG",
      "GAME_IDS",
      "PROTOCOL_VERSION",
      "REACTION_IDS",
      "isRoomCode",
      "ROOM_CODE_ALPHABET",
    ]) {
      expect(shared, name).toHaveProperty(name);
    }
  });
});
