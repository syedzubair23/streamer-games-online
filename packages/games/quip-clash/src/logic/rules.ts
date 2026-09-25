/**
 * Pure rule helpers for Quip Clash (`docs/specs/quip-clash.md`): authors and team mode (R1),
 * prompt selection and assignment (R2, "Edge cases"), answer validation (R3), and scoring
 * (R7–R12). No state transitions live here; see `game.ts`.
 *
 * @module
 */
import {
  cleanUserText,
  filterText,
  normalize,
  type PlayerId,
  type QuipPrompt,
  type Rng,
  type TeamId,
} from "@sg/shared";
import type { ContentAccess, GameResult, Seat } from "@sg/engine";
import {
  ANSWER_MAX,
  LAST_QUIP_BASE,
  MATCHUP_BASE,
  QUIP_OUT_AUD_MIN,
  QUIP_OUT_BONUS,
  type AuthorId,
  type QcAuthor,
  type QcOptions,
  type QcPrompt,
  type QcResult,
  type QcRoomSettings,
  type QcState,
  type Round,
} from "./types.ts";

// ---- R1: authors and team mode ----------------------------------------------------------------

/** The authors of a game and whether team mode is on (R1). */
export interface AuthorSetup {
  authors: QcAuthor[];
  teamMode: boolean;
  teamNote: string | null;
}

/** The host-dock note when team mode cannot run (R1). */
export const TEAM_NOTE =
  "Quip Clash needs 3 or 4 teams, so this game is played without teams (everyone writes solo).";

/**
 * Builds the authors (R1). Team mode runs when the room has 3 or 4 teams that each have a
 * seated member and every seat is on one of them; each team is one author. With 2 teams (or
 * any other shape) the game runs solo and `teamNote` tells the host. When the setup context
 * lists no teams but seats carry `teamId`s, the teams are taken from the seats.
 */
export function buildAuthors(
  seats: readonly Seat[],
  teams: readonly { id: TeamId; name: string; colorSlot: number }[],
): AuthorSetup {
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  const teamList =
    teams.length > 0
      ? teams
      : [...new Set(ordered.flatMap((s) => (s.teamId === undefined ? [] : [s.teamId])))].map(
          (id, i) => ({ id, name: id, colorSlot: i % 8 }),
        );
  const solo = (note: string | null): AuthorSetup => ({
    authors: ordered.map((s) => ({
      id: s.id,
      name: s.name,
      members: [s.id],
      colorSlot: s.colorSlot,
      seat: s.seat,
    })),
    teamMode: false,
    teamNote: note,
  });
  if (teamList.length === 0) return solo(null);
  const populated = teamList.filter((t) => ordered.some((s) => s.teamId === t.id));
  const everyoneOnATeam = ordered.every((s) => populated.some((t) => t.id === s.teamId));
  if (populated.length < 3 || populated.length > 4 || !everyoneOnATeam) return solo(TEAM_NOTE);
  const authors = populated.map((t) => {
    const members = ordered.filter((s) => s.teamId === t.id);
    return {
      id: t.id,
      name: t.name,
      members: members.map((m) => m.id),
      colorSlot: t.colorSlot,
      seat: Math.min(...members.map((m) => m.seat)),
    };
  });
  authors.sort((a, b) => a.seat - b.seat);
  return { authors, teamMode: true, teamNote: null };
}

/** The author a player writes for (their own id, or their team in team mode), or null. */
export function authorOf(state: Pick<QcState, "authors">, player: PlayerId): QcAuthor | null {
  return state.authors.find((a) => a.members.includes(player)) ?? null;
}

// ---- R2 and "Edge cases": prompt selection ---------------------------------------------------

/** The default (fallback) prompt pack. */
export const CORE_PACK = "quip-core";

/** Rounds played for an options preset (`rounds: "2"` skips round 2). */
export function roundsFor(options: Pick<QcOptions, "rounds">): Round[] {
  return options.rounds === "2" ? [1, 3] : [1, 2, 3];
}

/** Prompts a game needs: N per matchup round plus one Last Quip (`N×2+1` for 3 rounds). */
export function promptsNeeded(authors: number, options: Pick<QcOptions, "rounds">): number {
  return authors * (roundsFor(options).length - 1) + 1;
}

/** The outcome of {@link selectPrompts}: the prompts (in play order), or an error for the host. */
export type PromptSelection = { ok: true; items: QuipPrompt[] } | { ok: false; error: string };

/**
 * Picks `needed` distinct prompts ("Edge cases"): unused items from the chosen packs first, then
 * unused items from the core pack, then (only when the session has used everything) items
 * already played this session. Teen packs are skipped in family mode. Items are distinct by id
 * and by normalised text. Fails when fewer than `needed` exist at all.
 */
export function selectPrompts(
  content: ContentAccess,
  options: Pick<QcOptions, "packs">,
  room: Pick<QcRoomSettings, "contentFilter">,
  needed: number,
  rng: Rng,
): PromptSelection {
  const infos = content.packs("quip-prompts");
  const allowed = (id: string): boolean =>
    infos.some((p) => p.id === id && !(room.contentFilter === "family" && p.rating === "teen"));
  const chosen = options.packs.filter(allowed);
  const core = allowed(CORE_PACK) ? [CORE_PACK] : [];
  const chosenItems = content.items("quip-prompts", chosen);
  const coreItems = content.items("quip-prompts", core);
  const used = (item: QuipPrompt): boolean => content.isUsed("quip-prompts", item.id);
  const tiers = [
    chosenItems.filter((i) => !used(i)),
    coreItems.filter((i) => !used(i)),
    chosenItems.filter(used),
    coreItems.filter(used),
  ];
  const ids = new Set<string>();
  const texts = new Set<string>();
  const picked: QuipPrompt[] = [];
  for (const tier of tiers) {
    for (const item of rng.shuffle(tier)) {
      if (picked.length >= needed) break;
      const key = normalize(item.text);
      if (ids.has(item.id) || texts.has(key)) continue;
      ids.add(item.id);
      texts.add(key);
      picked.push(item);
    }
  }
  if (picked.length < needed) {
    return {
      ok: false,
      error: `Not enough prompts: this game needs ${needed}, but the chosen packs have only ${picked.length}. Add a prompt pack to start Quip Clash.`,
    };
  }
  return { ok: true, items: picked };
}

/**
 * R2 assignment for one matchup round: shuffles the authors into a circle; prompt *i* goes to
 * authors *i* and *(i+1) mod N*, in a random A/B order. Every author gets exactly 2 prompts and
 * every prompt exactly 2 distinct authors (N ≥ 3).
 */
export function assignRound(
  authors: readonly AuthorId[],
  items: readonly QuipPrompt[],
  round: Round,
  rng: Rng,
): QcPrompt[] {
  const circle = rng.shuffle(authors);
  const n = circle.length;
  return items.map((item, i) => {
    const a = circle[i % n] as AuthorId;
    const b = circle[(i + 1) % n] as AuthorId;
    return { id: item.id, text: item.text, authors: rng.bool() ? [a, b] : [b, a], round };
  });
}

// ---- R3: answer validation ---------------------------------------------------------------------

/** A validated, filtered answer. */
export interface CleanAnswer {
  text: string;
  flagged: boolean;
  masked: boolean;
}

/**
 * R3: an answer is 1–45 characters after trimming (control characters removed, whitespace
 * collapsed), then filtered at the room's level: family mode masks matches (the author may
 * resubmit), standard mode keeps the text and flags it for the Stage blur. Returns null when the
 * text is empty or too long.
 */
export function cleanAnswer(
  raw: string,
  filter: QcRoomSettings["contentFilter"],
): CleanAnswer | null {
  const text = cleanUserText(raw, Number.MAX_SAFE_INTEGER);
  // Graphemes never outnumber UTF-16 units, so short text needs no grapheme count.
  if (text.length === 0 || (text.length > ANSWER_MAX && cleanUserText(raw, ANSWER_MAX) !== text)) {
    return null;
  }
  const res = filterText(text, filter);
  return {
    text: res.text,
    flagged: res.flagged && filter === "standard",
    masked: res.flagged && filter === "family",
  };
}

/** R9: two answers jinx when they are equal after `normalize()`. */
export function isJinx(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

// ---- R7–R11: scoring ---------------------------------------------------------------------------

/** Round multiplier (R7): 1 for round 1, 2 for round 2. */
export function multiplier(round: Round): number {
  return round === 2 ? 2 : 1;
}

/** An aggregate audience result (from `PollResult`). */
export interface AudienceTally {
  total: number;
  tallies: Record<string, number>;
}

/** Whether the audience vote counts (R7): at least `audienceMin` members voted. */
export function audienceCounts(aud: AudienceTally | null, audienceMin: number): boolean {
  return aud !== null && aud.total > 0 && aud.total >= audienceMin;
}

/** Inputs of {@link scoreMatchup}. */
export interface MatchupInput {
  a: AuthorId;
  b: AuthorId;
  /** Player votes for A and for B. */
  votesA: number;
  votesB: number;
  /** The audience result, tallied by slot (`A` / `B`). */
  aud: AudienceTally | null;
  audienceMin: number;
  /** `audienceWeight` option (0–50). */
  weight: number;
  round: Round;
}

/**
 * R7 + R8: matchup scoring. `playerShare(X)` is X's share of the eligible votes cast (0.5 each
 * when none were cast); when the audience counts, `share = (1−w)·playerShare + w·audShare`.
 * Each author scores `round(base × share)`; a unanimous player vote (with at least one vote,
 * and audShare ≥ 0.8 when the audience counts) adds the QUIP-OUT bonus.
 */
export function scoreMatchup(input: MatchupInput): QcResult {
  const { a, b, votesA, votesB, aud, audienceMin, round } = input;
  const mult = multiplier(round);
  const base = MATCHUP_BASE * mult;
  const cast = votesA + votesB;
  const psA = cast === 0 ? 0.5 : votesA / cast;
  const psB = cast === 0 ? 0.5 : votesB / cast;
  const counted = audienceCounts(aud, audienceMin);
  const w = input.weight / 100;
  const result: QcResult = {
    points: {},
    playerShare: { [a]: psA, [b]: psB },
    votes: { [a]: votesA, [b]: votesB },
    audienceCounted: counted,
    audienceTotal: aud?.total ?? 0,
  };
  let shareA = psA;
  let shareB = psB;
  if (aud !== null && aud.total > 0) {
    const asA = (aud.tallies["A"] ?? 0) / aud.total;
    const asB = (aud.tallies["B"] ?? 0) / aud.total;
    result.audShare = { [a]: asA, [b]: asB };
    if (counted) {
      shareA = (1 - w) * psA + w * asA;
      shareB = (1 - w) * psB + w * asB;
    }
  }
  result.points = { [a]: Math.round(base * shareA), [b]: Math.round(base * shareB) };
  const sweep = cast >= 1 ? (votesA === cast ? a : votesB === cast ? b : null) : null;
  if (sweep !== null) {
    const aShare = result.audShare?.[sweep] ?? 0;
    if (!counted || aShare >= QUIP_OUT_AUD_MIN) {
      result.quipOut = sweep;
      result.points[sweep] = (result.points[sweep] ?? 0) + QUIP_OUT_BONUS * mult;
    }
  }
  return result;
}

/** R10: one blank answer; `winner` gets `base + QUIP-OUT bonus` with no vote. */
export function scoreAutoWin(winner: AuthorId, loser: AuthorId, round: Round): QcResult {
  const mult = multiplier(round);
  return {
    points: { [winner]: MATCHUP_BASE * mult + QUIP_OUT_BONUS * mult, [loser]: 0 },
    playerShare: { [winner]: 1, [loser]: 0 },
    votes: { [winner]: 0, [loser]: 0 },
    auto: winner,
    audienceCounted: false,
    audienceTotal: 0,
  };
}

/** R9: a JINX; both authors score 0 and no vote is held. */
export function scoreJinx(a: AuthorId, b: AuthorId): QcResult {
  return {
    points: { [a]: 0, [b]: 0 },
    playerShare: { [a]: 0.5, [b]: 0.5 },
    votes: { [a]: 0, [b]: 0 },
    jinx: true,
    audienceCounted: false,
    audienceTotal: 0,
  };
}

/** Inputs of {@link scoreLastQuip}. */
export interface LastQuipInput {
  /** The shown answers' authors, in slot order (`c1` is `shown[0]`). */
  shown: readonly AuthorId[];
  /** Hearts per shown author from the players. */
  votes: Record<AuthorId, number>;
  /** The audience result, tallied by slot (`c1`, `c2`, …). */
  aud: AudienceTally | null;
  audienceMin: number;
  weight: number;
}

/** The slot id of the `i`-th shown Last Quip card. */
export const slotId = (i: number): string => `c${i + 1}`;

/**
 * R11: Last Quip scoring. `playerShare(X) = hearts X / all hearts` (an even split when nobody
 * voted); the audience blend is R7's; each shown author scores `round(3000 × share)`.
 */
export function scoreLastQuip(input: LastQuipInput): QcResult {
  const { shown, votes, aud, audienceMin } = input;
  const k = shown.length;
  const all = shown.reduce((sum, id) => sum + (votes[id] ?? 0), 0);
  const counted = audienceCounts(aud, audienceMin);
  const w = input.weight / 100;
  const result: QcResult = {
    points: {},
    playerShare: {},
    votes: {},
    audienceCounted: counted,
    audienceTotal: aud?.total ?? 0,
  };
  const audShare: Record<AuthorId, number> = {};
  shown.forEach((id, i) => {
    const ps = all === 0 ? 1 / k : (votes[id] ?? 0) / all;
    result.playerShare[id] = ps;
    result.votes[id] = votes[id] ?? 0;
    let share = ps;
    if (aud !== null && aud.total > 0) {
      const as = (aud.tallies[slotId(i)] ?? 0) / aud.total;
      audShare[id] = as;
      if (counted) share = (1 - w) * ps + w * as;
    }
    result.points[id] = Math.round(LAST_QUIP_BASE * share);
  });
  if (aud !== null && aud.total > 0) result.audShare = audShare;
  return result;
}

// ---- R12: ranking ------------------------------------------------------------------------------

/**
 * R12 ranking: total score, then more QUIP-OUTs, then the earliest seat. Places are 1..N (the
 * tie-breaks make them distinct).
 */
export function ranking(
  state: Pick<QcState, "authors" | "scores" | "quipOuts">,
): GameResult["ranking"] {
  return [...state.authors]
    .sort(
      (x, y) =>
        (state.scores[y.id] ?? 0) - (state.scores[x.id] ?? 0) ||
        (state.quipOuts[y.id] ?? 0) - (state.quipOuts[x.id] ?? 0) ||
        x.seat - y.seat,
    )
    .map((a, i) => ({ id: a.id, score: state.scores[a.id] ?? 0, place: i + 1 }));
}

/** R3a: the round's top scorer (ties: the earlier seat). */
export function roundWinner(state: Pick<QcState, "authors" | "roundPoints">): AuthorId | null {
  let best: QcAuthor | null = null;
  for (const a of state.authors) {
    const pts = state.roundPoints[a.id] ?? 0;
    if (
      best === null ||
      pts > (state.roundPoints[best.id] ?? 0) ||
      (pts === (state.roundPoints[best.id] ?? 0) && a.seat < best.seat)
    ) {
      best = a;
    }
  }
  return best?.id ?? null;
}
