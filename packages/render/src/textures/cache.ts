/**
 * The procedural texture cache (SPEC §13.6: "generated at boot … and cached in IndexedDB").
 * A {@link TextureStore} is read synchronously by the texture kit (so `ctx.textures.*()` stays
 * synchronous): {@link openIdbTextureStore} loads and decodes every entry up front, during the
 * Iris load, then serves them from memory and persists newly painted textures in the background.
 *
 * Entries are keyed by the texture key (name, size, seed, tint, variant) and invalidated by
 * {@link TEXTURE_CACHE_VERSION}, which changes whenever a painter changes. Images are stored as
 * lossless PNG and decoded without premultiplication or colour conversion, so a cached texture
 * is pixel-identical to a freshly painted one.
 *
 * @module
 */
import type { Canvas2D } from "./canvas.ts";

/** Bump when any painter's output changes: stale cache entries are then discarded. */
export const TEXTURE_CACHE_VERSION = "sg-tex-2";

/** A synchronous read / background write texture store. */
export interface TextureStore {
  /** A decoded image for `key`, if cached. */
  get(key: string): CanvasImageSource | undefined;
  /** Persists a freshly painted canvas (background; errors are swallowed). */
  put(key: string, canvas: Canvas2D["canvas"]): void;
  /** Resolves when every pending write has finished. */
  flush(): Promise<void>;
  /** Number of decoded entries available. */
  readonly size: number;
}

/** An in-memory store (tests, and sessions without IndexedDB). */
export function createMemoryStore(): TextureStore & { keys(): string[] } {
  const map = new Map<string, CanvasImageSource>();
  return {
    get: (key) => map.get(key),
    put(key, canvas) {
      map.set(key, canvas as CanvasImageSource);
    },
    flush: () => Promise.resolve(),
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}

/** The IndexedDB and image-decoding functions the store uses (injectable for tests). */
export interface IdbStoreOptions {
  idb?: IDBFactory;
  dbName?: string;
  version?: string;
  decode?: (blob: Blob) => Promise<CanvasImageSource>;
}

const STORE = "textures";

interface Entry {
  v: string;
  blob: Blob;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

async function toBlob(canvas: Canvas2D["canvas"]): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b !== null ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
}

/**
 * Opens the IndexedDB texture store and decodes every current entry. Falls back to an empty
 * in-memory store when IndexedDB is unavailable or broken (private windows, blocked storage).
 */
export async function openIdbTextureStore(o: IdbStoreOptions = {}): Promise<TextureStore> {
  const idb = o.idb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const version = o.version ?? TEXTURE_CACHE_VERSION;
  const decode =
    o.decode ??
    ((blob: Blob) =>
      createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }));
  if (idb === undefined) return createMemoryStore();
  let db: IDBDatabase;
  try {
    const open = idb.open(o.dbName ?? "sg-textures", 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    db = await req(open);
  } catch {
    return createMemoryStore();
  }
  const images = new Map<string, CanvasImageSource>();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const [keys, values] = await Promise.all([
      req(store.getAllKeys()),
      req(store.getAll() as IDBRequest<Entry[]>),
    ]);
    const stale: IDBValidKey[] = [];
    const decodes: Promise<void>[] = [];
    keys.forEach((k, i) => {
      const e = values[i];
      if (e === undefined || e.v !== version || !(e.blob instanceof Blob)) {
        stale.push(k);
        return;
      }
      decodes.push(
        decode(e.blob).then(
          (img) => void images.set(String(k), img),
          () => void stale.push(k),
        ),
      );
    });
    await Promise.all(decodes);
    for (const k of stale) store.delete(k);
  } catch {
    images.clear();
  }
  const pending = new Set<Promise<void>>();
  return {
    get: (key) => images.get(key),
    put(key, canvas) {
      const p = (async () => {
        try {
          const blob = await toBlob(canvas);
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put({ v: version, blob } satisfies Entry, key);
          await new Promise<void>((resolve) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
          });
        } catch {
          // Caching is an optimisation: a failed write only costs a repaint next visit.
        }
      })();
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    async flush() {
      await Promise.all([...pending]);
    },
    get size() {
      return images.size;
    },
  };
}
