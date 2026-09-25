/**
 * Server-safe logic entry for `@sg/game-odd-one-out/logic` (SPEC §9.2): the Odd One Out
 * `GameModule` (`docs/specs/odd-one-out.md`), pure and deterministic.
 *
 * - `logic`: the module the platform runs (room settings from the setup context, ER-006/ER-009).
 * - `createOddOneOut(room)`: the same module with pinned room settings (clue filter level,
 *   seated host), for tests, scenarios and the server until those engine requests land.
 *
 * @module
 */
import type { GameManifest, GameModule, OptionSpec } from "@sg/engine";
import { bot, legalActions } from "./bot.ts";
import {
  onAction,
  onAudienceResult,
  onHostCommand,
  onPlayerLeave,
  onPlayerRejoin,
  onTimer,
  setupGame,
} from "./game.ts";
import { parseAction } from "./parse.ts";
import type { SetupContextWithRoom } from "./room.ts";
import {
  GAME_ID,
  type OooAction,
  type OooOptions,
  type OooRoomSettings,
  type OooState,
} from "./types.ts";
import { viewFor, type OooView } from "./views.ts";

export * from "./types.ts";
export * from "./views.ts";
export { bot, clueCandidates, legalActions } from "./bot.ts";
export { parseAction, RAW_TEXT_MAX } from "./parse.ts";
export { resolveRoomSettings, type SetupContextWithRoom } from "./room.ts";
export { dealDeck, FALLBACK_GENERIC, loadCategories, loadPairs } from "./content.ts";
export {
  connected,
  currentGiver,
  gameResult,
  inRound,
  involves,
  isOdd,
  isPlayer,
  quickReady,
  voteTargets,
} from "./game.ts";
export {
  checkClue,
  clueKey,
  clueOrder,
  mastersOfDisguise,
  oddCountFor,
  passesFor,
  ranking,
  says,
  scoreRound,
  tally,
  toClue,
  voteCounts,
} from "./rules.ts";

/** The manifest (spec "Manifest"). */
export const manifest: GameManifest = {
  id: GAME_ID,
  name: "Odd One Out",
  version: "1.0.0",
  minPlayers: 4,
  maxPlayers: 10,
  teamSupport: "none",
  audience: { predict: true },
  tickHz: 0,
  renderMode: "on-demand",
  estMinutes: [10, 14],
  tags: ["party", "social-deduction", "words", "audience-predict"],
  contentRating: "all",
  howToPlay: [
    "Everyone gets the secret word except the Odd One",
    "Give a one-word clue — not too obvious!",
    "Vote out the Odd One",
  ],
};

/** Host options (spec "Host options"). */
export const optionSpecs: OptionSpec[] = [
  {
    kind: "pack",
    key: "packs",
    label: "Category packs",
    packKind: "ooo-categories",
    multi: true,
    default: ["ooo-core"],
  },
  {
    kind: "enum",
    key: "variant",
    label: "Variant",
    choices: [
      { value: "classic", label: "Classic (the Odd One knows)" },
      { value: "undercover", label: "Undercover (a similar word)" },
    ],
    default: "classic",
  },
  {
    kind: "enum",
    key: "oddCount",
    label: "Odd ones",
    choices: [
      { value: "auto", label: "Auto (2 at 8+ players)" },
      { value: "1", label: "1" },
      { value: "2", label: "2" },
    ],
    default: "auto",
  },
  { kind: "int", key: "rounds", label: "Rounds", min: 2, max: 8, default: 3 },
  {
    kind: "enum",
    key: "clueRounds",
    label: "Clue passes",
    choices: [
      { value: "auto", label: "Auto (2 up to 7 players, else 1)" },
      { value: "1", label: "1" },
      { value: "2", label: "2" },
      { value: "3", label: "3" },
    ],
    default: "auto",
  },
  { kind: "seconds", key: "clueSec", label: "Clue time", min: 10, max: 60, default: 20 },
  {
    kind: "seconds",
    key: "discussSec",
    label: "Discussion time",
    min: 20,
    max: 180,
    default: 45,
  },
  {
    kind: "enum",
    key: "audienceSecret",
    label: "Secret on audience phones",
    choices: [
      { value: "phones", label: "Show on phones" },
      { value: "off", label: "Hide" },
    ],
    default: "phones",
  },
];

/** The Odd One Out module type. */
export type OddOneOutModule = GameModule<OooState, OooAction, OooOptions, OooView>;

/** Builds the module. `room` pins room settings over whatever the setup context carries. */
export function createOddOneOut(room: Partial<OooRoomSettings> = {}): OddOneOutModule {
  return {
    manifest,
    optionSpecs,
    parseAction,
    setup: (ctx) => setupGame(ctx as SetupContextWithRoom<OooOptions>, room),
    onAction,
    onTimer,
    onAudienceResult,
    onPlayerLeave,
    onPlayerRejoin,
    onHostCommand,
    view: viewFor,
    legalActions,
    bot,
    serialize: (state) => JSON.stringify(state),
    deserialize: (data) => JSON.parse(data) as OooState,
  };
}

/** The Odd One Out game module. */
export const logic: OddOneOutModule = createOddOneOut();
