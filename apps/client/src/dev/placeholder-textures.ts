/**
 * Procedural canvas textures for the scenario route's placeholder shell (`ctx.textures`,
 * SPEC §13.6). v1 ships no image files: every texture is painted at runtime from a seed, so the
 * route is deterministic and needs no network.
 *
 * Placeholder for `@sg/render/textures/*` (M1-06), which adds the art-directed versions and the
 * IndexedDB cache. The contract is the same: textures are cached and shared, games never dispose
 * them, and sizes are clamped per quality tier.
 *
 * @module
 */
import type {
  ColorLike,
  ProceduralTextureOptions,
  ProceduralTextures,
  QualityTier,
  TextureName,
} from "@sg/engine/client";
import { createRng, type Rng } from "@sg/shared";
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";

/** Maximum texture edge per tier (SPEC §10 texture budgets). */
export const MAX_TEXTURE_SIZE: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 256,
  mid: 512,
  high: 1024,
});

/** The 3-step toon ramp of SPEC §13.5. */
export const TOON_RAMP = [140, 205, 255] as const;

/** Colours the painters use when a caller gives no tint (the route's mode tokens). */
export interface TexturePalette {
  wood: string;
  felt: string;
  paper: string;
  wall: string;
  shadow: string;
  ink: string;
}

type Painter = (
  g: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  tint: string,
  variant: string | undefined,
) => void;

const css = (c: ColorLike | undefined, fallback: string): string =>
  c === undefined ? fallback : typeof c === "string" ? c : `#${c.getHexString()}`;

function speckle(g: CanvasRenderingContext2D, size: number, rng: Rng, n: number, a: number): void {
  for (let i = 0; i < n; i++) {
    const light = rng.float() < 0.5;
    g.fillStyle = light ? `rgba(255,250,240,${a})` : `rgba(40,20,30,${a})`;
    const r = 0.5 + rng.float() * (size / 256);
    g.fillRect(rng.float() * size, rng.float() * size, r, r);
  }
}

const PAINTERS: Readonly<Record<Exclude<TextureName, "ramp">, Painter>> = {
  noise(g, size, rng) {
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 96 + Math.floor(rng.float() * 64);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  },
  wood(g, size, rng, tint) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 2) {
      const wave = Math.sin(y * 0.045 + rng.float() * 0.4) * 0.5 + 0.5;
      g.fillStyle = `rgba(60,30,20,${(0.04 + wave * 0.07).toFixed(3)})`;
      g.fillRect(0, y, size, 1 + (rng.float() < 0.2 ? 1 : 0));
    }
    speckle(g, size, rng, size * 2, 0.05);
  },
  felt(g, size, rng, tint) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    speckle(g, size, rng, size * 12, 0.06);
  },
  paper(g, size, rng, tint) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    speckle(g, size, rng, size * 4, 0.035);
  },
  cork(g, size, rng, tint) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < size * 6; i++) {
      g.fillStyle = rng.float() < 0.5 ? "rgba(90,50,25,0.18)" : "rgba(255,235,200,0.14)";
      const r = 0.6 + rng.float() * 1.8 * (size / 256);
      g.beginPath();
      g.arc(rng.float() * size, rng.float() * size, r, 0, Math.PI * 2);
      g.fill();
    }
  },
  board(g, size, _rng, tint, variant) {
    const n = variant !== undefined && /^\d+$/.test(variant) ? Number(variant) : 8;
    const cell = size / n;
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    g.fillStyle = "rgba(40,20,30,0.18)";
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if ((x + y) % 2 === 1) g.fillRect(x * cell, y * cell, cell, cell);
  },
  cards(g, size, rng, tint) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    g.strokeStyle = "rgba(40,20,30,0.25)";
    g.lineWidth = Math.max(2, size / 64);
    const m = size * 0.06;
    g.strokeRect(m, m, size - 2 * m, size - 2 * m);
    speckle(g, size, rng, size, 0.03);
  },
  dice(g, size, _rng, tint) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    const cell = size / 3;
    g.fillStyle = "rgba(40,20,30,0.85)";
    for (let face = 0; face < 6; face++) {
      const ox = (face % 3) * cell;
      const oy = Math.floor(face / 3) * cell;
      const pips = face + 1;
      for (let p = 0; p < pips; p++) {
        const a = (p / pips) * Math.PI * 2;
        const r = pips === 1 ? 0 : cell * 0.25;
        g.beginPath();
        g.arc(ox + cell / 2 + Math.cos(a) * r, oy + cell / 2 + Math.sin(a) * r, cell * 0.07, 0, 7);
        g.fill();
      }
    }
  },
  blob(g, size) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.45)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  },
  matcap(g, size, _rng, tint, variant) {
    g.fillStyle = tint;
    g.fillRect(0, 0, size, size);
    const warm = variant !== "cool";
    const grad = g.createRadialGradient(
      size * 0.36,
      size * 0.3,
      size * 0.02,
      size / 2,
      size / 2,
      size * 0.55,
    );
    grad.addColorStop(0, warm ? "rgba(255,244,224,0.95)" : "rgba(232,240,255,0.95)");
    grad.addColorStop(0.45, "rgba(255,255,255,0.1)");
    grad.addColorStop(1, warm ? "rgba(80,30,40,0.55)" : "rgba(30,30,70,0.55)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  },
  grain(g, size, rng) {
    g.clearRect(0, 0, size, size);
    speckle(g, size, rng, size * 10, 0.08);
  },
};

/** The route's procedural texture set plus the bookkeeping the shell needs. */
export interface PlaceholderTextures {
  /** The `ctx.textures` API handed to games. */
  api: ProceduralTextures;
  /** Every texture created so far (shared, owned by the shell). */
  all(): readonly Texture[];
  /** Disposes every cached texture (shell teardown only). */
  dispose(): void;
}

/** Creates the cached procedural texture set for a quality tier and palette. */
export function createPlaceholderTextures(
  quality: QualityTier,
  palette: TexturePalette,
  doc: Document = document,
): PlaceholderTextures {
  const cache = new Map<string, CanvasTexture | DataTexture>();
  const max = MAX_TEXTURE_SIZE[quality];
  const defaults: Record<TextureName, { size: number; tint: string }> = {
    noise: { size: 128, tint: palette.wall },
    wood: { size: 512, tint: palette.wood },
    felt: { size: 256, tint: palette.felt },
    paper: { size: 256, tint: palette.paper },
    cork: { size: 256, tint: palette.wood },
    board: { size: 512, tint: palette.paper },
    cards: { size: 256, tint: palette.paper },
    dice: { size: 256, tint: palette.paper },
    blob: { size: 64, tint: palette.shadow },
    matcap: { size: 256, tint: palette.wall },
    ramp: { size: 3, tint: palette.ink },
    grain: { size: 128, tint: palette.ink },
  };

  const make = (
    name: TextureName,
    o: ProceduralTextureOptions = {},
  ): CanvasTexture | DataTexture => {
    const d = defaults[name];
    const size = Math.max(4, Math.min(max, Math.round(o.size ?? d.size)));
    const tint = css(o.tint, d.tint);
    const key = `${name}|${size}|${o.seed ?? 1}|${tint}|${o.variant ?? ""}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let tex: CanvasTexture | DataTexture;
    if (name === "ramp") {
      const data = new Uint8Array(TOON_RAMP);
      tex = new DataTexture(data, TOON_RAMP.length, 1, RedFormat);
      tex.minFilter = NearestFilter;
      tex.magFilter = NearestFilter;
      tex.generateMipmaps = false;
      tex.wrapS = ClampToEdgeWrapping;
      tex.needsUpdate = true;
    } else {
      const canvas = doc.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext("2d");
      if (g === null) throw new Error("placeholder textures: no 2D canvas context");
      PAINTERS[name](g, size, createRng(`${name}:${o.seed ?? 1}`), tint, o.variant);
      tex = new CanvasTexture(canvas);
      tex.colorSpace = name === "noise" || name === "blob" ? "" : SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.anisotropy = quality === "high" ? 4 : 1;
    }
    tex.name = `proc:${key}`;
    cache.set(key, tex);
    return tex;
  };

  const api = Object.freeze(
    Object.fromEntries(
      (Object.keys(defaults) as TextureName[]).map((name) => [
        name,
        (o?: ProceduralTextureOptions) => make(name, o),
      ]),
    ),
  ) as ProceduralTextures;

  return {
    api,
    all: () => [...cache.values()],
    dispose(): void {
      for (const t of cache.values()) t.dispose();
      cache.clear();
    },
  };
}

/** Approximate GPU bytes of a texture (RGBA8, plus a third for mipmaps). */
export function textureBytes(tex: Texture): number {
  const img = tex.image as { width?: number; height?: number } | null | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  const bpp = (tex as { format?: number }).format === RedFormat ? 1 : 4;
  const mip = tex.generateMipmaps ? 4 / 3 : 1;
  return Math.round(w * h * bpp * mip);
}
