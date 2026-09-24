/**
 * The visual QA rubric as data, parsed from `docs/critic/RUBRIC.md` (a copy of DOD §4) so the
 * harness never hard-codes item numbers, ★ gates or anchors that could drift from the document.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RUBRIC_PATH = "docs/critic/RUBRIC.md";

export interface RubricItem {
  id: number;
  name: string;
  /** ★ items are hard gates (DOD §4.2). */
  star: boolean;
  /** Scored once per game from the clips, never on a still. */
  clip: boolean;
  /** Scored only on 360×800 groups. */
  phone: boolean;
}

export interface Rubric {
  items: RubricItem[];
  /** Score anchors from §4.1, e.g. 10 → "Can't be told apart…". */
  anchors: Map<number, string>;
  text: string;
}

/** Parses the §4.1 anchor table and the §4.2 item table out of the rubric markdown. */
export function parseRubric(text: string): Rubric {
  const items: RubricItem[] = [];
  const anchors = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const item = /^\|\s*(\d{1,2})\s*(★)?\s*\|\s*\*\*(.+?)\*\*\s*(\((clip|phone)\))?[^|]*\|/.exec(
      line,
    );
    if (item) {
      items.push({
        id: Number(item[1]),
        name: item[3] ?? "",
        star: item[2] === "★",
        clip: item[5] === "clip",
        phone: item[5] === "phone",
      });
      continue;
    }
    const anchor = /^\|\s*\*\*(\d+(?:\.\d+)?)\*\*\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (anchor) anchors.set(Number(anchor[1]), anchor[2] ?? "");
  }
  if (items.length === 0) throw new Error("rubric: no items found in the §4.2 table");
  items.forEach((it, i) => {
    if (it.id !== i + 1)
      throw new Error(`rubric: items must be numbered 1..N (found ${it.id} at #${i + 1})`);
  });
  if (anchors.size === 0) throw new Error("rubric: no score anchors found in the §4.1 table");
  return { items, anchors, text };
}

export function loadRubric(root: string): Rubric {
  return parseRubric(readFileSync(join(root, RUBRIC_PATH), "utf8"));
}

/** Items that can be judged on one desktop still (no clip items, no phone-only items). */
export const stillItems = (r: Rubric): RubricItem[] => r.items.filter((i) => !i.clip && !i.phone);
