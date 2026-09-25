/**
 * `parseAction` for Quip Clash: turns an untrusted wire payload into a {@link QcAction}, or null.
 * Never throws (SPEC §9.3). Only the fields of the action survive; Last Quip allocations are
 * rebuilt into a fresh plain object with slot keys `c1..c8` only.
 *
 * @module
 */
import type { QcAction } from "./types.ts";

/** Raw text longer than this is refused before any cleaning (the answer cap is 45). */
export const RAW_TEXT_MAX = 400;
const ID_MAX = 64;
const SLOT = /^c[1-8]$/;

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= ID_MAX;

/** Parses an action payload; null for anything malformed. */
export function parseAction(raw: unknown): QcAction | null {
  if (!isRecord(raw)) return null;
  switch (raw["type"]) {
    case "answer": {
      const { promptId, text } = raw;
      if (!isId(promptId) || typeof text !== "string" || text.length > RAW_TEXT_MAX) return null;
      return { type: "answer", promptId, text };
    }
    case "safety": {
      const { promptId } = raw;
      return isId(promptId) ? { type: "safety", promptId } : null;
    }
    case "vote": {
      const { choice } = raw;
      return choice === "A" || choice === "B" ? { type: "vote", choice } : null;
    }
    case "lastVote": {
      const { alloc } = raw;
      if (!isRecord(alloc)) return null;
      const entries = Object.entries(alloc);
      if (entries.length === 0 || entries.length > 8) return null;
      const out: Record<string, number> = {};
      for (const [slot, n] of entries) {
        if (!SLOT.test(slot) || typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 3) {
          return null;
        }
        out[slot] = n;
      }
      return { type: "lastVote", alloc: out };
    }
    default:
      return null;
  }
}
