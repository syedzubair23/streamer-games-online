/**
 * Wire codecs (SPEC §9.5, §9.6).
 *
 * - **JSON text frames** carry every control message and view: {@link encodeMessage},
 *   {@link decodeMessage}, and {@link viewUpdate}, which picks `patch` or `full` using the
 *   60 % rule.
 * - **Binary frames** are Marble Rally only, little-endian, byte 0 = frame type:
 *   `0x01` race snapshot, `0x02` ranking, `0x03` your rank.
 *
 * Decoders never throw on untrusted input: they return `null` (binary) or `{ ok: false }` (JSON).
 * Encoders throw `RangeError` when the caller passes values that do not fit the wire format.
 *
 * @module
 */
import { diff } from "./diff.ts";
import type { C2S, S2C } from "./protocol.ts";
import type { GameId } from "./room.ts";

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

/** `maxPayloadLength` for WebSocket messages: 16 KB (SPEC §9.5). */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** A patch is sent only while its encoded size is at most this fraction of the full view (SPEC §9.6). */
export const PATCH_FULL_RATIO = 0.6;

/** Result of {@link decodeMessage}. */
export type DecodeResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Serialises a protocol message for a JSON text frame. */
export function encodeMessage(message: C2S | S2C): string {
  return JSON.stringify(message);
}

/**
 * Parses a text frame. Accepts a string or UTF-8 bytes. It checks only that the frame is
 * well-formed JSON, is an object with a string `t` tag, and is within `maxBytes`
 * (default {@link MAX_PAYLOAD_BYTES}); validating the message shape is the receiver's job.
 */
export function decodeMessage(
  data: string | ArrayBuffer | Uint8Array,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): DecodeResult {
  let text: string;
  if (typeof data === "string") {
    if (utf8Length(data) > maxBytes) return { ok: false, error: "payload too large" };
    text = data;
  } else {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength > maxBytes) return { ok: false, error: "payload too large" };
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: "invalid UTF-8" };
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "message must be a JSON object" };
  }
  if (typeof (value as { t?: unknown }).t !== "string") {
    return { ok: false, error: "message has no string `t` tag" };
  }
  return { ok: true, value };
}

/** The UTF-8 byte length of a string, without allocating. Lone surrogates count as 3 bytes (U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** A `view` or `patch` message, already serialised. */
export interface ViewUpdate {
  message: Extract<S2C, { t: "view" } | { t: "patch" }>;
  /** `encodeMessage(message)`, so fan-out can reuse one buffer per viewer key (SPEC §9.5). */
  text: string;
}

/**
 * Builds the message that brings a viewer from `prev` to `next`: a `patch` when one exists and
 * the encoded patch message is at most {@link PATCH_FULL_RATIO} of the encoded full-view
 * message's UTF-8 size, otherwise a full
 * `view`. With `prev === null` (join, resync, game start) it is always a full view. Returns
 * `null` when nothing changed.
 */
export function viewUpdate(
  seq: number,
  game: GameId,
  prev: unknown,
  next: unknown,
): ViewUpdate | null {
  const fullMessage: ViewUpdate["message"] = { t: "view", seq, game, full: next };
  if (prev === null) return { message: fullMessage, text: encodeMessage(fullMessage) };
  const ops = diff(prev, next);
  if (ops.length === 0) return null;
  const fullText = encodeMessage(fullMessage);
  const patchMessage: ViewUpdate["message"] = { t: "patch", seq, ops };
  const patchText = encodeMessage(patchMessage);
  if (utf8Length(patchText) <= PATCH_FULL_RATIO * utf8Length(fullText)) {
    return { message: patchMessage, text: patchText };
  }
  return { message: fullMessage, text: fullText };
}

// ---------------------------------------------------------------------------------------------
// Binary frames (Marble Rally)
// ---------------------------------------------------------------------------------------------

/** `0x01` race snapshot, stage topic, 10 Hz. */
export const FRAME_RACE_SNAPSHOT = 0x01;
/** `0x02` ranking, stage topic only, 2 Hz. */
export const FRAME_RANKING = 0x02;
/** `0x03` your rank, one per enrolled socket via `streamEach`, 1 Hz. */
export const FRAME_YOUR_RANK = 0x03;

/** Header bytes of a `0x01` frame: `u8 type, u16 seq, u32 raceMs, u16 count`. */
export const RACE_SNAPSHOT_HEADER_BYTES = 9;
/** Bytes per marble in a `0x01` frame: `u16 id, i16 x, i16 y`. */
export const RACE_SNAPSHOT_MARBLE_BYTES = 6;
/** Header bytes of a `0x02` frame: `u8 type, u16 seq, u16 n`. */
export const RANKING_HEADER_BYTES = 5;
/** Size of a `0x03` frame: `u8 type, u16 rank, u16 n, u8 checkpoint, u8 flags`. */
export const YOUR_RANK_BYTES = 7;

/** Top bit of `count` in a `0x01` frame marks a full keyframe (sent every 2 s). */
const KEYFRAME_BIT = 0x8000;
/** Most marbles a single `0x01` frame can carry (`count` keeps its top bit for the keyframe flag). */
export const RACE_SNAPSHOT_MAX_MARBLES = 0x7fff;

/** One marble in a race snapshot, in quantized units (2 world units per step). */
export interface MarblePos {
  id: number;
  x: number;
  y: number;
}

/** A decoded `0x01` race snapshot. */
export interface RaceSnapshot {
  type: typeof FRAME_RACE_SNAPSHOT;
  seq: number;
  raceMs: number;
  /** A full keyframe lists every marble; a delta frame lists only the ones that moved ≥ 1 step. */
  keyframe: boolean;
  marbles: MarblePos[];
}

/** A decoded `0x02` ranking: marble ids in current race order. */
export interface RankingFrame {
  type: typeof FRAME_RANKING;
  seq: number;
  ids: number[];
}

/** A decoded `0x03` "your rank" frame. */
export interface YourRankFrame {
  type: typeof FRAME_YOUR_RANK;
  rank: number;
  n: number;
  checkpoint: number;
  dnf: boolean;
  finished: boolean;
}

/** Any decoded binary frame. */
export type BinaryFrame = RaceSnapshot | RankingFrame | YourRankFrame;

/**
 * Quantizes a solver position for the wire: the solver's fixed-point value (1/16 world unit)
 * divided by 32, rounded toward −∞, i.e. 2 world units per step (SPEC §9.6).
 */
export function quantizeFixed(fixed: number): number {
  return Math.floor(fixed / 32);
}

/** World units for a quantized wire coordinate (the inverse of {@link quantizeFixed}, to the step). */
export function quantizedToWorld(q: number): number {
  return q * 2;
}

/** Wraps a running counter into the `u16` wire `seq` (`seq` wraps at 65,536). */
export function wrapSeq(seq: number): number {
  return ((seq % 0x10000) + 0x10000) % 0x10000;
}

/** Encodes a `0x01` race snapshot. */
export function encodeRaceSnapshot(frame: Omit<RaceSnapshot, "type">): Uint8Array<ArrayBuffer> {
  const { seq, raceMs, keyframe, marbles } = frame;
  checkUint("seq", seq, 0xffff);
  checkUint("raceMs", raceMs, 0xffffffff);
  if (marbles.length > RACE_SNAPSHOT_MAX_MARBLES) {
    throw new RangeError(`race snapshot: at most ${RACE_SNAPSHOT_MAX_MARBLES} marbles per frame`);
  }
  const out = new Uint8Array(
    RACE_SNAPSHOT_HEADER_BYTES + marbles.length * RACE_SNAPSHOT_MARBLE_BYTES,
  );
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_RACE_SNAPSHOT);
  view.setUint16(1, seq, true);
  view.setUint32(3, raceMs, true);
  view.setUint16(7, marbles.length | (keyframe ? KEYFRAME_BIT : 0), true);
  let at = RACE_SNAPSHOT_HEADER_BYTES;
  for (const m of marbles) {
    checkUint("marble id", m.id, 0xffff);
    checkInt16("marble x", m.x);
    checkInt16("marble y", m.y);
    view.setUint16(at, m.id, true);
    view.setInt16(at + 2, m.x, true);
    view.setInt16(at + 4, m.y, true);
    at += RACE_SNAPSHOT_MARBLE_BYTES;
  }
  return out;
}

/** Decodes a `0x01` race snapshot, or returns `null` if the bytes are not a well-formed one. */
export function decodeRaceSnapshot(data: ArrayBuffer | Uint8Array): RaceSnapshot | null {
  const view = toView(data);
  if (view.byteLength < RACE_SNAPSHOT_HEADER_BYTES || view.getUint8(0) !== FRAME_RACE_SNAPSHOT) {
    return null;
  }
  const rawCount = view.getUint16(7, true);
  const count = rawCount & RACE_SNAPSHOT_MAX_MARBLES;
  if (view.byteLength !== RACE_SNAPSHOT_HEADER_BYTES + count * RACE_SNAPSHOT_MARBLE_BYTES)
    return null;
  const marbles: MarblePos[] = new Array<MarblePos>(count);
  let at = RACE_SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    marbles[i] = {
      id: view.getUint16(at, true),
      x: view.getInt16(at + 2, true),
      y: view.getInt16(at + 4, true),
    };
    at += RACE_SNAPSHOT_MARBLE_BYTES;
  }
  return {
    type: FRAME_RACE_SNAPSHOT,
    seq: view.getUint16(1, true),
    raceMs: view.getUint32(3, true),
    keyframe: (rawCount & KEYFRAME_BIT) !== 0,
    marbles,
  };
}

/** Encodes a `0x02` ranking frame (marble ids in race order). */
export function encodeRanking(frame: Omit<RankingFrame, "type">): Uint8Array<ArrayBuffer> {
  const { seq, ids } = frame;
  checkUint("seq", seq, 0xffff);
  if (ids.length > 0xffff) throw new RangeError("ranking: at most 65535 ids per frame");
  const out = new Uint8Array(RANKING_HEADER_BYTES + ids.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_RANKING);
  view.setUint16(1, seq, true);
  view.setUint16(3, ids.length, true);
  let at = RANKING_HEADER_BYTES;
  for (const id of ids) {
    checkUint("marble id", id, 0xffff);
    view.setUint16(at, id, true);
    at += 2;
  }
  return out;
}

/** Decodes a `0x02` ranking frame, or returns `null` if the bytes are not a well-formed one. */
export function decodeRanking(data: ArrayBuffer | Uint8Array): RankingFrame | null {
  const view = toView(data);
  if (view.byteLength < RANKING_HEADER_BYTES || view.getUint8(0) !== FRAME_RANKING) return null;
  const n = view.getUint16(3, true);
  if (view.byteLength !== RANKING_HEADER_BYTES + n * 2) return null;
  const ids = new Array<number>(n);
  for (let i = 0; i < n; i++) ids[i] = view.getUint16(RANKING_HEADER_BYTES + i * 2, true);
  return { type: FRAME_RANKING, seq: view.getUint16(1, true), ids };
}

/** Encodes a 7-byte `0x03` "your rank" frame. */
export function encodeYourRank(frame: Omit<YourRankFrame, "type">): Uint8Array<ArrayBuffer> {
  checkUint("rank", frame.rank, 0xffff);
  checkUint("n", frame.n, 0xffff);
  checkUint("checkpoint", frame.checkpoint, 0xff);
  const out = new Uint8Array(YOUR_RANK_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_YOUR_RANK);
  view.setUint16(1, frame.rank, true);
  view.setUint16(3, frame.n, true);
  view.setUint8(5, frame.checkpoint);
  view.setUint8(6, (frame.dnf ? 1 : 0) | (frame.finished ? 2 : 0));
  return out;
}

/** Decodes a `0x03` "your rank" frame, or returns `null` if the bytes are not a well-formed one. */
export function decodeYourRank(data: ArrayBuffer | Uint8Array): YourRankFrame | null {
  const view = toView(data);
  if (view.byteLength !== YOUR_RANK_BYTES || view.getUint8(0) !== FRAME_YOUR_RANK) return null;
  const flags = view.getUint8(6);
  return {
    type: FRAME_YOUR_RANK,
    rank: view.getUint16(1, true),
    n: view.getUint16(3, true),
    checkpoint: view.getUint8(5),
    dnf: (flags & 1) !== 0,
    finished: (flags & 2) !== 0,
  };
}

/** Decodes any binary frame by its type byte, or returns `null` for unknown or malformed frames. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): BinaryFrame | null {
  const view = toView(data);
  if (view.byteLength === 0) return null;
  switch (view.getUint8(0)) {
    case FRAME_RACE_SNAPSHOT:
      return decodeRaceSnapshot(data);
    case FRAME_RANKING:
      return decodeRanking(data);
    case FRAME_YOUR_RANK:
      return decodeYourRank(data);
    default:
      return null;
  }
}

function toView(data: ArrayBuffer | Uint8Array): DataView {
  return data instanceof Uint8Array
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
}

function checkUint(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer in [0, ${max}], got ${value}`);
  }
}

function checkInt16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new RangeError(`${name} must be an integer in [-32768, 32767], got ${value}`);
  }
}
