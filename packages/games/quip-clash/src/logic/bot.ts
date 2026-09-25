/**
 * The Quip Clash bot and `legalActions` (SPEC §9.3: `bot()` is required for takeovers and sims).
 *
 * The bot writes short original answers from a phrase kit, sometimes presses Safety Quip, and
 * votes at random (so bot-vs-bot games are fair, DOD G5). A disconnected author's bot does
 * nothing here: the game itself fills their answers with safety quips 10 s before the deadline
 * (R14), and a disconnected voter's vote is simply missing.
 *
 * Generated answers never repeat or contain (and are never contained in) any other text in the
 * game, so two authors can never write the same line by accident.
 *
 * @module
 */
import { createRng, type PlayerId, type Rng } from "@sg/shared";
import { answerOf, isEligible, roundPrompts } from "./game.ts";
import { authorOf, slotId } from "./rules.ts";
import {
  ANSWER_MAX,
  LAST_QUIP_HEARTS,
  type AuthorId,
  type QcAction,
  type QcState,
} from "./types.ts";

const OPENERS = [
  "a suspiciously damp",
  "my grandma's",
  "an emotional support",
  "a haunted",
  "one extremely polite",
  "a lukewarm",
  "a tiny, furious",
  "an overconfident",
  "a slightly used",
  "a very dramatic",
  "a sleepy",
  "an award-winning",
  "a secretly sentient",
  "a glitter-covered",
  "the world's saddest",
  "a budget",
  "a heroic",
  "an unlicensed",
  "a deeply confused",
  "a single, lonely",
  "a mysteriously warm",
  "an ancient",
  "a motivational",
  "a crunchy",
] as const;

const NOUNS = [
  "trombone",
  "raccoon",
  "spreadsheet",
  "casserole",
  "llama",
  "rubber duck",
  "harmonica",
  "lawn gnome",
  "waffle iron",
  "pigeon",
  "shoelace",
  "accordion",
  "garden hose",
  "potato",
  "flip phone",
  "traffic cone",
  "sock puppet",
  "kazoo",
  "pancake",
  "canoe",
  "snow globe",
  "bagpipe",
  "cactus",
  "toaster",
] as const;

const TAILS = [
  "",
  " named Kevin",
  " with opinions",
  " on roller skates",
  " in a tuxedo",
  " at 3 a.m.",
  " full of soup",
  " that hums",
  " wearing sunglasses",
  " from the future",
] as const;

/** Every text already in the game (answers, safety lines, prompts, names), lowercased. */
function gameTexts(state: QcState): string[] {
  const out: string[] = [];
  for (const byAuthor of Object.values(state.hidden.answers)) {
    for (const a of Object.values(byAuthor)) out.push(a.text);
  }
  for (const pool of Object.values(state.hidden.safetyPool)) out.push(...pool);
  for (const p of state.prompts) out.push(p.text);
  for (const a of state.authors) out.push(a.name);
  for (const p of state.players) out.push(p.name);
  return out.filter((t) => t.length >= 3).map((t) => t.toLowerCase());
}

/**
 * A fresh answer: an opener, a noun and (sometimes) a tail, that neither contains nor is
 * contained in any text already in the game. Falls back to a numbered variant.
 */
export function freshAnswer(state: QcState, rng: Rng): string {
  const taken = gameTexts(state);
  const clashes = (text: string): boolean => {
    const t = text.toLowerCase();
    return taken.some((x) => x.includes(t) || t.includes(x));
  };
  for (let attempt = 0; attempt < 24; attempt++) {
    const text = `${rng.pick(OPENERS)} ${rng.pick(NOUNS)}${rng.pick(TAILS)}`;
    if (text.length <= ANSWER_MAX && !clashes(text)) return text;
  }
  for (let n = 2; ; n++) {
    const numbered = `${rng.pick(NOUNS)} number ${n}`;
    if (!clashes(numbered)) return numbered;
  }
}

/** Slots of the Last Quip cards a player may give hearts to (not their own). */
function votableSlots(state: QcState, author: AuthorId): string[] {
  return state.order.flatMap((a, i) => (a === author ? [] : [slotId(i)]));
}

/**
 * The bot (SPEC §9.3): answers its next open prompt (15% of the time with a Safety Quip while
 * an unused line is left), then votes at random; Last Quip hearts go to random other cards.
 * Like {@link freshAnswer}, it never makes two authors hold the same hidden text: the rules
 * allow a reused line (R3), but the engine's secrecy check cannot tell a shared text from a
 * leak (docs/engine-requests.md ER-008).
 */
export function bot(state: QcState, player: PlayerId, rng: Rng): QcAction | null {
  if (state.away.includes(player)) return null;
  const author = authorOf(state, player);
  if (author === null) return null;
  if (state.phase === "answer") {
    const open = roundPrompts(state).find(
      (p) => p.authors.includes(author.id) && answerOf(state, p.id, author.id) === undefined,
    );
    if (open === undefined) return null;
    const canSafety =
      state.options.safetyQuip &&
      state.safetyUsed[author.id] !== state.round &&
      (state.hidden.safetyPool[open.id] ?? []).length > 0;
    if (canSafety && rng.bool(0.15)) return { type: "safety", promptId: open.id };
    return { type: "answer", promptId: open.id, text: freshAnswer(state, rng) };
  }
  if (state.phase !== "vote" || state.closing) return null;
  if (state.votes[player] !== undefined || !isEligible(state, player)) return null;
  if (state.round !== 3) return { type: "vote", choice: rng.bool() ? "A" : "B" };
  const slots = votableSlots(state, author.id);
  const alloc: Record<string, number> = {};
  for (let i = 0; i < LAST_QUIP_HEARTS; i++) {
    const slot = rng.pick(slots);
    alloc[slot] = (alloc[slot] ?? 0) + 1;
  }
  return { type: "lastVote", alloc };
}

/**
 * `legalActions` (SPEC §9.3: a representative sample for text games): one sample answer per
 * own prompt plus Safety Quip where allowed and an unused line is left (see {@link bot});
 * both matchup votes; for Last Quip every
 * all-hearts-on-one-card allocation plus one spread allocation.
 */
export function legalActions(state: QcState, player: PlayerId): QcAction[] {
  const author = authorOf(state, player);
  if (author === null) return [];
  if (state.phase === "answer") {
    const out: QcAction[] = [];
    const safetyOpen = state.options.safetyQuip && state.safetyUsed[author.id] !== state.round;
    for (const p of roundPrompts(state)) {
      if (!p.authors.includes(author.id)) continue;
      const text = freshAnswer(state, createRng(`legal:${author.id}:${p.id}`));
      out.push({ type: "answer", promptId: p.id, text });
      if (safetyOpen && (state.hidden.safetyPool[p.id] ?? []).length > 0) {
        out.push({ type: "safety", promptId: p.id });
      }
    }
    return out;
  }
  if (state.phase !== "vote" || state.closing || !isEligible(state, player)) return [];
  if (state.round !== 3) {
    return [
      { type: "vote", choice: "A" },
      { type: "vote", choice: "B" },
    ];
  }
  const slots = votableSlots(state, author.id);
  const out: QcAction[] = slots.map((slot) => ({ type: "lastVote", alloc: { [slot]: 3 } }));
  if (slots.length >= 3) {
    out.push({
      type: "lastVote",
      alloc: { [slots[0] as string]: 1, [slots[1] as string]: 1, [slots[2] as string]: 1 },
    });
  }
  return out;
}
