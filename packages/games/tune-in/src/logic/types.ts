/**
 * Tune In state, action, option and view types (`docs/specs/tune-in.md` "Types"), plus the
 * timing constants of the rules. The spec's `TiState` fields are kept exactly; the extra
 * fields below them are bookkeeping the rules need (rotation, polls, rate limits, the deck).
 *
 * @module
 */
import type { PlayerId, TeamId } from "@sg/shared";

/** Phases, in the order of the spec's state machine. */
export type TiPhase =
  "intro" | "card-pick" | "clue" | "guess" | "steal" | "reveal" | "turn-score" | "final";

/** Resolved play mode (the `auto` option picks one at setup). */
export type TiMode = "teams" | "ffa";

/** A spectrum card. `examples` are ordered left to right along the dial (bot clues). */
export interface Card {
  id: string;
  left: string;
  right: string;
  examples?: string[];
}

/** A steal side: the target is left (lower) or right (higher) of the locked dial. */
export type Side = "left" | "right";

/** Result-bet options (R4a). */
export type BetOption = "bullseye" | "close" | "miss";

/** Host options (spec "Host options"). */
export interface TiOptions {
  mode: "auto" | "teams" | "ffa";
  packs: string[];
  clueSec: number;
  guessSec: number;
  scoreToWin: number;
  steal: boolean;
  audiencePicksCard: boolean;
  liveHeatmap: boolean;
  /** 0 = auto (1 rotation, or 2 with fewer than 4 players). */
  cycles: number;
}

/** A seated player as the game tracks it. */
export interface TiPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  colorSlot: number;
  teamId?: TeamId;
  connected: boolean;
}

/** A team (teams mode only). `members` are in seat order; the psychic rotates through them. */
export interface TiTeam {
  id: TeamId;
  name: string;
  colorSlot: number;
  members: PlayerId[];
}

/** One FFA guesser's private dial. */
export interface FfaDial {
  v: number;
  locked: boolean;
  moved: boolean;
}

/** The public result of the latest scored turn. */
export interface TiLast {
  target: number;
  /** Teams: the locked team dial. FFA: the best guesser's dial. */
  dial: number;
  /** Teams: the active team's points. FFA: the best guesser's points. */
  points: number;
  steal?: { side: Side; ok: boolean };
  audMean?: number;
  audBand?: number;
  /** FFA: points per player this turn (the psychic's is the rounded mean of the guessers). */
  ffa?: Record<PlayerId, number>;
  /** FFA: every guesser's revealed dial. */
  dials?: Record<PlayerId, number>;
  psychic: PlayerId;
  team?: TeamId;
  /** How the result bet resolved (R4a). */
  bet: BetOption;
  /** The audience mean scored a higher band than the team (R10 "Chat beat you!"). */
  chatBeatYou: boolean;
  /** Teams: this team plays the next turn again (R8). */
  catchUp: boolean;
}

/** Sudden death after a tie at the turn cap: one extra turn per team (R11). */
export interface SuddenDeath {
  /** Turns still to play, in order. */
  queue: TeamId[];
}

/** The ids of the audience polls open (or awaiting their result) this turn. */
export interface TiPolls {
  card: string | null;
  bet: string | null;
  dial: string | null;
}

/** Module state (plain JSON). */
export interface TiState {
  phase: TiPhase;
  mode: TiMode;
  turn: number;
  deadline: number | null;
  psychic: PlayerId;
  activeTeam?: TeamId;
  cardChoices: [Card, Card];
  card?: Card;
  clue?: string;
  hidden: {
    target: number;
    ffaDials: Record<PlayerId, FfaDial>;
  };
  /** Team dial (teams): public. */
  dial: number;
  stealPicks: Record<PlayerId, Side>;
  last?: TiLast;
  scores: Record<string, number>;
  catchUpUsed: boolean;
  turnsPerSeat: Record<PlayerId, number>;

  // ---- bookkeeping ----
  /**
   * Upcoming cards (a ring: offered cards go to the back). Server-only content, never in any
   * view; not a player secret (cards are public once offered), so it is not under `hidden`.
   */
  deck: Card[];
  options: TiOptions;
  players: TiPlayer[];
  teams: TiTeam[];
  /** FFA: the psychic for every turn, in order (R3). */
  psychicQueue: PlayerId[];
  /** Teams: index of the next psychic within each team. */
  teamRotation: Record<TeamId, number>;
  /** Teams: the team that plays the next turn (set at reveal: alternation or catch-up). */
  nextTeam?: TeamId;
  /** Turn cap (teams 12 plus sudden death; FFA the queue length). */
  maxTurns: number;
  suddenDeath: SuddenDeath | null;
  /** Who picks the card in `card-pick`: the audience vote or the psychic (R4). */
  cardPicker: "audience" | "psychic" | null;
  /** Team dial moved at least once this turn (R6 lock guard). */
  dialMoved: boolean;
  locked: boolean;
  guessStartedAt: number | null;
  /** Recent accepted `setDial` times per player (R6: 5 per second). */
  dialRate: Record<PlayerId, number[]>;
  polls: TiPolls;
  pollSeq: number;
  /** This turn's audience dial result, once the platform delivers it. */
  dialResult: { mean: number; total: number } | null;
  /** The dial poll is open (closed at the lock, R10). */
  dialOpen: boolean;
  /** The turn is locked and waits for the dial result before the reveal. */
  awaitingDial: boolean;
  /** The wait for the dial result timed out (or the host skipped it): reveal without it. */
  dialWaited: boolean;
  /** Timer ids currently armed (cleared on every phase change). */
  timers: string[];
  /** The team or player that scored last (R11 tie-break). */
  lastScorer: string | null;
  /** The ids placed first at the end (teams or players). */
  winners: string[] | null;
  /** Running highlight counters for the final card. */
  stats: { bullseyes: Record<string, number>; chatBeats: number };
}

/** Player actions (spec "Types"). */
export type TiAction =
  | { type: "pickCard"; idx: 0 | 1 }
  | { type: "clue"; text: string }
  | { type: "setDial"; v: number }
  | { type: "lock" }
  | { type: "steal"; side: Side };

/** A card as clients see it (no bot examples). */
export interface CardView {
  id: string;
  left: string;
  right: string;
}

/** The viewer's own slice of the view. */
export interface TiYou {
  id: PlayerId;
  teamId: TeamId | null;
  /** What this player does in the current phase. */
  role: "psychic" | "guesser" | "stealer" | "waiting";
  /** FFA: the player's own dial (never anyone else's before the reveal). */
  ffaDial: FfaDial | null;
  /** A `lock` would be accepted right now (ignoring the 5 s clock). */
  canLock: boolean;
  stealPick: Side | null;
}

/** What every viewer receives. The stage view never carries a secret. */
export interface TiView {
  phase: TiPhase;
  deadline: number | null;
  mode: TiMode;
  turn: number;
  maxTurns: number;
  suddenDeath: boolean;
  players: TiPlayer[];
  teams: TiTeam[];
  psychic: PlayerId;
  activeTeam: TeamId | null;
  stealTeam: TeamId | null;
  cardChoices: [CardView, CardView];
  card: CardView | null;
  cardPicker: "audience" | "psychic" | null;
  clue: string | null;
  dial: number;
  dialMoved: boolean;
  locked: boolean;
  /** Server ms from which `lock` is accepted without a dial move (R6). */
  lockOpensAt: number | null;
  /** FFA: who has locked (the stage sees only this, never the dials). */
  ffaLocked: PlayerId[];
  stealPicks: Record<PlayerId, Side>;
  awaitingDial: boolean;
  /** Psychic only in `clue`/`guess`; public from `reveal` on. Otherwise null. */
  target: number | null;
  last: TiLast | null;
  scores: Record<string, number>;
  catchUpUsed: boolean;
  polls: TiPolls;
  winners: string[] | null;
  scoreToWin: number;
  liveHeatmap: boolean;
  you: TiYou | null;
}

// ---- timing (ms) ----------------------------------------------------------------------------

/** Intro card (pace). */
export const INTRO_MS = 4_000;
/** Audience card vote and psychic card pick (input). */
export const CARD_PICK_MS = 10_000;
/** Steal window (input). */
export const STEAL_MS = 10_000;
/** Reveal (pace). */
export const REVEAL_MS = 5_000;
/** Turn score readout (pace). */
export const TURN_SCORE_MS = 2_500;
/** Final celebration (pace). */
export const FINAL_MS = 8_000;
/** A `lock` without a dial move is accepted this long after the guess opens (R6). */
export const LOCK_MIN_MS = 5_000;
/** R6 rate limit: accepted `setDial` per player per second. */
export const DIAL_RATE_MAX = 5;
/** Grace after a poll's deadline before the game stops waiting for its result. */
export const POLL_GRACE_MS = 1_500;
/**
 * Longest wait for the dial result after the guess opened: the runner holds an early close
 * until `streamDelaySec (≤ 8) + 5 s` after opening (SPEC §4), plus a margin.
 */
export const DIAL_WAIT_MS = 14_000;

// ---- rules constants ------------------------------------------------------------------------

/** Dial range (R1). */
export const DIAL_MAX = 1000;
/** The dial rests here at the start of every guess. */
export const DIAL_REST = 500;
/** Teams mode turn cap before sudden death (R11). */
export const TEAM_TURN_CAP = 12;
/** FFA turn cap (R3). */
export const FFA_TURN_CAP = 9;
/** Teams mode needs at least this many players (spec header). */
export const TEAMS_MIN_PLAYERS = 4;
/** Clue length limits in characters (R5). */
export const CLUE_MIN = 1;
export const CLUE_MAX = 40;
/** Card-end tokens shorter than this are not checked (edge case). */
export const CLUE_TOKEN_MIN = 3;
/** Audience dial bands (R10). */
export const AUDIENCE_BANDS: { within: number; points: number }[] = [
  { within: 25, points: 100 },
  { within: 75, points: 60 },
  { within: 125, points: 30 },
];
