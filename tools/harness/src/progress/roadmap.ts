/**
 * Extracts the list of roadmap items from `docs/ROADMAP.md`, so `progress.json` can be checked
 * (and seeded) against it: one entry per roadmap item ID.
 *
 * Items are defined in three shapes:
 *  - a heading: `### M0-03 Agent house rules + progress tooling`;
 *  - a table row whose first cell starts with a bold ID: `| **M10-01** Overlay layouts | …`;
 *  - a game milestone heading `### M4 \`trivia-night\``, which expands the standard item
 *    template (`| **Mx-01 Logic** | …`) and may add extra bold items in its body
 *    (`**M4-01b** covers Bluff mode logic`, `**M2-06 Golden promotion:** …`).
 */
import {
  CRITIC_GATES,
  DEFAULT_MAX_ROUNDS,
  GAME_GATES,
  PLATFORM_GATES,
  type Evidence,
  type ItemKind,
  type ProgressItem,
} from "./model.ts";

/** A roadmap item, before any progress state is attached. */
export interface RoadmapItem {
  id: string;
  title: string;
  milestone: string;
  kind: ItemKind;
  game: string | null;
}

/** Platform items judged by the visual critic (DOD P6 plus the critic-reviewed M10 items). */
const VISUAL_PLATFORM_ITEMS = new Set(["M1-05", "M1-07", "M1-09", "M10-01", "M10-08", "M10-09"]);
/** Template slots whose output is judged by the game's critic loop (Stage, Controller, Verify & critic). */
const VISUAL_GAME_SLOTS = new Set(["03", "04", "05"]);
/** Extra game items judged by the critic: M2-06 re-runs the platform scenarios against the golden. */
const VISUAL_GAME_EXTRAS = new Set(["M2-06"]);

const ITEM_ID = /^M(\d+)-(\d+)([a-z]?)$/;

/** Sort key for IDs like `M9-00b`: milestone, number, suffix. */
export function compareIds(a: string, b: string): number {
  const pa = ITEM_ID.exec(a);
  const pb = ITEM_ID.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  return (
    Number(pa[1]) - Number(pb[1]) ||
    Number(pa[2]) - Number(pb[2]) ||
    (pa[3] ?? "").localeCompare(pb[3] ?? "")
  );
}

const clean = (text: string): string =>
  text
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:.,;]+$/, "");

/** Parses ROADMAP.md into its items, sorted by ID. Throws on a duplicate definition. */
export function parseRoadmap(markdown: string): RoadmapItem[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const items = new Map<string, RoadmapItem>();
  const add = (item: RoadmapItem): void => {
    if (items.has(item.id)) throw new Error(`ROADMAP.md defines ${item.id} twice`);
    items.set(item.id, item);
  };

  // The game item template: `| **Mx-01 Logic** | …`.
  const template: { slot: string; title: string }[] = [];
  for (const line of lines) {
    const m = /^\|\s*\*\*Mx-(\d+) ([^*]+)\*\*/.exec(line);
    if (m?.[1] && m[2]) template.push({ slot: m[1], title: clean(m[2]) });
  }

  let game: { milestone: string; id: string } | null = null;
  for (const line of lines) {
    if (/^#{1,3} /.test(line)) game = null;

    const heading = /^### (M\d+-\d+[a-z]?) (.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      add({
        id: heading[1],
        title: clean(heading[2]),
        milestone: heading[1].split("-")[0] ?? "",
        kind: "platform",
        game: null,
      });
      continue;
    }

    const gameHeading = /^### (M\d+) `([a-z0-9-]+)`/.exec(line);
    if (gameHeading?.[1] && gameHeading[2]) {
      game = { milestone: gameHeading[1], id: gameHeading[2] };
      const n = gameHeading[1].slice(1);
      for (const { slot, title } of template) {
        add({
          id: `M${n}-${slot}`,
          title: `${game.id}: ${title}`,
          milestone: game.milestone,
          kind: "game",
          game: game.id,
        });
      }
      continue;
    }

    const row = /^\|\s*\*\*(M\d+-\d+[a-z]?)\*\*\s*([^|]*)\|/.exec(line);
    if (row?.[1] && !game) {
      add({
        id: row[1],
        title: clean(row[2] ?? "") || row[1],
        milestone: row[1].split("-")[0] ?? "",
        kind: "platform",
        game: null,
      });
      continue;
    }

    if (game) {
      const extra = /\*\*(M\d+-\d+[a-z]?)(?: ([^*]+?))?\*\*(?: covers ([^(]+))?/g;
      for (const m of line.matchAll(extra)) {
        const id = m[1];
        if (!id || !id.startsWith(`${game.milestone}-`) || items.has(id)) continue;
        const title = clean(m[2] ?? m[3] ?? "") || "extra";
        add({
          id,
          title: `${game.id}: ${title}`,
          milestone: game.milestone,
          kind: "game",
          game: game.id,
        });
      }
    }
  }

  return [...items.values()].sort((a, b) => compareIds(a.id, b.id));
}

/** Whether a passing critic report is required before `done`. */
export function isVisual(item: RoadmapItem): boolean {
  if (item.kind === "platform") return VISUAL_PLATFORM_ITEMS.has(item.id);
  return VISUAL_GAME_EXTRAS.has(item.id) || VISUAL_GAME_SLOTS.has(item.id.split("-")[1] ?? "");
}

/** Where an item's evidence lives (DOD §1, §2, §7, §8). */
export function evidenceFor(item: RoadmapItem): Evidence {
  const slot = item.id.split("-")[1];
  // Mx-05 is the whole-game gate: `pnpm verify:game <game>` and the game's critic loop.
  const wholeGame = item.kind === "game" && slot === "05" && item.game !== null;
  const key = wholeGame && item.game ? item.game : item.id;
  let critic: string | null = null;
  if (isVisual(item)) {
    if (item.id === "M10-09") critic = "artifacts/critic/drift";
    else if (item.kind === "game" && item.game && !VISUAL_GAME_EXTRAS.has(item.id))
      critic = `artifacts/critic/${item.game}`;
    else critic = `artifacts/critic/${item.id}`;
  }
  const gates =
    item.kind === "platform" ? PLATFORM_GATES : wholeGame ? GAME_GATES : ([] as string[]);
  return {
    handoff: `artifacts/handoff/${key}.md`,
    verify: `artifacts/verify/${key}.json`,
    critic,
    gates: gates.filter((g) => !CRITIC_GATES.includes(g)),
  };
}

/** A fresh `todo` progress row for a roadmap item. */
export function newProgressItem(item: RoadmapItem): ProgressItem {
  return {
    id: item.id,
    title: item.title,
    milestone: item.milestone,
    kind: item.kind,
    game: item.game,
    visual: isVisual(item),
    status: "todo",
    owner: null,
    criticRound: 0,
    maxRounds: DEFAULT_MAX_ROUNDS,
    blockedReason: null,
    notes: "",
    updated: null,
    evidence: evidenceFor(item),
  };
}
