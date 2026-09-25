/**
 * The server's game registry (SPEC §9.2 `games.ts`) and its content packs (SPEC §12).
 *
 * - {@link GameRegistry} maps each {@link GameId} to its logic module. The default loaders
 *   import every game's server-safe `@sg/game-<id>/logic` entry and take its exported `logic`
 *   (the `GameModule` the contract suite runs, DOD G4). A game whose logic item has not landed
 *   yet exports no module and is simply unavailable: the room refuses to start it with a clear
 *   error instead of crashing. Tests (and the dev harness) register modules directly.
 * - {@link PackLibrary} reads `content/packs/<kind>/<id>.json` once, validates each pack with
 *   the shared zod schemas and hands each room a {@link ContentAccess}: the room's content
 *   filter decides which packs are visible (`family` hides `teen` packs), and a per-room
 *   {@link UsedContent} set remembers items already played this session (no repeats).
 *
 * Clients never receive a pack: games copy the items they use into `hidden` state and reveal
 * them through `view()` (SPEC §9.3 rule 5).
 *
 * @module
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAME_IDS,
  PACK_KINDS,
  parsePack,
  type AnyPack,
  type GameId,
  type PackItemMap,
  type PackKind,
  type RoomConfig,
} from "@sg/shared";
import { contentKey, type AnyGameModule, type ContentAccess, type PackInfo } from "@sg/engine";

// ---------------------------------------------------------------------------------------------
// Game modules
// ---------------------------------------------------------------------------------------------

/** Loads one game's logic entry (a dynamic import). */
export type GameLoader = () => Promise<unknown>;

/**
 * The default loaders: one static dynamic import per launch game, so bundlers can see every
 * entry. Each resolves to the game's `logic/index.ts` namespace.
 */
export const DEFAULT_GAME_LOADERS: Readonly<Record<GameId, GameLoader>> = Object.freeze({
  "quip-clash": () => import("@sg/game-quip-clash/logic"),
  "tune-in": () => import("@sg/game-tune-in/logic"),
  "trivia-night": () => import("@sg/game-trivia-night/logic"),
  doodle: () => import("@sg/game-doodle/logic"),
  "odd-one-out": () => import("@sg/game-odd-one-out/logic"),
  ludo: () => import("@sg/game-ludo/logic"),
  chess: () => import("@sg/game-chess/logic"),
  "marble-rally": () => import("@sg/game-marble-rally/logic"),
});

const MODULE_FUNCTIONS = [
  "parseAction",
  "setup",
  "onAction",
  "view",
  "legalActions",
  "bot",
  "serialize",
  "deserialize",
] as const;

/**
 * True when `value` has the shape of a `GameModule` (manifest, option specs and every
 * required function). With `id`, the manifest id must match too.
 */
export function isGameModule(value: unknown, id?: string): value is AnyGameModule {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const manifest = m["manifest"] as Record<string, unknown> | undefined;
  if (typeof manifest !== "object" || manifest === null) return false;
  if (typeof manifest["id"] !== "string" || (id !== undefined && manifest["id"] !== id))
    return false;
  if (typeof manifest["minPlayers"] !== "number" || typeof manifest["maxPlayers"] !== "number")
    return false;
  if (!Array.isArray(m["optionSpecs"])) return false;
  return MODULE_FUNCTIONS.every((f) => typeof m[f] === "function");
}

/** Why a game is not available. */
export interface GameUnavailable {
  id: GameId;
  reason: string;
}

/**
 * Game id → logic module. Lookups are synchronous (the room actor is single-threaded and
 * never awaits); {@link GameRegistry.preload} runs the loaders once at server start.
 */
export class GameRegistry {
  readonly #modules = new Map<GameId, AnyGameModule>();
  readonly #unavailable = new Map<GameId, string>();
  readonly #loaders: Partial<Record<GameId, GameLoader>>;

  /**
   * @param modules modules registered up front (tests, the dev harness); they win over loaders
   * @param loaders dynamic imports for the rest; defaults to {@link DEFAULT_GAME_LOADERS}
   */
  constructor(
    modules: Partial<Record<GameId, AnyGameModule>> = {},
    loaders: Partial<Record<GameId, GameLoader>> = DEFAULT_GAME_LOADERS,
  ) {
    this.#loaders = loaders;
    for (const [id, module] of Object.entries(modules) as [GameId, AnyGameModule][])
      this.register(id, module);
  }

  /**
   * Registers a module for a playlist id. The module's own manifest id may differ (the
   * engine's tictactoe fixture stands in for launch games in server tests).
   *
   * @throws TypeError when `module` is not a game module
   */
  register(id: GameId, module: AnyGameModule): void {
    if (!isGameModule(module)) throw new TypeError(`GameRegistry: ${id} is not a GameModule`);
    this.#modules.set(id, module);
    this.#unavailable.delete(id);
  }

  /**
   * Runs every loader whose game is not registered yet. A game whose entry fails to import or
   * exports no `logic` module is recorded as unavailable. Never throws.
   */
  async preload(): Promise<GameUnavailable[]> {
    await Promise.all(
      GAME_IDS.map(async (id) => {
        if (this.#modules.has(id)) return;
        const loader = this.#loaders[id];
        if (loader === undefined) {
          this.#unavailable.set(id, "no loader");
          return;
        }
        try {
          const ns = (await loader()) as Record<string, unknown>;
          const module = ns["logic"];
          if (isGameModule(module, id)) this.#modules.set(id, module);
          else
            this.#unavailable.set(id, "its logic entry does not export a `logic` GameModule yet");
        } catch (err) {
          this.#unavailable.set(id, err instanceof Error ? err.message : String(err));
        }
      }),
    );
    return this.unavailable();
  }

  /** The module for a playlist id, or `null`. */
  get(id: GameId): AnyGameModule | null {
    return this.#modules.get(id) ?? null;
  }

  /** Games that could not be loaded, with the reason. */
  unavailable(): GameUnavailable[] {
    return [...this.#unavailable].map(([id, reason]) => ({ id, reason }));
  }

  /** Why `id` is unavailable (for the host's error message). */
  whyUnavailable(id: GameId): string {
    return this.#unavailable.get(id) ?? "it is not registered on this server";
  }
}

// ---------------------------------------------------------------------------------------------
// Content packs
// ---------------------------------------------------------------------------------------------

/** Where the repo keeps its packs: `<repo>/content/packs`, resolved from this file. */
export const DEFAULT_PACKS_DIR = fileURLToPath(new URL("../../../content/packs", import.meta.url));

/** A pack that failed to load, with the reason (logged by the server at start). */
export interface PackProblem {
  file: string;
  errors: string[];
}

/**
 * Content keys already used in one room session, per kind (SPEC §12, `ContentAccess.isUsed`).
 */
export class UsedContent {
  readonly #used = new Map<PackKind, Set<string>>();

  /** Marks a key as used. */
  mark(kind: PackKind, key: string): void {
    let set = this.#used.get(kind);
    if (set === undefined) {
      set = new Set();
      this.#used.set(kind, set);
    }
    set.add(key);
  }

  /** Whether a key was used. */
  has(kind: PackKind, key: string): boolean {
    return this.#used.get(kind)?.has(key) ?? false;
  }

  /** JSON-safe copy (room snapshots). */
  toRecord(): Partial<Record<PackKind, string[]>> {
    const out: Partial<Record<PackKind, string[]>> = {};
    for (const [kind, set] of this.#used) out[kind] = [...set];
    return out;
  }

  /** Rebuilds from {@link toRecord}. */
  static fromRecord(r: Partial<Record<PackKind, string[]>> | undefined): UsedContent {
    const u = new UsedContent();
    for (const [kind, keys] of Object.entries(r ?? {}) as [PackKind, string[]][])
      for (const k of keys) u.mark(kind, k);
    return u;
  }
}

/** A room's view of the library plus a record of what its games drew from. */
export interface RoomContent {
  access: ContentAccess;
  /**
   * After a game ends: marks as used every item of the kinds the game read whose content key
   * appears verbatim in the game's final serialized state (games copy the items they play
   * into state), so later games in the session do not repeat them.
   */
  commit(serializedState: string): void;
}

/** Every valid pack under a directory, loaded once. */
export class PackLibrary {
  readonly #packs = new Map<string, AnyPack>();
  /** Packs that failed validation. */
  readonly problems: PackProblem[] = [];

  /** An empty library (no content). */
  static empty(): PackLibrary {
    return new PackLibrary([]);
  }

  /**
   * Reads `<dir>/<kind>/*.json` for every pack kind. A missing directory is an empty library;
   * an invalid pack is skipped and listed in {@link problems}, as is a pack in the wrong kind
   * folder or a duplicate pack id.
   */
  static load(dir: string = DEFAULT_PACKS_DIR): PackLibrary {
    const lib = new PackLibrary([]);
    for (const kind of PACK_KINDS) {
      const kindDir = join(dir, kind);
      let files: string[];
      try {
        if (!statSync(kindDir).isDirectory()) continue;
        files = readdirSync(kindDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files.sort()) {
        const file = `${kind}/${f}`;
        let json: unknown;
        try {
          json = JSON.parse(readFileSync(join(kindDir, f), "utf8"));
        } catch (err) {
          lib.problems.push({ file, errors: [err instanceof Error ? err.message : String(err)] });
          continue;
        }
        const parsed = parsePack(json);
        if (!parsed.ok) lib.problems.push({ file, errors: parsed.errors });
        else if (parsed.pack.kind !== kind)
          lib.problems.push({
            file,
            errors: [`pack kind ${parsed.pack.kind} is in the ${kind} folder`],
          });
        else lib.#add(parsed.pack, file);
      }
    }
    return lib;
  }

  /** @param packs already-validated packs (tests) */
  constructor(packs: readonly AnyPack[]) {
    for (const p of packs) this.#add(p, p.id);
  }

  /** Number of loaded packs. */
  get size(): number {
    return this.#packs.size;
  }

  /**
   * Content access for one room game: `family` rooms see only packs rated `all`. Reads are
   * recorded so {@link RoomContent.commit} can mark what the game used.
   */
  forRoom(filter: RoomConfig["contentFilter"], used: UsedContent): RoomContent {
    const visible = (p: AnyPack): boolean => filter !== "family" || p.rating === "all";
    const read = new Map<PackKind, Set<string>>();
    const access: ContentAccess = {
      packs: (kind: PackKind): readonly PackInfo[] =>
        [...this.#packs.values()]
          .filter((p) => p.kind === kind && visible(p))
          .map((p) => ({
            id: p.id,
            kind: p.kind,
            name: p.name,
            rating: p.rating,
            count: p.items.length,
          })),
      items: <K extends PackKind>(
        kind: K,
        packIds: readonly string[],
      ): readonly PackItemMap[K][] => {
        const out: PackItemMap[K][] = [];
        for (const id of packIds) {
          const pack = this.#packs.get(id);
          if (pack === undefined || pack.kind !== kind || !visible(pack)) continue;
          let ids = read.get(kind);
          if (ids === undefined) {
            ids = new Set();
            read.set(kind, ids);
          }
          ids.add(id);
          out.push(...(pack.items as PackItemMap[K][]));
        }
        return out;
      },
      isUsed: (kind: PackKind, key: string): boolean => used.has(kind, key),
    };
    return {
      access,
      commit: (serialized: string): void => {
        for (const [kind, ids] of read) {
          for (const id of ids) {
            const pack = this.#packs.get(id);
            if (pack === undefined) continue;
            for (const item of pack.items) {
              const key = contentKey(kind, item as PackItemMap[typeof kind]);
              if (key.length > 0 && serialized.includes(JSON.stringify(key).slice(1, -1)))
                used.mark(kind, key);
            }
          }
        }
      },
    };
  }

  #add(pack: AnyPack, file: string): void {
    if (this.#packs.has(pack.id)) {
      this.problems.push({ file, errors: [`duplicate pack id ${pack.id}`] });
      return;
    }
    this.#packs.set(pack.id, pack);
  }
}
