/**
 * `parseAction` for Odd One Out: turns an untrusted wire payload into an {@link OooAction}, or
 * null. Never throws (SPEC §9.3). Only the fields of the action survive; quick-chat lines
 * outside 0–7 are refused here (T10), and clue text longer than {@link RAW_TEXT_MAX} is refused
 * before any cleaning (the clue cap itself, R3, is checked by the reducer).
 *
 * @module
 */
import type { OooAction, QuickLine } from "./types.ts";

/** Raw clue / option text longer than this is refused outright. */
export const RAW_TEXT_MAX = 200;
const ID_MAX = 64;

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= ID_MAX;

const isLine = (v: unknown): v is QuickLine =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7;

/** Parses an action payload; null for anything malformed. */
export function parseAction(raw: unknown): OooAction | null {
  if (!isRecord(raw)) return null;
  switch (raw["type"]) {
    case "gotIt":
      return { type: "gotIt" };
    case "ready":
      return { type: "ready" };
    case "clue": {
      const { text } = raw;
      return typeof text === "string" && text.length <= RAW_TEXT_MAX
        ? { type: "clue", text }
        : null;
    }
    case "vote": {
      const { target } = raw;
      return isId(target) ? { type: "vote", target } : null;
    }
    case "guess": {
      const { option } = raw;
      return typeof option === "string" && option.length > 0 && option.length <= RAW_TEXT_MAX
        ? { type: "guess", option }
        : null;
    }
    case "point": {
      const { target } = raw;
      if (target === null) return { type: "point", target: null };
      return isId(target) ? { type: "point", target } : null;
    }
    case "quick": {
      const { line } = raw;
      return isLine(line) ? { type: "quick", line } : null;
    }
    default:
      return null;
  }
}
