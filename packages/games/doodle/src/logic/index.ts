/**
 * Server-safe logic entry for `@sg/game-doodle/logic` (SPEC §9.2): the Doodle `GameModule`
 * (`docs/specs/doodle.md`), pure and deterministic.
 *
 * - `logic`: the module the platform runs (room settings from the setup context, ER-006).
 * - `createDoodle(room)`: the same module with pinned room settings (content filter,
 *   moderation, audienceMin), for tests, scenarios and the server until ER-006 lands.
 *
 * M5-01 ships Guess mode (with Team Doodle). Telephone mode is M5-01b (cut-first, SPEC §6
 * "Build-order risk"): until it lands, `mode` offers only `guess`.
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
  type DoodleAction,
  type DoodleOptions,
  type DoodleRoomSettings,
  type DoodleState,
} from "./types.ts";
import { viewFor, type DoodleView } from "./views.ts";

export * from "./types.ts";
export * from "./views.ts";
export * from "./rules.ts";
export * from "./words.ts";
export {
  bot,
  legalActions,
  scribble,
  BOT_STROKES,
  BOT_GUESS_P,
  BOT_GUESS_PERIOD_MS,
  DECOY_GUESSES,
  INSIDER_SAMPLE,
} from "./bot.ts";
export { parseAction, RAW_TEXT_MAX, RAW_POINTS_MAX } from "./parse.ts";
export { resolveRoomSettings, type SetupContextWithRoom } from "./room.ts";
export {
  connectedGuessers,
  CUSTOM_TURN_SHARE,
  gameResult,
  mayGuess,
  mayReport,
  teamMode,
  TIMER,
} from "./game.ts";

/** The manifest (spec "Manifest"). */
export const manifest: GameManifest = {
  id: GAME_ID,
  name: "Doodle",
  version: "1.0.0",
  minPlayers: 3,
  maxPlayers: 12,
  teamSupport: "optional",
  audience: { guess: true, vote: true, predict: true, tap: true },
  tickHz: 0,
  renderMode: "on-demand",
  estMinutes: [8, 14],
  tags: ["party", "drawing", "guessing", "audience-guess"],
  contentRating: "all",
  howToPlay: [
    "One player draws a secret word",
    "Everyone races to guess it",
    "Faster guesses score more",
  ],
};

/** Host options (spec "Host options", Guess mode keys; Telephone keys arrive with M5-01b). */
export const optionSpecs: OptionSpec[] = [
  {
    kind: "enum",
    key: "mode",
    label: "Mode",
    choices: [{ value: "guess", label: "Guess (one draws, everyone guesses)" }],
    default: "guess",
  },
  {
    kind: "pack",
    key: "packs",
    label: "Word packs",
    packKind: "doodle-words",
    multi: true,
    default: ["doodle-core"],
  },
  {
    kind: "enum",
    key: "customWords",
    label: "Custom words",
    choices: [
      { value: "off", label: "Off" },
      { value: "mix", label: "Mix with the packs" },
      { value: "only", label: "Only custom words" },
    ],
    default: "off",
  },
  {
    kind: "enum",
    key: "rounds",
    label: "Rounds",
    choices: [
      { value: "auto", label: "Auto (2 for 3–4 players, else 1)" },
      { value: "1", label: "1 round" },
      { value: "2", label: "2 rounds" },
      { value: "3", label: "3 rounds" },
    ],
    default: "auto",
  },
  { kind: "seconds", key: "drawSec", label: "Drawing time", min: 40, max: 150, default: 70 },
  { kind: "bool", key: "hints", label: "Letter hints", default: true },
  { kind: "bool", key: "audiencePicksTier", label: "Chat picks the difficulty", default: true },
];

/** The Doodle module type. */
export type DoodleModule = GameModule<DoodleState, DoodleAction, DoodleOptions, DoodleView>;

/** Builds the module. `room` pins room settings over whatever the setup context carries. */
export function createDoodle(room: Partial<DoodleRoomSettings> = {}): DoodleModule {
  return {
    manifest,
    optionSpecs,
    parseAction,
    setup: (ctx) => setupGame(ctx as SetupContextWithRoom<DoodleOptions>, room),
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
    deserialize: (data) => JSON.parse(data) as DoodleState,
  };
}

/** The Doodle game module. */
export const logic: DoodleModule = createDoodle();
