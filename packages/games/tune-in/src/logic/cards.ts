/**
 * The Tune In deck: spectrum cards drawn from the room's `spectrum` packs (SPEC §12), with a
 * small built-in fallback so a room with no (or a too small) pack still plays, and so client
 * scenarios (which get no content) have cards. Card choices are drawn in pairs of two
 * different cards (spec edge case).
 *
 * @module
 */
import { normalize, type Rng } from "@sg/shared";
import type { ContentAccess } from "@sg/engine";
import type { Card } from "./types.ts";

/**
 * Built-in fallback cards (original). `examples` run left to right along the dial, and never
 * contain a word of either end (so the bot's clues always pass the R5 filter).
 */
export const FALLBACK_CARDS: readonly Card[] = Object.freeze([
  { id: "fb-cold-hot", left: "Cold", right: "Hot", examples: ["Ice cube", "Tap water", "Lava"] },
  {
    id: "fb-underrated-overrated",
    left: "Underrated",
    right: "Overrated",
    examples: ["Naps", "Brunch", "Avocado toast"],
  },
  { id: "fb-quiet-loud", left: "Quiet", right: "Loud", examples: ["Library", "Café", "Fireworks"] },
  { id: "fb-tiny-huge", left: "Tiny", right: "Huge", examples: ["Ant", "Bicycle", "Whale"] },
  {
    id: "fb-useless-useful",
    left: "Useless",
    right: "Useful",
    examples: ["Chocolate teapot", "Spare button", "Duct tape"],
  },
  {
    id: "fb-cozy-uncomfortable",
    left: "Cozy",
    right: "Uncomfortable",
    examples: ["Blanket fort", "Office chair", "Wet socks"],
  },
  {
    id: "fb-boring-thrilling",
    left: "Boring",
    right: "Thrilling",
    examples: ["Waiting room", "Board game night", "Rollercoaster"],
  },
  {
    id: "fb-healthy-unhealthy",
    left: "Healthy",
    right: "Unhealthy",
    examples: ["Broccoli", "Pizza", "Deep-fried butter"],
  },
  {
    id: "fb-easy-hard",
    left: "Easy to learn",
    right: "Hard to learn",
    examples: ["Tic-tac-toe", "Guitar", "Mandarin"],
  },
  {
    id: "fb-cheap-pricey",
    left: "Cheap",
    right: "Pricey",
    examples: ["Paperclip", "Sneakers", "Yacht"],
  },
  { id: "fb-slow-fast", left: "Slow", right: "Fast", examples: ["Snail", "Jogger", "Cheetah"] },
  {
    id: "fb-soft-rough",
    left: "Soft",
    right: "Rough",
    examples: ["Kitten fur", "Denim", "Sandpaper"],
  },
  {
    id: "fb-calm-chaotic",
    left: "Calm",
    right: "Chaotic",
    examples: ["Zen garden", "Supermarket", "Toddler party"],
  },
  {
    id: "fb-old-new",
    left: "Old-fashioned",
    right: "Futuristic",
    examples: ["Typewriter", "Smartphone", "Teleporter"],
  },
  {
    id: "fb-sweet-savory",
    left: "Sweet",
    right: "Savory",
    examples: ["Candy floss", "Popcorn", "Anchovies"],
  },
  {
    id: "fb-villain-hero",
    left: "Villain",
    right: "Hero",
    examples: ["Dragon", "Referee", "Firefighter"],
  },
]);

/** Cards kept in the deck ring: enough for every turn plus host skips, without bloating state. */
export const DECK_SIZE = 36;

/** Two cards are the same if their ids or their normalized ends match. */
export function sameCard(a: Card, b: Card): boolean {
  if (a.id === b.id) return true;
  return normalize(a.left) === normalize(b.left) && normalize(a.right) === normalize(b.right);
}

function toCard(item: {
  id: string;
  left: string;
  right: string;
  examples: readonly string[];
}): Card {
  return { id: item.id, left: item.left, right: item.right, examples: [...item.examples] };
}

/**
 * Builds the game's deck from the selected packs: unused cards first (SPEC §12 "no repeats
 * across games"), each group shuffled, duplicates removed, capped at {@link DECK_SIZE}. Falls
 * back to {@link FALLBACK_CARDS} when fewer than 2 distinct cards are available.
 */
export function buildDeck(content: ContentAccess, packs: readonly string[], rng: Rng): Card[] {
  const unique: Card[] = [];
  for (const item of content.items("spectrum", packs)) {
    const card = toCard(item);
    if (!unique.some((c) => sameCard(c, card))) unique.push(card);
  }
  const source =
    unique.length >= 2
      ? unique
      : FALLBACK_CARDS.map((c) => toCard({ ...c, examples: c.examples ?? [] }));
  const fresh = source.filter((c) => !content.isUsed("spectrum", c.id));
  const used = source.filter((c) => content.isUsed("spectrum", c.id));
  return [...rng.shuffle(fresh), ...rng.shuffle(used)].slice(0, DECK_SIZE);
}

/**
 * Draws the next two different cards from the front of the ring and moves them to the back.
 * The deck always holds at least 2 distinct cards (see {@link buildDeck}).
 */
export function drawPair(deck: readonly Card[]): { pair: [Card, Card]; deck: Card[] } {
  const [first, ...rest] = deck;
  if (first === undefined) throw new Error("tune-in: empty deck");
  const idx = rest.findIndex((c) => !sameCard(c, first));
  if (idx < 0) throw new Error("tune-in: deck needs two different cards");
  const second = rest[idx] as Card;
  const remaining = rest.filter((_, i) => i !== idx);
  return { pair: [first, second], deck: [...remaining, first, second] };
}
