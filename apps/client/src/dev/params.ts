/**
 * Query parameters of the `/dev/scenario` route (SPEC §14):
 * `?game=&state=&mode=&seed=&quality=&vp=&role=&t=&freeze=1&hud=1`, plus the harness-only
 * switches `players`, `player`, `play`, `reduced` and `ambient`.
 *
 * Parsing is strict: an unknown mode, role or tier, a malformed number or a missing
 * `game`/`state` is an error, never a silent default, so a harness typo cannot produce a
 * plausible-looking but wrong screenshot.
 *
 * @module
 */
import type { ScenarioRole } from "@sg/engine";
import type { QualityTier } from "@sg/engine/client";
import type { AmbientMode } from "@sg/shared";

/** Every ambient mode the route accepts (SPEC §8). */
export const SCENARIO_MODES: readonly AmbientMode[] = ["day", "dusk", "night", "rain", "snow"];
/** Every role the route accepts (SPEC §14). */
export const ROUTE_ROLES: readonly ScenarioRole[] = ["stage", "host", "player", "audience"];
/** Every quality tier the route accepts (SPEC §10). */
export const ROUTE_TIERS: readonly QualityTier[] = ["low", "mid", "high"];

/** What the route plays after the scene is ready (`play=`). */
export type PlayMode =
  /** Nothing: the frame stays as rendered (the default). */
  | "none"
  /** The scenario's hero animation, scrubbed 0→1 in a loop (clips). */
  | "anim"
  /** The game's perf script: the listed animations back to back (G8b). */
  | "perf";

/** The parsed, validated route parameters. */
export interface ScenarioParams {
  game: string;
  state: string;
  mode: AmbientMode;
  seed: number;
  quality: QualityTier;
  /** Viewport label (`vp=`, e.g. `360x800`), informational: the harness sets the real size. */
  vp: string | null;
  role: ScenarioRole;
  /** Normalized time within the scenario's hero animation to seek to, or `null`. */
  t: number | null;
  /**
   * Stop the wall clock after the ready frame (deterministic screenshots). Default on. With a
   * `play` mode, the scene then advances only through `__SCENE__.step(ms)` (frame-exact clips).
   */
  freeze: boolean;
  /** Show the HUD layer. Default on. */
  hud: boolean;
  /** Player-count hint for the scenario builder, or `null` for the game's minimum. */
  players: number | null;
  /** Player id to view as for `role=player`, or `null` for the scenario's own viewer. */
  player: string | null;
  play: PlayMode;
  /** Comma-separated animation names for `play=perf`, in order. */
  perf: string[];
  /** Force the reduced-motion path (also on when the browser prefers reduced motion). */
  reduced: boolean;
  /** Keep the shell's ambient life (idle camera drift) running. Default off. */
  ambient: boolean;
}

/** A parse failure: every problem found, so one run reports them all. */
export class ScenarioParamError extends Error {
  constructor(readonly problems: string[]) {
    super(`bad /dev/scenario query: ${problems.join("; ")}`);
    this.name = "ScenarioParamError";
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VP = /^\d{2,5}x\d{2,5}$/;

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
  name: string,
  problems: string[],
): T {
  if (value === null || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${name}=${value} is not one of ${allowed.join("|")}`);
  return fallback;
}

function flag(value: string | null, fallback: boolean, name: string, problems: string[]): boolean {
  if (value === null || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  problems.push(`${name}=${value} must be 0 or 1`);
  return fallback;
}

function integer(
  value: string | null,
  min: number,
  max: number,
  name: string,
  problems: string[],
): number | null {
  if (value === null || value === "") return null;
  if (!/^-?\d+$/.test(value)) {
    problems.push(`${name}=${value} is not an integer`);
    return null;
  }
  const n = Number(value);
  if (n < min || n > max) {
    problems.push(`${name}=${value} is outside ${min}..${max}`);
    return null;
  }
  return n;
}

/**
 * Parses and validates a `/dev/scenario` query string.
 *
 * @throws ScenarioParamError listing every problem when the query is invalid.
 */
export function parseScenarioParams(search: string | URLSearchParams): ScenarioParams {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const problems: string[] = [];

  const game = q.get("game") ?? "";
  if (!ID.test(game)) problems.push(game === "" ? "game= is required" : `game=${game} is invalid`);
  const state = q.get("state") ?? "";
  if (!ID.test(state))
    problems.push(state === "" ? "state= is required" : `state=${state} is invalid`);

  const mode = oneOf(q.get("mode"), SCENARIO_MODES, "dusk", "mode", problems);
  const role = oneOf(q.get("role"), ROUTE_ROLES, "stage", "role", problems);
  const quality = oneOf(q.get("quality"), ROUTE_TIERS, "mid", "quality", problems);
  const seed = integer(q.get("seed"), 0, 0xffffffff, "seed", problems) ?? 1;
  const players = integer(q.get("players"), 1, 64, "players", problems);

  let t: number | null = null;
  const rawT = q.get("t");
  if (rawT !== null && rawT !== "") {
    const n = Number(rawT);
    if (!Number.isFinite(n) || n < 0 || n > 1) problems.push(`t=${rawT} must be a number in 0..1`);
    else t = n;
  }

  const vpRaw = q.get("vp");
  const vp = vpRaw === null || vpRaw === "" ? null : vpRaw;
  if (vp !== null && !VP.test(vp)) problems.push(`vp=${vp} must look like 360x800`);

  const playerRaw = q.get("player");
  const player = playerRaw === null || playerRaw === "" ? null : playerRaw;
  if (player !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(player))
    problems.push(`player=${player} is invalid`);

  const perfRaw = q.get("perf");
  const perf =
    perfRaw === null || perfRaw === ""
      ? []
      : perfRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
  for (const name of perf) if (!ID.test(name)) problems.push(`perf anim ${name} is invalid`);

  const play = oneOf(q.get("play"), ["none", "anim", "perf"] as const, "none", "play", problems);
  if (play === "perf" && perf.length === 0) problems.push("play=perf needs perf=<anim,...>");

  const freeze = flag(q.get("freeze"), true, "freeze", problems);
  const hud = flag(q.get("hud"), true, "hud", problems);
  const reduced = flag(q.get("reduced"), false, "reduced", problems);
  const ambient = flag(q.get("ambient"), false, "ambient", problems);

  if ((role === "player" || role === "audience") && play !== "none")
    problems.push(`play=${play} applies to the stage roles only`);

  if (problems.length > 0) throw new ScenarioParamError(problems);
  return {
    game,
    state,
    mode,
    seed,
    quality,
    vp,
    role,
    t,
    freeze,
    hud,
    players,
    player,
    play,
    perf,
    reduced,
    ambient,
  };
}

/** Builds a `/dev/scenario` URL (path + query) from parameters; the inverse of the parser. */
export function scenarioUrl(p: Partial<ScenarioParams> & { game: string; state: string }): string {
  const q = new URLSearchParams();
  q.set("game", p.game);
  q.set("state", p.state);
  if (p.mode !== undefined) q.set("mode", p.mode);
  if (p.seed !== undefined) q.set("seed", String(p.seed));
  if (p.quality !== undefined) q.set("quality", p.quality);
  if (p.vp !== undefined && p.vp !== null) q.set("vp", p.vp);
  if (p.role !== undefined) q.set("role", p.role);
  if (p.t !== undefined && p.t !== null) q.set("t", String(p.t));
  if (p.freeze !== undefined) q.set("freeze", p.freeze ? "1" : "0");
  if (p.hud !== undefined) q.set("hud", p.hud ? "1" : "0");
  if (p.players !== undefined && p.players !== null) q.set("players", String(p.players));
  if (p.player !== undefined && p.player !== null) q.set("player", p.player);
  if (p.play !== undefined && p.play !== "none") q.set("play", p.play);
  if (p.perf !== undefined && p.perf.length > 0) q.set("perf", p.perf.join(","));
  if (p.reduced !== undefined) q.set("reduced", p.reduced ? "1" : "0");
  if (p.ambient !== undefined) q.set("ambient", p.ambient ? "1" : "0");
  return `/dev/scenario?${q.toString()}`;
}
