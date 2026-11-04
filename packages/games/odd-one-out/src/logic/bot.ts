/**
 * `legalActions` and the bot for Odd One Out (`GameModule.bot` is required: takeover and sims).
 *
 * The bot follows R10: a regular player's bot gives clues from the secret's clue bank, an odd
 * one's bot (who does not know the secret) gives category-wide generic clues, and it votes
 * randomly (it votes for whoever it pointed at, a random pick). An accused odd one's bot makes a
 * random last guess (edge case). Around that it taps "Got it", points once per round, sends at
 * most one quick-chat line in the discussion and then taps "Ready to vote", so a bot table stays
 * lively without flooding the chat.
 *
 * @module
 */
import { hasProfanity, type PlayerId, type Rng } from "@sg/shared";
import { FALLBACK_GENERIC } from "./content.ts";
import { currentGiver, isOdd, isPlayer, quickReady, voteTargets } from "./game.ts";
import { clueKey, says, toClue } from "./rules.ts";
import { type OooAction, type OooState, type QuickLine } from "./types.ts";

const LINES: readonly QuickLine[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** The last-resort clue when every list is used up. */
const LAST_RESORT = "hmm";

/**
 * Bank phrase → its one-word clue, or null when it can't be one. The result depends only on the
 * phrase, so this never changes a bot's choice; it saves the profanity matcher, which dominates
 * bot turns otherwise. The phrases come from content packs, so the cache stays small.
 */
const CLEAN_CLUES = new Map<string, string | null>();

function cleanClue(phrase: string): string | null {
  const known = CLEAN_CLUES.get(phrase);
  if (known !== undefined) return known;
  const clue = toClue(phrase);
  const clean = clue !== null && !hasProfanity(clue) ? clue : null;
  CLEAN_CLUES.set(phrase, clean);
  return clean;
}

/**
 * Candidate clues for `player` in priority order (R10): unused clue-bank clues (regular players
 * only), then unused generic clues, then the fallbacks. A regular player never offers a clue
 * that says the secret; nobody repeats a clue already on the table while fresh ones remain.
 */
export function clueCandidates(s: OooState, player: PlayerId): string[] {
  const odd = isOdd(s, player);
  const given = new Set(s.clues.map((c) => clueKey(c.text)));
  const usable = (list: readonly string[]): string[] =>
    list
      .map(cleanClue)
      .filter((c): c is string => c !== null)
      .filter((c) => odd || !says(c, s.hidden.secret));
  const fresh = (list: readonly string[]): string[] =>
    usable(list).filter((c) => !given.has(clueKey(c)));
  const out = [
    ...(odd ? [] : fresh(s.hidden.bank)),
    ...fresh(s.hidden.generic),
    ...fresh(FALLBACK_GENERIC),
    ...(odd ? [] : usable(s.hidden.bank)),
    ...usable(s.hidden.generic),
  ];
  const unique = [...new Map(out.map((c) => [clueKey(c), c])).values()];
  return unique.length > 0 ? unique : [LAST_RESORT];
}

/** R5 talk actions: point at someone else (or lower the hand), quick-chat when off cooldown. */
function talkActions(s: OooState, player: PlayerId): OooAction[] {
  const out: OooAction[] = [];
  const current = s.points[player] ?? null;
  for (const p of s.players) {
    if (p.id !== player && p.id !== current) out.push({ type: "point", target: p.id });
  }
  if (current !== null) out.push({ type: "point", target: null });
  // `clock` is the latest state change; any later action time is at least as late.
  if (quickReady(s, player, s.clock)) {
    for (const line of LINES) out.push({ type: "quick", line });
  }
  return out;
}

/**
 * Every legal action of `player` (the clue is a representative sample: the bot's first choice).
 */
export function legalActions(s: OooState, player: PlayerId): OooAction[] {
  if (!isPlayer(s, player)) return [];
  switch (s.phase) {
    case "reveal":
      return s.ready.includes(player) ? [] : [{ type: "gotIt" }];
    case "clues": {
      const out: OooAction[] = [];
      if (currentGiver(s) === player) {
        out.push({ type: "clue", text: clueCandidates(s, player)[0] as string });
      }
      return [...out, ...talkActions(s, player)];
    }
    case "discuss":
      return [
        ...(s.ready.includes(player) ? [] : [{ type: "ready" } as const]),
        ...talkActions(s, player),
      ];
    case "vote":
    case "revote":
      return s.voted.includes(player)
        ? []
        : voteTargets(s, player).map((target) => ({ type: "vote", target }));
    case "last-guess":
      return s.accused === player
        ? (s.category?.options ?? []).map((option) => ({ type: "guess", option }))
        : [];
    default:
      return [];
  }
}

const others = (s: OooState, player: PlayerId): PlayerId[] =>
  s.players.map((p) => p.id).filter((id) => id !== player);

/** The bot's move for `player`, or null when it has nothing to do right now. */
export function bot(s: OooState, player: PlayerId, rng: Rng): OooAction | null {
  if (!isPlayer(s, player)) return null;
  const pointed = s.points[player] ?? null;
  switch (s.phase) {
    case "reveal":
      return s.ready.includes(player) ? null : { type: "gotIt" };
    case "clues": {
      if (currentGiver(s) === player) {
        const list = clueCandidates(s, player);
        // Mostly the best clue, sometimes the next one, so bot tables vary.
        const pick = list.length > 1 && rng.bool(0.3) ? list[1] : list[0];
        return { type: "clue", text: pick as string };
      }
      const givers = [...new Set(s.clues.map((c) => c.by))].filter((id) => id !== player);
      if (pointed === null && givers.length >= 2 && rng.bool(0.35)) {
        return { type: "point", target: rng.pick(givers) };
      }
      return null;
    }
    case "discuss": {
      if (pointed === null) return { type: "point", target: rng.pick(others(s, player)) };
      const chatted = s.chat.some((c) => c.by === player);
      if (!chatted && quickReady(s, player, s.clock) && rng.bool(0.5)) {
        return { type: "quick", line: rng.pick(LINES) };
      }
      return s.ready.includes(player) ? null : { type: "ready" };
    }
    case "vote":
    case "revote": {
      if (s.voted.includes(player)) return null;
      const targets = voteTargets(s, player);
      const target = pointed !== null && targets.includes(pointed) ? pointed : rng.pick(targets);
      return { type: "vote", target };
    }
    case "last-guess": {
      const options = s.category?.options ?? [];
      return s.accused === player && options.length > 0
        ? { type: "guess", option: rng.pick(options) }
        : null;
    }
    default:
      return null;
  }
}
