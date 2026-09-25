/**
 * Server-safe logic entry for `@sg/game-quip-clash/logic` (SPEC §9.2): the Quip Clash
 * `GameModule` (`docs/specs/quip-clash.md`), pure and deterministic.
 *
 * - `logic`: the module the platform runs (room settings from the setup context, ER-006).
 * - `createQuipClash(room)`: the same module with pinned room settings (moderation, content
 *   filter, audienceMin), for tests, scenarios and the server until ER-006 lands.
 *
 * @module
 */
import type { GameManifest, GameModule, OptionSpec } from "@sg/engine";
import { bot, legalActions } from "./bot.ts";
import {
  onAction,
  onAudienceResult,
  onHostCommand,
  onModeration,
  onPlayerLeave,
  onPlayerRejoin,
  onTimer,
  setupGame,
} from "./game.ts";
import { parseAction } from "./parse.ts";
import type { SetupContextWithRoom } from "./room.ts";
import {
  GAME_ID,
  type QcAction,
  type QcOptions,
  type QcRoomSettings,
  type QcState,
} from "./types.ts";
import { viewFor, type QcView } from "./views.ts";

export * from "./types.ts";
export * from "./views.ts";
export { bot, freshAnswer, legalActions } from "./bot.ts";
export { parseAction, RAW_TEXT_MAX } from "./parse.ts";
export { resolveRoomSettings, type SetupContextWithRoom } from "./room.ts";
export {
  answerComplete,
  answerOf,
  authorDone,
  currentPrompt,
  gameResult,
  involves,
  isEligible,
  pendingIn,
  roundPrompts,
  voteComplete,
} from "./game.ts";
export {
  assignRound,
  audienceCounts,
  authorOf,
  buildAuthors,
  cleanAnswer,
  CORE_PACK,
  isJinx,
  multiplier,
  promptsNeeded,
  ranking,
  roundsFor,
  roundWinner,
  scoreAutoWin,
  scoreJinx,
  scoreLastQuip,
  scoreMatchup,
  selectPrompts,
  slotId,
  TEAM_NOTE,
} from "./rules.ts";

/** The manifest (spec "Manifest"). */
export const manifest: GameManifest = {
  id: GAME_ID,
  name: "Quip Clash",
  version: "1.0.0",
  minPlayers: 3,
  maxPlayers: 8,
  teamSupport: "optional",
  audience: { vote: true, predict: true },
  tickHz: 0,
  renderMode: "on-demand",
  estMinutes: [12, 15],
  tags: ["party", "writing", "comedy", "audience-vote"],
  contentRating: "all",
  howToPlay: [
    "Write funny answers to prompts",
    "Two answers go head to head",
    "Everyone votes. Funniest wins!",
  ],
};

/** Host options (spec "Host options"). */
export const optionSpecs: OptionSpec[] = [
  {
    kind: "pack",
    key: "packs",
    label: "Prompt packs",
    packKind: "quip-prompts",
    multi: true,
    default: ["quip-core"],
  },
  { kind: "seconds", key: "answerSec", label: "Writing time", min: 45, max: 180, default: 90 },
  { kind: "seconds", key: "voteSec", label: "Voting time", min: 10, max: 40, default: 20 },
  {
    kind: "int",
    key: "audienceWeight",
    label: "Chat vote weight (%)",
    min: 0,
    max: 50,
    step: 5,
    default: 30,
  },
  {
    kind: "enum",
    key: "rounds",
    label: "Rounds",
    choices: [
      { value: "3", label: "3 rounds" },
      { value: "2", label: "2 rounds (skip round 2)" },
    ],
    default: "3",
  },
  { kind: "bool", key: "safetyQuip", label: "Safety Quip button", default: true },
];

/** The Quip Clash module type. */
export type QuipClashModule = GameModule<QcState, QcAction, QcOptions, QcView>;

/** Builds the module. `room` pins room settings over whatever the setup context carries. */
export function createQuipClash(room: Partial<QcRoomSettings> = {}): QuipClashModule {
  return {
    manifest,
    optionSpecs,
    parseAction,
    setup: (ctx) => setupGame(ctx as SetupContextWithRoom<QcOptions>, room),
    onAction,
    onTimer,
    onAudienceResult,
    onModeration,
    onPlayerLeave,
    onPlayerRejoin,
    onHostCommand,
    view: viewFor,
    legalActions,
    bot,
    serialize: (state) => JSON.stringify(state),
    deserialize: (data) => JSON.parse(data) as QcState,
  };
}

/** The Quip Clash game module. */
export const logic: QuipClashModule = createQuipClash();
