/**
 * Quip Clash views (`docs/specs/quip-clash.md` "Views per role"). `view()` is the security
 * boundary (SPEC §9.3):
 *
 * - **stage / audience**: public state only. No prompt before `show-prompt`, no answer before
 *   `show-answers` / `show-all` (pending answers are blurred placeholders with no text), no
 *   authors of the answers before `results`, no ballots before `results`.
 * - **player**: the same, plus their own prompts and answers (their team's in team mode) during
 *   the answer phase, their eligibility and their own vote.
 * - **host / moderator**: the stage view plus the moderation queue (pending text, R13), the
 *   team-mode note and the R14 end prompt. Never another player's unrevealed answer.
 *
 * @module
 */
import type { ViewerKey } from "@sg/engine";
import type { PlayerId } from "@sg/shared";
import { answerOf, authorDone, currentPrompt, isEligible, roundPrompts } from "./game.ts";
import { authorOf, ranking, roundsFor, slotId } from "./rules.ts";
import type { AuthorId, Phase, QcHighlight, QcPlayer, QcState, Round } from "./types.ts";

/** One answer card as the views show it. */
export interface QcCardView {
  /** `A` / `B` in a matchup, `c1..c8` in Last Quip. */
  slot: string;
  /** The text, or null while it awaits review or when the answer is blank. */
  text: string | null;
  /** Waiting for host review (R13): the Stage shows a blurred card. */
  awaiting: boolean;
  /** No answer (R4/R10). */
  blank: boolean;
  /** Standard-mode profanity flag: blurred until the host reveals it (SPEC §9.7). */
  flagged: boolean;
  /** Replaced by a safety quip after a rejection ("edited by host", R13). */
  byHost: boolean;
  /** The author, from `results` on. */
  author: AuthorId | null;
}

/** An author as the views list them. */
export interface QcAuthorView {
  id: AuthorId;
  name: string;
  colorSlot: number;
  members: PlayerId[];
  seat: number;
  /** Finished answering this round (ids only; answer phase). */
  done: boolean;
  /** Every member is disconnected. */
  away: boolean;
}

/** The result of the matchup or Last Quip on screen (from `results`). */
export interface QcResultView {
  points: Record<AuthorId, number>;
  playerShare: Record<AuthorId, number>;
  audShare: Record<AuthorId, number> | null;
  quipOut: AuthorId | null;
  jinx: boolean;
  auto: AuthorId | null;
  votes: Record<AuthorId, number>;
  audienceCounted: boolean;
  audienceTotal: number;
}

/** A player's own prompt during the answer phase. */
export interface QcOwnPrompt {
  id: string;
  text: string;
  answer: string | null;
  safety: boolean;
  /** Family-mode masking changed the text; the author may resubmit. */
  masked: boolean;
}

/** Player-only fields. */
export interface QcYouView {
  id: PlayerId;
  author: AuthorId;
  /** Own prompts and current answers (answer phase only; team mode: the team's). */
  prompts: QcOwnPrompt[];
  /** The Safety Quip button is available on at least one own prompt (R3). */
  safetyLeft: boolean;
  done: boolean;
  /** May vote right now. */
  canVote: boolean;
  /** Is one of the current matchup's authors ("You're in this one!"). */
  inMatchup: boolean;
  /** Own card slots on screen (a matchup's A/B, or Last Quip cards they cannot vote for). */
  ownSlots: string[];
  /** Own matchup vote (`A` / `B`). */
  vote: string | null;
  /** Own Last Quip hearts (slot → count). */
  alloc: Record<string, number> | null;
}

/** Host / moderator-only fields. */
export interface QcHostView {
  /**
   * Answers waiting for review, with their text (R13). No author: a host who also plays must
   * not learn who wrote what before `results` (the platform has the owner from `moderate`).
   */
  review: { itemId: string; promptId: string; promptText: string; text: string }[];
  /** R14: fewer than 3 authors connected for 30 s; `forceAdvance` ends the game. */
  endPrompt: boolean;
}

/** Every role's view. `you` is set for players only; `host` for host and moderator. */
export interface QcView {
  phase: Phase;
  round: Round;
  /** The rounds this game plays (`[1, 2, 3]`, or `[1, 3]`). */
  rounds: Round[];
  matchup: number;
  /** Matchups (prompts) this round. */
  matchups: number;
  deadline: number | null;
  /** The players' vote is over; the audience window is closing (the Stage "closing…" state). */
  closing: boolean;
  players: QcPlayer[];
  authors: QcAuthorView[];
  teamMode: boolean;
  /** R1: team mode was requested but cannot run. */
  teamNote: string | null;
  /** Setup failed (not enough prompts). */
  error: string | null;
  scores: Record<AuthorId, number>;
  quipOuts: Record<AuthorId, number>;
  /** The prompt on screen, from `show-prompt` (round 3: from `show-all`). */
  prompt: { id: string; text: string } | null;
  /** The matchup's cards A and B, from `show-answers`. */
  cards: QcCardView[] | null;
  /** Answers on screen still awaiting review (the dock chip "1 answer awaiting review"). */
  awaiting: number;
  /**
   * Votes cast so far and players eligible, as counts only ("3 of 4 voted"): who may vote
   * would tell who wrote the answers, which stays hidden until `results`.
   */
  votesCast: number;
  votersEligible: number;
  /** Ballots, from `results`: `A`/`B`, or slot → hearts. */
  ballots: Record<PlayerId, string | Record<string, number>> | null;
  result: QcResultView | null;
  /** The audience vote of the current matchup / Last Quip. */
  poll: { pollId: string; min: number } | null;
  /** The round-winner bet (R3a). */
  predict: {
    pollId: string;
    round: Round;
    open: boolean;
    tallies: Record<string, number> | null;
    total: number;
  } | null;
  /** The final ranking and highlights (final phase). */
  final: {
    ranking: { id: AuthorId; score: number; place: number }[];
    highlights: QcHighlight[];
  } | null;
  you: QcYouView | null;
  host: QcHostView | null;
}

const REVEAL_PHASES: readonly Phase[] = ["show-answers", "review-wait", "vote", "results"];
const LAST_QUIP_PHASES: readonly Phase[] = ["show-all", "review-wait", "vote", "results"];
const PROMPT_PHASES: readonly Phase[] = ["show-prompt", ...REVEAL_PHASES];

/** Whether the current prompt is on screen. */
function promptShown(s: QcState): boolean {
  return (s.round === 3 ? LAST_QUIP_PHASES : PROMPT_PHASES).includes(s.phase);
}

/** Whether the current prompt's answers are on screen. */
function answersShown(s: QcState): boolean {
  return (s.round === 3 ? LAST_QUIP_PHASES : REVEAL_PHASES).includes(s.phase);
}

function card(s: QcState, promptId: string, author: AuthorId, slot: string): QcCardView {
  const rev = s.revealed[promptId];
  const ans = answerOf(s, promptId, author);
  const text = rev?.answers[author] ?? null;
  return {
    slot,
    text,
    awaiting: ans?.mod === "pending",
    blank: ans === undefined,
    flagged: rev?.flagged.includes(author) ?? false,
    byHost: rev?.edited.includes(author) ?? false,
    author: s.phase === "results" ? author : null,
  };
}

function cards(s: QcState): QcCardView[] | null {
  if (!answersShown(s)) return null;
  const p = currentPrompt(s);
  if (s.round === 3) return s.order.map((a, i) => card(s, p.id, a, slotId(i)));
  const [a, b] = p.authors as [AuthorId, AuthorId];
  return [card(s, p.id, a, "A"), card(s, p.id, b, "B")];
}

function resultView(s: QcState): QcResultView | null {
  if (s.phase !== "results") return null;
  const r = s.results[currentPrompt(s).id];
  if (r === undefined) return null;
  return {
    points: r.points,
    playerShare: r.playerShare,
    audShare: r.audShare ?? null,
    quipOut: r.quipOut ?? null,
    jinx: r.jinx === true,
    auto: r.auto ?? null,
    votes: r.votes,
    audienceCounted: r.audienceCounted,
    audienceTotal: r.audienceTotal,
  };
}

function eligibleCount(s: QcState): number {
  if (s.phase !== "vote") return 0;
  return s.players.filter((p) => isEligible(s, p.id)).length;
}

function publicView(s: QcState): QcView {
  const shown = promptShown(s);
  const p = shown ? currentPrompt(s) : null;
  const c = cards(s);
  return {
    phase: s.phase,
    round: s.round,
    rounds: roundsFor(s.options),
    matchup: s.matchup,
    matchups: roundPrompts(s).length,
    deadline: s.deadline,
    closing: s.closing,
    players: s.players,
    authors: s.authors.map((a) => ({
      id: a.id,
      name: a.name,
      colorSlot: a.colorSlot,
      members: a.members,
      seat: a.seat,
      done: s.phase === "answer" && authorDone(s, a.id),
      away: a.members.every((m) => s.away.includes(m)),
    })),
    teamMode: s.teamMode,
    teamNote: s.teamNote,
    error: s.error,
    scores: s.scores,
    quipOuts: s.quipOuts,
    prompt: p === null ? null : { id: p.id, text: p.text },
    cards: c,
    awaiting: c === null ? 0 : c.filter((x) => x.awaiting).length,
    votesCast: s.phase === "vote" ? Object.keys(s.votes).length : 0,
    votersEligible: eligibleCount(s),
    ballots: s.phase === "results" ? s.votes : null,
    result: resultView(s),
    poll: s.aud === null ? null : { pollId: s.aud.pollId, min: s.room.audienceMin },
    predict: s.predict,
    final: s.phase === "final" ? { ranking: ranking(s), highlights: s.highlights } : null,
    you: null,
    host: null,
  };
}

function youView(s: QcState, player: PlayerId): QcYouView | null {
  const author = authorOf(s, player);
  if (author === null) return null;
  const answering = s.phase === "answer";
  const prompts: QcOwnPrompt[] = answering
    ? roundPrompts(s)
        .filter((p) => p.authors.includes(author.id))
        .map((p) => {
          const ans = answerOf(s, p.id, author.id);
          return {
            id: p.id,
            text: p.text,
            answer: ans?.text ?? null,
            safety: ans?.safety ?? false,
            masked: ans?.masked ?? false,
          };
        })
    : [];
  const safetyLeft =
    answering &&
    s.options.safetyQuip &&
    s.safetyUsed[author.id] !== s.round &&
    prompts.some((p) => (s.hidden.safetyPool[p.id] ?? []).length > 0);
  const onScreen = promptShown(s) ? currentPrompt(s) : null;
  const inMatchup = s.round !== 3 && onScreen !== null && onScreen.authors.includes(author.id);
  let ownSlots: string[] = [];
  if (inMatchup && onScreen !== null) ownSlots = [onScreen.authors[0] === author.id ? "A" : "B"];
  else if (s.round === 3 && answersShown(s)) {
    ownSlots = s.order.flatMap((a, i) => (a === author.id ? [slotId(i)] : []));
  }
  const ballot = s.votes[player];
  return {
    id: player,
    author: author.id,
    prompts,
    safetyLeft,
    done: answering && authorDone(s, author.id),
    canVote: s.phase === "vote" && !s.closing && isEligible(s, player),
    inMatchup,
    ownSlots,
    vote: typeof ballot === "string" ? ballot : null,
    alloc: ballot !== undefined && typeof ballot !== "string" ? ballot : null,
  };
}

function hostView(s: QcState): QcHostView {
  return {
    review: Object.entries(s.modItems).map(([itemId, item]) => ({
      itemId,
      promptId: item.promptId,
      promptText: (s.prompts.find((p) => p.id === item.promptId) as QcState["prompts"][number])
        .text,
      text: (answerOf(s, item.promptId, item.author) as NonNullable<ReturnType<typeof answerOf>>)
        .text,
    })),
    endPrompt: s.endPrompt,
  };
}

/** `view()`: the per-role projection (the security boundary). */
export function viewFor(s: QcState, viewer: ViewerKey): QcView {
  const v = publicView(s);
  switch (viewer.role) {
    case "player":
      v.you = youView(s, viewer.id);
      return v;
    case "host":
    case "moderator":
      v.host = hostView(s);
      return v;
    default:
      return v;
  }
}
