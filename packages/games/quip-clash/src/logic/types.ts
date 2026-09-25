/**
 * Quip Clash types and tuning constants (`docs/specs/quip-clash.md` "Types", "Rules").
 *
 * The state follows the spec's `QcState` shape. Additions (all public, never secret):
 * `players`, `teamMode`, `teamNote`, `room`, `order`, `modItems`, `away`, `aud`, `predict`,
 * `endPrompt`, `lowSince`, `highlights` and `result`.
 *
 * Answer slots. The spec's `vote.choice` and `lastVote.alloc` are typed as author ids, but
 * the "Views per role" table hides the authors of A/B until `results`. A client that could vote
 * by author id would have to receive author ids for the answers, which leaks authorship. So a
 * vote names an **answer slot** instead: `"A"` / `"B"` in a matchup, `"c1".."c8"` in Last Quip
 * (see Builder notes). Slots map to authors only inside the (server-side) state.
 *
 * @module
 */
import type { PlayerId, RoomConfig, TeamId } from "@sg/shared";

/** The game id. */
export const GAME_ID = "quip-clash" as const;

/** A player id, or a team id in team mode. */
export type AuthorId = string;

/** Phase ids (spec "State machine"). */
export type Phase =
  | "intro"
  | "answer"
  | "show-prompt"
  | "show-answers"
  | "review-wait"
  | "vote"
  | "results"
  | "scores"
  | "show-all"
  | "final";

/** Every phase, in first-seen order. */
export const PHASES: readonly Phase[] = Object.freeze([
  "intro",
  "answer",
  "show-prompt",
  "show-answers",
  "review-wait",
  "vote",
  "results",
  "scores",
  "show-all",
  "final",
]);

/** Phases with a player input window (the only ones that may carry a deadline). */
export const INPUT_PHASES: readonly Phase[] = Object.freeze(["answer", "vote"]);

/** A round number. */
export type Round = 1 | 2 | 3;

/** Host options (spec "Host options"). */
export interface QcOptions {
  packs: string[];
  answerSec: number;
  voteSec: number;
  audienceWeight: number;
  rounds: "2" | "3";
  safetyQuip: boolean;
}

/**
 * The room settings the rules need (SPEC §7 `RoomConfig`). The engine's `SetupContext` does not
 * carry them yet (docs/engine-requests.md ER-006); see `room.ts`.
 */
export type QcRoomSettings = Pick<RoomConfig, "contentFilter" | "moderation" | "audienceMin">;

/** An author: one player, or one room team in team mode (R1). */
export interface QcAuthor {
  id: AuthorId;
  name: string;
  members: PlayerId[];
  colorSlot: number;
  /** The earliest seat among the members: the tie-break order (R12). */
  seat: number;
}

/** A seated player, as the views list them. */
export interface QcPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  colorSlot: number;
  teamId?: TeamId;
}

/** A prompt in play. `authors` is `[A, B]` for rounds 1 and 2 and every author for round 3. */
export interface QcPrompt {
  id: string;
  text: string;
  authors: AuthorId[];
  round: Round;
}

/** Moderation status of a submitted answer (R13). */
export type ModStatus = "ok" | "pending" | "edited";

/** A submitted answer (hidden until revealed). */
export interface QcAnswer {
  text: string;
  safety: boolean;
  mod: ModStatus;
  /** Standard-mode profanity flag: the Stage blurs it until the host reveals it (SPEC §9.7). */
  flagged: boolean;
  /** Family-mode masking changed the text; the author may resubmit. */
  masked: boolean;
}

/** Answers revealed at `show-answers` / `show-all`. */
export interface QcRevealed {
  answers: Record<AuthorId, string>;
  /** Authors whose revealed answer is flagged (standard mode). */
  flagged: AuthorId[];
  /** Authors whose answer was replaced by a safety quip after a rejection ("edited by host"). */
  edited: AuthorId[];
}

/** A matchup or Last Quip result (R7–R11). */
export interface QcResult {
  points: Record<AuthorId, number>;
  playerShare: Record<AuthorId, number>;
  audShare?: Record<AuthorId, number>;
  quipOut?: AuthorId;
  jinx?: true;
  /** One answer was blank: this author won automatically (R10). */
  auto?: AuthorId;
  /** Player votes per author (matchup: 0/1 each; Last Quip: hearts). */
  votes: Record<AuthorId, number>;
  /** Whether the audience vote counted (R7 `audienceMin`). */
  audienceCounted: boolean;
  /** Audience votes in the poll (0 when no result arrived). */
  audienceTotal: number;
}

/** A matchup vote (a slot) or a Last Quip allocation (slot → hearts). */
export type QcBallot = string | Record<string, number>;

/** The audience poll of the current vote. */
export interface QcAudiencePoll {
  pollId: string;
  /** `closeRequested`: the game emitted `audience.close` (the runner may hold it). */
  closeRequested: boolean;
  /** The aggregate result, once it arrived. */
  result: { total: number; tallies: Record<string, number> } | null;
}

/** The round-winner predict poll (R3a). */
export interface QcPredict {
  pollId: string;
  round: Round;
  open: boolean;
  /** Final tallies once the poll closed (author id → count). */
  tallies: Record<string, number> | null;
  total: number;
}

/** A current moderation item (R13). Stale items (after a resubmit) are removed. */
export interface QcModItem {
  promptId: string;
  author: AuthorId;
}

/** Final highlight (R12). */
export interface QcHighlight {
  label: string;
  kind: "audience-favourite" | "quip-out-king";
  author: AuthorId;
  text?: string;
}

/** The module state (plain JSON). */
export interface QcState {
  phase: Phase;
  round: Round;
  /** Index into this round's prompts (rounds 1–2); 0 in round 3. */
  matchup: number;
  deadline: number | null;
  /** The players' vote is over and the game waits for the audience result (R6). */
  closing: boolean;
  players: QcPlayer[];
  authors: QcAuthor[];
  teamMode: boolean;
  /** Host-dock note when team mode was requested but cannot run (R1). */
  teamNote: string | null;
  prompts: QcPrompt[];
  hidden: {
    answers: Record<string, Record<AuthorId, QcAnswer>>;
    safetyPool: Record<string, string[]>;
  };
  revealed: Record<string, QcRevealed>;
  /** Display order of Last Quip cards: slot `c<i+1>` is `order[i]`. */
  order: AuthorId[];
  votes: Record<PlayerId, QcBallot>;
  results: Record<string, QcResult>;
  scores: Record<AuthorId, number>;
  quipOuts: Record<AuthorId, number>;
  safetyUsed: Record<AuthorId, number>;
  /** Points earned per author in the current round (predict resolution, R3a). */
  roundPoints: Record<AuthorId, number>;
  options: QcOptions;
  room: QcRoomSettings;
  /** Current moderation items by item id. */
  modItems: Record<string, QcModItem>;
  /** Monotonic counter for moderation item ids. */
  modSeq: number;
  /** Disconnected players (R14). */
  away: PlayerId[];
  /** Game time since which fewer than 3 authors are connected, or null (R14). */
  lowSince: number | null;
  /** The host is being asked to end the game early (R14). */
  endPrompt: boolean;
  aud: QcAudiencePoll | null;
  predict: QcPredict | null;
  /** Setup could not start (not enough prompts): the host sees this message. */
  error: string | null;
  highlights: QcHighlight[];
}

/** Actions (spec "Types"; vote targets are answer slots, see the module docs). */
export type QcAction =
  | { type: "answer"; promptId: string; text: string }
  | { type: "safety"; promptId: string }
  | { type: "vote"; choice: string }
  | { type: "lastVote"; alloc: Record<string, number> };

// ---- Tuning (spec "Rules" and "State machine") ------------------------------------------------

/** Answer length after trimming (R3). */
export const ANSWER_MAX = 45;
/** Round 3 answer window base (R11). */
export const LAST_QUIP_ANSWER_MS = 75_000;
/** Hearts per player in Last Quip (R11). */
export const LAST_QUIP_HEARTS = 3;
/** Last Quip points base (R11). */
export const LAST_QUIP_BASE = 3000;
/** Matchup base per multiplier (R7). */
export const MATCHUP_BASE = 1000;
/** QUIP-OUT bonus per multiplier (R8). */
export const QUIP_OUT_BONUS = 250;
/** QUIP-OUT audience share floor when the audience counts (R8). */
export const QUIP_OUT_AUD_MIN = 0.8;
/** A disconnected author's safety quips land this long before the deadline (R14). */
export const AWAY_SAFETY_LEAD_MS = 10_000;
/** Review-wait timeout (R13, SPEC §9.7). */
export const REVIEW_TIMEOUT_MS = 20_000;
/** Low-author prompt delay (R14). */
export const LOW_AUTHORS_MS = 30_000;
/**
 * How long the game waits for the audience result after it asked to close the vote poll. The
 * runner holds an early close until `streamDelaySec (≤ 8 s) + 5 s` after the poll opened, so
 * 15 s after the close request is always enough; past it the vote resolves without chat.
 */
export const AUDIENCE_WAIT_MS = 15_000;

/** Pacing per phase (spec "State machine", R5). */
export const PACE = Object.freeze({
  intro: 6_000,
  showPrompt: 2_500,
  showAnswers: 1_500,
  results: 4_500,
  scores: 5_000,
  showAll: 3_000,
  lastResults: 7_000,
  final: 9_000,
});

/** Timer ids. */
export const TIMER = Object.freeze({
  /** The current phase's pace or deadline (also review-wait and the audience wait). */
  phase: "phase",
  /** Safety quips for disconnected authors, 10 s before the answer deadline (R14). */
  away: "away",
  /** Fewer than 3 connected authors for 30 s (R14). */
  low: "low-authors",
});
