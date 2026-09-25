/**
 * `parseAction` for Doodle: turns any wire payload into a {@link DoodleAction} or `null`.
 * Never throws. Shapes are checked here; game rules (whose turn, ranges, caps, rate limits)
 * are checked by `onAction`, which refuses illegal actions without changing the state.
 *
 * @module
 */
import type { DoodleAction } from "./types.ts";

/** Longest raw text accepted off the wire (the rule limit, 32 characters, is checked later). */
export const RAW_TEXT_MAX = 256;
/** Longest raw point list accepted off the wire (the 128-point batch rule is checked later). */
export const RAW_POINTS_MAX = 2 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(rec: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Parses a raw action payload. */
export function parseAction(raw: unknown): DoodleAction | null {
  if (!isRecord(raw)) return null;
  const type = own(raw, "type");
  switch (type) {
    case "pickWord": {
      const idx = own(raw, "idx");
      return idx === 0 || idx === 1 || idx === 2 ? { type, idx } : null;
    }
    case "stroke": {
      const id = own(raw, "id");
      const c = own(raw, "c");
      const s = own(raw, "s");
      const pts = own(raw, "pts");
      const done = own(raw, "done");
      if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
      if (typeof c !== "number" || !Number.isInteger(c)) return null;
      if (typeof s !== "number" || !Number.isInteger(s)) return null;
      if (typeof done !== "boolean") return null;
      if (!Array.isArray(pts) || pts.length > RAW_POINTS_MAX) return null;
      const out: number[] = [];
      for (const v of pts as unknown[]) {
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        out.push(v);
      }
      return { type, id, c, s, pts: out, done };
    }
    case "undo":
    case "clear":
    case "report":
      return { type };
    case "guess": {
      const text = own(raw, "text");
      return typeof text === "string" && text.length <= RAW_TEXT_MAX ? { type, text } : null;
    }
    default:
      return null;
  }
}
