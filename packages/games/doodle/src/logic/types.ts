/**
 * Doodle types and constants (`docs/specs/doodle.md` "Types", "Stroke format", "Host options").
 *
 * M5-01 implements **Guess mode** (and Team Doodle, R7). Telephone mode (R9–R14) is ROADMAP
 * item M5-01b (cut-first); the state keeps the spec's shape (`mode`, `votes`) so it can plug in.
 *
 * Secrecy (SPEC §9.3 rule 4): the current word, the drawer's three choices, the pre-drawn deck
 * and the used words live under `hidden`. The word and the choices carry `owner: <drawer>` so
 * the contract secrecy fuzz knows the drawer may see them. `view()` is the only way out.
 *
 * @module
 */
import type { PlayerId, RoomConfig, TeamId } from "@sg/shared";

/** Stable game id, matching `docs/specs/doodle.md`. */
export const GAME_ID = "doodle" as const;

// ---- Stroke format ----------------------------------------------------------------------------

/** Logical canvas width: x is an integer in `0..CANVAS_W-1`. */
export const CANVAS_W = 1024;
/** Logical canvas height: y is an integer in `0..CANVAS_H-1`. */
export const CANVAS_H = 768;
/** Palette size (ink, the 8 identity colours, brown, grey, paper/eraser). */
export const PALETTE_SIZE = 12;
/** The eraser is palette index 11, the paper colour. */
export const ERASER_COLOR = 11;
/** Brush sizes in px, by size index 0..3. */
export const BRUSH_SIZES: readonly number[] = Object.freeze([4, 8, 16, 32]);
/** At most this many points in one `stroke` batch. */
export const MAX_BATCH_POINTS = 128;
/** A drawing holds at most this many points. */
export const MAX_POINTS = 20_000;
/** A drawing holds at most this many strokes. */
export const MAX_STROKES = 600;
/** Stroke ids: 1–24 characters of `[A-Za-z0-9_-]`. */
export const STROKE_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

/** One stroke: palette index `c`, size index `s`, flat points `x0,y0,x1,y1,…`. */
export interface Stroke {
  id: string;
  c: number;
  s: number;
  pts: number[];
  /** True once the client sent the stroke's last batch (`done: true`). */
  done: boolean;
}

/** A drawing (spec "Types"). `points` is the total point count over every stroke. */
export interface Drawing {
  strokes: Stroke[];
  points: number;
  skipped?: boolean;
  empty?: boolean;
}

// ---- Words ------------------------------------------------------------------------------------

/** Difficulty tier: 1 easy, 2 medium, 3 hard; 0 for a host custom word (no tier). */
export type Tier = 0 | 1 | 2 | 3;

/** A word as the game holds it. */
export interface WordItem {
  w: string;
  alt: string[];
  tier: Tier;
}

/** Tier names on the Stage and in the audience tier vote (R2). */
export const TIER_LABELS: Readonly<Record<1 | 2 | 3, string>> = Object.freeze({
  1: "Easy 🌱",
  2: "Medium 🌿",
  3: "HARD 🌵",
});

// ---- Options ----------------------------------------------------------------------------------

/** Resolved host options (spec "Host options", Guess mode keys). */
export interface DoodleOptions {
  mode: "guess";
  packs: string[];
  customWords: "off" | "mix" | "only";
  rounds: "auto" | "1" | "2" | "3";
  drawSec: number;
  hints: boolean;
  audiencePicksTier: boolean;
}

/** The room settings Doodle needs (ER-006: not yet in `SetupContext`). */
export type DoodleRoomSettings = Pick<RoomConfig, "contentFilter" | "moderation" | "audienceMin">;

// ---- Timing (ms) ------------------------------------------------------------------------------

/** Intro card (pace). */
export const INTRO_MS = 6_000;
/** Audience tier vote window base (R2: `timing.input(8_000)`). */
export const TIER_VOTE_MS = 8_000;
/** Drawer word pick window base (R2: 12 s). */
export const PICK_MS = 12_000;
/** Reveal (R5: pace 4000). */
export const REVEAL_MS = 4_000;
/** Final podium (pace). */
export const FINAL_MS = 9_000;
/** Grace after a poll's deadline before the game stops waiting for its result. */
export const POLL_GRACE_MS = 2_000;
/** R4: one guess per 800 ms per player. */
export const GUESS_INTERVAL_MS = 800;
/** R4: a guess is 1–32 characters. */
export const GUESS_MAX = 32;
/** The feed keeps the last 30 entries. */
export const FEED_MAX = 30;
/** R7: only the drawing team guesses for the first 60% of the time. */
export const STEAL_AT = 0.6;
/** The final gallery strip keeps at most this many drawings. */
export const GALLERY_MAX = 8;

// ---- Scoring ----------------------------------------------------------------------------------

/** R5 guesser base, time bonus and first-guesser bonus. */
export const GUESS_BASE = 100;
export const GUESS_TIME_BONUS = 200;
export const FIRST_BONUS = 50;
/** R5 drawer: 60 per correct guesser, capped at 360. */
export const DRAWER_PER_GUESSER = 60;
export const DRAWER_CAP = 360;
/** R2/R5: an audience-chosen HARD turn multiplies every score by 1.25 (rounded). */
export const HARD_MULTIPLIER = 1.25;
/** R7 team guess: 200 + round(300 × remaining / total). */
export const TEAM_BASE = 200;
export const TEAM_TIME_BONUS = 300;

// ---- State ------------------------------------------------------------------------------------

/** Guess mode phases (spec "State machine"). */
export type Phase = "intro" | "word-pick" | "draw" | "reveal" | "final";

/** A seated player. */
export interface DoodlePlayer {
  id: PlayerId;
  name: string;
  seat: number;
  colorSlot: number;
  teamId?: TeamId;
  connected: boolean;
}

/** A team in Team Doodle (R7). */
export interface DoodleTeam {
  id: TeamId;
  name: string;
  colorSlot: number;
  members: PlayerId[];
}

/** One guess-feed entry (spec "Types", plus the flags the views need). */
export interface FeedEntry {
  by: PlayerId;
  /** Filtered text of an incorrect guess (never present for a correct guess). */
  text?: string;
  correct?: true;
  /** Standard filter: the Stage blurs this text until the host reveals it. */
  flagged?: true;
  /** A message from a player who already guessed: only correct guessers and the drawer see it. */
  insider?: true;
}

/** How the turn's word was chosen (R2). */
export interface TierInfo {
  /** The tier of the word (0 = custom word). */
  tier: Tier;
  by: "audience" | "drawer" | "random";
  /** An audience-chosen HARD turn: every score ×1.25. */
  hard: boolean;
}

/** Why a turn ended. */
export type TurnEnd =
  "all-correct" | "team-scored" | "time" | "report" | "host-skip" | "drawer-left" | "host";

/** The reveal readout (R5): the word, why the turn ended and each player's points this turn. */
export interface RevealInfo {
  word: string;
  alt: string[];
  reason: TurnEnd;
  skipped: boolean;
  /** Points earned this turn, per player (FFA) or per team (Team Doodle). */
  points: Record<string, number>;
}

/** The audience guess poll's outcome for one turn (spec "Audience hooks"). */
export interface CrowdResult {
  turn: number;
  correct: number;
  first: string[];
  /** Whether the first correct chatter beat the first correct player (null: unknown). */
  beat: boolean | null;
}

/** A past turn, for highlights and the gallery. */
export interface TurnRecord {
  turn: number;
  drawer: PlayerId;
  word: string;
  correct: number;
  skipped: boolean;
}

/** A gallery strip entry for the final podium. */
export interface GalleryEntry {
  turn: number;
  drawer: PlayerId;
  word: string;
  correct: number;
  drawing: Drawing;
}

/** Everything server-only (never sent to any client). */
export interface DoodleHidden {
  /** The turn's word; the drawer owns it. */
  word?: { owner: PlayerId; w: string; alt: string[]; tier: Tier };
  /** The three words offered to the drawer (easy, medium, hard; or three custom words). */
  wordChoices?: { owner: PlayerId; words: WordItem[] };
  /**
   * Words offered in earlier turns (no repeats in the session). The current turn's words stay
   * under `word` / `wordChoices` (owned by the drawer) until the turn moves on.
   */
  usedWords: string[];
  /** Pre-drawn words for the rest of the game, per tier (index 0 = custom). */
  deck: [WordItem[], WordItem[], WordItem[], WordItem[]];
}

/** The Doodle state. Field names follow the spec's `DoodleState`. */
export interface DoodleState {
  mode: "guess";
  phase: Phase;
  /** Game-clock ms of the current phase's end, or null (no timer). */
  deadline: number | null;
  /** 1-based round number (0 in the intro). */
  round: number;
  /** 0-based turn index into `order` (-1 in the intro). */
  turn: number;
  drawer?: PlayerId;
  /** The hint, e.g. `"_ a _ _ _"`, from the start of the draw phase until the reveal. */
  hint?: string;
  /** The live drawing of the current turn. */
  drawing: Drawing;
  /** The last 30 feed entries. */
  feed: FeedEntry[];
  /** Correct guessers this turn → their points. */
  correct: Record<PlayerId, number>;
  /** Players who reported this turn's drawing. */
  reports: PlayerId[];
  hidden: DoodleHidden;
  /** Running score per player (FFA) or per team (Team Doodle). */
  scores: Record<string, number>;
  /** Telephone chain votes (M5-01b); always empty in Guess mode. */
  votes: Record<PlayerId, number>;

  // ---- Guess mode bookkeeping ----
  options: DoodleOptions;
  room: DoodleRoomSettings;
  players: DoodlePlayer[];
  teams: DoodleTeam[];
  /** Drawer per turn, in turn order. */
  order: PlayerId[];
  /** Team per turn (Team Doodle), parallel to `order`. */
  teamOrder: TeamId[];
  rounds: number;
  /** Turns per round (`order.length / rounds`). */
  turnsPerRound: number;
  /** Game-clock ms of the last reducer call (bots read it; never a secret). */
  clock: number;
  /** Who picks the word this turn. */
  picker: "audience" | "drawer" | null;
  /** The open audience tier vote, if any. */
  tierPoll: string | null;
  /** The open audience guess poll of this turn, if any. */
  guessPoll: string | null;
  /** How the word was chosen (public from the draw phase on: "Chat chose HARD 🌵"). */
  tier: TierInfo | null;
  /** Draw phase start and length (ms) for hints and time scaling. */
  drawStart: number;
  drawTotal: number;
  /** Letter positions revealed by the hints so far. */
  hintShown: number[];
  /** Last accepted guess per player (game ms), for the 800 ms rate limit. */
  lastGuessAt: Record<PlayerId, number>;
  /** Game ms of this turn's first correct player guess (Chat vs Players). */
  firstCorrectAt: number | null;
  /** Team Doodle: the drawing team this turn and when the steal window opens. */
  teamTurn: TeamId | null;
  stealAt: number | null;
  stealOpen: boolean;
  /** Audience guess polls of ended turns still waiting for their result. */
  pendingGuess: { pollId: string; turn: number; firstCorrectAt: number | null }[];
  /** The reveal readout (reveal phase only). */
  reveal: RevealInfo | null;
  /** The latest audience guess result. */
  crowd: CrowdResult | null;
  /** Correct guessers per drawer over the game ("Best Artist"). */
  artist: Record<PlayerId, number>;
  history: TurnRecord[];
  gallery: GalleryEntry[];
  /** Final ranking ids with place 1 (final phase). */
  winners: string[];
  pollSeq: number;
}

// ---- Actions ----------------------------------------------------------------------------------

/** Guess mode actions (spec "Types"; `write`, `advance` and `vote` are Telephone, M5-01b). */
export type DoodleAction =
  | { type: "pickWord"; idx: 0 | 1 | 2 }
  | { type: "stroke"; id: string; c: number; s: number; pts: number[]; done: boolean }
  | { type: "undo" }
  | { type: "clear" }
  | { type: "guess"; text: string }
  | { type: "report" };
