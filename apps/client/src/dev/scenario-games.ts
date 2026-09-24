/**
 * The scenario route's lazy game map: `?game=<id>` loads only that game's chunks.
 *
 * Every entry resolves a game's three published entry points (SPEC §9.2 package exports):
 *
 * | Entry | Export the route looks for |
 * |---|---|
 * | `@sg/game-<id>/logic` | `logic: GameModule` (SPEC §9.2), or the one export shaped like a GameModule |
 * | `@sg/game-<id>/scenarios` | `scenarios: ScenarioRegistry`, or the one export shaped like a registry |
 * | `@sg/game-<id>/client` | `client: GameClientModule`, or the one export shaped like a client module |
 *
 * The shapes are checked at runtime, so a game whose Mx-01/Mx-03 item has not landed yet gives
 * a clear "not registered yet" error instead of a blank frame. `tictactoe` is the engine's
 * reference fixture (`@sg/engine/fixtures/tictactoe`), used to validate the route (M0-05).
 *
 * @module
 */
import type { GameModule, ScenarioRegistry } from "@sg/engine";
import type { GameClientModule } from "@sg/engine/client";

/** A game as the route mounts it. `client` is null for a game without a client yet. */
export interface ScenarioGame {
  logic: GameModule<unknown, unknown, unknown, unknown>;
  scenarios: ScenarioRegistry<unknown>;
  client: GameClientModule<unknown, unknown> | null;
}

type Mod = Record<string, unknown>;

const isObject = (v: unknown): v is Mod => typeof v === "object" && v !== null;
const isFn = (v: unknown): boolean => typeof v === "function";

/** Whether a value has the GameModule shape (manifest + the core functions). */
export function isGameModule(v: unknown): v is ScenarioGame["logic"] {
  return (
    isObject(v) &&
    isObject(v["manifest"]) &&
    typeof (v["manifest"] as Mod)["id"] === "string" &&
    isFn(v["setup"]) &&
    isFn(v["view"]) &&
    isFn(v["onAction"]) &&
    isFn(v["parseAction"])
  );
}

/** Whether a value is a non-empty ScenarioRegistry (every entry has an id and a `build`). */
export function isScenarioRegistry(v: unknown): v is ScenarioRegistry<unknown> {
  if (!isObject(v) || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return (
    entries.length > 0 &&
    entries.every(([k, s]) => isObject(s) && s["id"] === k && isFn(s["build"]))
  );
}

/** Whether a value has the GameClientModule shape. */
export function isClientModule(v: unknown): v is GameClientModule<unknown, unknown> {
  return isObject(v) && typeof v["id"] === "string" && isFn(v["stage"]) && isFn(v["controller"]);
}

/**
 * Picks the export named `preferred` when it has the right shape, else the single export that
 * does. Returns null when there is none, and throws when several match (ambiguous).
 */
export function pickExport<T>(
  mod: Mod,
  preferred: string,
  guard: (v: unknown) => v is T,
  what: string,
): T | null {
  const named = mod[preferred];
  if (guard(named)) return named;
  const matches = Object.entries(mod).filter(([, v]) => guard(v));
  if (matches.length > 1)
    throw new Error(
      `${what}: several exports match (${matches.map(([k]) => k).join(", ")}); export it as "${preferred}"`,
    );
  return matches.length === 1 ? (matches[0]?.[1] as T) : null;
}

/** Assembles a {@link ScenarioGame} from a game's loaded entry modules. */
export function assembleGame(
  id: string,
  logicMod: Mod,
  scenarioMod: Mod,
  clientMod: Mod | null,
): ScenarioGame {
  const logic = pickExport(logicMod, "logic", isGameModule, `@sg/game-${id}/logic`);
  if (logic === null)
    throw new Error(
      `game "${id}" has no logic yet: @sg/game-${id}/logic must export \`logic: GameModule\` (its Mx-01 item)`,
    );
  if (logic.manifest.id !== id)
    throw new Error(`game "${id}": logic.manifest.id is "${logic.manifest.id}"`);
  const scenarios = pickExport(
    scenarioMod,
    "scenarios",
    isScenarioRegistry,
    `@sg/game-${id}/scenarios`,
  );
  if (scenarios === null)
    throw new Error(
      `game "${id}" has no scenarios yet: @sg/game-${id}/scenarios must export \`scenarios: ScenarioRegistry\` (its Mx-01 item)`,
    );
  const client =
    clientMod === null
      ? null
      : pickExport(clientMod, "client", isClientModule, `@sg/game-${id}/client`);
  return { logic, scenarios, client };
}

async function load(
  id: string,
  logic: () => Promise<Mod>,
  scenarios: () => Promise<Mod>,
  client: () => Promise<Mod>,
): Promise<ScenarioGame> {
  const [l, s, c] = await Promise.all([logic(), scenarios(), client()]);
  return assembleGame(id, l, s, c);
}

/** Loaders by game id. Each one is a dynamic import, so only the requested game is fetched. */
export const SCENARIO_GAMES: Readonly<Record<string, () => Promise<ScenarioGame>>> = Object.freeze({
  tictactoe: () =>
    load(
      "tictactoe",
      async () => {
        const m = await import("@sg/engine/fixtures/tictactoe");
        return { logic: m.tictactoe };
      },
      async () => {
        const m = await import("@sg/engine/fixtures/tictactoe");
        return { scenarios: m.tictactoeScenarios };
      },
      async () => {
        const m = await import("@sg/engine/fixtures/tictactoe/client");
        return { client: m.tictactoeClient };
      },
    ),
  "quip-clash": () =>
    load(
      "quip-clash",
      () => import("@sg/game-quip-clash/logic"),
      () => import("@sg/game-quip-clash/scenarios"),
      () => import("@sg/game-quip-clash/client"),
    ),
  "tune-in": () =>
    load(
      "tune-in",
      () => import("@sg/game-tune-in/logic"),
      () => import("@sg/game-tune-in/scenarios"),
      () => import("@sg/game-tune-in/client"),
    ),
  "trivia-night": () =>
    load(
      "trivia-night",
      () => import("@sg/game-trivia-night/logic"),
      () => import("@sg/game-trivia-night/scenarios"),
      () => import("@sg/game-trivia-night/client"),
    ),
  doodle: () =>
    load(
      "doodle",
      () => import("@sg/game-doodle/logic"),
      () => import("@sg/game-doodle/scenarios"),
      () => import("@sg/game-doodle/client"),
    ),
  "odd-one-out": () =>
    load(
      "odd-one-out",
      () => import("@sg/game-odd-one-out/logic"),
      () => import("@sg/game-odd-one-out/scenarios"),
      () => import("@sg/game-odd-one-out/client"),
    ),
  ludo: () =>
    load(
      "ludo",
      () => import("@sg/game-ludo/logic"),
      () => import("@sg/game-ludo/scenarios"),
      () => import("@sg/game-ludo/client"),
    ),
  chess: () =>
    load(
      "chess",
      () => import("@sg/game-chess/logic"),
      () => import("@sg/game-chess/scenarios"),
      () => import("@sg/game-chess/client"),
    ),
  "marble-rally": () =>
    load(
      "marble-rally",
      () => import("@sg/game-marble-rally/logic"),
      () => import("@sg/game-marble-rally/scenarios"),
      () => import("@sg/game-marble-rally/client"),
    ),
});

/** Loads a game for the route. */
export async function loadScenarioGame(id: string): Promise<ScenarioGame> {
  const loader = Object.hasOwn(SCENARIO_GAMES, id) ? SCENARIO_GAMES[id] : undefined;
  if (loader === undefined)
    throw new Error(`unknown game "${id}" (known: ${Object.keys(SCENARIO_GAMES).join(", ")})`);
  return loader();
}
