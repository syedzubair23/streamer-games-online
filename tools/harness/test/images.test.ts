import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  abPaths,
  imagesIn,
  makeAbPairs,
  ourAbShots,
  scoreAb,
  seededPick,
  shuffle,
} from "../ab-pairs.ts";
import { contactSheet, contactSheetsForRound } from "../contact-sheet.ts";
import { summarize } from "../pixel-diff.ts";
import { checkTokenContrast, composite, contrast, luminance, parseHex } from "../src/contrast.ts";
import {
  BLANK_STDDEV,
  compareDirs,
  diffImages,
  luminanceStdDev,
  readPng,
  writePng,
  type Rgba,
} from "../src/image.ts";
import { screenshotMatrix, STAGE_VIEWPORTS } from "../src/matrix.ts";
import type { ScenarioManifest } from "../src/scenarios/manifest.ts";
import { STREAM, streamFile, streamSim, streamSimRound } from "../stream-sim.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "sg-harness-"));

function solid(w: number, h: number, rgb: [number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

function stripes(w: number, h: number): Rgba {
  const img = solid(w, h, [20, 20, 20]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      img.data[i] = 230;
      img.data[i + 1] = 230;
      img.data[i + 2] = 230;
    }
  return img;
}

const png = (file: string, img: Rgba): string => {
  writeFileSync(file, writePng(img));
  return file;
};

describe("PNG checks", () => {
  it("flags a blank frame by its luma deviation (DOD G7)", () => {
    expect(luminanceStdDev(solid(8, 8, [120, 90, 60]))).toBeCloseTo(0, 3);
    expect(luminanceStdDev(stripes(8, 8))).toBeGreaterThan(BLANK_STDDEV);
    expect(luminanceStdDev({ width: 0, height: 0, data: new Uint8Array() })).toBe(0);
  });

  it("diffs exactly, round-trips PNG and compares directories", () => {
    const a = stripes(16, 8);
    const b = readPng(writePng(a));
    expect(diffImages(a, b)).toMatchObject({ diffPixels: 0, ratio: 0, sameSize: true });
    const c = readPng(writePng(a));
    c.data[0] = 0;
    expect(diffImages(a, c).diffPixels).toBe(1);
    expect(diffImages(a, solid(4, 4, [0, 0, 0]))).toMatchObject({ sameSize: false, ratio: 1 });

    const d1 = tmp();
    const d2 = tmp();
    png(join(d1, "same.png"), a);
    png(join(d2, "same.png"), a);
    png(join(d1, "diff.png"), a);
    png(join(d2, "diff.png"), c);
    png(join(d1, "only-a.png"), a);
    png(join(d2, "only-b.png"), a);
    const res = compareDirs(d1, d2);
    expect(res.map((r) => `${r.file}:${r.status}`)).toEqual([
      "diff.png:different",
      "only-a.png:missing-b",
      "only-b.png:missing-a",
      "same.png:same",
    ]);
    expect(compareDirs(join(d1, "nope"), join(d2, "nope"))).toEqual([]);
    expect(summarize(res, 0).ok).toBe(false);
    const sameOnly = res.filter((r) => r.status === "same");
    expect(summarize(sameOnly, 0)).toMatchObject({ ok: true });
    const diffOnly = res.filter((r) => r.status === "different");
    expect(summarize(diffOnly, 0).ok).toBe(false);
    expect(summarize(diffOnly, 0.02).ok).toBe(true); // 1 px of 128 is < 2%? no: 0.78%
    expect(summarize([], 0)).toEqual({ ok: false, lines: ["no PNGs to compare"] });
  });
});

describe("token contrast (DOD G9)", () => {
  it("computes WCAG ratios and flags ink that fails 4.5:1", () => {
    expect(parseHex("#102030")).toEqual([16, 32, 48]);
    expect(() => parseHex("#12")).toThrow();
    expect(luminance("#000000")).toBe(0);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(composite("#FFFFFF", 0.5, "#000000")).toBe("#808080");
    expect(
      checkTokenContrast({
        uiBg: "#FFF3E4",
        uiSurface: "#FFF9F1",
        uiSurfaceAlpha: 0.88,
        uiInk: "#3D2A33",
      }).ok,
    ).toBe(true);
    const bad = checkTokenContrast({
      uiBg: "#FFFFFF",
      uiSurface: "#FFFFFF",
      uiSurfaceAlpha: 1,
      uiInk: "#BBBBBB",
    });
    expect(bad.ok).toBe(false);
    expect(bad.failures.map((f) => f.pair)).toEqual(["ink/bg", "ink/surface"]);
  });
});

function fakeManifest(): ScenarioManifest {
  const s = (
    id: string,
    roles: ("stage" | "player" | "audience")[],
    anim: { name: string; durationMs: number } | null = null,
  ) => ({
    id,
    description: id,
    anim,
    roles,
    critic: "",
    variants: {},
    inSpec: true,
    registered: true,
  });
  return {
    game: "demo",
    spec: "x.md",
    perfScript: [],
    problems: [],
    notes: [],
    scenarios: [
      s("intro", ["stage", "audience"]),
      s("midgame", ["stage", "player"], { name: "pop", durationMs: 300 }),
    ],
  };
}

describe("stream-sim, contact sheets and A/B pairs", () => {
  it("stream-sim writes 1280×720 JPEGs for the dusk and night 1080p shots", async () => {
    const root = tmp();
    const dir = join(root, "artifacts/screenshots/demo/round-1");
    mkdirSync(dir, { recursive: true });
    for (const mode of ["dusk", "night"])
      png(join(dir, `intro__${mode}__1920x1080.png`), stripes(192, 108));
    const out = await streamSimRound(root, "demo", 1, ["intro"]);
    expect(out).toEqual([
      `artifacts/screenshots/demo/round-1/stream/${streamFile("intro", "dusk")}`,
      `artifacts/screenshots/demo/round-1/stream/${streamFile("intro", "night")}`,
    ]);
    const meta = await sharp(join(root, out[0]!)).metadata();
    expect(meta).toMatchObject({ width: STREAM.width, height: STREAM.height, format: "jpeg" });
    await expect(streamSimRound(root, "demo", 1, ["missing"])).rejects.toThrow(/missing/);
    await streamSim(join(dir, "intro__dusk__1920x1080.png"), join(root, "x/y.jpg"));
  });

  it("contact sheets tile every mode, the stream set, the controller set and the snow check", async () => {
    const root = tmp();
    const m = fakeManifest();
    const dir = join(root, "artifacts/screenshots/demo/round-2");
    mkdirSync(join(dir, "stream"), { recursive: true });
    for (const shot of screenshotMatrix(m))
      png(join(dir, shot.file), stripes(shot.viewport.width / 10, shot.viewport.height / 10));
    for (const mode of ["dusk", "night"])
      writeFileSync(
        join(dir, "stream", streamFile("intro", mode)),
        await sharp(writePng(stripes(64, 36)))
          .jpeg()
          .toBuffer(),
      );
    const files = await contactSheetsForRound(root, m, 2);
    expect(files.map((f) => f.split("/").pop())).toEqual([
      "stage-day.png",
      "stage-dusk.png",
      "stage-night.png",
      "stage-rain.png",
      "stream.png",
      "controller.png",
      "snow.png",
    ]);
    const meta = await sharp(join(root, files[0]!)).metadata();
    expect(meta.width).toBeGreaterThan(STAGE_VIEWPORTS.length * 100);
    await expect(
      contactSheet([{ file: null, label: "x" }], {
        title: "t",
        columns: ["a", "b"],
        rows: ["r"],
        cell: { width: 10, height: 10 },
      }),
    ).rejects.toThrow(/cells for 1×2/);
  });

  it("A/B pairs hide the key outside the critic inputs and score ties for us", async () => {
    const root = tmp();
    const ours = [
      png(join(root, "o1.png"), stripes(40, 20)),
      png(join(root, "o2.png"), stripes(40, 20)),
    ];
    const golden = [png(join(root, "g1.png"), solid(40, 20, [200, 100, 50]))];
    const external = [
      png(join(root, "e1.png"), solid(40, 20, [50, 100, 200])),
      png(join(root, "e2.png"), solid(20, 40, [90, 90, 90])),
    ];
    const outDir = join(root, "artifacts/critic/demo/ab-1");
    const keyFile = join(root, "artifacts/ab-keys/demo/ab-1.json");
    const run = () =>
      makeAbPairs({
        game: "demo",
        round: 1,
        ours,
        golden,
        external,
        perKind: 3,
        outDir,
        keyFile,
        pick: seededPick(7),
      });
    const { key, files, notes } = await run();
    expect(notes).toEqual([]);
    expect(files).toHaveLength(6);
    expect(imagesIn(outDir)).toHaveLength(6);
    expect(key.pairs.filter((p) => p.kind === "golden")).toHaveLength(3);
    expect(new Set(key.pairs.map((p) => p.ours)).size).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(keyFile, "utf8"))).toEqual(key);
    expect((await run()).key).toEqual(key); // seeded: reproducible
    const meta = await sharp(files[0]!).metadata();
    expect(meta.width).toBeGreaterThan(meta.height!);

    const answers = key.pairs.map((p, i) => ({
      pair: p.pair,
      choice: i === 0 ? ("tie" as const) : p.ours === "A" ? ("B" as const) : ("A" as const),
    }));
    const score = scoreAb(key, answers.slice(0, 5));
    expect(score.unanswered).toEqual([key.pairs[5]!.pair]);
    const firstKind = key.pairs[0]!.kind;
    expect(score[firstKind].oursOrTie).toBe(1);
    expect(scoreAb({ game: "g", round: 1, pairs: [] }, []).golden.share).toBeNull();

    await expect(
      makeAbPairs({
        game: "demo",
        round: 1,
        ours,
        golden,
        external,
        outDir,
        keyFile: join(outDir, "key.json"),
      }),
    ).rejects.toThrow(/must not live inside/);
    await expect(
      makeAbPairs({ game: "demo", round: 1, ours: [], golden, external, outDir, keyFile }),
    ).rejects.toThrow(/no shots/);
    const none = await makeAbPairs({
      game: "demo",
      round: 2,
      ours,
      golden: [],
      external: [],
      outDir: join(root, "o2"),
      keyFile: join(root, "k2.json"),
    });
    expect(none.notes).toEqual([
      "no golden references found: golden pairs skipped",
      "no external references found: external pairs skipped",
    ]);
    expect(abPaths("demo", 3)).toEqual({
      outDir: "artifacts/critic/demo/ab-3",
      keyFile: "artifacts/ab-keys/demo/ab-3.json",
    });
    expect(shuffle([1, 2, 3], seededPick(1)).sort()).toEqual([1, 2, 3]);
    const shotDir = join(root, "artifacts/screenshots/demo/round-1");
    mkdirSync(shotDir, { recursive: true });
    png(join(shotDir, "a__dusk__1920x1080.png"), stripes(4, 4));
    png(join(shotDir, "a__dusk__360x800.png"), stripes(4, 4));
    png(join(shotDir, "a__snow__1920x1080.png"), stripes(4, 4));
    expect(ourAbShots(root, "demo", 1).map((f) => f.split(/[\\/]/).pop())).toEqual([
      "a__dusk__1920x1080.png",
    ]);
  });
});
