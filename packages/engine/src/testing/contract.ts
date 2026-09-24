/**
 * The contract suite every game must pass (ROADMAP M0-04, DOD G4, SPEC §9.3 module rules):
 *
 * | check         | what it proves                                                            |
 * |---------------|---------------------------------------------------------------------------|
 * | `determinism` | the same seed and inputs give the same states and effects, run after run  |
 * | `serialize`   | state is plain JSON and `deserialize(serialize(s))` round-trips exactly   |
 * | `secrecy`     | fuzzed games: no view leaks another viewer's `secret`/`hidden` values     |
 * | `termination` | bot-only games always end, within `maxSteps`, with no illegal bot action  |
 * | `parseAction` | 1,000 garbage payloads never throw; every legal action parses             |
 * | `illegal`     | actions from seats that may not act leave the state unchanged             |
 * | `views`       | every view carries `phase: string` and `deadline: number \| null`         |
 *
 * `checkContract` returns a report (used by the engine's own "expected to fail" fixture
 * tests); `runContractSuite` registers one Vitest test per check.
 *
 * @module
 */
import { createRng, type PlayerId, type Rng } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  SECRET_KEYS,
  type ContentAccess,
  type Effect,
  type GameModule,
  type ViewerKey,
} from "../game-module.ts";
import type { RoomConfig } from "@sg/shared";
import { viewerKeyId, type GameRunner } from "../runner.ts";
import {
  defaultPlayerCounts,
  seedList,
  simulateGame,
  type SimOptions,
  type SimResult,
} from "./sim.ts";

/** The checks of the contract suite. */
export type ContractCheckName =
  "determinism" | "serialize" | "secrecy" | "termination" | "parseAction" | "illegal" | "views";

/** Every check, in report order. */
export const CONTRACT_CHECKS: readonly ContractCheckName[] = Object.freeze([
  "determinism",
  "serialize",
  "secrecy",
  "termination",
  "parseAction",
  "illegal",
  "views",
]);

/** Options for the contract suite. */
export interface ContractOptions<S, O> {
  /** Seeds per player count: a count (`1..n`) or explicit seeds. Default 20. */
  seeds?: number | readonly number[];
  /** Player counts. Default min, typical and max from the manifest. */
  players?: readonly number[];
  /** Option presets to cycle through (each game uses one). Default: the defaults only. */
  presets?: readonly Partial<O>[];
  /** Games played for the secrecy fuzz (DOD G4: 200). */
  fuzzGames?: number;
  /** Garbage payloads for the parseAction fuzz (DOD G4: 1,000). */
  garbage?: number;
  /** Extra secret locations (SPEC §9.3 rule 4 `secretPaths`, JSONPath-lite). */
  secretPaths?: readonly string[];
  /** Runner steps per game before it counts as non-terminating. Default 10,000. */
  maxSteps?: number;
  /** Content for setup; a factory is called once per game. */
  content?: ContentAccess | (() => ContentAccess);
  /** Default 1. */
  timerScale?: RoomConfig["timerScale"];
  /** Default 3. */
  streamDelaySec?: number;
  /** Games compared for determinism (each is played twice). Default 12. */
  determinismGames?: number;
  /** States sampled for the parseAction / illegal / views checks. Default 400. */
  sampleStates?: number;
  /** Only run these checks. */
  checks?: readonly ContractCheckName[];
  /** Hooks passed through to the sim (involvement, direct audience actions…). */
  sim?: Pick<SimOptions<S, O>, "audienceAction" | "audienceDirectOpen" | "involves">;
  /** Vitest timeout per check (ms). Default 120,000. */
  timeoutMs?: number;
}

/** The result of one check. */
export interface ContractCheck {
  name: ContractCheckName;
  ok: boolean;
  /** Human-readable failures (the first few, with seeds and paths). */
  failures: string[];
  /** Counters: games, states, payloads… */
  stats: Record<string, number>;
}

/** The full contract report. */
export interface ContractReport {
  game: string;
  ok: boolean;
  checks: ContractCheck[];
}

const MAX_FAILURES = 8;

interface GamePlan<O> {
  seed: number;
  players: number;
  preset: Partial<O> | undefined;
}

/**
 * Runs the contract checks and returns a report. Never throws for a module failure: module
 * exceptions are reported as failures of the check that hit them.
 */
export function checkContract<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O> = {},
): ContractReport {
  const selected = opts.checks ?? CONTRACT_CHECKS;
  const checks = CONTRACT_CHECKS.filter((c) => selected.includes(c)).map((name) =>
    runCheck(module, opts, name),
  );
  return { game: module.manifest.id, ok: checks.every((c) => c.ok), checks };
}

/**
 * Registers the contract suite with Vitest: one `describe` per module, one `it` per check,
 * each failing with the check's failure list.
 */
export function runContractSuite<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O> = {},
): void {
  const selected = opts.checks ?? CONTRACT_CHECKS;
  describe(`contract: ${module.manifest.id}`, () => {
    for (const name of CONTRACT_CHECKS.filter((c) => selected.includes(c))) {
      it(
        name,
        () => {
          const check = runCheck(module, opts, name);
          expect(check.failures, `${name} failures`).toEqual([]);
          expect(check.ok).toBe(true);
        },
        opts.timeoutMs ?? 120_000,
      );
    }
  });
}

function runCheck<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  name: ContractCheckName,
): ContractCheck {
  const failures: string[] = [];
  const stats: Record<string, number> = {};
  const fail = (msg: string): void => {
    if (failures.length < MAX_FAILURES) failures.push(msg);
    stats["failures"] = (stats["failures"] ?? 0) + 1;
  };
  try {
    switch (name) {
      case "determinism":
        checkDeterminism(module, opts, fail, stats);
        break;
      case "serialize":
        checkSerialize(module, opts, fail, stats);
        break;
      case "secrecy":
        checkSecrecy(module, opts, fail, stats);
        break;
      case "termination":
        checkTermination(module, opts, fail, stats);
        break;
      case "parseAction":
        checkParseAction(module, opts, fail, stats);
        break;
      case "illegal":
        checkIllegal(module, opts, fail, stats);
        break;
      case "views":
        checkViews(module, opts, fail, stats);
        break;
    }
  } catch (err) {
    fail(`threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  return { name, ok: (stats["failures"] ?? 0) === 0, failures, stats };
}

type Fail = (msg: string) => void;

function plans<S, O>(
  manifest: { minPlayers: number; maxPlayers: number },
  opts: ContractOptions<S, O>,
  limit = Infinity,
): GamePlan<O>[] {
  const counts = opts.players ?? defaultPlayerCounts(manifest);
  const seeds = seedList(opts.seeds ?? 20);
  const presets: (Partial<O> | undefined)[] =
    opts.presets !== undefined && opts.presets.length > 0 ? [...opts.presets] : [undefined];
  const out: GamePlan<O>[] = [];
  let i = 0;
  for (const seed of seeds) {
    for (const players of counts) {
      out.push({ seed, players, preset: presets[i % presets.length] });
      i++;
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function simOpts<S, O>(
  opts: ContractOptions<S, O>,
  plan: GamePlan<O>,
  extra: Partial<SimOptions<S, O>> = {},
): SimOptions<S, O> {
  const out: SimOptions<S, O> = {
    ...opts.sim,
    seed: plan.seed,
    players: plan.players,
    maxSteps: opts.maxSteps ?? 10_000,
    ...extra,
  };
  if (plan.preset !== undefined) out.options = plan.preset;
  if (opts.content !== undefined) out.content = opts.content;
  if (opts.timerScale !== undefined) out.timerScale = opts.timerScale;
  if (opts.streamDelaySec !== undefined) out.streamDelaySec = opts.streamDelaySec;
  return out;
}

const label = (plan: GamePlan<unknown>): string => `seed ${plan.seed}, ${plan.players}p`;

// ---- determinism ------------------------------------------------------------------------------

function checkDeterminism<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  const games = plans(module.manifest, opts, opts.determinismGames ?? 12);
  for (const plan of games) {
    const a = simulateGame(module, simOpts(opts, plan, { recordHashes: true }));
    const b = simulateGame(module, simOpts(opts, plan, { recordHashes: true }));
    stats["games"] = (stats["games"] ?? 0) + 1;
    if (a.fingerprint !== b.fingerprint || a.hashes.length !== b.hashes.length) {
      const at = a.hashes.findIndex((h, i) => h !== b.hashes[i]);
      fail(
        `${label(plan)}: two runs diverged at event ${at === -1 ? Math.min(a.hashes.length, b.hashes.length) : at} ` +
          `(fingerprints ${a.fingerprint} vs ${b.fingerprint})`,
      );
    }
  }
}

// ---- serialize ---------------------------------------------------------------------------------

function checkSerialize<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  for (const plan of plans(module.manifest, opts)) {
    let reported = false;
    simulateGame(
      module,
      simOpts(opts, plan, {
        onStep: ({ state }) => {
          stats["states"] = (stats["states"] ?? 0) + 1;
          if (reported) return;
          const problem = serializeProblem(module, state);
          if (problem !== null) {
            reported = true;
            fail(`${label(plan)}: ${problem}`);
          }
        },
      }),
    );
    stats["games"] = (stats["games"] ?? 0) + 1;
  }
}

function serializeProblem<S>(
  module: GameModule<S, unknown, unknown, unknown>,
  state: S,
): string | null {
  const notPlain = plainJsonProblem(state, "state");
  if (notPlain !== null) return `state is not plain JSON: ${notPlain}`;
  const text = module.serialize(state);
  if (typeof text !== "string") return "serialize() did not return a string";
  const back = module.deserialize(text);
  const diff = jsonDiff(state, back, "state");
  if (diff !== null) return `deserialize(serialize(s)) differs at ${diff}`;
  if (module.serialize(back) !== text) return "serialize(deserialize(t)) !== t";
  return null;
}

/** Why `value` is not plain JSON (a path and a reason), or `null` when it is. */
export function plainJsonProblem(value: unknown, path = "$"): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${path} is ${value}`;
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) return `${path}[${i}] is a hole`;
          const p = plainJsonProblem(value[i], `${path}[${i}]`);
          if (p !== null) return p;
        }
        return null;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "?";
        return `${path} is a ${name}, not a plain object`;
      }
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) return `${path}.${k} is undefined`;
        const p = plainJsonProblem(v, `${path}.${k}`);
        if (p !== null) return p;
      }
      return null;
    }
    default:
      return `${path} is a ${typeof value}`;
  }
}

/** The first path where two JSON values differ, or `null` when they are deep-equal. */
export function jsonDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const d = jsonDiff(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (!Object.hasOwn(ra, k) || !Object.hasOwn(rb, k)) return `${path}.${k}`;
    const d = jsonDiff(ra[k], rb[k], `${path}.${k}`);
    if (d !== null) return d;
  }
  return null;
}

// ---- secrecy -----------------------------------------------------------------------------------

/** A hidden value found in state, with the viewer ids that own it. */
export interface SecretValue {
  value: string | number;
  path: (string | number)[];
  owners: string[];
}

/**
 * Collects the hidden values of a state (SPEC §9.3 rule 4): every string (length ≥ 3) and
 * number under a `secret` / `hidden` key or a `secretPaths` match. A value's **owners** are
 * the player/team ids on its path (as keys, or as the `id` / `playerId` / `ownerId` / `owner` /
 * `authorId` of an enclosing object). Strings that also appear outside hidden subtrees are
 * public (revealed) and are skipped.
 */
export function collectSecrets(
  state: unknown,
  ids: ReadonlySet<string>,
  secretPaths: readonly string[] = [],
): SecretValue[] {
  const secrets: SecretValue[] = [];
  const publicStrings = new Set<string>();
  const secretRoots = new Set<unknown>();
  for (const sp of secretPaths) {
    for (const hit of selectPath(state, parsePath(sp))) secretRoots.add(hit);
  }
  const walk = (
    node: unknown,
    path: (string | number)[],
    owners: string[],
    hidden: boolean,
  ): void => {
    const isHidden = hidden || (secretRoots.has(node) && typeof node === "object" && node !== null);
    if (typeof node === "string") {
      if (node.length < 3) return;
      if (isHidden || secretRoots.has(node)) secrets.push({ value: node, path, owners });
      else publicStrings.add(node);
      return;
    }
    if (typeof node === "number") {
      if (isHidden) secrets.push({ value: node, path, owners });
      return;
    }
    if (typeof node !== "object" || node === null) return;
    let nextOwners = owners;
    if (!Array.isArray(node)) {
      const rec = node as Record<string, unknown>;
      for (const f of ["id", "playerId", "ownerId", "owner", "authorId"]) {
        const v = rec[f];
        if (typeof v === "string" && ids.has(v) && !nextOwners.includes(v)) {
          nextOwners = [...nextOwners, v];
        }
      }
    }
    const entries: [string | number, unknown][] = Array.isArray(node)
      ? node.map((v, i) => [i, v])
      : Object.entries(node);
    for (const [key, child] of entries) {
      const keyOwners =
        typeof key === "string" && ids.has(key) && !nextOwners.includes(key)
          ? [...nextOwners, key]
          : nextOwners;
      const childHidden = isHidden || (typeof key === "string" && SECRET_KEYS.includes(key));
      walk(child, [...path, key], keyOwners, childHidden);
    }
  };
  walk(state, [], [], false);
  return secrets.filter((s) => typeof s.value === "number" || !publicStrings.has(s.value));
}

type PathSeg = { key: string } | { any: true };

function parsePath(path: string): PathSeg[] {
  const segs: PathSeg[] = [];
  for (const part of path.replace(/^\$\.?/, "").split(".")) {
    if (part === "") continue;
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (m === null) throw new Error(`secretPaths: cannot parse "${path}"`);
    const [, name, brackets] = m;
    if (name !== undefined && name !== "") segs.push(name === "*" ? { any: true } : { key: name });
    for (const b of (brackets ?? "").match(/\[[^\]]*\]/g) ?? []) {
      const inner = b.slice(1, -1).replace(/^["']|["']$/g, "");
      segs.push(inner === "*" ? { any: true } : { key: inner });
    }
  }
  return segs;
}

function selectPath(node: unknown, segs: readonly PathSeg[]): unknown[] {
  if (segs.length === 0) return [node];
  if (typeof node !== "object" || node === null) return [];
  const [head, ...rest] = segs as [PathSeg, ...PathSeg[]];
  const rec = node as Record<string, unknown>;
  if ("any" in head) return Object.values(rec).flatMap((child) => selectPath(child, rest));
  return Object.hasOwn(rec, head.key) ? selectPath(rec[head.key], rest) : [];
}

function getPath(node: unknown, path: readonly (string | number)[]): unknown {
  let cur = node;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    const rec = cur as Record<string | number, unknown>;
    if (!Object.hasOwn(rec, key)) return undefined;
    cur = rec[key];
  }
  return cur;
}

/** The viewers the secrecy fuzz checks: every seat plus every shared viewer key. */
export function allViewers(players: readonly PlayerId[]): ViewerKey[] {
  return [
    { role: "stage" },
    { role: "audience" },
    { role: "audience", restricted: true },
    { role: "host" },
    { role: "moderator" },
    ...players.map((id): ViewerKey => ({ role: "player", id })),
  ];
}

/**
 * The leaks in one state: for each viewer, hidden values it does not own that appear in its
 * view (strings verbatim in the serialized view; numbers at the same path). Values sent for
 * moderation (`moderate` effect previews) may appear in the host and moderator views.
 */
export function findLeaks<S, V>(
  module: Pick<GameModule<S, unknown, unknown, V>, "view">,
  state: S,
  players: readonly { id: PlayerId; teamId?: string }[],
  opts: {
    teams?: readonly string[];
    secretPaths?: readonly string[];
    moderated?: ReadonlySet<string>;
  } = {},
): string[] {
  const ids = new Set<string>([...players.map((p) => p.id), ...(opts.teams ?? [])]);
  for (const p of players) if (p.teamId !== undefined) ids.add(p.teamId);
  const secrets = collectSecrets(state, ids, opts.secretPaths);
  if (secrets.length === 0) return [];
  const leaks: string[] = [];
  for (const viewer of allViewers(players.map((p) => p.id))) {
    const view = module.view(state, viewer);
    const text = JSON.stringify(view) ?? "";
    const mine = new Set<string>();
    if (viewer.role === "player") {
      mine.add(viewer.id);
      const team = players.find((p) => p.id === viewer.id)?.teamId;
      if (team !== undefined) mine.add(team);
    }
    const staff = viewer.role === "host" || viewer.role === "moderator";
    for (const s of secrets) {
      if (s.owners.some((o) => mine.has(o))) continue;
      if (typeof s.value === "string") {
        if (staff && opts.moderated?.has(s.value)) continue;
        if (text.includes(s.value)) {
          leaks.push(
            `${viewerKeyId(viewer)} sees "${s.value}" from state.${s.path.join(".")}` +
              (s.owners.length > 0 ? ` (owned by ${s.owners.join(",")})` : ""),
          );
        }
      } else if (getPath(view, s.path) === s.value) {
        leaks.push(`${viewerKeyId(viewer)} sees ${s.value} at ${s.path.join(".")}`);
      }
    }
  }
  return leaks;
}

function checkSecrecy<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  const games = opts.fuzzGames ?? 200;
  const counts = opts.players ?? defaultPlayerCounts(module.manifest);
  const presets = opts.presets ?? [];
  for (let g = 0; g < games; g++) {
    const plan: GamePlan<O> = {
      seed: 10_000 + g,
      players: counts[g % counts.length] as number,
      preset: presets.length > 0 ? presets[g % presets.length] : undefined,
    };
    const moderated = new Set<string>();
    let reported = false;
    simulateGame(
      module,
      simOpts(opts, plan, {
        policy: "mixed",
        onStep: ({ state, effects, runner }) => {
          stats["states"] = (stats["states"] ?? 0) + 1;
          for (const e of effects) if (e.type === "moderate") moderated.add(e.preview);
          if (reported) return;
          const leaks = findLeaks(module, state, runner.players, {
            secretPaths: opts.secretPaths ?? [],
            moderated,
          });
          if (leaks.length > 0) {
            reported = true;
            fail(`${label(plan)}: ${leaks.slice(0, 3).join("; ")}`);
          }
        },
      }),
    );
    stats["games"] = g + 1;
  }
}

// ---- termination ---------------------------------------------------------------------------------

function checkTermination<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  let maxSteps = 0;
  for (const plan of plans(module.manifest, opts)) {
    const sim: SimResult<S> = simulateGame(module, simOpts(opts, plan));
    stats["games"] = (stats["games"] ?? 0) + 1;
    maxSteps = Math.max(maxSteps, sim.steps);
    if (!sim.ended) fail(`${label(plan)}: did not end (${sim.failure ?? "?"})`);
    else if (sim.result === null || !Array.isArray(sim.result.ranking)) {
      fail(`${label(plan)}: ended without a GameResult ranking`);
    }
    if (sim.illegalActions > 0) {
      fail(
        `${label(plan)}: ${sim.illegalActions} illegal bot action(s): ${sim.illegalSamples.join("; ")}`,
      );
    }
  }
  stats["maxSteps"] = maxSteps;
}

// ---- state sampling for parseAction / illegal / views -------------------------------------------

interface Sample<S, A> {
  state: S;
  players: { id: PlayerId; teamId?: string }[];
  legal: Map<PlayerId, A[]>;
}

function sampleStates<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
): Sample<S, A>[] {
  const want = opts.sampleStates ?? 400;
  const games = plans(module.manifest, opts, 12);
  const perGame = Math.max(1, Math.ceil(want / games.length));
  const out: Sample<S, A>[] = [];
  for (const plan of games) {
    const all: Sample<S, A>[] = [];
    simulateGame(
      module,
      simOpts(opts, plan, {
        policy: "mixed",
        onStep: ({ state, runner }) => {
          const players = (runner as GameRunner<S, unknown, unknown, unknown>).players.map((p) =>
            p.teamId !== undefined ? { id: p.id, teamId: p.teamId } : { id: p.id },
          );
          const legal = new Map(players.map((p) => [p.id, module.legalActions(state, p.id)]));
          all.push({ state, players, legal });
        },
      }),
    );
    const step = Math.max(1, Math.floor(all.length / perGame));
    for (let i = 0; i < all.length && out.length < want; i += step) {
      const s = all[i];
      if (s !== undefined) out.push(s);
    }
  }
  return out;
}

// ---- parseAction ----------------------------------------------------------------------------------

/** A random JSON-ish payload (numbers, strings, nested objects/arrays, odd keys, huge values). */
export function garbagePayload(rng: Rng, depth = 0, seedActions: readonly unknown[] = []): unknown {
  const r = rng.int(depth > 2 ? 8 : 12);
  switch (r) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return rng.pick([0, -1, 1, 0.5, 1e308, -1e308, Number.NaN, Infinity, -Infinity, 2 ** 53]);
    case 3:
      return rng.pick(["", "move", "__proto__", "constructor", "x".repeat(20_000), "🎲", "null"]);
    case 4:
      return rng.bool();
    case 5:
      return rng.int(1_000_000) - 500_000;
    case 6: {
      if (seedActions.length === 0) return { type: rng.pick(["move", "vote", "answer", ""]) };
      // A legal action with one field mutated.
      const base = JSON.parse(JSON.stringify(rng.pick(seedActions))) as unknown;
      if (typeof base !== "object" || base === null) return base;
      const rec = base as Record<string, unknown>;
      const keys = Object.keys(rec);
      const key = keys.length > 0 && rng.bool(0.7) ? rng.pick(keys) : "extra";
      rec[key] = garbagePayload(rng, depth + 1);
      return rec;
    }
    case 7:
      return Object.assign(Object.create(null) as object, { type: "move", cell: rng.int(20) - 5 });
    case 8: {
      const n = rng.int(4);
      return Array.from({ length: n }, () => garbagePayload(rng, depth + 1, seedActions));
    }
    default: {
      const obj: Record<string, unknown> = {};
      const n = 1 + rng.int(4);
      for (let i = 0; i < n; i++) {
        const key = rng.pick([
          "type",
          "cell",
          "choice",
          "text",
          "a",
          "b",
          "id",
          "__proto__",
          "toString",
        ]);
        Object.defineProperty(obj, key, {
          value: garbagePayload(rng, depth + 1, seedActions),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return obj;
    }
  }
}

function checkParseAction<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  const samples = sampleStates(module, opts);
  const legalActions: A[] = samples.flatMap((s) => [...s.legal.values()].flat());
  const rng = createRng(`contract:parse:${module.manifest.id}`);
  const count = opts.garbage ?? 1000;
  for (let i = 0; i < count; i++) {
    const payload = garbagePayload(rng, 0, legalActions);
    let parsed: A | null;
    try {
      parsed = module.parseAction(payload);
    } catch (err) {
      fail(
        `parseAction threw on payload #${i}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    stats["payloads"] = i + 1;
    if (parsed === null) continue;
    stats["accepted"] = (stats["accepted"] ?? 0) + 1;
    const sample = samples.length > 0 ? rng.pick(samples) : undefined;
    if (sample === undefined) continue;
    const actorId =
      rng.bool(0.8) && sample.players.length > 0 ? rng.pick(sample.players).id : "zz-intruder";
    try {
      module.onAction(sample.state, parsed, actionCtx(rng, actorId));
    } catch (err) {
      fail(
        `onAction threw for parsed garbage ${short(parsed)} by ${actorId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Every legal action must survive the wire.
  let roundTrips = 0;
  for (const action of legalActions.slice(0, 2000)) {
    roundTrips++;
    let parsed: A | null;
    try {
      parsed = module.parseAction(JSON.parse(JSON.stringify(action)) as unknown);
    } catch (err) {
      fail(`parseAction threw on legal action ${short(action)}: ${String(err)}`);
      continue;
    }
    if (parsed === null)
      fail(`legal action ${short(action)} does not parse after a JSON round trip`);
  }
  stats["legalRoundTrips"] = roundTrips;
}

// ---- illegal ---------------------------------------------------------------------------------------

function actionCtx(rng: Rng, actorId: PlayerId, teamId?: string) {
  return {
    rng: rng.fork(`ctx:${actorId}`),
    now: 1_000_000,
    timing: { input: (ms: number) => ms, pace: (ms: number) => ms },
    audienceCount: 0,
    actor:
      teamId !== undefined
        ? { id: actorId, role: "player" as const, teamId }
        : { id: actorId, role: "player" as const },
  };
}

function checkIllegal<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  const samples = sampleStates(module, opts);
  const rng = createRng(`contract:illegal:${module.manifest.id}`);
  const tryIllegal = (
    sample: Sample<S, A>,
    action: A,
    actorId: PlayerId,
    teamId: string | undefined,
    why: string,
  ): void => {
    stats["attempts"] = (stats["attempts"] ?? 0) + 1;
    const before = module.serialize(sample.state);
    let effects: Effect[] | undefined;
    let after: S;
    try {
      const step = module.onAction(sample.state, action, actionCtx(rng, actorId, teamId));
      after = step.state;
      effects = step.effects;
    } catch (err) {
      fail(
        `onAction threw for ${why} ${short(action)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (module.serialize(after) !== before) {
      fail(`${why} ${short(action)} by ${actorId} changed the state`);
      return;
    }
    const bad = (effects ?? []).filter((e) => e.type !== "fx");
    if (bad.length > 0)
      fail(`${why} ${short(action)} by ${actorId} emitted ${bad.map((e) => e.type).join(", ")}`);
  };
  for (const sample of samples) {
    const everyLegal = [...sample.legal.values()].flat();
    if (everyLegal.length === 0) continue;
    // A stranger may never act.
    tryIllegal(sample, rng.pick(everyLegal), "zz-intruder", undefined, "intruder action");
    // A seat with nothing to do may not act, even with another seat's legal action.
    for (const p of sample.players) {
      if ((sample.legal.get(p.id) ?? []).length > 0) continue;
      tryIllegal(sample, rng.pick(everyLegal), p.id, p.teamId, "out-of-turn action");
    }
  }
  stats["states"] = samples.length;
}

// ---- views -----------------------------------------------------------------------------------------

function checkViews<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O>,
  fail: Fail,
  stats: Record<string, number>,
): void {
  const samples = sampleStates(module, opts);
  for (const sample of samples) {
    for (const viewer of allViewers(sample.players.map((p) => p.id))) {
      stats["views"] = (stats["views"] ?? 0) + 1;
      const view = module.view(sample.state, viewer) as unknown;
      if (typeof view !== "object" || view === null || Array.isArray(view)) {
        fail(`${viewerKeyId(viewer)} view is not an object`);
        continue;
      }
      const rec = view as Record<string, unknown>;
      if (typeof rec["phase"] !== "string") fail(`${viewerKeyId(viewer)} view has no phase string`);
      const d = rec["deadline"];
      if (!(d === null || (typeof d === "number" && Number.isFinite(d)))) {
        fail(`${viewerKeyId(viewer)} view deadline is ${JSON.stringify(d)}, not number | null`);
      }
      const plain = plainJsonProblem(view, "view");
      if (plain !== null) fail(`${viewerKeyId(viewer)} ${plain}`);
    }
  }
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
