import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  decodeMessage,
  decodeRaceSnapshot,
  decodeRanking,
  decodeYourRank,
  encodeMessage,
  encodeRaceSnapshot,
  encodeRanking,
  encodeYourRank,
  FRAME_RACE_SNAPSHOT,
  FRAME_RANKING,
  FRAME_YOUR_RANK,
  MAX_PAYLOAD_BYTES,
  PATCH_FULL_RATIO,
  quantizedToWorld,
  quantizeFixed,
  RACE_SNAPSHOT_MAX_MARBLES,
  utf8Length,
  viewUpdate,
  wrapSeq,
} from "../src/codec.ts";
import { apply } from "../src/diff.ts";
import type { C2S, S2C } from "../src/protocol.ts";
import { createRng } from "../src/rng.ts";

describe("JSON text frames", () => {
  it("round-trips protocol messages", () => {
    const messages: (C2S | S2C)[] = [
      { t: "hello", v: 1, code: "BCDF", want: "player", name: "Ada" },
      { t: "act", id: 3, a: { type: "move", to: 5 } },
      { t: "react", e: "heart" },
      { t: "host", cmd: { c: "raffle", n: 3 } },
      { t: "patch", seq: 9, ops: [{ op: "set", path: ["phase"], value: "reveal" }] },
      { t: "error", code: "RATE_LIMIT", msg: "slow down" },
      { t: "pong", ts: 1, serverNow: 2 },
    ];
    for (const m of messages) {
      const text = encodeMessage(m);
      expect(decodeMessage(text)).toEqual({ ok: true, value: m });
      expect(decodeMessage(new TextEncoder().encode(text))).toEqual({ ok: true, value: m });
      expect(decodeMessage(new TextEncoder().encode(text).buffer)).toEqual({ ok: true, value: m });
    }
  });

  it.each<[string, string | Uint8Array]>([
    ["invalid JSON", "{nope"],
    ["a JSON array", "[1,2]"],
    ["a JSON scalar", "42"],
    ["null", "null"],
    ["a missing tag", '{"x":1}'],
    ["a non-string tag", '{"t":5}'],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
  ])("rejects %s without throwing", (_name, input) => {
    const result = decodeMessage(input);
    expect(result.ok).toBe(false);
  });

  it("enforces the 16 KB payload cap on strings (by UTF-8 bytes) and bytes", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(16 * 1024);
    const pad = (n: number) => `{"t":"x","p":"${"a".repeat(n - 16)}"}`;
    expect(utf8Length(pad(MAX_PAYLOAD_BYTES))).toBe(MAX_PAYLOAD_BYTES);
    expect(decodeMessage(pad(MAX_PAYLOAD_BYTES)).ok).toBe(true);
    expect(decodeMessage(pad(MAX_PAYLOAD_BYTES + 1))).toEqual({
      ok: false,
      error: "payload too large",
    });
    expect(decodeMessage(new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toEqual({
      ok: false,
      error: "payload too large",
    });
    // Multi-byte characters count by bytes, not UTF-16 units.
    const emoji = `{"t":"x","p":"${"😀".repeat(5000)}"}`;
    expect(emoji.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(decodeMessage(emoji).ok).toBe(false);
    expect(decodeMessage('{"t":"x"}', 5).ok).toBe(false);
  });

  it("utf8Length matches TextEncoder, including lone surrogates", () => {
    for (const s of ["", "abc", "é", "€", "😀", "a😀b€é", "\ud800", "x\udc00y", "\ud800x"]) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).byteLength);
    }
  });
});

describe("viewUpdate (patch vs full, SPEC §9.6)", () => {
  const big = {
    phase: "play",
    deadline: 1000,
    players: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, score: 0 })),
  };

  it("sends a full view when there is no previous view", () => {
    const update = viewUpdate(1, "ludo", null, big);
    expect(update?.message).toEqual({ t: "view", seq: 1, game: "ludo", full: big });
    expect(update?.text).toBe(encodeMessage(update!.message));
  });

  it("returns null when nothing changed", () => {
    expect(viewUpdate(2, "ludo", big, structuredClone(big))).toBeNull();
  });

  it("sends a patch for a small change and it applies back to the next view", () => {
    const next = { ...big, phase: "reveal" };
    const update = viewUpdate(2, "ludo", big, next);
    expect(update?.message.t).toBe("patch");
    if (update?.message.t !== "patch") throw new Error("expected patch");
    expect(update.message.seq).toBe(2);
    expect(apply(big, update.message.ops)).toEqual(next);
    expect(update.text).toBe(encodeMessage(update.message));
  });

  it("falls back to a full view when the patch exceeds 60% of the full size", () => {
    expect(PATCH_FULL_RATIO).toBe(0.6);
    const next = {
      phase: "reveal",
      deadline: 2000,
      players: big.players.map((p) => ({ ...p, name: `${p.name}!`, score: 9 })),
    };
    const update = viewUpdate(3, "ludo", big, next);
    expect(update?.message).toEqual({ t: "view", seq: 3, game: "ludo", full: next });
  });

  it("keeps the 60% boundary: every chosen patch is ≤ 60% of the full message", () => {
    const rng = createRng("ratio");
    for (let k = 0; k < 500; k++) {
      const next = {
        ...big,
        players: big.players.map((p) => (rng.int(3) === 0 ? { ...p, score: rng.int(100) } : p)),
      };
      const update = viewUpdate(k, "ludo", big, next);
      if (update === null) continue;
      const fullText = encodeMessage({ t: "view", seq: k, game: "ludo", full: next });
      if (update.message.t === "patch") {
        expect(utf8Length(update.text)).toBeLessThanOrEqual(0.6 * utf8Length(fullText));
      } else {
        expect(update.text).toBe(fullText);
      }
    }
  });
});

describe("binary frames: 0x01 race snapshot", () => {
  it("has the exact little-endian layout from SPEC §9.6", () => {
    const bytes = encodeRaceSnapshot({
      seq: 0x0102,
      raceMs: 0x03040506,
      keyframe: false,
      marbles: [{ id: 0x0708, x: -2, y: 0x0a0b }],
    });
    expect(Array.from(bytes)).toEqual([
      0x01, // type
      0x02,
      0x01, // u16 seq
      0x06,
      0x05,
      0x04,
      0x03, // u32 raceMs
      0x01,
      0x00, // u16 count
      0x08,
      0x07, // u16 id
      0xfe,
      0xff, // i16 x = -2
      0x0b,
      0x0a, // i16 y
    ]);
  });

  it("round-trips and marks keyframes with the top bit of count", () => {
    const rng = createRng("race");
    const marbles = Array.from({ length: 500 }, (_, id) => ({
      id,
      x: rng.int(2049),
      y: rng.int(4097),
    }));
    for (const keyframe of [true, false]) {
      const frame = { seq: 65535, raceMs: 123_456, keyframe, marbles };
      const bytes = encodeRaceSnapshot(frame);
      expect(bytes.byteLength).toBe(9 + 6 * 500);
      expect(bytes[8]! & 0x80).toBe(keyframe ? 0x80 : 0);
      expect(decodeRaceSnapshot(bytes)).toEqual({ type: FRAME_RACE_SNAPSHOT, ...frame });
      expect(decodeFrame(bytes.buffer)).toEqual({ type: FRAME_RACE_SNAPSHOT, ...frame });
    }
    const empty = encodeRaceSnapshot({ seq: 0, raceMs: 0, keyframe: true, marbles: [] });
    expect(decodeRaceSnapshot(empty)?.marbles).toEqual([]);
  });

  it("decodes from a Uint8Array view at a non-zero offset (unaligned)", () => {
    const bytes = encodeRaceSnapshot({
      seq: 7,
      raceMs: 9,
      keyframe: false,
      marbles: [{ id: 1, x: -5, y: 6 }],
    });
    const host = new Uint8Array(bytes.byteLength + 3);
    host.set(bytes, 3);
    expect(decodeRaceSnapshot(host.subarray(3))?.marbles).toEqual([{ id: 1, x: -5, y: 6 }]);
  });

  it("rejects values that do not fit the wire format", () => {
    const ok = {
      seq: 0,
      raceMs: 0,
      keyframe: false,
      marbles: [] as { id: number; x: number; y: number }[],
    };
    expect(() => encodeRaceSnapshot({ ...ok, seq: 65536 })).toThrow(RangeError);
    expect(() => encodeRaceSnapshot({ ...ok, seq: -1 })).toThrow(RangeError);
    expect(() => encodeRaceSnapshot({ ...ok, raceMs: 2 ** 32 })).toThrow(RangeError);
    expect(() => encodeRaceSnapshot({ ...ok, marbles: [{ id: 70000, x: 0, y: 0 }] })).toThrow(
      RangeError,
    );
    expect(() => encodeRaceSnapshot({ ...ok, marbles: [{ id: 1, x: 32768, y: 0 }] })).toThrow(
      RangeError,
    );
    expect(() => encodeRaceSnapshot({ ...ok, marbles: [{ id: 1, x: 0, y: -32769 }] })).toThrow(
      RangeError,
    );
    expect(() => encodeRaceSnapshot({ ...ok, marbles: [{ id: 1, x: 0.5, y: 0 }] })).toThrow(
      RangeError,
    );
    const tooMany = Array.from({ length: RACE_SNAPSHOT_MAX_MARBLES + 1 }, (_, id) => ({
      id: id & 0xffff,
      x: 0,
      y: 0,
    }));
    expect(() => encodeRaceSnapshot({ ...ok, marbles: tooMany })).toThrow(RangeError);
  });

  it("returns null for malformed frames", () => {
    const good = encodeRaceSnapshot({
      seq: 1,
      raceMs: 1,
      keyframe: false,
      marbles: [{ id: 1, x: 1, y: 1 }],
    });
    expect(decodeRaceSnapshot(good.subarray(0, good.byteLength - 1))).toBeNull(); // truncated
    expect(decodeRaceSnapshot(new Uint8Array([...good, 0]))).toBeNull(); // trailing byte
    expect(decodeRaceSnapshot(new Uint8Array([0x01, 0, 0]))).toBeNull(); // short header
    expect(decodeRaceSnapshot(encodeRanking({ seq: 1, ids: [] }))).toBeNull(); // wrong type
  });

  it("quantizes solver positions to 2 world units per step and fits i16", () => {
    // The 4096×8192 world in 1/16-unit fixed point spans 0..65536 × 0..131072.
    expect(quantizeFixed(0)).toBe(0);
    expect(quantizeFixed(31)).toBe(0);
    expect(quantizeFixed(32)).toBe(1);
    expect(quantizeFixed(-1)).toBe(-1);
    expect(quantizeFixed(4096 * 16)).toBe(2048);
    expect(quantizeFixed(8192 * 16)).toBe(4096);
    expect(quantizedToWorld(quantizeFixed(8192 * 16))).toBe(8192);
    expect(() =>
      encodeRaceSnapshot({
        seq: 0,
        raceMs: 0,
        keyframe: true,
        marbles: [{ id: 0, x: 2048, y: 4096 }],
      }),
    ).not.toThrow();
  });

  it("wrapSeq keeps seq in u16", () => {
    expect(wrapSeq(0)).toBe(0);
    expect(wrapSeq(65535)).toBe(65535);
    expect(wrapSeq(65536)).toBe(0);
    expect(wrapSeq(70000)).toBe(70000 - 65536);
    expect(wrapSeq(-1)).toBe(65535);
  });
});

describe("binary frames: 0x02 ranking", () => {
  it("has the exact layout and round-trips", () => {
    const bytes = encodeRanking({ seq: 0x0201, ids: [5, 0x0304] });
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0x02, 0x02, 0x00, 0x05, 0x00, 0x04, 0x03]);
    expect(decodeRanking(bytes)).toEqual({ type: FRAME_RANKING, seq: 0x0201, ids: [5, 0x0304] });
    const ids = Array.from({ length: 500 }, (_, i) => 499 - i);
    expect(decodeFrame(encodeRanking({ seq: 9, ids }))).toEqual({
      type: FRAME_RANKING,
      seq: 9,
      ids,
    });
  });

  it("validates input and rejects malformed frames", () => {
    expect(() => encodeRanking({ seq: 70000, ids: [] })).toThrow(RangeError);
    expect(() => encodeRanking({ seq: 1, ids: [-1] })).toThrow(RangeError);
    expect(() => encodeRanking({ seq: 1, ids: new Array<number>(65536).fill(0) })).toThrow(
      RangeError,
    );
    const good = encodeRanking({ seq: 1, ids: [1, 2] });
    expect(decodeRanking(good.subarray(0, 6))).toBeNull();
    expect(decodeRanking(new Uint8Array([0x02, 0]))).toBeNull();
    expect(decodeRanking(new Uint8Array([0x01, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("binary frames: 0x03 your rank", () => {
  it("is 7 bytes with the exact layout and round-trips flags", () => {
    const bytes = encodeYourRank({
      rank: 0x0102,
      n: 0x0304,
      checkpoint: 5,
      dnf: true,
      finished: false,
    });
    expect(Array.from(bytes)).toEqual([0x03, 0x02, 0x01, 0x04, 0x03, 0x05, 0x01]);
    for (const dnf of [true, false]) {
      for (const finished of [true, false]) {
        const frame = { rank: 12, n: 500, checkpoint: 3, dnf, finished };
        expect(decodeFrame(encodeYourRank(frame))).toEqual({ type: FRAME_YOUR_RANK, ...frame });
      }
    }
  });

  it("validates input and rejects malformed frames", () => {
    expect(() =>
      encodeYourRank({ rank: 1, n: 1, checkpoint: 256, dnf: false, finished: false }),
    ).toThrow(RangeError);
    expect(() =>
      encodeYourRank({ rank: -1, n: 1, checkpoint: 0, dnf: false, finished: false }),
    ).toThrow(RangeError);
    expect(decodeYourRank(new Uint8Array(6).fill(3))).toBeNull();
    expect(decodeYourRank(new Uint8Array([0x02, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("decodeFrame", () => {
  it("returns null for empty or unknown frames", () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(new Uint8Array([0x09, 1, 2]))).toBeNull();
  });
});
