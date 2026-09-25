/**
 * The IndexedDB texture store (`textures/cache.ts`, SPEC §13.6 "cached in IndexedDB") against a
 * small in-memory IndexedDB: round trips, version invalidation, corrupt entries, and every
 * failure path degrading to "no cache" instead of breaking the boot. The real browser path
 * (PNG encode + `createImageBitmap` decode, pixel-identical after a reload) is covered by
 * `test/browser/render-kit.spec.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryStore,
  openIdbTextureStore,
  TEXTURE_CACHE_VERSION,
} from "../src/textures/cache.ts";
import type { Canvas2D } from "../src/textures/canvas.ts";

type Handler = (() => void) | null;

/** An IDBRequest-like object that settles on a microtask. */
class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  static ok<T>(value: T): FakeRequest<T> {
    const r = new FakeRequest<T>();
    queueMicrotask(() => {
      r.result = value;
      r.onsuccess?.();
    });
    return r;
  }
  static fail<T>(err: Error | null): FakeRequest<T> {
    const r = new FakeRequest<T>();
    queueMicrotask(() => {
      r.error = err;
      r.onerror?.();
    });
    return r;
  }
}

interface FakeFlags {
  failOpen?: boolean;
  throwOnOpen?: boolean;
  failRead?: boolean;
  failWrite?: boolean;
}

/** A single-database, single-store IndexedDB with just the calls the store makes. */
function fakeIdb(flags: FakeFlags = {}) {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  let upgrades = 0;
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore(n: string) {
      stores.add(n);
    },
    transaction(_name: string, _mode: string) {
      if (flags.failRead === true) throw new Error("transaction failed");
      const tx = {
        oncomplete: null as Handler,
        onerror: null as Handler,
        onabort: null as Handler,
        objectStore: () => ({
          getAllKeys: () => FakeRequest.ok([...data.keys()]),
          getAll: () => FakeRequest.ok([...data.values()]),
          delete(k: string) {
            data.delete(k);
          },
          put(v: unknown, k: string) {
            queueMicrotask(() => {
              if (flags.failWrite === true) {
                tx.onerror?.();
                return;
              }
              data.set(k, v);
              tx.oncomplete?.();
            });
          },
        }),
      };
      return tx;
    },
  };
  const factory = {
    open(_name: string, _version: number) {
      if (flags.throwOnOpen === true) throw new Error("SecurityError");
      if (flags.failOpen === true) return FakeRequest.fail(null);
      const r = new FakeRequest<typeof db>();
      queueMicrotask(() => {
        r.result = db;
        if (!stores.has("textures")) {
          upgrades++;
          r.onupgradeneeded?.();
        }
        r.onsuccess?.();
      });
      return r;
    },
  };
  return {
    idb: factory as unknown as IDBFactory,
    data,
    flags,
    get upgrades() {
      return upgrades;
    },
  };
}

/** An OffscreenCanvas-like source whose PNG is its label. */
function offscreen(label: string, fail = false): Canvas2D["canvas"] {
  return {
    convertToBlob: () =>
      fail
        ? Promise.reject(new Error("encode failed"))
        : Promise.resolve(new Blob([label], { type: "image/png" })),
  } as unknown as Canvas2D["canvas"];
}

/** An HTMLCanvasElement-like source (callback `toBlob`). */
function htmlCanvas(label: string | null): Canvas2D["canvas"] {
  return {
    toBlob: (cb: (b: Blob | null) => void) =>
      cb(label === null ? null : new Blob([label], { type: "image/png" })),
  } as unknown as Canvas2D["canvas"];
}

/** Decodes a blob to its text (stands in for createImageBitmap). */
const decode = async (blob: Blob): Promise<CanvasImageSource> =>
  ({ decoded: await blob.text() }) as unknown as CanvasImageSource;

describe("memory store", () => {
  it("serves what was put, synchronously", async () => {
    const s = createMemoryStore();
    const c = offscreen("a");
    expect(s.get("k")).toBeUndefined();
    s.put("k", c);
    expect(s.get("k")).toBe(c);
    expect(s.size).toBe(1);
    expect(s.keys()).toEqual(["k"]);
    await expect(s.flush()).resolves.toBeUndefined();
  });
});

describe("IndexedDB texture store", () => {
  it("creates its object store, persists puts and serves them decoded after a reopen", async () => {
    const f = fakeIdb();
    const first = await openIdbTextureStore({ idb: f.idb, decode });
    expect(f.upgrades).toBe(1);
    expect(first.size).toBe(0);
    first.put("wood|512x256", offscreen("WOOD"));
    first.put("felt|256x256", htmlCanvas("FELT"));
    await first.flush();
    expect([...f.data.keys()].sort()).toEqual(["felt|256x256", "wood|512x256"]);
    expect((f.data.get("wood|512x256") as { v: string }).v).toBe(TEXTURE_CACHE_VERSION);

    const second = await openIdbTextureStore({ idb: f.idb, decode });
    expect(f.upgrades).toBe(1);
    expect(second.size).toBe(2);
    expect(second.get("wood|512x256")).toEqual({ decoded: "WOOD" });
    expect(second.get("felt|256x256")).toEqual({ decoded: "FELT" });
    expect(second.get("missing")).toBeUndefined();
  });

  it("discards entries from another cache version, non-blob entries and undecodable images", async () => {
    const f = fakeIdb();
    f.data.set("old", { v: "sg-tex-0", blob: new Blob(["OLD"]) });
    f.data.set("junk", { v: TEXTURE_CACHE_VERSION, blob: "not a blob" });
    f.data.set("broken", { v: TEXTURE_CACHE_VERSION, blob: new Blob(["BROKEN"]) });
    f.data.set("good", { v: TEXTURE_CACHE_VERSION, blob: new Blob(["GOOD"]) });
    const store = await openIdbTextureStore({
      idb: f.idb,
      decode: async (b) => {
        if ((await b.text()) === "BROKEN") throw new Error("decode failed");
        return decode(b);
      },
    });
    expect(store.size).toBe(1);
    expect(store.get("good")).toEqual({ decoded: "GOOD" });
    expect([...f.data.keys()]).toEqual(["good"]);
  });

  it("a different version option invalidates everything", async () => {
    const f = fakeIdb();
    const a = await openIdbTextureStore({ idb: f.idb, decode });
    a.put("k", offscreen("K"));
    await a.flush();
    const b = await openIdbTextureStore({ idb: f.idb, decode, version: "other" });
    expect(b.size).toBe(0);
    expect(f.data.size).toBe(0);
  });

  it("falls back to an empty in-memory store without IndexedDB or when it cannot open", async () => {
    const g = globalThis as { indexedDB?: IDBFactory };
    expect(g.indexedDB).toBeUndefined();
    const none = await openIdbTextureStore({ decode });
    expect(none.size).toBe(0);
    none.put("k", offscreen("K"));
    expect(none.get("k")).toBeDefined();
    for (const flags of [{ failOpen: true }, { throwOnOpen: true }] satisfies FakeFlags[]) {
      const s = await openIdbTextureStore({ idb: fakeIdb(flags).idb, decode });
      expect(s.size).toBe(0);
      s.put("k", offscreen("K"));
      expect(s.get("k")).toBeDefined();
    }
  });

  it("a failed read starts empty; failed encodes and writes are swallowed", async () => {
    const f = fakeIdb();
    f.data.set("good", { v: TEXTURE_CACHE_VERSION, blob: new Blob(["GOOD"]) });
    f.flags.failRead = true;
    const s = await openIdbTextureStore({ idb: f.idb, decode });
    expect(s.size).toBe(0);
    // Writes open a transaction too: with the database still failing, they are dropped.
    s.put("a", offscreen("A"));
    await expect(s.flush()).resolves.toBeUndefined();
    f.flags.failRead = false;
    s.put("b", offscreen("B", true));
    s.put("c", htmlCanvas(null));
    f.flags.failWrite = true;
    s.put("d", offscreen("D"));
    await expect(s.flush()).resolves.toBeUndefined();
    expect([...f.data.keys()]).toEqual(["good"]);
    f.flags.failWrite = false;
    s.put("e", offscreen("E"));
    await s.flush();
    expect([...f.data.keys()].sort()).toEqual(["e", "good"]);
  });
});
