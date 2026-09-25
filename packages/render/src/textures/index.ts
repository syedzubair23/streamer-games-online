/**
 * The procedural texture kit (`ctx.textures`, SPEC §13.6): **the only texture factory**. v1
 * ships no image files; every texture is painted at runtime from a seed.
 *
 * - Textures are cached by (name, size, seed, tint, variant) and **shared**: games never
 *   dispose them (they are registered in {@link TextureKit.shared}, which `disposeObject3D`
 *   skips). The shell disposes the kit on teardown.
 * - Sizes are clamped to the tier's maximum; anisotropy follows the tier.
 * - {@link TextureKit.generateBoot} paints the boot set (one of each texture, both matcaps) and
 *   reports per-texture timings; the whole set stays within the SPEC §13.6 budget of 150 ms
 *   on a Chromebook-class CPU (the `textures.perf` spec runs it under a 4× CPU throttle).
 * - An optional {@link TextureStore} (IndexedDB) serves previously painted textures.
 *
 * @module
 */
import { createRng } from "@sg/shared";
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type DataTexture,
  type Texture,
} from "three";
import { toCss, toRGB } from "../color.ts";
import { createSharedResources, type SharedResources } from "../dispose.ts";
import { TIERS } from "../quality.ts";
import {
  TEXTURE_NAMES,
  type ColorLike,
  type ProceduralTextureOptions,
  type ProceduralTextures,
  type QualityTier,
  type TextureName,
} from "../types.ts";
import { blobRecipe } from "./blob.ts";
import { boardRecipe } from "./board.ts";
import type { TextureStore } from "./cache.ts";
import { defaultCanvasFactory, type Canvas2D, type CanvasFactory } from "./canvas.ts";
import { cardsRecipe } from "./cards.ts";
import { corkRecipe } from "./cork.ts";
import { diceRecipe } from "./dice.ts";
import { feltRecipe } from "./felt.ts";
import { grainRecipe } from "./grain.ts";
import { matcapRecipe } from "./matcap.ts";
import { noiseRecipe } from "./noise.ts";
import { paperRecipe } from "./paper.ts";
import { createRampTexture } from "./ramp.ts";
import { DEFAULT_PALETTE, type TextureRecipe, type TexturePalette } from "./recipe.ts";
import { woodRecipe } from "./wood.ts";

export { BLOB_STOPS, blobAlpha } from "./blob.ts";
export { BOARD_FRAME, BOARD_PAINT_ALPHA, parseBoardVariant, type BoardLayout } from "./board.ts";
export {
  createMemoryStore,
  openIdbTextureStore,
  TEXTURE_CACHE_VERSION,
  type IdbStoreOptions,
  type TextureStore,
} from "./cache.ts";
export {
  ALPHA_SHIFT,
  defaultCanvasFactory,
  drawPeriodicField,
  GREY,
  LITTLE_ENDIAN,
  OPAQUE,
  packRGBA,
  overlayTile,
  paintPixels,
  roundRectPath,
  type FieldOptions,
  type Canvas2D,
  type CanvasFactory,
  type Ctx2D,
} from "./canvas.ts";
export { CARD_ATLAS, CARD_FONT, cardCell, cardUV } from "./cards.ts";
export { DICE_ATLAS, diceFaceUV, PIP_LAYOUTS, PIP_R } from "./dice.ts";
export { FELT_FIBRES } from "./felt.ts";
export { GRAIN_CONTRAST } from "./grain.ts";
export { MATCAP_TONES } from "./matcap.ts";
export { createTileNoise, type GridOptions, type TileNoise } from "./noise.ts";
export { PAPER_GRAIN_ALPHA, PAPER_RULE_RGB, PAPER_RULES } from "./paper.ts";
export { createRampTexture, TOON_RAMP } from "./ramp.ts";
export {
  DEFAULT_PALETTE,
  type PaintInput,
  type TextureRecipe,
  type TexturePalette,
} from "./recipe.ts";

/** Every canvas recipe by name. */
export const RECIPES: Readonly<Record<Exclude<TextureName, "ramp">, TextureRecipe>> = Object.freeze(
  {
    noise: noiseRecipe,
    wood: woodRecipe,
    felt: feltRecipe,
    paper: paperRecipe,
    cork: corkRecipe,
    board: boardRecipe,
    cards: cardsRecipe,
    dice: diceRecipe,
    blob: blobRecipe,
    matcap: matcapRecipe,
    grain: grainRecipe,
  },
);

/** Options of {@link createTextureKit}. */
export interface TextureKitOptions {
  tier: QualityTier;
  /** Default colours (the active mode's tokens); missing entries use {@link DEFAULT_PALETTE}. */
  palette?: Partial<TexturePalette>;
  /** Canvas factory (default: OffscreenCanvas, else `<canvas>`). */
  canvas?: CanvasFactory;
  /** Previously painted textures (IndexedDB). */
  store?: TextureStore | null;
  /** Registry of shell-owned resources (created if omitted). */
  shared?: SharedResources;
  /** Clock for timings (default `performance.now`). */
  now?: () => number;
}

/** The texture kit: `ctx.textures` plus the shell's bookkeeping. */
export interface TextureKit {
  /** The game-facing API (`ctx.textures`). */
  readonly api: ProceduralTextures;
  readonly tier: QualityTier;
  /** Shell-owned resources: every cached texture is registered here. */
  readonly shared: SharedResources;
  /** Every texture created so far. */
  all(): readonly Texture[];
  /** The canvas behind a cached canvas texture (e.g. to build a CSS data URL). */
  canvasOf(texture: Texture): Canvas2D["canvas"] | undefined;
  /** Paints the boot set; returns ms per entry and the total. */
  generateBoot(): { total: number; entries: Record<string, number> };
  /** Time spent painting (ms) per cache key. */
  readonly timings: ReadonlyMap<string, number>;
  /** Cache hits served from the store. */
  readonly storeHits: number;
  /** Disposes every cached texture (shell teardown only). */
  dispose(): void;
}

/** The boot set: what the shell paints during the Iris load. */
export const BOOT_SET: readonly { name: TextureName; opts?: ProceduralTextureOptions }[] =
  Object.freeze([
    { name: "ramp" },
    { name: "blob" },
    { name: "noise" },
    { name: "grain" },
    { name: "matcap", opts: { variant: "warm" } },
    { name: "matcap", opts: { variant: "cool" } },
    { name: "wood" },
    { name: "wood", opts: { variant: "table" } },
    { name: "felt" },
    { name: "paper" },
    { name: "cork" },
    { name: "dice" },
    { name: "board" },
    { name: "cards" },
  ]);

function resolveWrap(r: TextureRecipe, variant: string | undefined): "repeat" | "clamp" {
  return typeof r.wrap === "function" ? r.wrap(variant) : r.wrap;
}

/** Creates the texture kit for a tier. */
export function createTextureKit(o: TextureKitOptions): TextureKit {
  const tier = o.tier;
  const preset = TIERS[tier];
  const palette: TexturePalette = { ...DEFAULT_PALETTE, ...o.palette };
  const factory = o.canvas ?? defaultCanvasFactory();
  const store = o.store ?? null;
  const shared = o.shared ?? createSharedResources();
  const now =
    o.now ?? (() => (globalThis as { performance?: { now(): number } }).performance?.now() ?? 0);
  const cache = new Map<string, CanvasTexture | DataTexture>();
  const canvases = new Map<string, Canvas2D>();
  const canvasByTexture = new WeakMap<Texture, Canvas2D["canvas"]>();
  const timings = new Map<string, number>();
  let storeHits = 0;
  // Scratch canvases (fields before upscaling, card/tile templates) are pooled by size: a
  // painter uses one and draws it immediately, so reuse is safe and saves canvas creation.
  const scratchPool = new Map<string, Canvas2D>();
  const scratch = (sw: number, sh: number): Canvas2D => {
    const key = `${sw}x${sh}`;
    let c = scratchPool.get(key);
    if (c === undefined) {
      c = factory(sw, sh);
      scratchPool.set(key, c);
    } else {
      // Reset state (clip, transform, alpha) as well as pixels before reuse.
      const ctx = c.ctx as Canvas2D["ctx"] & { reset?: () => void };
      if (typeof ctx.reset === "function") ctx.reset();
      else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, sw, sh);
      }
    }
    return c;
  };

  const sizeFor = (r: TextureRecipe, opts: ProceduralTextureOptions): { w: number; h: number } => {
    const want = opts.size ?? r.size(tier, opts.variant);
    const w = Math.max(4, Math.min(preset.maxTextureSize, Math.round(want)));
    const aspect = typeof r.aspect === "function" ? r.aspect(opts.variant) : r.aspect;
    return { w, h: Math.max(1, Math.round(w * aspect)) };
  };

  const keyOf = (
    name: TextureName,
    w: number,
    h: number,
    seed: number,
    tint: string,
    variant: string | undefined,
  ): string => `${name}|${w}x${h}|${seed}|${tint}|${variant ?? ""}`;

  /** Paints (or fetches) the canvas for a recipe; shared by textures and `source()`. */
  const canvasFor = (
    r: TextureRecipe,
    opts: ProceduralTextureOptions,
  ): { key: string; canvas: Canvas2D } => {
    const { w, h } = sizeFor(r, opts);
    const seed = opts.seed ?? 1;
    const tinted = opts.tint !== undefined;
    const tintColor: ColorLike = opts.tint ?? r.tint(palette);
    const tintCss = toCss(tintColor);
    const key = keyOf(r.name, w, h, seed, tintCss, opts.variant);
    const hit = canvases.get(key);
    if (hit !== undefined) return { key, canvas: hit };
    const t0 = now();
    const c = factory(w, h);
    const cached = store?.get(key);
    if (cached !== undefined) {
      c.ctx.drawImage(cached, 0, 0);
      storeHits++;
    } else {
      r.paint({
        ctx: c.ctx,
        w,
        h,
        rng: createRng(`${r.name}:${seed}:${opts.variant ?? ""}`),
        seed,
        tint: toRGB(tintColor),
        tinted,
        variant: opts.variant,
        palette,
        tier,
        source: (name, so = {}) => {
          const sr = RECIPES[name as Exclude<TextureName, "ramp">] as TextureRecipe | undefined;
          if (sr === undefined) throw new RangeError(`textures: "${name}" has no canvas`);
          return canvasFor(sr, {
            ...(so.w !== undefined ? { size: so.w } : {}),
            ...(so.seed !== undefined ? { seed: so.seed } : {}),
            ...(so.tint !== undefined ? { tint: so.tint } : {}),
            ...(so.variant !== undefined ? { variant: so.variant } : {}),
          }).canvas.canvas;
        },
        scratch,
      });
      store?.put(key, c.canvas);
    }
    timings.set(key, now() - t0);
    canvases.set(key, c);
    return { key, canvas: c };
  };

  const make = (
    name: TextureName,
    opts: ProceduralTextureOptions = {},
  ): CanvasTexture | DataTexture => {
    if (name === "ramp") {
      const key = "ramp";
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const t0 = now();
      const tex = createRampTexture();
      tex.name = "sg:ramp";
      cache.set(key, tex);
      shared.add(tex);
      timings.set(key, now() - t0);
      return tex;
    }
    const r = RECIPES[name] as TextureRecipe | undefined;
    if (r === undefined) throw new RangeError(`textures: unknown texture "${String(name)}"`);
    const { key, canvas } = canvasFor(r, opts);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const tex = new CanvasTexture(canvas.canvas as HTMLCanvasElement);
    tex.name = `sg:${key}`;
    tex.colorSpace = r.colorSpace === "srgb" ? SRGBColorSpace : NoColorSpace;
    const wrap = resolveWrap(r, opts.variant) === "repeat" ? RepeatWrapping : ClampToEdgeWrapping;
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = preset.anisotropy;
    tex.needsUpdate = true;
    cache.set(key, tex);
    canvasByTexture.set(tex, canvas.canvas);
    shared.add(tex);
    return tex;
  };

  const api = Object.freeze(
    Object.fromEntries(
      TEXTURE_NAMES.map((name) => [name, (opts?: ProceduralTextureOptions) => make(name, opts)]),
    ),
  ) as ProceduralTextures;

  return {
    api,
    tier,
    shared,
    all: () => [...cache.values()],
    canvasOf: (t) => canvasByTexture.get(t),
    generateBoot() {
      const entries: Record<string, number> = {};
      const t0 = now();
      for (const e of BOOT_SET) {
        const s = now();
        make(e.name, e.opts);
        const label = e.opts?.variant !== undefined ? `${e.name}:${e.opts.variant}` : e.name;
        entries[label] = now() - s;
      }
      return { total: now() - t0, entries };
    },
    timings,
    get storeHits() {
      return storeHits;
    },
    dispose() {
      for (const t of cache.values()) {
        shared.delete(t);
        t.dispose();
      }
      cache.clear();
      canvases.clear();
      scratchPool.clear();
    },
  };
}
