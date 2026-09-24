/**
 * The scenario manifest `artifacts/scenarios/<id>.json` (DOD §3: "the harness reads
 * artifacts/scenarios/<id>.json, which the build emits from scenarios.ts"). It joins what the
 * game **registers** (`scenarios.ts`: ids, descriptions, anims) with what its **spec** requires
 * (the Scenarios table: roles, critic notes, anims; the perf script), and lists every mismatch.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GameTarget } from "../games.ts";
import { parseGameSpec, type GameSpec, type Role } from "./spec.ts";

/** What the harness needs from one registered scenario. */
export interface RegisteredScenario {
  id: string;
  description: string;
  anim: { name: string; durationMs: number } | null;
}

/** One scenario in the manifest. */
export interface ManifestScenario extends RegisteredScenario {
  /** Roles from the spec table (empty when the scenario is not in the spec). */
  roles: Role[];
  /** "What the critic should see", from the spec. */
  critic: string;
  /** Role qualifiers from the spec (e.g. `player: ["drawer", "guesser"]`). */
  variants: Partial<Record<Role, string[]>>;
  inSpec: boolean;
  registered: boolean;
}

/** `artifacts/scenarios/<id>.json`. */
export interface ScenarioManifest {
  game: string;
  spec: string;
  scenarios: ManifestScenario[];
  /** Animation names of the perf script (G8b). */
  perfScript: string[];
  /** Spec scenarios that are not registered, and other hard mismatches (G6 fails on any). */
  problems: string[];
  /** Registered scenarios the spec does not list (reported, not a failure). */
  notes: string[];
}

/** Repo-relative path of a game's manifest. */
export const manifestPath = (id: string): string => `artifacts/scenarios/${id}.json`;

/** Imports a game's ScenarioRegistry and reduces it to plain data. */
export async function loadRegistry(
  root: string,
  target: GameTarget,
): Promise<RegisteredScenario[]> {
  const mod = (await import(pathToFileURL(join(root, target.scenarios.module)).href)) as Record<
    string,
    unknown
  >;
  const registry = mod[target.scenarios.export];
  if (typeof registry !== "object" || registry === null)
    throw new Error(
      `${target.scenarios.module} does not export \`${target.scenarios.export}\` (a ScenarioRegistry)`,
    );
  return Object.entries(registry as Record<string, unknown>).map(([key, value]) => {
    const s = value as { id?: unknown; description?: unknown; anim?: unknown; build?: unknown };
    if (typeof s.build !== "function") throw new Error(`scenario "${key}" has no build()`);
    if (s.id !== key) throw new Error(`scenario key "${key}" has id "${String(s.id)}"`);
    const anim = s.anim as { name?: unknown; durationMs?: unknown } | undefined;
    return {
      id: key,
      description: typeof s.description === "string" ? s.description : "",
      anim:
        anim !== undefined && typeof anim.name === "string" && typeof anim.durationMs === "number"
          ? { name: anim.name, durationMs: anim.durationMs }
          : null,
    };
  });
}

/** Joins a registry with its spec. Pure. */
export function buildManifest(
  target: Pick<GameTarget, "id" | "spec">,
  spec: GameSpec,
  registry: readonly RegisteredScenario[],
): ScenarioManifest {
  const problems: string[] = [];
  const notes: string[] = [];
  const byId = new Map(registry.map((r) => [r.id, r]));
  const scenarios: ManifestScenario[] = [];
  for (const s of spec.scenarios) {
    const reg = byId.get(s.id);
    if (reg === undefined) {
      problems.push(`scenario "${s.id}" is in the spec but not registered in scenarios.ts`);
      scenarios.push({
        id: s.id,
        description: s.description,
        anim: s.anim,
        roles: s.roles,
        critic: s.critic,
        variants: s.variants,
        inSpec: true,
        registered: false,
      });
      continue;
    }
    const specAnim = s.anim === null ? "none" : `${s.anim.name} ${s.anim.durationMs} ms`;
    const regAnim = reg.anim === null ? "none" : `${reg.anim.name} ${reg.anim.durationMs} ms`;
    if (specAnim !== regAnim)
      problems.push(`scenario "${s.id}": spec anim is ${specAnim}, registered anim is ${regAnim}`);
    scenarios.push({
      ...reg,
      roles: s.roles,
      critic: s.critic,
      variants: s.variants,
      inSpec: true,
      registered: true,
    });
    for (const [role, list] of Object.entries(s.variants))
      if ((list?.length ?? 0) > 1)
        notes.push(
          `scenario "${s.id}" lists ${role} variants ${list!.join(", ")}: the harness renders the scenario's own ${role} viewer; register one scenario per variant to capture each`,
        );
  }
  for (const r of registry) {
    if (spec.scenarios.some((s) => s.id === r.id)) continue;
    notes.push(`scenario "${r.id}" is registered but not in the spec table (not screenshotted)`);
    scenarios.push({ ...r, roles: [], critic: "", variants: {}, inSpec: false, registered: true });
  }
  const anims = new Set(
    scenarios.flatMap((s) => (s.anim !== null && s.registered ? [s.anim.name] : [])),
  );
  for (const name of spec.perfScript)
    if (!anims.has(name)) problems.push(`perf script anim "${name}" has no registered scenario`);
  if (spec.perfScript.length === 0) notes.push("the spec has no parsable perf script");
  return {
    game: target.id,
    spec: target.spec,
    scenarios,
    perfScript: spec.perfScript,
    problems,
    notes,
  };
}

/** Reads the spec and registry and writes `artifacts/scenarios/<id>.json`. */
export async function emitManifest(root: string, target: GameTarget): Promise<ScenarioManifest> {
  const spec = parseGameSpec(readFileSync(join(root, target.spec), "utf8"));
  const registry = await loadRegistry(root, target);
  const manifest = buildManifest(target, spec, registry);
  const out = join(root, manifestPath(target.id));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Reads a previously emitted manifest. */
export function readManifest(root: string, id: string): ScenarioManifest {
  const path = join(root, manifestPath(id));
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ScenarioManifest;
  } catch (err) {
    throw new Error(
      `cannot read ${manifestPath(id)} (run \`pnpm verify:game ${id}\` or check-scenarios first): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}
