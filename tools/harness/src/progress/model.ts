/**
 * Data model for `progress.json`, the source of truth for roadmap item status
 * (docs/DOD.md §8, docs/SPEC.md §14, docs/research/05 §B.3).
 *
 * The status lifecycle is `todo → building → verifying → critic → fixing → verifying → … → done`,
 * with `blocked` reachable from any state. Items without visuals skip the critic:
 * `verifying → done`.
 */

/** Every status an item can be in, in lifecycle order (also the order used in summaries). */
export const STATUSES = [
  "todo",
  "building",
  "verifying",
  "critic",
  "fixing",
  "done",
  "blocked",
] as const;

export type Status = (typeof STATUSES)[number];

/** Platform items use the P-gates (DOD §1); game items (M2–M9) use the G-gates (DOD §2). */
export type ItemKind = "platform" | "game";

/** Where the evidence for an item lives, relative to the repo root. */
export interface Evidence {
  /** `artifacts/handoff/<id>.md`: required to enter `verifying`. */
  handoff: string;
  /** `artifacts/verify/<id>.json`: required to enter `critic` and `done`. */
  verify: string;
  /** Directory holding `round-<r>.json` merged critic reports, or `null` for items without visuals. */
  critic: string | null;
  /** Gates that must be present and green in the verify JSON (critic gates excluded). */
  gates: string[];
}

/** One roadmap item's row in `progress.json`. */
export interface ProgressItem {
  id: string;
  title: string;
  milestone: string;
  kind: ItemKind;
  /** The game id for M2–M9 items, otherwise `null`. */
  game: string | null;
  /** `true` when a passing critic report is required for `done` (DOD P6 / §7). */
  visual: boolean;
  status: Status;
  owner: string | null;
  /** Number of critic rounds entered so far (0 before the first). */
  criticRound: number;
  maxRounds: number;
  blockedReason: string | null;
  /** At most {@link MAX_NOTE_LINES} lines (research 05 §B.10). */
  notes: string;
  /** ISO-8601 UTC timestamp of the last `set`, or `null` if never set. */
  updated: string | null;
  evidence: Evidence;
}

/** The whole `progress.json` document. */
export interface ProgressFile {
  $comment?: string;
  version: 1;
  items: ProgressItem[];
}

export const PROGRESS_COMMENT =
  "Source of truth for roadmap item status. Change it only with `pnpm progress set <id> key=value`; PROGRESS.md is generated from it by `pnpm progress render`.";

/** DOD §7: a game that has not passed after round 5 goes to `blocked`. */
export const DEFAULT_MAX_ROUNDS = 5;
export const MAX_NOTE_LINES = 3;
export const MAX_NOTE_LINE_LENGTH = 200;

/** Gates the verify JSON must carry for a platform item (P6 is the critic; see DOD §1). */
export const PLATFORM_GATES = ["P1", "P2", "P3", "P4", "P5", "P7"];
/** Gates `pnpm verify:game` must report green before the critic (DOD §2, §8). */
export const GAME_GATES = [
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8a",
  "G8b",
  "G9",
  "G10",
  "G11",
  "G13",
  "G14",
];
/** Gates owned by the critic; checked through critic reports, never through the verify JSON. */
export const CRITIC_GATES = ["G12", "P6"];

/**
 * Legal status transitions. `critic` is only reachable for visual items and `verifying → done`
 * only for non-visual ones; {@link allowedNext} applies that split.
 */
const TRANSITIONS: Record<Status, readonly Status[]> = {
  todo: ["building", "blocked"],
  building: ["verifying", "blocked"],
  verifying: ["critic", "done", "fixing", "blocked"],
  critic: ["done", "fixing", "blocked"],
  fixing: ["verifying", "blocked"],
  // Drift guard / engine-change regression sends a done item back to fixing (DOD §7).
  done: ["fixing", "blocked"],
  // Unblocking resumes work; the item must re-earn every later state.
  blocked: ["todo", "building", "fixing"],
};

/** The statuses `item` may move to next. */
export function allowedNext(item: Pick<ProgressItem, "status" | "visual">): Status[] {
  return TRANSITIONS[item.status].filter((to) => {
    if (to === "critic") return item.visual;
    if (to === "done" && item.status === "verifying") return !item.visual;
    return true;
  });
}

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}
