/**
 * M0-06 reference board: `_style/` has 12–20 images from the six named sources, every game has
 * 3–6, SOURCES.md lists every image's URL, and the fetcher rebuilds the images.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANIFEST_PATH,
  type ReferenceEntry,
  type ReferenceManifest,
  SOURCES_PATH,
  STYLE_COUNT,
  fetchReferences,
  gameIds,
  loadManifest,
  missingReferences,
  referencePath,
  renderSources,
  validateManifest,
} from "../src/critic/references.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = loadManifest(root);
const games = gameIds(root);

const entry = (over: Partial<ReferenceEntry> = {}): ReferenceEntry => ({
  set: "_style",
  file: "tiny-glade-01.png",
  game: "Tiny Glade",
  steamAppId: 2198150,
  storePage: "https://store.steampowered.com/app/2198150/",
  url: "https://example.com/a.jpg",
  note: "warm light",
  ...over,
});

describe("the committed reference manifest", () => {
  it("satisfies every M0-06 rule", () => {
    expect(validateManifest(manifest, games)).toEqual([]);
  });

  it("has 12–20 _style images and 3–6 per game", () => {
    const style = manifest.entries.filter((e) => e.set === "_style").length;
    expect(style).toBeGreaterThanOrEqual(12);
    expect(style).toBeLessThanOrEqual(20);
    expect(games.length).toBe(8);
    for (const id of games) {
      const n = manifest.entries.filter((e) => e.set === id).length;
      expect(n, id).toBeGreaterThanOrEqual(3);
      expect(n, id).toBeLessThanOrEqual(6);
    }
  });

  it("SOURCES.md is generated from the manifest and lists every image URL", () => {
    const sources = readFileSync(join(root, SOURCES_PATH), "utf8");
    expect(sources).toBe(renderSources(manifest));
    for (const e of manifest.entries) {
      expect(sources).toContain(`\`${e.set}/${e.file}\``);
      expect(sources).toContain(e.url);
    }
  });

  it("keeps reference images out of git", () => {
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("/docs/references/**/*.png");
  });

  const present = missingReferences(root, manifest).length === 0;
  it.runIf(present)(
    "local images (after `pnpm refs:fetch`) are PNGs that fit the target size",
    async () => {
      for (const e of manifest.entries) {
        const meta = await sharp(referencePath(root, e)).metadata();
        expect(meta.format, e.file).toBe("png");
        expect(meta.width ?? 0).toBeLessThanOrEqual(manifest.size.width);
        expect(meta.height ?? 0).toBeLessThanOrEqual(manifest.size.height);
        expect(meta.width ?? 0).toBeGreaterThanOrEqual(640);
      }
    },
    60_000,
  );
});

describe("validateManifest", () => {
  const good = (): ReferenceManifest => JSON.parse(JSON.stringify(manifest)) as ReferenceManifest;

  it("flags too few or too many _style images", () => {
    const m = good();
    m.entries = m.entries.filter((e) => e.set !== "_style" || e.game === "Tiny Glade");
    const n = m.entries.filter((e) => e.set === "_style").length;
    expect(validateManifest(m, games).join("\n")).toMatch(new RegExp(`_style has ${n} images`));
    const big = good();
    const extra = STYLE_COUNT.max + 1 - big.entries.filter((e) => e.set === "_style").length;
    for (let i = 0; i < extra; i++)
      big.entries.push(entry({ file: `extra-${String(i).padStart(2, "0")}.png` }));
    expect(validateManifest(big, games).join("\n")).toMatch(
      new RegExp(`_style has ${STYLE_COUNT.max + 1} images`),
    );
  });

  it("flags a missing named source", () => {
    const m = good();
    m.entries = m.entries.map((e) =>
      e.game === "Townscaper" ? { ...e, game: "Something Else" } : e,
    );
    expect(validateManifest(m, games)).toContain("_style has no Townscaper image");
  });

  it("flags a game with too few images and an unknown set", () => {
    const m = good();
    m.entries = m.entries.filter((e) => e.set !== "chess");
    m.entries.push(entry({ set: "not-a-game", file: "x-01.png" }));
    const problems = validateManifest(m, games).join("\n");
    expect(problems).toMatch(/chess has 0 images/);
    expect(problems).toMatch(/unknown set "not-a-game"/);
  });

  it("flags bad names, URLs, store pages, notes and duplicates", () => {
    const m = good();
    m.entries.push(
      entry({ file: "Bad Name.jpg" }),
      entry({ file: "dup-01.png" }),
      entry({ file: "dup-01.png" }),
      entry({ file: "http-01.png", url: "http://insecure/a.jpg" }),
      entry({ file: "page-01.png", storePage: "https://example.com/" }),
      entry({ file: "appid-01.png", steamAppId: 1 }),
      entry({ file: "note-01.png", note: " " }),
    );
    const problems = validateManifest(m, games).join("\n");
    expect(problems).toMatch(/Bad Name\.jpg: file must be/);
    expect(problems).toMatch(/duplicate entry _style\/dup-01\.png/);
    expect(problems).toMatch(/http-01\.png: url must be https/);
    expect(problems).toMatch(/page-01\.png: storePage must be an official store page/);
    expect(problems).toMatch(/appid-01\.png: storePage does not match steamAppId 1/);
    expect(problems).toMatch(/note-01\.png: note is empty/);
  });

  it("pins every _style image by sha256 and checks the hash format", () => {
    const m = good();
    const { sha256: _drop, ...unpinned } = m.entries[0] as ReferenceEntry;
    m.entries.push(
      { ...unpinned, file: "unpinned-01.png" },
      entry({ file: "badhash-01.png", sha256: "ABC" }),
      entry({ set: "chess", file: "chess-extra-01.png" }),
    );
    const problems = validateManifest(m, games).join("\n");
    expect(problems).toMatch(/unpinned-01\.png: _style entries need the sha256/);
    expect(problems).toMatch(/badhash-01\.png: sha256 must be 64 lowercase hex/);
    expect(problems).not.toMatch(/chess-extra-01/);
  });
});

describe("the _style selection rules", () => {
  it("are written down in the manifest and rendered into SOURCES.md", () => {
    expect(manifest.styleSelection?.length ?? 0).toBeGreaterThanOrEqual(4);
    const text = renderSources(manifest);
    expect(text).toContain("## How the `_style/` frames were chosen");
    for (const rule of manifest.styleSelection ?? []) expect(text).toContain(rule);
    expect(renderSources({ ...manifest, styleSelection: [] })).not.toContain("How the");
  });

  it("give two frames per named source, none of them a title card", () => {
    const style = manifest.entries.filter((e) => e.set === "_style");
    const perGame = new Map<string, number>();
    for (const e of style) perGame.set(e.game, (perGame.get(e.game) ?? 0) + 1);
    expect([...perGame.values()].every((n) => n === 2)).toBe(true);
    expect(style.some((e) => /\btitle\b|\blogo\b/i.test(e.note))).toBe(false);
  });
});

describe("loadManifest", () => {
  let dir = "";
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const write = (body: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), "sg-refs-"));
    made.push(dir);
    mkdirSync(join(dir, "docs/references"), { recursive: true });
    writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(body));
    return dir;
  };

  it("rejects malformed manifests", () => {
    expect(() => loadManifest(write({ entries: [] }))).toThrow(/expected \{ size, entries/);
    expect(() => loadManifest(write({ size: { width: "x", height: 1 }, entries: [] }))).toThrow(
      /numeric/,
    );
    expect(() =>
      loadManifest(write({ size: { width: 1, height: 1 }, entries: [{ set: "_style" }] })),
    ).toThrow(/entry #1 is missing a field/);
    const base = {
      set: "_style",
      file: "a-01.png",
      game: "g",
      steamAppId: 1,
      storePage: "s",
      url: "u",
      note: "n",
    };
    expect(() =>
      loadManifest(write({ size: { width: 1, height: 1 }, entries: [{ ...base, sha256: 1 }] })),
    ).toThrow(/entry #1 sha256 must be a string/);
    expect(() =>
      loadManifest(write({ size: { width: 1, height: 1 }, entries: [base], styleSelection: [1] })),
    ).toThrow(/styleSelection must be an array of strings/);
    const ok = loadManifest(
      write({
        size: { width: 1, height: 1 },
        entries: [{ ...base, sha256: "a".repeat(64) }],
        styleSelection: ["rule"],
      }),
    );
    expect(ok.entries[0]?.sha256).toBe("a".repeat(64));
    expect(ok.styleSelection).toEqual(["rule"]);
  });
});

describe("fetchReferences", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const jpeg = (): Promise<Buffer> =>
    sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 200, g: 150, b: 90 } },
    })
      .jpeg()
      .toBuffer();
  const small: ReferenceManifest = {
    size: { width: 1280, height: 720 },
    entries: [
      entry(),
      entry({ set: "chess", file: "chess-ultra-01.png", url: "https://example.com/b.jpg" }),
    ],
  };

  it("downloads, scales to fit and stores PNGs; skips existing files unless forced", async () => {
    dir = mkdtempSync(join(tmpdir(), "sg-refs-"));
    const body = await jpeg();
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
    };
    const logs: string[] = [];
    const first = await fetchReferences(dir, small, { fetchImpl, log: (l) => logs.push(l) });
    expect(first.fetched).toEqual(["_style/tiny-glade-01.png", "chess/chess-ultra-01.png"]);
    expect(logs).toHaveLength(2);
    const meta = await sharp(join(dir, "docs/references/chess/chess-ultra-01.png")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1280, 720]);
    expect(missingReferences(dir, small)).toEqual([]);

    const second = await fetchReferences(dir, small, { fetchImpl });
    expect(second).toEqual({
      fetched: [],
      skipped: ["_style/tiny-glade-01.png", "chess/chess-ultra-01.png"],
    });
    const forced = await fetchReferences(dir, small, { fetchImpl, force: true });
    expect(forced.fetched).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  it("retries transient failures and gives up with a clear error", async () => {
    dir = mkdtempSync(join(tmpdir(), "sg-refs-"));
    const body = await jpeg();
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new Error("ECONNRESET");
      if (n === 2) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
    };
    const one: ReferenceManifest = { ...small, entries: [entry()] };
    await fetchReferences(dir, one, { fetchImpl: flaky, retryDelayMs: 1 });
    expect(n).toBe(3);
    expect(existsSync(referencePath(dir, entry()))).toBe(true);

    const down = async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      fetchReferences(dir, one, { fetchImpl: down, force: true, attempts: 2, retryDelayMs: 1 }),
    ).rejects.toThrow(/could not fetch _style\/tiny-glade-01\.png .*HTTP 404/);
  });

  it("stores a download whose sha256 matches the pin and refuses one that differs", async () => {
    dir = mkdtempSync(join(tmpdir(), "sg-refs-"));
    const body = await jpeg();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    const hash = createHash("sha256").update(body).digest("hex");
    const pinned: ReferenceManifest = { ...small, entries: [entry({ sha256: hash })] };
    expect((await fetchReferences(dir, pinned, { fetchImpl })).fetched).toHaveLength(1);
    const wrong: ReferenceManifest = { ...small, entries: [entry({ sha256: "0".repeat(64) })] };
    await expect(fetchReferences(dir, wrong, { fetchImpl, force: true })).rejects.toThrow(
      /has sha256 [0-9a-f]{64}, but the manifest pins 0{64}/,
    );
  });
});
