/**
 * Odd One Out types (`docs/specs/odd-one-out.md` "Types", "Host options", "State machine").
 *
 * The state follows the spec's `OooState` with a few additions the rules need:
 * `players`/`away` (seats and R10 disconnects), `rounds` (the match length), `oddCount`,
 * `voted` (who has voted, never whom), `quickAt`/`clock` (the R5 quick-chat rate limit),
 * `predict` (the audience bet), `history` (past round results) and `error` (no playable
 * content). Hidden information lives under `hidden` (SPEC §9.3 rule 4): the secret, the
 * Undercover decoy, who is odd, the ballots, the last guess, the clue bank for the bots and the
 * deck of future rounds.
 *
 * @module
 */
import type { PlayerId } from "@sg/shared";

/** Stable game id, matching `docs/specs/odd-one-out.md`. */
export const GAME_ID = "odd-one-out" as const;

/** Every phase of the state machine, in play order. */
export const PHASES = [
  "intro",
  "deal",
  "reveal",
  "clues",
  "discuss",
  "vote",
  "revote",
  "accuse-reveal",
  "last-guess",
  "round-result",
  "final",
] as const;

/** A phase of the state machine (spec "State machine"). */
export type Phase = (typeof PHASES)[number];

/** Phases of a round in progress (`hidden.odd` is set; spec invariant). */
export const ROUND_PHASES: readonly Phase[] = [
  "deal",
  "reveal",
  "clues",
  "discuss",
  "vote",
  "revote",
  "accuse-reveal",
  "last-guess",
  "round-result",
];

/** Phases whose deadline is a player input window (`timing.input`, null at timerScale 0). */
export const INPUT_PHASES: readonly Phase[] = ["clues", "discuss", "vote", "revote", "last-guess"];

/** Phases where `point` and `quick` are allowed (spec Types comment, R5, T10). */
export const TALK_PHASES: readonly Phase[] = ["clues", "discuss"];

/** The Undercover / Classic variant (host option `variant`). */
export type Variant = "classic" | "undercover";

/** A quick-chat line index (R5: 8 fixed lines). */
export type QuickLine = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The 8 fixed quick-chat lines (R5). There is no free text, so nothing to moderate. */
export const QUICK_LINES: readonly string[] = Object.freeze([
  "It's you! 👉",
  "Trust me",
  "Your clue was weird",
  "Too obvious…",
  "I'm not sure",
  "Vote with me",
  "Not me!",
  "Hmm 🤔",
]);

/** The text of a missing clue (R3: a pass). */
export const PASS_CLUE = "…";

/** Longest clue in characters (R3). */
export const CLUE_MAX = 20;

/** Paced phase lengths in ms (`timing.pace`, never scaled). */
export const PACE = {
  /** SPEC §3 step 6: the 3-step intro card. */
  intro: 6_000,
  /** Cards fly from the lantern to each plush. */
  deal: 1_500,
  /** R2: the role reveal (auto-advances; everyone tapping "Got it" ends it early). */
  reveal: 6_000,
  /** State machine: accuse-reveal (pace 4000). */
  accuseReveal: 4_000,
  /** State machine: round-result (pace 6000). */
  roundResult: 6_000,
  /** The match podium before `end`. */
  final: 8_000,
} as const;

/** Input window bases in ms (`timing.input`). */
export const INPUT = {
  /** R6: the vote. */
  vote: 20_000,
  /** R6: the revote among tied players. */
  revote: 15_000,
  /** R7: the accused odd one's last guess. */
  lastGuess: 20_000,
} as const;

/** R5: at most one quick-chat line per 4 s per player. */
export const QUICK_COOLDOWN_MS = 4_000;

/** R5: a quick-chat bubble stays up 3 s (the client fades it; kept here for scenarios). */
export const BUBBLE_MS = 3_000;

/** R5: the chat log keeps the last 12 lines. */
export const CHAT_KEEP = 12;

/** The one module timer: the current phase (or clue turn) ends. */
export const TIMER = { phase: "phase" } as const;

/** Host options (spec "Host options"), as resolved by the runner. */
export interface OooOptions {
  packs: string[];
  variant: Variant;
  oddCount: "auto" | "1" | "2";
  rounds: number;
  clueRounds: "auto" | "1" | "2" | "3";
  clueSec: number;
  discussSec: number;
  audienceSecret: "phones" | "off";
}

/** The room settings the rules read (SPEC §7 `RoomConfig`, plus whether the host is seated). */
export interface OooRoomSettings {
  /** The profanity filter level for clues (R3, SPEC §9.7). */
  contentFilter: "family" | "standard";
  /**
   * The host also holds a player seat. Then the host panel never shows the secret
   * (R11, Views table, edge case "The host is seated").
   */
  hostSeated: boolean;
}

/** A seated player as the game keeps them (seat order). */
export interface OooPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  colorSlot: number;
}

/** The round's category (public: its name from `deal`; its options at last-guess and after). */
export interface OooCategoryInfo {
  id: string;
  name: string;
  /** The 12 secrets (Classic) or the pair's two words (Undercover without a matching category). */
  options: string[];
}

/** One clue on the table (R3). */
export interface OooClue {
  by: PlayerId;
  text: string;
  pass: number;
  /** Standard filter: flagged text the Stage blurs until the host reveals it (SPEC §9.7). */
  flagged?: true;
}

/** One quick-chat line (R5). */
export interface OooChat {
  by: PlayerId;
  line: QuickLine;
  at: number;
}

/** How a round ended (R4–R8, R10). `caught` is the Undercover catch (R7: no guess). */
export type Outcome =
  | "caught-wrong-guess"
  | "caught-stole"
  | "caught"
  | "innocent-accused"
  | "tie-twice"
  | "said-word"
  | "odd-said-word"
  | "void";

/** A finished round (public from `round-result` on). */
export interface OooRoundResult {
  round: number;
  /**
   * The secret, revealed (the spec's `roundResult.secret`; named `word` because `secret` keys
   * mark hidden values for the contract suite's secrecy fuzz, SPEC §9.3 rule 4).
   */
  word: string;
  /** Undercover: the odd ones' similar word. */
  decoy?: string;
  odd: PlayerId[];
  outcome: Outcome;
  /** Points per player this round (every player listed, 0 included). */
  points: Record<PlayerId, number>;
  /** The accused player, when the vote picked one. */
  accused?: PlayerId;
  /** The accused odd one's last guess (Classic), or null when time ran out. */
  guess?: string | null;
  /** The player whose clue said the word (R4). */
  saidBy?: PlayerId;
}

/** One round's content, dealt at setup (the deck lives in `hidden`). */
export interface OooCard {
  category: OooCategoryInfo;
  secret: string;
  /** Undercover: the paired similar word the odd ones get. */
  decoy?: string;
  /** Undercover: the pair's content key (`"a|b"`) so the room marks it used. */
  pairKey?: string;
  /** `category.clueBank[secret]`: clues a regular player's bot gives (R10). */
  bank: string[];
  /** `category.genericClues`: clues an odd one's bot gives (R10). */
  generic: string[];
}

/** The audience "Who's the Odd One?" predict poll of the current round. */
export interface OooPredict {
  pollId: string;
  open: boolean;
  /** Final tallies once the poll closed (the sus meter freezes on them), else null. */
  tallies: Record<string, number> | null;
  total: number;
}

/** Hidden state (never sent as is; `view()` picks what each viewer may see). */
export interface OooHidden {
  secret: string;
  decoy?: string;
  odd: PlayerId[];
  /** Ballots of the current vote or revote (voter → target). */
  votes: Record<PlayerId, PlayerId>;
  guess?: string;
  /** Content keys used so far in this match (categories, secrets, pairs). */
  used: string[];
  /** Clues for the secret (R10 regular bot). */
  bank: string[];
  /** Category-wide clues (R10 odd bot). */
  generic: string[];
  /** Future rounds, dealt at setup (ContentAccess is only available in `setup`). */
  deck: OooCard[];
}

/** The full game state. */
export interface OooState {
  phase: Phase;
  /** Current round (1-based; 0 during intro). */
  round: number;
  /** Rounds in the match (option `rounds`). */
  rounds: number;
  deadline: number | null;
  variant: Variant;
  options: OooOptions;
  room: OooRoomSettings;
  players: OooPlayer[];
  /** Disconnected seats (R10). */
  away: PlayerId[];
  /** Odd ones this round (R1), public as a count only. */
  oddCount: number;
  /** Clue passes this round (R3). */
  passes: number;
  category: OooCategoryInfo | null;
  order: PlayerId[];
  turn: { pass: number; idx: number };
  clues: OooClue[];
  /** "Got it" taps during reveal, "Ready to vote" during discuss. */
  ready: PlayerId[];
  /** R5 pointing (public). */
  points: Record<PlayerId, PlayerId | null>;
  /** R5 quick-chat, last 12. */
  chat: OooChat[];
  /** Last quick-chat time per player (R5 rate limit). */
  quickAt: Record<PlayerId, number>;
  /** Game time of the latest state change (lets `legalActions` apply the rate limit). */
  clock: number;
  /** Players who voted in the current vote or revote (never whom). */
  voted: PlayerId[];
  hidden: OooHidden;
  revealedVotes?: Record<PlayerId, PlayerId>;
  accused?: PlayerId;
  tied?: PlayerId[];
  roundResult?: OooRoundResult;
  history: OooRoundResult[];
  predict: OooPredict | null;
  scores: Record<PlayerId, number>;
  /** Points earned as an odd one ("Master of Disguise", R9). */
  oddPoints: Record<PlayerId, number>;
  /** Why the match cannot start (not enough content); the host ends it with forceAdvance. */
  error: string | null;
}

/** Player actions (spec Types). `point`/`quick` are allowed in the clues and discuss phases. */
export type OooAction =
  | { type: "gotIt" }
  | { type: "clue"; text: string }
  | { type: "ready" }
  | { type: "vote"; target: PlayerId }
  | { type: "guess"; option: string }
  | { type: "point"; target: PlayerId | null }
  | { type: "quick"; line: QuickLine };
