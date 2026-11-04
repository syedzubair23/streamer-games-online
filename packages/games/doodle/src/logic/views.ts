/**
 * Doodle views (spec "Views"): the security boundary.
 *
 * - The drawer's view has the word (and, while the drawer picks, the three choices).
 * - The Stage, the audience, the host and the other players see only the hint (and during the
 *   tier vote, only the tier names). The word appears in every view from the reveal on.
 * - Everyone sees the live drawing and the filtered feed. The text of a correct guess is never
 *   in any view; insider chat (from players who already guessed) reaches only the other correct
 *   guessers and the drawer.
 * - The host view adds the id of the item the host dock can skip; it never carries the word.
 *
 * @module
 */
import type { GameResult, ViewerKey } from "@sg/engine";
import type { PlayerId, TeamId } from "@sg/shared";
import { gameResult, mayGuess, mayReport, teamMode } from "./game.ts";
import { pageFull } from "./rules.ts";
import {
  TIER_LABELS,
  type CrowdResult,
  type DoodleState,
  type Drawing,
  type FeedEntry,
  type GalleryEntry,
  type Phase,
  type RevealInfo,
  type Tier,
  type TierInfo,
} from "./types.ts";

/** A seat as views show it. */
export interface ViewPlayer {
  id: PlayerId;
  name: string;
  colorSlot: number;
  teamId?: TeamId;
  connected: boolean;
}

/** The viewer's own slice (players only). */
export interface ViewYou {
  id: PlayerId;
  role: "drawer" | "guesser";
  /** The word: the drawer during the draw phase only. */
  word: { w: string; alt: string[] } | null;
  /** The three choices: the drawer while picking only. */
  choices: { w: string; tier: Tier }[] | null;
  /** This viewer guessed correctly this turn (and its points). */
  correct: number | null;
  reported: boolean;
  canGuess: boolean;
  canReport: boolean;
  /** Drawer: the page is full ("Page full!"); undo still works. */
  pageFull: boolean;
}

/** The Doodle view. */
export interface DoodleView {
  phase: Phase;
  deadline: number | null;
  mode: "guess";
  round: number;
  rounds: number;
  /** 0-based turn index (-1 in the intro) and the total turn count. */
  turn: number;
  turns: number;
  drawer: PlayerId | null;
  picker: "audience" | "drawer" | null;
  /** The open audience tier vote: tier names only, never words. */
  tierVote: { pollId: string; options: { id: string; label: string }[] } | null;
  /** How this turn's word was chosen ("Chat chose HARD 🌵"), from the draw phase on. */
  tier: TierInfo | null;
  /** The hint tiles, e.g. `"_ a _ _ _"` (draw phase only). */
  hint: string | null;
  drawing: Drawing;
  feed: FeedEntry[];
  correct: Record<PlayerId, number>;
  reports: number;
  scores: Record<string, number>;
  players: ViewPlayer[];
  teams: { id: TeamId; name: string; colorSlot: number; members: PlayerId[] }[];
  teamTurn: TeamId | null;
  stealOpen: boolean;
  reveal: RevealInfo | null;
  crowd: CrowdResult | null;
  final: {
    ranking: GameResult["ranking"];
    bestArtist: PlayerId | null;
    gallery: GalleryEntry[];
  } | null;
  you: ViewYou | null;
  /** Host view only: the item the host dock can skip (`skipItem`). */
  host: { itemId: string | null } | null;
}

/** Whether `viewer` may read insider chat: the drawer and the correct guessers. */
function insider(state: DoodleState, id: PlayerId | null): boolean {
  if (id === null) return false;
  return id === state.drawer || Object.hasOwn(state.correct, id);
}

function youOf(state: DoodleState, id: PlayerId): ViewYou | null {
  if (!state.players.some((p) => p.id === id)) return null;
  const drawer = id === state.drawer;
  const word = state.hidden.word;
  const choices = state.hidden.wordChoices;
  return {
    id,
    role: drawer ? "drawer" : "guesser",
    word:
      drawer && state.phase === "draw" && word !== undefined
        ? { w: word.w, alt: [...word.alt] }
        : null,
    choices:
      drawer && state.phase === "word-pick" && state.picker === "drawer" && choices !== undefined
        ? choices.words.map((c) => ({ w: c.w, tier: c.tier }))
        : null,
    correct: state.correct[id] ?? null,
    reported: state.reports.includes(id),
    canGuess: mayGuess(state, id),
    canReport: mayReport(state, id),
    pageFull: drawer && state.phase === "draw" && pageFull(state.drawing),
  };
}

/** `view()`: the per-viewer projection. */
export function viewFor(state: DoodleState, viewer: ViewerKey): DoodleView {
  const playerId = viewer.role === "player" ? viewer.id : null;
  const canInsider = insider(state, playerId);
  const final =
    state.phase === "final"
      ? (() => {
          const result = gameResult(state);
          return {
            ranking: result.ranking,
            bestArtist: result.highlights?.[0]?.playerId ?? null,
            gallery: state.gallery,
          };
        })()
      : null;
  return {
    phase: state.phase,
    deadline: state.deadline,
    mode: state.mode,
    round: state.round,
    rounds: state.rounds,
    turn: state.turn,
    turns: state.order.length,
    drawer: state.drawer ?? null,
    picker: state.picker,
    tierVote:
      state.tierPoll !== null
        ? {
            pollId: state.tierPoll,
            options: ([1, 2, 3] as const).map((t) => ({ id: String(t), label: TIER_LABELS[t] })),
          }
        : null,
    tier: state.phase === "draw" || state.phase === "reveal" ? state.tier : null,
    hint: state.phase === "draw" ? (state.hint ?? null) : null,
    drawing: state.drawing,
    feed: state.feed.filter((f) => f.insider !== true || canInsider),
    correct: { ...state.correct },
    reports: state.reports.length,
    scores: { ...state.scores },
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      colorSlot: p.colorSlot,
      ...(p.teamId !== undefined ? { teamId: p.teamId } : {}),
      connected: p.connected,
    })),
    teams: state.teams.map((t) => ({ ...t, members: [...t.members] })),
    teamTurn: teamMode(state) ? state.teamTurn : null,
    stealOpen: state.stealOpen,
    reveal: state.phase === "reveal" ? state.reveal : null,
    crowd: state.crowd,
    final,
    you: playerId === null ? null : youOf(state, playerId),
    host:
      viewer.role === "host"
        ? {
            itemId:
              state.phase === "word-pick" || state.phase === "draw" ? `turn-${state.turn}` : null,
          }
        : null,
  };
}
