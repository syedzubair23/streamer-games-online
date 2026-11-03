/**
 * Odd One Out views (`docs/specs/odd-one-out.md` "Views", R11): the security boundary.
 *
 * | | stage | player (regular) | player (odd) | audience | audience (restricted) | host / moderator |
 * |---|---|---|---|---|---|---|
 * | secret | only in `roundResult` | ✔ (`me.word`) | ✗ (`me.odd`); Undercover: the decoy as `me.word` | ✔ if `audienceSecret: phones` | ✗ | ✔ unless the host is seated |
 * | who is odd | only in `roundResult` | ✗ | only self (Classic) | ✗ | ✗ | ✗ |
 * | votes | at reveal | own vote | own vote | at reveal | at reveal | at reveal |
 *
 * Every view is built from the same public base, so the Stage never gets anything a phone
 * does not; per-viewer extras are added on top. In Undercover the odd one's `me` has exactly the
 * shape and flags of a regular player's (`odd: false`), so the phone gives nothing away.
 *
 * @module
 */
import type { ViewerKey } from "@sg/engine";
import type { PlayerId } from "@sg/shared";
import { currentGiver, inRound } from "./game.ts";
import type {
  OooChat,
  OooClue,
  OooPredict,
  OooRoundResult,
  OooState,
  Phase,
  Variant,
} from "./types.ts";

/** A seat as every viewer sees it. */
export interface OooPlayerView {
  id: PlayerId;
  name: string;
  seat: number;
  colorSlot: number;
  away: boolean;
  score: number;
}

/** A player's private card (player views only). */
export interface OooMe {
  id: PlayerId;
  /** The word on the card: the secret, the Undercover decoy, or null for a Classic odd one. */
  word: string | null;
  /** "You are the Odd One 🎭" (Classic only; an Undercover odd one does not know). */
  odd: boolean;
  /** This player's own ballot in the current vote or revote. */
  vote: PlayerId | null;
}

/** The view every viewer gets (plus per-viewer extras). */
export interface OooView {
  phase: Phase;
  deadline: number | null;
  round: number;
  rounds: number;
  variant: Variant;
  oddCount: number;
  passes: number;
  players: OooPlayerView[];
  /** The category (from the deal); `options` only at last-guess and on the result card. */
  category: { id: string; name: string; options?: string[] } | null;
  order: PlayerId[];
  turn: { pass: number; idx: number };
  /** Whose clue turn it is. */
  giver: PlayerId | null;
  clues: OooClue[];
  ready: PlayerId[];
  points: Record<PlayerId, PlayerId | null>;
  chat: OooChat[];
  /** Who has voted in the current vote or revote (never whom). */
  voted: PlayerId[];
  revealedVotes?: Record<PlayerId, PlayerId>;
  accused?: PlayerId;
  tied?: PlayerId[];
  roundResult?: OooRoundResult;
  history: OooRoundResult[];
  predict: OooPredict | null;
  scores: Record<PlayerId, number>;
  oddPoints: Record<PlayerId, number>;
  error: string | null;
  /** Player views: the private card. */
  me?: OooMe;
  /** Audience (`audienceSecret: phones`, unrestricted) and host/moderator (host not seated). */
  secret?: string;
  /** Host/moderator views when the host holds a seat: "You are playing — secrets hidden". */
  hostSeated?: true;
}

const copy = <T>(v: T): T => structuredClone(v);

function base(s: OooState): OooView {
  const showOptions =
    s.variant === "classic" && (s.phase === "last-guess" || s.phase === "round-result");
  const view: OooView = {
    phase: s.phase,
    deadline: s.deadline,
    round: s.round,
    rounds: s.rounds,
    variant: s.variant,
    oddCount: s.oddCount,
    passes: s.passes,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      colorSlot: p.colorSlot,
      away: s.away.includes(p.id),
      score: s.scores[p.id] ?? 0,
    })),
    category:
      s.category === null
        ? null
        : {
            id: s.category.id,
            name: s.category.name,
            ...(showOptions ? { options: [...s.category.options] } : {}),
          },
    order: [...s.order],
    turn: { ...s.turn },
    giver: currentGiver(s),
    clues: copy(s.clues),
    ready: [...s.ready],
    points: { ...s.points },
    chat: copy(s.chat),
    voted: [...s.voted],
    history: copy(s.history),
    predict: s.predict === null ? null : copy(s.predict),
    scores: { ...s.scores },
    oddPoints: { ...s.oddPoints },
    error: s.error,
  };
  if (s.revealedVotes !== undefined) view.revealedVotes = { ...s.revealedVotes };
  if (s.accused !== undefined) view.accused = s.accused;
  if (s.tied !== undefined) view.tied = [...s.tied];
  if (s.roundResult !== undefined) view.roundResult = copy(s.roundResult);
  return view;
}

/** The private card of `id` (R2, T6). */
function card(s: OooState, id: PlayerId): OooMe {
  const round = inRound(s) && s.hidden.odd.length > 0;
  const odd = round && s.hidden.odd.includes(id);
  let word: string | null = null;
  if (round) word = odd ? (s.hidden.decoy ?? null) : s.hidden.secret;
  const vote = s.phase === "vote" || s.phase === "revote" ? (s.hidden.votes[id] ?? null) : null;
  return { id, word, odd: odd && s.variant === "classic", vote };
}

/** `view()`: the security boundary (spec "Views", R11). */
export function viewFor(s: OooState, viewer: ViewerKey): OooView {
  const view = base(s);
  const live = inRound(s) && s.hidden.secret !== "";
  switch (viewer.role) {
    case "stage":
      return view;
    case "player":
      if (s.players.some((p) => p.id === viewer.id)) view.me = card(s, viewer.id);
      return view;
    case "audience":
      if (live && viewer.restricted !== true && s.options.audienceSecret === "phones") {
        view.secret = s.hidden.secret;
      }
      return view;
    case "host":
    case "moderator":
      if (s.room.hostSeated) view.hostSeated = true;
      else if (live) view.secret = s.hidden.secret;
      return view;
  }
}
