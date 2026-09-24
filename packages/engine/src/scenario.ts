/**
 * The scenario contract (SPEC §14): every visible state of a game is reachable as a named
 * scenario that `/dev/scenario` renders with no network. The declarations between the markers
 * are copied exactly from the spec (`test/spec-sync.test.ts` fails if they drift).
 *
 * @module
 */
import { createRng, type PlayerId, type Rng } from "@sg/shared";
import type { GameModule, ViewerKey } from "./game-module.ts";

// ---------------------------------------------------------------------------------------------
// Copied exactly from SPEC §14.
// ---------------------------------------------------------------------------------------------

/**
 * What a scenario builder receives: seed, seeded rng, player count and the role being rendered.
 */
/**
 * A named, reachable game state for `/dev/scenario` (SPEC §14): builds a state (and optionally a
 * viewer and fx to replay), with an optional animation to scrub.
 */
// prettier-ignore
export interface ScenarioCtx { seed: number; rng: Rng; players: number; role: "stage"|"host"|"player"|"audience" }
// prettier-ignore
export interface Scenario<S> { id: string; description: string; build(ctx: ScenarioCtx): { state: S; viewer?: ViewerKey; fx?: {name:string;data?:unknown}[] }; anim?: { name: string; durationMs: number } }
/**
 * A game's scenarios by id (exported from its `scenarios.ts`).
 */
// prettier-ignore
export type ScenarioRegistry<S> = Record<string, Scenario<S>>;

// ---------------------------------------------------------------------------------------------
// End of the SPEC §14 copy.
// ---------------------------------------------------------------------------------------------

/** The roles a scenario can be rendered for (`/dev/scenario?role=`). */
export type ScenarioRole = ScenarioCtx["role"];

/** Every scenario role, in the order the harness renders them. */
export const SCENARIO_ROLES: readonly ScenarioRole[] = Object.freeze([
  "stage",
  "host",
  "player",
  "audience",
]);

/** The default player a `role=player` scenario is viewed as, when the scenario names none. */
export const DEFAULT_SCENARIO_PLAYER: PlayerId = "p1";

/**
 * The viewer key for a scenario role. `player` views as `playerId` (default
 * {@link DEFAULT_SCENARIO_PLAYER}); the other roles map one to one.
 */
export function viewerKeyForRole(role: ScenarioRole, playerId?: PlayerId): ViewerKey {
  switch (role) {
    case "player":
      return { role: "player", id: playerId ?? DEFAULT_SCENARIO_PLAYER };
    case "audience":
      return { role: "audience" };
    case "host":
      return { role: "host" };
    case "stage":
      return { role: "stage" };
  }
}

/** Inputs to {@link resolveScenario}: the query parameters of `/dev/scenario`. */
export interface ResolveScenarioInput {
  /** The scenario id (`state=`). */
  state: string;
  /** The seed (`seed=`); also seeds the scenario's `rng`. Default 1. */
  seed?: number;
  /** Player count hint for scenarios that support several. Default `module.manifest.minPlayers`. */
  players?: number;
  /** Role to render for (`role=`). Default `stage`. */
  role?: ScenarioRole;
  /** Player id for `role=player` when the scenario does not pick its own viewer. */
  playerId?: PlayerId;
}

/** What the scenario route mounts: the state, the viewer, its view and any fx to replay. */
export interface ResolvedScenario<S, V> {
  scenario: Scenario<S>;
  state: S;
  viewer: ViewerKey;
  view: V;
  fx: { name: string; data?: unknown }[];
}

/**
 * Builds a scenario exactly as `/dev/scenario` does (SPEC §14): seeds an rng from `seed`,
 * calls `scenario.build`, then runs `view(state, viewer)` for the scenario's own viewer when it
 * matches `role`, or else the viewer of `role`. Deterministic for a fixed input.
 *
 * @throws Error when the scenario id is unknown (the message lists the registered ids).
 */
export function resolveScenario<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  registry: ScenarioRegistry<S>,
  input: ResolveScenarioInput,
): ResolvedScenario<S, V> {
  const scenario = Object.hasOwn(registry, input.state) ? registry[input.state] : undefined;
  if (scenario === undefined) {
    const known = Object.keys(registry).join(", ") || "(none)";
    throw new Error(
      `resolveScenario: ${module.manifest.id} has no scenario "${input.state}" (known: ${known})`,
    );
  }
  const seed = input.seed ?? 1;
  const role = input.role ?? "stage";
  const built = scenario.build({
    seed,
    rng: createRng(seed),
    players: input.players ?? module.manifest.minPlayers,
    role,
  });
  // A scenario's own viewer applies only to the role it was written for (e.g. "view as p3" for
  // role=player); the stage render of the same scenario still uses the stage view.
  const viewer =
    built.viewer !== undefined && built.viewer.role === role
      ? built.viewer
      : viewerKeyForRole(role, input.playerId);
  return {
    scenario,
    state: built.state,
    viewer,
    view: module.view(built.state, viewer),
    fx: built.fx ?? [],
  };
}
