/**
 * Procedural textures (SPEC §13.6): recipes paint deterministically from their seed through the
 * expected native operations (coarse periodic fields upscaled, gradients, patterns, paths), sizes
 * clamp per tier, textures are cached and shared, and the store serves cached canvases. The Node
 * canvas stub records calls and keeps real pixel buffers for `putImageData`; real rasterised
 * pixels (determinism, non-blank output, seamless tiling) and the 150 ms budget are covered by
 * `test/browser/*.spec.ts`.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRng } from "@sg/shared";
import { createSharedResources } from "../src/dispose.ts";
import {
  BLOB_STOPS,
  BOARD_FRAME,
  BOOT_SET,
  blobAlpha,
  cardCell,
  cardUV,
  CARD_ATLAS,
  createMemoryStore,
  createTextureKit,
  ALPHA_SHIFT,
  createTileNoise,
  defaultCanvasFactory,
  GREY,
  LITTLE_ENDIAN,
  OPAQUE,
  packRGBA,
  DEFAULT_PALETTE,
  diceFaceUV,
  DICE_ATLAS,
  drawPeriodicField,
  MATCAP_TONES,
  overlayTile,
  parseBoardVariant,
  PIP_LAYOUTS,
  PIP_R,
  RECIPES,
  TOON_RAMP,
  type TextureKit,
} from "../src/textures/index.ts";
import { TEXTURE_NAMES, type QualityTier, type TextureName } from "../src/types.ts";
import { fakeCanvasFactory, type FakeCanvas } from "./helpers/fake-canvas.ts";

function kit(
  tier: QualityTier = "mid",
  created: FakeCanvas[] = [],
  extra: Partial<Parameters<typeof createTextureKit>[0]> = {},
): TextureKit {
  let t = 0;
  return createTextureKit({
    tier,
    canvas: fakeCanvasFactory(created),
    now: () => (t += 1),
    ...extra,
  });
}
function canvasOf(
  k: TextureKit,
  name: TextureName,
  opts?: Parameters<TextureKit["api"]["wood"]>[0],
): FakeCanvas {
  const tex = k.api[name](opts);
  const c = k.canvasOf(tex) as unknown as FakeCanvas | undefined;
  if (c === undefined) throw new Error(`${name} has no canvas`);
  return c;
}

describe("tileable value noise", () => {
  it("is deterministic, in [0, 1) and wraps at the period", () => {
    const a = createTileNoise(createRng(1), 4, 4, 3);
    const b = createTileNoise(createRng(1), 4, 4, 3);
    for (let i = 0; i < 50; i++) {
      const u = i / 50;
      const v = ((i * 7) % 50) / 50;
      expect(a.fbm(u, v)).toBe(b.fbm(u, v));
      expect(a.fbm(u, v)).toBeGreaterThanOrEqual(0);
      expect(a.fbm(u, v)).toBeLessThan(1);
      expect(a.fbm(u + 1, v - 1)).toBeCloseTo(a.fbm(u, v), 9);
    }
    expect(a.octaves).toBe(3);
    expect(a.octave(9, 0.5, 0.5)).toBe(0);
    const c = createTileNoise(createRng(2), 0, 0, 1);
    expect(c.fbm(0.3, 0.3)).toBeGreaterThanOrEqual(0);
  });

  it("grid() is bit-identical to per-point fbm / octave calls", () => {
    const n = createTileNoise(createRng(7), 3, 2, 3);
    for (const [fw, fh, offset] of [
      [16, 16, 0],
      [64, 32, 0.5],
      [7, 5, 0.25],
    ] as const) {
      const g = n.grid(new Float64Array(fw * fh), fw, fh, { offset });
      const o1 = n.grid(new Float64Array(fw * fh + 3), fw, fh, { offset, octave: 1 });
      for (let y = 0; y < fh; y++)
        for (let x = 0; x < fw; x++) {
          const u = (x + offset) / fw;
          const v = (y + offset) / fh;
          expect(g[y * fw + x]).toBe(n.fbm(u, v));
          expect(o1[y * fw + x]).toBe(n.octave(1, u, v));
        }
      expect(o1[fw * fh]).toBe(0);
    }
    expect(() => n.grid(new Float64Array(3), 2, 2)).toThrow(RangeError);
    // An octave beyond the stack samples nothing.
    expect([...n.grid(new Float64Array(4), 2, 2, { octave: 9 })]).toEqual([0, 0, 0, 0]);
  });
});

describe("packed texels", () => {
  it("packRGBA writes RGBA bytes through a Uint32Array view on this platform's byte order", () => {
    const bytes = new Uint8ClampedArray(8);
    const words = new Uint32Array(bytes.buffer);
    words[0] = packRGBA(10, 20, 30, 40);
    words[1] = (packRGBA(1, 2, 3, 0) | (200 << ALPHA_SHIFT)) >>> 0;
    expect([...bytes]).toEqual([10, 20, 30, 40, 1, 2, 3, 200]);
    words[0] = (77 * GREY + OPAQUE) >>> 0;
    expect([...bytes.subarray(0, 4)]).toEqual([77, 77, 77, 255]);
    expect(LITTLE_ENDIAN).toBe(true);
    expect(packRGBA(300, -1, 0, 255)).toBe(packRGBA(300 & 255, 255, 0, 255));
  });
});

describe("periodic fields", () => {
  it("pads the field with wrapped texels and draws the padding just outside the canvas", () => {
    const created: FakeCanvas[] = [];
    const factory = fakeCanvasFactory(created);
    const target = factory(64, 32);
    // Field texel (x, y) holds r = x, g = y.
    drawPeriodicField(
      target.ctx,
      factory,
      64,
      32,
      4,
      2,
      (d, fw, fh) => {
        for (let y = 0; y < fh; y++)
          for (let x = 0; x < fw; x++) {
            const i = (y * fw + x) * 4;
            d[i] = x;
            d[i + 1] = y;
            d[i + 3] = 255;
          }
      },
      { smooth: false, alpha: 0.5, op: "overlay" },
    );
    const padded = created[1] as FakeCanvas;
    expect([padded.width, padded.height]).toEqual([6, 4]);
    const px = (x: number, y: number) => [
      padded.pixels[(y * 6 + x) * 4],
      padded.pixels[(y * 6 + x) * 4 + 1],
    ];
    expect(px(1, 1)).toEqual([0, 0]); // inner (0, 0)
    expect(px(4, 2)).toEqual([3, 1]); // inner (3, 1)
    expect(px(0, 1)).toEqual([3, 0]); // left pad ← last column
    expect(px(5, 1)).toEqual([0, 0]); // right pad ← first column
    expect(px(1, 0)).toEqual([0, 1]); // top pad ← last row
    expect(px(1, 3)).toEqual([0, 0]); // bottom pad ← first row
    expect(px(0, 0)).toEqual([3, 1]); // corners
    expect(px(5, 3)).toEqual([0, 0]);
    const t = target.canvas as unknown as FakeCanvas;
    expect(t.log).toContain("drawImage 6x4 0 0 6 4 -16 -16 96 64");
    expect(t.log).toContain("imageSmoothingEnabled=false");
    expect(t.log).toContain("globalCompositeOperation=overlay");
    expect(t.log).toContain("globalAlpha=0.5");
  });

  it("overlays a tile as a repeating pattern with a blend mode", () => {
    const f = fakeCanvasFactory();
    const a = f(32, 32);
    const tile = f(8, 8);
    overlayTile(a.ctx, tile.canvas, 32, 32, 0.2, "multiply");
    const log = (a.canvas as unknown as FakeCanvas).log;
    expect(log).toContain("globalCompositeOperation=multiply");
    expect(log).toContain("fillRect 0 0 32 32");
  });
});

describe("recipes", () => {
  it("cover every texture name except the data ramp", () => {
    expect(Object.keys(RECIPES).sort()).toEqual(TEXTURE_NAMES.filter((n) => n !== "ramp").sort());
  });

  it.each([
    "wood",
    "felt",
    "paper",
    "cork",
    "noise",
    "grain",
    "matcap",
    "dice",
    "board",
    "cards",
    "blob",
  ] as const)("%s paints the same way for the same seed", (name) => {
    const a = canvasOf(kit("mid"), name, { seed: 3 });
    const b = canvasOf(kit("mid"), name, { seed: 3 });
    expect(a.log.length).toBeGreaterThan(0);
    expect(a.log).toEqual(b.log);
    expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels))).toBe(true);
  });

  it.each(["wood", "felt"] as const)("%s depends on the seed (knots, fibres)", (name) => {
    const a = canvasOf(kit("mid"), name, { seed: 3 });
    const b = canvasOf(kit("mid"), name, { seed: 4 });
    expect(a.log).not.toEqual(b.log);
  });

  it.each(["cork", "noise", "grain", "paper"] as const)("%s fields depend on the seed", (name) => {
    const pixels = (seed: number) => {
      const created: FakeCanvas[] = [];
      canvasOf(kit("mid", created), name, { seed });
      return Buffer.concat(created.map((c) => Buffer.from(c.pixels)));
    };
    expect(pixels(3).equals(pixels(3))).toBe(true);
    expect(pixels(3).equals(pixels(4))).toBe(false);
  });

  it("white noise paints real per-pixel values", () => {
    const c = canvasOf(kit("mid"), "noise", { variant: "white" });
    let min = 255;
    let max = 0;
    for (let i = 0; i < c.pixels.length; i += 4) {
      min = Math.min(min, c.pixels[i] as number);
      max = Math.max(max, c.pixels[i] as number);
    }
    expect(max - min).toBeGreaterThan(200);
  });

  it("wood: rings, fibres and grain over the base; knots as eyes; the table adds the mat ellipse", () => {
    const k = kit("mid");
    const c = canvasOf(k, "wood");
    expect([c.width, c.height]).toEqual([512, 256]);
    // Two upscaled fields (rings, fibres) and knot eyes (radial gradients), then grain.
    expect(c.log.filter((l) => l.startsWith("drawImage")).length).toBe(2);
    expect(c.calls.filter((x) => x === "createRadialGradient").length).toBeGreaterThanOrEqual(2);
    expect(c.calls).toContain("createPattern");
    const table = canvasOf(k, "wood", { variant: "table" });
    // The table reuses the plain wood canvas of the same seed, then darkens the mat area.
    expect(table.log[0]).toBe("drawImage 512x256 0 0 512 256");
    expect(table.calls.filter((x) => x === "createRadialGradient").length).toBe(1);
    expect(k.api.wood({ variant: "table" }).wrapS).toBe(ClampToEdgeWrapping);
    expect(k.api.wood().wrapS).toBe(RepeatWrapping);
    // A tinted table reuses a tinted wood.
    const tinted = canvasOf(k, "wood", { variant: "table", tint: "#A57A5C" });
    expect(tinted.log[0]).toBe("drawImage 512x256 0 0 512 256");
  });

  it("paper: blotches, multiplied grain and, when ruled, faint blue rules", () => {
    const k = kit("mid");
    const plain = canvasOf(k, "paper");
    expect(plain.log).toContain("globalCompositeOperation=multiply");
    const ruled = canvasOf(k, "paper", { variant: "ruled" });
    expect(
      ruled.log.filter((l) => l.startsWith("fillRect 0 ") && l.endsWith(" 256 1")).length,
    ).toBe(8);
    expect(ruled.log).toContain("fillStyle=rgba(150,185,225,0.32)");
  });

  it("felt: two fibre paths (one per shade) with ≥ 200 fibres; cork: mottle, granules and grit", () => {
    const k = kit("mid");
    const felt = canvasOf(k, "felt");
    expect(felt.calls.filter((x) => x === "stroke").length).toBe(2);
    expect(felt.calls.filter((x) => x === "moveTo").length).toBeGreaterThanOrEqual(200);
    const cork = canvasOf(k, "cork");
    expect(cork.log.filter((l) => l.startsWith("drawImage")).length).toBe(2);
    expect(cork.log).toContain("imageSmoothingEnabled=false");
    expect(cork.log).toContain("globalCompositeOperation=overlay");
  });

  it("blob: a white radial gradient whose alpha follows the smoothstep falloff", () => {
    expect(blobAlpha(0)).toBe(1);
    expect(blobAlpha(1)).toBe(0);
    expect(blobAlpha(0.5)).toBeCloseTo(0.5, 6);
    const c = canvasOf(kit("low"), "blob");
    expect(c.width).toBe(64);
    expect(c.stops.length).toBe(BLOB_STOPS + 1);
    expect(c.stops[0]).toBe("0:rgba(255,255,255,1.0000)");
    expect(c.stops[BLOB_STOPS]).toBe("1:rgba(255,255,255,0.0000)");
  });

  it("matcap: disc clip, diffuse, fresnel and two highlights; cool and tinted variants change tones", () => {
    const k = kit("mid");
    const warm = canvasOf(k, "matcap", { variant: "warm" });
    expect(warm.calls.filter((x) => x === "createRadialGradient").length).toBe(4);
    expect(warm.calls).toContain("clip");
    expect(warm.stops[0]).toBe(`0:rgba(${MATCAP_TONES.warm.mid.join(",")},1)`);
    const cool = canvasOf(k, "matcap", { variant: "cool" });
    expect(cool.stops[0]).toBe(`0:rgba(${MATCAP_TONES.cool.mid.join(",")},1)`);
    const tinted = canvasOf(k, "matcap", { tint: "#5CC79A" });
    expect(tinted.stops[0]).toBe("0:rgba(92,199,154,1)");
  });

  it("dice: six faces in a 3 × 2 atlas with the standard pip layouts", () => {
    const c = canvasOf(kit("mid"), "dice");
    expect([c.width, c.height]).toEqual([384, 256]);
    expect(Object.keys(PIP_LAYOUTS).map((v) => PIP_LAYOUTS[Number(v) as 1].length)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(c.calls.filter((x) => x === "arc").length).toBe(21);
    // Face 1's single pip sits in the middle of cell 0.
    expect(c.log).toContain(
      `arc 64 64 ${Math.round(PIP_R * 128 * 1000) / 1000} 0 ${Math.round(Math.PI * 2 * 1000) / 1000}`,
    );
    expect(diceFaceUV(1)).toEqual([0, 0.5, 1 / 3, 1]);
    expect(diceFaceUV(6)).toEqual([2 / 3, 0, 1, 0.5]);
    expect(diceFaceUV(99)).toEqual(diceFaceUV(6));
    expect(DICE_ATLAS).toEqual({ cols: 3, rows: 2 });
  });

  it("board: parses layouts and paints tiles over the (shared, cached) wood", () => {
    expect(parseBoardVariant(undefined)).toEqual({ kind: "checker", n: 8 });
    expect(parseBoardVariant("grid-3")).toEqual({ kind: "grid", n: 3 });
    expect(parseBoardVariant("checker-40")).toEqual({ kind: "checker", n: 16 });
    expect(parseBoardVariant("nope")).toEqual({ kind: "checker", n: 8 });
    expect(BOARD_FRAME).toBeGreaterThan(0);
    const created: FakeCanvas[] = [];
    const k = kit("low", created);
    const board = canvasOf(k, "board", { variant: "grid-3" });
    expect(board.width).toBe(512);
    // Wood tiled twice (2:1), one fill for the grid tone, one inset blit per tile.
    expect(board.log.filter((l) => l.startsWith("drawImage 512x256")).length).toBe(2);
    expect(board.calls.filter((x) => x === "fill").length).toBe(1);
    expect(
      board.log.filter((l) => l.startsWith("drawImage") && !l.startsWith("drawImage 512x256"))
        .length,
    ).toBe(9);
    const checker = canvasOf(k, "board", { variant: "checker-8" });
    expect(checker.calls.filter((x) => x === "fill").length).toBe(2);
    // The wood it drew from is the cached default wood, painted once.
    expect(created.filter((c) => c.width === 512 && c.height === 256).length).toBe(1);
  });

  it("cards: an 8 × 4 atlas of 5:7 cards; numbers, blank and back variants", () => {
    expect(cardCell(1024)).toEqual({ w: 128, h: 179 });
    expect(cardCell(2048)).toEqual({ w: 256, h: 358 });
    const uv = cardUV(9, 1024);
    expect(uv[0]).toBeCloseTo(128 / 1024, 9);
    expect(uv[2]).toBeCloseTo(256 / 1024, 9);
    expect(uv[1]).toBeCloseTo(0.5, 9);
    expect(uv[3]).toBeCloseTo(0.75, 9);
    expect(cardUV(-5, 1024)).toEqual(cardUV(0, 1024));
    expect(CARD_ATLAS.cols * CARD_ATLAS.rows).toBe(32);
    const created: FakeCanvas[] = [];
    const k = kit("mid", created);
    const numbers = canvasOf(k, "cards");
    expect([numbers.width, numbers.height]).toEqual([1024, 717]);
    // The ten digits are shaped once into a glyph strip (then copied into a 180° strip); every
    // card gets its template plus its numeral twice (upright and rotated), composed from the
    // strip: 1–9 have one digit, 10–32 two, so 2 × (9 + 23 × 2) = 110 glyph blits.
    const strips = created.filter((c) => c.calls.includes("fillText"));
    expect(strips).toHaveLength(1);
    expect(
      strips[0]?.log.filter((l) => l.startsWith("fillText")).map((l) => l.split(" ")[1]),
    ).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(
      created.filter((c) => c.calls.includes("rotate") && c.calls.includes("drawImage")),
    ).toHaveLength(1);
    expect(numbers.calls.filter((c) => c === "fillText").length).toBe(0);
    expect(numbers.calls.filter((c) => c === "drawImage").length).toBe(32 + 110);
    // Card 12 (row 1, column 3; cell origin 387, 182; 122 × 173 card) at 30 px: glyph cells
    // are 26 × 53 (0.6 em advance + 2 × 4 px padding). Upright: "1" then "2" one advance (18 px)
    // later, anchored at (399, 192). Rotated about (497, 345): "1" rightmost, "2" to its left.
    expect(numbers.log).toContain("drawImage 260x53 26 0 26 53 395 188 26 53");
    expect(numbers.log).toContain("drawImage 260x53 52 0 26 53 413 188 26 53");
    expect(numbers.log).toContain("drawImage 261x53 208 0 26 53 475 296 26 53");
    expect(numbers.log).toContain("drawImage 261x53 182 0 26 53 457 296 26 53");
    const blank = canvasOf(k, "cards", { variant: "blank" });
    expect(blank.calls.filter((c) => c === "fillText").length).toBe(0);
    const back = canvasOf(k, "cards", { variant: "back" });
    expect(back.calls.filter((c) => c === "drawImage").length).toBe(32);
    expect(kit("high").api.cards().image.width).toBe(2048);
  });
});

describe("texture kit", () => {
  it("returns the 3-step toon ramp as a nearest-filtered single-channel DataTexture", () => {
    const k = kit("low");
    const r = k.api.ramp();
    expect(r).toBeInstanceOf(DataTexture);
    expect([...(r.image as { data: Uint8Array }).data]).toEqual([...TOON_RAMP]);
    expect(TOON_RAMP).toEqual([140, 205, 255]);
    expect(r.format).toBe(RedFormat);
    expect(r.magFilter).toBe(NearestFilter);
    expect(r.generateMipmaps).toBe(false);
    expect(k.api.ramp()).toBe(r);
    expect(k.shared.has(r)).toBe(true);
  });

  it("caches by options and registers every texture as shared", () => {
    const shared = createSharedResources();
    const k = kit("mid", [], { shared });
    const a = k.api.felt();
    expect(k.api.felt()).toBe(a);
    expect(k.api.felt({ seed: 1 })).toBe(a);
    expect(k.api.felt({ seed: 2 })).not.toBe(a);
    expect(k.api.felt({ tint: "#5FA89A" })).not.toBe(a);
    expect(shared.has(a)).toBe(true);
    expect(k.shared).toBe(shared);
    expect(k.all().length).toBe(3);
  });

  it("sets colour space, wrapping, mipmaps and anisotropy per recipe and tier", () => {
    const low = kit("low");
    const high = kit("high");
    expect(low.api.wood().colorSpace).toBe(SRGBColorSpace);
    expect(low.api.noise().colorSpace).toBe(NoColorSpace);
    expect(low.api.blob().wrapS).toBe(ClampToEdgeWrapping);
    expect(low.api.felt().wrapT).toBe(RepeatWrapping);
    expect(low.api.felt().anisotropy).toBe(1);
    expect(high.api.felt().anisotropy).toBe(4);
    expect(high.api.felt().generateMipmaps).toBe(true);
  });

  it("clamps sizes to the tier maximum and uses per-tier defaults", () => {
    expect(kit("low").api.board().image.width).toBe(512);
    expect(kit("mid").api.board().image.width).toBe(1024);
    expect(kit("low").api.board({ size: 4096 }).image.width).toBe(1024);
    expect(kit("high").api.board({ size: 4096 }).image.width).toBe(2048);
    expect(kit("high").api.wood().image.width).toBe(1024);
    expect(kit("mid").api.felt({ size: 1 }).image.width).toBe(4);
  });

  it("paints the boot set with per-entry timings", () => {
    const k = kit("low");
    const r = k.generateBoot();
    expect(Object.keys(r.entries)).toEqual(
      BOOT_SET.map((e) => (e.opts?.variant !== undefined ? `${e.name}:${e.opts.variant}` : e.name)),
    );
    expect(r.total).toBeGreaterThan(0);
    expect(k.timings.size).toBeGreaterThanOrEqual(BOOT_SET.length);
    for (const name of TEXTURE_NAMES)
      expect(k.all().some((t) => t.name.startsWith(`sg:${name}`))).toBe(true);
  });

  it("uses the palette defaults and overrides", () => {
    const k = kit("mid", [], { palette: { felt: "#5FA89A" } });
    const c = canvasOf(k, "felt");
    expect(c.log).toContain("fillStyle=rgba(95,168,154,1)");
    expect(DEFAULT_PALETTE.paper).toBe("#FBF5EA");
    expect(k.api.felt().name).toContain("#5fa89a");
  });

  it("serves previously painted canvases from the store", () => {
    const store = createMemoryStore();
    const a = kit("mid", [], { store });
    const painted = canvasOf(a, "grain");
    expect(store.size).toBe(1);
    expect(store.keys()[0]).toMatch(/^grain\|128x128\|1\|/);
    const b = kit("mid", [], { store });
    const cached = canvasOf(b, "grain");
    expect(b.storeHits).toBe(1);
    expect(Buffer.from(cached.pixels).equals(Buffer.from(painted.pixels))).toBe(true);
    expect(cached.calls).not.toContain("putImageData");
    return store.flush();
  });

  it("rejects unknown names and disposes everything on teardown", () => {
    const k = kit("low");
    expect(() => (k.api as unknown as Record<string, () => unknown>)["nope"]?.()).not.toThrow();
    const t = k.api.paper();
    let disposed = 0;
    t.addEventListener("dispose", () => disposed++);
    k.dispose();
    expect(disposed).toBe(1);
    expect(k.all().length).toBe(0);
    expect(k.shared.has(t)).toBe(false);
    expect(k.canvasOf(k.api.ramp())).toBeUndefined();
  });
});

describe("default canvas factory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers OffscreenCanvas", () => {
    const made: [number, number, unknown][] = [];
    class Offscreen {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext(kind: string, opts: unknown) {
        made.push([this.width, this.height, opts]);
        return kind === "2d" ? { kind } : null;
      }
    }
    vi.stubGlobal("OffscreenCanvas", Offscreen);
    const c = defaultCanvasFactory()(8, 4);
    expect(c.canvas).toBeInstanceOf(Offscreen);
    expect(c.ctx).toEqual({ kind: "2d" });
    expect(made).toEqual([[8, 4, { willReadFrequently: false }]]);
  });

  it("falls back to a <canvas> element, and fails clearly without any canvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const el = { width: 0, height: 0, getContext: (k: string) => (k === "2d" ? { k } : null) };
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "canvas" ? el : null) });
    const c = defaultCanvasFactory()(16, 9);
    expect(c.canvas).toBe(el);
    expect([el.width, el.height]).toEqual([16, 9]);
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(() => defaultCanvasFactory()(1, 1)).toThrow(/no 2D canvas context/);
    vi.stubGlobal("document", undefined);
    expect(() => defaultCanvasFactory()).toThrow(/no canvas available/);
  });

  it("reports an OffscreenCanvas without a 2D context", () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );
    expect(() => defaultCanvasFactory()(1, 1)).toThrow(/no 2D context on OffscreenCanvas/);
  });
});
