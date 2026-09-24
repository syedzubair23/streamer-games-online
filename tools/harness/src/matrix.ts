/**
 * The per-game screenshot matrix of DOD §3 and the file naming contract
 * `artifacts/screenshots/<id>/round-<r>/<state>__<mode>__<vp|role>.png`.
 *
 * | Set | States | Modes | Viewports / roles |
 * |---|---|---|---|
 * | Stage | every `stage` scenario | day, dusk, night, rain | 360×800 (low, DPR 2), 1280×720 (mid), 1920×1080 (high) |
 * | Stream-sim | the 1920×1080 stage shots | dusk, night | 1280×720 JPEG q60 |
 * | Controller | every `player`/`audience` scenario | dusk, night | 360×800, per role |
 * | Snow spot check | `midgame` | snow | 1920×1080 |
 * | Clips | every scenario with an anim | dusk | 1280×720, 4–6 s WebM |
 *
 * @module
 */
import type { ManifestScenario, ScenarioManifest } from "./scenarios/manifest.ts";

export type Mode = "day" | "dusk" | "night" | "rain" | "snow";
export type Tier = "low" | "mid" | "high";

/** A viewport of the matrix. */
export interface Viewport {
  label: string;
  width: number;
  height: number;
  dpr: number;
  tier: Tier;
  mobile: boolean;
}

/** The three Stage viewports (DOD §3). */
export const STAGE_VIEWPORTS: readonly Viewport[] = Object.freeze([
  { label: "360x800", width: 360, height: 800, dpr: 2, tier: "low", mobile: true },
  { label: "1280x720", width: 1280, height: 720, dpr: 1, tier: "mid", mobile: false },
  { label: "1920x1080", width: 1920, height: 1080, dpr: 1, tier: "high", mobile: false },
]);
/** The phone viewport for controllers. */
export const PHONE: Viewport = Object.freeze({
  label: "360x800",
  width: 360,
  height: 800,
  dpr: 2,
  tier: "low",
  mobile: true,
});
/** The clip viewport. */
export const CLIP_VIEWPORT: Viewport = STAGE_VIEWPORTS[1] as Viewport;
/** The perf viewports (DOD G8a/G8b). */
export const PERF_LOW: Viewport = Object.freeze({
  label: "412x915",
  width: 412,
  height: 915,
  dpr: 1,
  tier: "low",
  mobile: true,
});
export const PERF_HIGH: Viewport = STAGE_VIEWPORTS[2] as Viewport;

export const STAGE_MODES: readonly Mode[] = ["day", "dusk", "night", "rain"];
export const CONTROLLER_MODES: readonly Mode[] = ["dusk", "night"];
export const STREAM_MODES: readonly Mode[] = ["dusk", "night"];
export const CLIP_MODE: Mode = "dusk";
/** The fixed seed of every harness capture (research 05 §B.7 uses 3). */
export const HARNESS_SEED = 3;

/** One capture of the matrix. */
export interface Shot {
  set: "stage" | "controller" | "snow";
  state: string;
  mode: Mode;
  role: "stage" | "player" | "audience";
  viewport: Viewport;
  /** File name inside the round directory. */
  file: string;
}

/** `<state>__<mode>__<vp|role>.png` (DOD §3). */
export const shotFile = (state: string, mode: string, tag: string): string =>
  `${state}__${mode}__${tag}.png`;

/** Repo-relative round directory for a game's screenshots. */
export const roundDir = (id: string, round: number | string): string =>
  `artifacts/screenshots/${id}/round-${round}`;

const inMatrix = (s: ManifestScenario): boolean => s.inSpec && s.registered;

/** The scenario used for the snow spot check and perf: `midgame`, else the first stage scenario. */
export function midgameScenario(manifest: ScenarioManifest): ManifestScenario | null {
  const stage = manifest.scenarios.filter((s) => inMatrix(s) && s.roles.includes("stage"));
  return stage.find((s) => s.id === "midgame") ?? stage[0] ?? null;
}

/** Every still of the matrix for a manifest (clips and stream-sim are derived separately). */
export function screenshotMatrix(manifest: ScenarioManifest): Shot[] {
  const shots: Shot[] = [];
  const scenarios = manifest.scenarios.filter(inMatrix);
  for (const s of scenarios.filter((x) => x.roles.includes("stage")))
    for (const mode of STAGE_MODES)
      for (const vp of STAGE_VIEWPORTS)
        shots.push({
          set: "stage",
          state: s.id,
          mode,
          role: "stage",
          viewport: vp,
          file: shotFile(s.id, mode, vp.label),
        });
  for (const s of scenarios)
    for (const role of ["player", "audience"] as const)
      if (s.roles.includes(role))
        for (const mode of CONTROLLER_MODES)
          shots.push({
            set: "controller",
            state: s.id,
            mode,
            role,
            viewport: PHONE,
            file: shotFile(s.id, mode, role),
          });
  const mid = midgameScenario(manifest);
  if (mid !== null) {
    const vp = STAGE_VIEWPORTS[2] as Viewport;
    shots.push({
      set: "snow",
      state: mid.id,
      mode: "snow",
      role: "stage",
      viewport: vp,
      file: shotFile(mid.id, "snow", vp.label),
    });
  }
  return shots;
}

/** Scenarios that get a clip (every matrix scenario with an anim and a stage role). */
export function clipScenarios(manifest: ScenarioManifest): ManifestScenario[] {
  return manifest.scenarios.filter(
    (s) => inMatrix(s) && s.anim !== null && s.roles.includes("stage"),
  );
}

/** The expected matrix size (G7 "the full matrix is captured"). */
export function matrixCounts(manifest: ScenarioManifest): {
  stills: number;
  stream: number;
  clips: number;
} {
  const stills = screenshotMatrix(manifest);
  return {
    stills: stills.length,
    stream: stills.filter(
      (s) => s.set === "stage" && s.viewport.label === "1920x1080" && STREAM_MODES.includes(s.mode),
    ).length,
    clips: clipScenarios(manifest).length,
  };
}

/** Query parameters of `/dev/scenario` (SPEC §14); mirrors `apps/client/src/dev/params.ts`. */
export interface ScenarioQuery {
  game: string;
  state: string;
  mode?: Mode;
  seed?: number;
  quality?: Tier;
  vp?: string;
  role?: "stage" | "host" | "player" | "audience";
  t?: number;
  freeze?: boolean;
  hud?: boolean;
  player?: string;
  play?: "anim" | "perf";
  perf?: readonly string[];
  reduced?: boolean;
  ambient?: boolean;
}

/** Builds a `/dev/scenario?...` path. */
export function scenarioPath(q: ScenarioQuery): string {
  const p = new URLSearchParams();
  p.set("game", q.game);
  p.set("state", q.state);
  if (q.mode !== undefined) p.set("mode", q.mode);
  p.set("seed", String(q.seed ?? HARNESS_SEED));
  if (q.quality !== undefined) p.set("quality", q.quality);
  if (q.vp !== undefined) p.set("vp", q.vp);
  if (q.role !== undefined) p.set("role", q.role);
  if (q.t !== undefined) p.set("t", String(q.t));
  p.set("freeze", q.freeze === false ? "0" : "1");
  if (q.hud !== undefined) p.set("hud", q.hud ? "1" : "0");
  if (q.player !== undefined) p.set("player", q.player);
  if (q.play !== undefined) p.set("play", q.play);
  if (q.perf !== undefined && q.perf.length > 0) p.set("perf", q.perf.join(","));
  if (q.reduced !== undefined) p.set("reduced", q.reduced ? "1" : "0");
  if (q.ambient !== undefined) p.set("ambient", q.ambient ? "1" : "0");
  return `/dev/scenario?${p.toString()}`;
}

/** The path of a matrix shot. */
export function shotPath(game: string, shot: Shot): string {
  return scenarioPath({
    game,
    state: shot.state,
    mode: shot.mode,
    quality: shot.viewport.tier,
    vp: shot.viewport.label,
    role: shot.role,
  });
}
