/**
 * Trivia Night state, action, option and view types (`docs/specs/trivia-night.md` "Types"),
 * plus the timing and scoring constants of the rules.
 *
 * The spec's `TnState` fields are kept (the Bluff-only fields stay empty until M4-01b adds
 * Bluff mode); the fields after them are bookkeeping the Classic rules need (seats, teams,
 * timers, polls, stats). Anything secret lives under `hidden` and is copied into a public field
 * only when its reveal phase starts (spec "Implementation rule").
 *
 * @module
 */
import type { PlayerId, TeamId, TriviaBluffItem, TriviaMcItem } from "@sg/shared";

/** A multiple-choice item (spec `McItem`, the `trivia-mc` pack item). */
export type McItem = TriviaMcItem;
/** A bluff item (spec `BluffItem`, the `trivia-bluff` pack item; Bluff mode is M4-01b). */
export type BluffItem = TriviaBluffItem;

/** Phases, in the order of the spec's Classic state machine. */
export type TnPhase =
  | "intro"
  | "category"
  | "read"
  | "answer"
  | "reveal"
  | "scoreboard"
  | "lifeline-vote"
  | "showdown"
  | "showdown-answer"
  | "showdown-verdict"
  | "final";

/** Play modes (spec R14). This item (M4-01) plays `classic`; M4-01b adds `bluff` and `mixed`. */
export type TnMode = "classic" | "bluff" | "mixed";

/** Host options (spec "Host options"; the Bluff keys arrive with M4-01b). */
export interface TnOptions {
  mode: "classic";
  packs: string[];
  questions: number;
  answerSec: number;
  speedScoring: boolean;
  showdown: boolean;
  lifeline: boolean;
  difficulty: "easy" | "curve" | "hard";
}

/** A seated player as the game tracks it. */
export interface TnPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  colorSlot: number;
  teamId?: TeamId;
  connected: boolean;
}

/** A team in team mode (R7). `members` are in seat order; empty teams are excluded. */
export interface TnTeam {
  id: TeamId;
  name: string;
  colorSlot: number;
  members: PlayerId[];
}

/**
 * The public part of the current question. `q` is copied in at `read` and `options` at
 * `answer` (spec R2: the answers are hidden while the question is read).
 */
export interface McCurrent {
  kind: "mc";
  id: string;
  category: string;
  difficulty: 1 | 2 | 3;
  q?: string;
  options?: string[];
}

/** One locked answer: the option and the server (game) time it arrived. */
export interface Lock {
  choice: number;
  at: number;
}

/** One player's line in a question result (spec `lastReveal.perPlayer`, plus the breakdown). */
export interface PlayerResult {
  ok: boolean;
  points: number;
  /** Answer time in ms (`receivedAt − answerOpenedAt`), or -1 when the player did not lock. */
  ms: number;
  /** The player's own lock, or null. */
  choice: number | null;
  /** Speed bonus included in `points` (before the Steamed halving). */
  speed: number;
  /** Streak bonus included in `points` (before the Steamed halving). */
  streak: number;
  /** The points were halved by the Steamed status (R5). */
  halved: boolean;
}

/** The public result of the latest question (spec `lastReveal`). */
export interface LastReveal {
  /** The question number this result belongs to. */
  index: number;
  correct: number;
  perPlayer: Record<PlayerId, PlayerResult>;
  /** Audience share per option in whole percent (only when the audience answered). */
  audiencePct?: number[];
  audienceTotal?: number;
  /** Team mode: each team's plurality answer (null when no member locked). */
  teamAnswers?: Record<TeamId, number | null>;
  /** Players whose Steamed status expired with this question ("Cooled off!"). */
  cooledOff: PlayerId[];
}

/** The Showdown, "The Kettle" (R5). */
export interface Showdown {
  /** The two players, lowest first (the bottom two by score, R5 tie-break). */
  players: [PlayerId, PlayerId];
  /** The question after which this Showdown runs (4 or 8). */
  after: number;
  /** The showdown question, public from `showdown-answer`. */
  q?: { q: string; options: string[] };
  /** Who has locked (public; the choices stay hidden until the verdict). */
  answered: PlayerId[];
  /** The losers (public from `showdown-verdict`): one player, or both when both were wrong. */
  verdict?: PlayerId[];
  /** The winner (+750 "Cool Head"), or null when both lost. */
  winner?: PlayerId | null;
  /** The correct option (public from `showdown-verdict`). */
  correct?: number;
  /** Each player's lock at the verdict. */
  results?: Record<PlayerId, { ok: boolean; ms: number; choice: number | null }>;
}

/** The lifeline (R6). */
export interface Lifeline {
  status: "unused" | "voting" | "granted" | "none";
  /** The 50/50 recipient once granted. */
  recipient: PlayerId | null;
  /** The question the 50/50 applies to. */
  question: number | null;
}

/** The ids of this question's audience polls (null when none is open or pending). */
export interface TnPolls {
  quiz: string | null;
  predict: string | null;
  vote: string | null;
}

/** Running counters for the scoreboard's Chat vs Players line and the final highlights. */
export interface TnStats {
  /** Sum of the audience's per-question correct rate (0..1), over questions it answered. */
  chatRateSum: number;
  chatQuestions: number;
  /** Player locks that were correct / answer opportunities (connected players per question). */
  playerCorrect: number;
  playerChances: number;
  bestStreak: Record<PlayerId, number>;
  coolHeads: Record<PlayerId, number>;
}

/** Module state (plain JSON). */
export interface TnState {
  phase: TnPhase;
  mode: TnMode;
  /** The current question number (1-based; 0 before the first question). */
  index: number;
  /** Questions in this game (the queue can come up short when content runs out). */
  total: number;
  deadline: number | null;
  /** Game time the current answer window opened (R3 answer times), or null. */
  openedAt: number | null;
  current?: McCurrent;
  hidden: {
    /** Upcoming questions, in play order. */
    queue: McItem[];
    /** Replacement questions for the host's `skipItem`. */
    spares: McItem[];
    /** Showdown questions (one per Showdown). */
    showdownQueue: McItem[];
    /** The full current item (question text and options before they are public). */
    item?: McItem;
    correct?: number;
    answers: Record<PlayerId, Lock>;
    /** Bluff mode (M4-01b): unused in Classic. */
    lies: Record<PlayerId, string>;
    lifelineRemoved?: { player: PlayerId; remove: [number, number] };
    /** Bluff mode (M4-01b): unused in Classic. */
    bluffAuthors: Record<string, PlayerId[]>;
    /** Bluff mode (M4-01b): unused in Classic. */
    picks: Record<PlayerId, string>;
    showdownCorrect?: number;
    /** The current showdown question (text and options before they are public). */
    showdownItem?: McItem;
    /** The showdown players' locks. */
    showdownAnswers: Record<PlayerId, Lock>;
    /** The audience quiz result of the current question (secret until the reveal). */
    quizResult?: { total: number; tallies: Record<string, number> };
  };
  lastReveal?: LastReveal;
  scores: Record<string, number>;
  streaks: Record<PlayerId, number>;
  steamed: Record<PlayerId, { questionsLeft: 0 | 1 | 2 }>;
  showdown?: Showdown;
  totalCorrectMs: Record<PlayerId, number>;

  // ---- bookkeeping ----
  options: TnOptions;
  players: TnPlayer[];
  /** Team mode (R7): two or more non-empty room teams. Empty otherwise. */
  teams: TnTeam[];
  teamScores: Record<TeamId, number>;
  /** Who has locked the current question (public: the stage marks their plates). */
  answered: PlayerId[];
  /** The answer window is over; the game waits (briefly) for the audience quiz result. */
  answerClosed: boolean;
  /** Total answer time per player, a missed answer counting its full window (R5 tie-break). */
  totalAnswerMs: Record<PlayerId, number>;
  /** Speed bonus on for this game: `speedScoring` and a timer (R4: off at timerScale 0). */
  speedBonusOn: boolean;
  /** The current question's speed window and stream delay in ms (null: no timer). */
  answerWindow: { windowMs: number; delayMs: number } | null;
  lifeline: Lifeline;
  polls: TnPolls;
  pollSeq: number;
  /** Timer ids currently armed (cleared on every phase change). */
  timers: string[];
  timerSeq: number;
  stats: TnStats;
  /** Played questions (id and category), in order. */
  played: { id: string; category: string }[];
  /** Game time the current answer window closed (missed answers count up to it, R5). */
  closedAt: number | null;
  /** The ids placed first at the end (players, or teams in team mode). */
  winners: string[] | null;
}

/** Player actions (spec `TnAction`; `lie` and `pick` arrive with Bluff mode in M4-01b). */
export type TnAction = { type: "answer"; choice: 0 | 1 | 2 | 3 };

/** The viewer's own slice of the view. */
export interface TnYou {
  id: PlayerId;
  teamId: TeamId | null;
  /** An `answer` would be accepted now. */
  canAnswer: boolean;
  /** This player has locked the current question (or their showdown question). */
  locked: boolean;
  /** The player's own lock (never anyone else's before the reveal). */
  choice: number | null;
  /** The two options the lifeline removed, on the recipient's phone only (R6). */
  removed: [number, number] | null;
  streak: number;
  steamedLeft: 0 | 1 | 2;
  /** This player's line in the latest result. */
  last: PlayerResult | null;
  inShowdown: boolean;
}

/** One line of the standings (R8 order). */
export interface Standing {
  id: string;
  score: number;
  place: number;
}

/** What every viewer receives. The stage view never carries a secret. */
export interface TnView {
  phase: TnPhase;
  deadline: number | null;
  mode: TnMode;
  index: number;
  total: number;
  /** The current question's category (from `category`). */
  category: string | null;
  difficulty: 1 | 2 | 3 | null;
  /** The question text (from `read`). */
  q: string | null;
  /** The four options (from `answer`). */
  options: string[] | null;
  /**
   * Length in ms of the open input window (answer or showdown answer), for the timer ring: the
   * ring shows `(deadline − now) / inputMs`. A duration, so it survives a pause. Null otherwise.
   */
  inputMs: number | null;
  answered: PlayerId[];
  answerClosed: boolean;
  lastReveal: LastReveal | null;
  scores: Record<string, number>;
  teamScores: Record<TeamId, number>;
  streaks: Record<PlayerId, number>;
  steamed: Record<PlayerId, { questionsLeft: 0 | 1 | 2 }>;
  standings: Standing[];
  players: TnPlayer[];
  teams: TnTeam[];
  showdown: Showdown | null;
  lifeline: Lifeline;
  polls: TnPolls;
  answerSec: number;
  /** R4: false at timerScale 0 or with `speedScoring` off ("Speed bonus off (no timer)"). */
  speedBonus: boolean;
  /** Why the speed bonus is off, for the host dock (host view only). */
  hostNote: string | null;
  /** The scoreboard's Chat vs Players line, in whole percent (null: no data yet). */
  chatVsPlayers: { chatPct: number | null; playersPct: number | null };
  winners: string[] | null;
  you: TnYou | null;
}

// ---- timing (ms) ----------------------------------------------------------------------------

/** Intro card (pace). */
export const INTRO_MS = 5_000;
/** R2 category card (pace). */
export const CATEGORY_MS = 1_800;
/** R2 read phase: 2500 + 40 ms per character, at most 6000 (pace). */
export const READ_BASE_MS = 2_500;
export const READ_PER_CHAR_MS = 40;
export const READ_MAX_MS = 6_000;
/** R2 reveal (pace). */
export const REVEAL_MS = 4_000;
/** R7 scoreboard break (pace). */
export const SCOREBOARD_MS = 4_000;
/** R6 lifeline vote (12 s). */
export const LIFELINE_MS = 12_000;
/** R5 predict poll before the showdown question (12 s). */
export const SHOWDOWN_PREDICT_MS = 12_000;
/** R5 showdown answer window (input, 10 s). */
export const SHOWDOWN_ANSWER_MS = 10_000;
/** R5 verdict: whistle, steam and the Cool Head award (pace). */
export const VERDICT_MS = 4_000;
/** Final podium (pace). */
export const FINAL_MS = 8_000;
/** Grace after a poll's deadline before the game stops waiting for its result. */
export const POLL_GRACE_MS = 1_500;
/**
 * Longest wait for the quiz result after the answer window opened: the runner holds an early
 * close until `streamDelaySec (≤ 8) + 5 s` after opening (SPEC §4), plus a margin.
 */
export const QUIZ_WAIT_MS = 14_000;

// ---- scoring --------------------------------------------------------------------------------

/** R4: a correct answer. */
export const CORRECT_POINTS = 500;
/** R4: the largest speed bonus. */
export const SPEED_MAX = 500;
/** R4: streak bonus per consecutive correct answer beyond the first, capped. */
export const STREAK_STEP = 100;
export const STREAK_CAP = 300;
/** R5: the Showdown winner's "Cool Head" award. */
export const COOL_HEAD_POINTS = 750;
/** R5: Steamed lasts exactly this many questions, at this factor. */
export const STEAMED_QUESTIONS = 2;
export const STEAMED_FACTOR = 0.5;
/** R5: the Showdown needs this many players. */
export const SHOWDOWN_MIN_PLAYERS = 3;
/** R5/R6/R7: breaks come after every 4th question; the Showdown after these. */
export const BREAK_EVERY = 4;
export const SHOWDOWN_AFTER: readonly number[] = [4, 8];
/** R6: the lifeline vote runs in the break after this question. */
export const LIFELINE_AFTER = 4;
/** Spare questions drawn for the host's `skipItem`. */
export const SPARE_QUESTIONS = 3;
/** Option letters (spec "Visual": books A–D). */
export const LETTERS = ["A", "B", "C", "D"] as const;
