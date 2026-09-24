/**
 * `fakeContent`: an in-memory {@link ContentAccess} built from content-pack fixtures, for game
 * tests, sims and scenarios (SPEC §9.3 `SetupContext.content`, §12). Packs are validated
 * against the real pack schemas by default, so a fixture cannot drift from what the server
 * would load.
 *
 * @module
 */
import { isPackKind, packSchema, type AnyPack, type PackItemMap, type PackKind } from "@sg/shared";
import { contentKey, type ContentAccess, type PackInfo } from "../game-module.ts";

/** Options for {@link fakeContent}. */
export interface FakeContentOptions {
  /** Content keys already used earlier in the session, per kind (see `contentKey`). */
  used?: Partial<Record<PackKind, readonly string[]>>;
  /** Validate every pack with its zod schema (default true). */
  validate?: boolean;
}

/** A {@link ContentAccess} whose "used" set can be changed by tests. */
export interface FakeContent extends ContentAccess {
  /** Marks a content key as used (as the room would after a game). */
  markUsed(kind: PackKind, key: string): void;
}

/**
 * Builds a content access over `packs`.
 *
 * @throws Error when a pack fails its schema (with the zod issues) or two packs share an id.
 */
export function fakeContent(packs: readonly AnyPack[], opts: FakeContentOptions = {}): FakeContent {
  const byId = new Map<string, AnyPack>();
  for (const pack of packs) {
    if (!isPackKind(pack.kind)) throw new Error(`fakeContent: unknown pack kind ${pack.kind}`);
    if (opts.validate !== false) {
      const parsed = packSchema(pack.kind).safeParse(pack);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        throw new Error(`fakeContent: pack ${pack.id} is invalid: ${issues.join("; ")}`);
      }
    }
    if (byId.has(pack.id)) throw new Error(`fakeContent: duplicate pack id ${pack.id}`);
    byId.set(pack.id, pack);
  }
  const used = new Map<PackKind, Set<string>>();
  const usedSet = (kind: PackKind): Set<string> => {
    let set = used.get(kind);
    if (set === undefined) {
      set = new Set();
      used.set(kind, set);
    }
    return set;
  };
  for (const [kind, keys] of Object.entries(opts.used ?? {}) as [PackKind, string[]][]) {
    for (const key of keys) usedSet(kind).add(key);
  }

  return {
    packs(kind: PackKind): readonly PackInfo[] {
      return [...byId.values()]
        .filter((p) => p.kind === kind)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          name: p.name,
          rating: p.rating,
          count: p.items.length,
        }));
    },
    items<K extends PackKind>(kind: K, packIds: readonly string[]): readonly PackItemMap[K][] {
      const out: PackItemMap[K][] = [];
      for (const id of packIds) {
        const pack = byId.get(id);
        if (pack === undefined || pack.kind !== kind) continue;
        out.push(...(pack.items as PackItemMap[K][]));
      }
      return out;
    },
    isUsed(kind: PackKind, key: string): boolean {
      return used.get(kind)?.has(key) ?? false;
    },
    markUsed(kind: PackKind, key: string): void {
      usedSet(kind).add(key);
    },
  };
}

/** Marks every item of `items` used, by its {@link contentKey}. */
export function markAllUsed<K extends PackKind>(
  content: FakeContent,
  kind: K,
  items: readonly PackItemMap[K][],
): void {
  for (const item of items) content.markUsed(kind, contentKey(kind, item));
}
