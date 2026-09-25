/**
 * Seeded, tileable value noise and fBm (research 03 §6: "a value-noise / fBm function (seeded,
 * 2–4 octaves) on a small grid, upscaled with bilinear filtering; there is no Perlin library"),
 * and the `noise` texture recipe.
 *
 * Every octave's lattice is precomputed into a `Float32Array` whose period divides the texture,
 * so repeating textures (felt, paper, cork, wood) tile seamlessly and a sample is four array reads.
 *
 * @module
 */
import type { Rng } from "@sg/shared";
import { drawPeriodicField, GREY, OPAQUE, paintPixels } from "./canvas.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Tileable multi-octave value noise over the unit square. */
export interface TileNoise {
  /** One octave (0 = coarsest) at unit coordinates `u, v` (wrapping), in `[0, 1)`. */
  octave(o: number, u: number, v: number): number;
  /** Normalised fBm (gain 0.5) at unit coordinates, in `[0, 1)`. */
  fbm(u: number, v: number): number;
  /**
   * Samples a whole `fw × fh` grid at once, row-major into `out` (length ≥ `fw × fh`): texel
   * `(x, y)` gets `fbm((x + offset) / fw, (y + offset) / fh)`, or a single octave with
   * `octave`. Bit-identical to the per-point calls, several times faster: the lattice indices
   * and smoothstep weights are computed once per column and per row, and the inner loop is
   * four array reads and three lerps (boot painting runs cold, in the interpreter, where
   * per-texel function calls dominate).
   */
  grid(out: Float64Array, fw: number, fh: number, o?: GridOptions): Float64Array;
  readonly octaves: number;
}

/** Options of {@link TileNoise.grid}. */
export interface GridOptions {
  /** Texel offset of the sample point (0: texel corner, 0.5: texel centre). Default 0. */
  offset?: number;
  /** Sample only this octave (raw, not normalised), instead of the normalised fBm. */
  octave?: number;
}

/**
 * Creates tileable noise with a `periodX × periodY` lattice at octave 0 (doubling per octave).
 * Values are uniform in `[0, 1)` from `rng`.
 */
export function createTileNoise(
  rng: Rng,
  periodX: number,
  periodY: number,
  octaves = 3,
): TileNoise {
  const px = Math.max(1, Math.floor(periodX));
  const py = Math.max(1, Math.floor(periodY));
  const layers: { w: number; h: number; data: Float32Array }[] = [];
  for (let o = 0; o < octaves; o++) {
    const w = px << o;
    const h = py << o;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = rng.float();
    layers.push({ w, h, data });
  }
  let norm = 0;
  for (let o = 0; o < octaves; o++) norm += 0.5 ** o;
  const inv = 1 / norm;

  const octave = (o: number, u: number, v: number): number => {
    const L = layers[o];
    if (L === undefined) return 0;
    const x = u * L.w;
    const y = v * L.h;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    let tx = x - fx;
    let ty = y - fy;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const x0 = ((fx % L.w) + L.w) % L.w;
    const y0 = ((fy % L.h) + L.h) % L.h;
    const x1 = x0 + 1 === L.w ? 0 : x0 + 1;
    const y1 = y0 + 1 === L.h ? 0 : y0 + 1;
    const d = L.data;
    const a = d[y0 * L.w + x0] as number;
    const b = d[y0 * L.w + x1] as number;
    const c = d[y1 * L.w + x0] as number;
    const e = d[y1 * L.w + x1] as number;
    const top = a + (b - a) * tx;
    const bot = c + (e - c) * tx;
    return top + (bot - top) * ty;
  };

  /** Lattice index pair and smoothstep weight per grid column (or row) for one octave. */
  const axis = (n: number, period: number, count: number, offset: number) => {
    const i0 = new Int32Array(count);
    const i1 = new Int32Array(count);
    const t = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const x = ((k + offset) / n) * period;
      const f = Math.floor(x);
      const tt = x - f;
      t[k] = tt * tt * (3 - 2 * tt);
      const a = ((f % period) + period) % period;
      i0[k] = a;
      i1[k] = a + 1 === period ? 0 : a + 1;
    }
    return { i0, i1, t };
  };

  const grid = (out: Float64Array, fw: number, fh: number, go: GridOptions = {}): Float64Array => {
    const n = fw * fh;
    if (out.length < n) throw new RangeError(`TileNoise.grid: out has ${out.length} < ${n} slots`);
    const offset = go.offset ?? 0;
    const only = go.octave;
    out.fill(0, 0, n);
    const first = only ?? 0;
    const last = only ?? octaves - 1;
    // fBm weights octave o by 0.5^o (as `fbm` does); a single raw octave has weight 1.
    for (let o = first, amp = 1; o <= last; o++, amp *= 0.5) {
      const L = layers[o];
      if (L === undefined) continue;
      const cx = axis(fw, L.w, fw, offset);
      const cy = axis(fh, L.h, fh, offset);
      const d = L.data;
      const a = only === undefined ? amp : 1;
      for (let y = 0, i = 0; y < fh; y++) {
        const r0 = (cy.i0[y] as number) * L.w;
        const r1 = (cy.i1[y] as number) * L.w;
        const ty = cy.t[y] as number;
        for (let x = 0; x < fw; x++, i++) {
          const x0 = cx.i0[x] as number;
          const x1 = cx.i1[x] as number;
          const tx = cx.t[x] as number;
          const p = d[r0 + x0] as number;
          const top = p + ((d[r0 + x1] as number) - p) * tx;
          const q = d[r1 + x0] as number;
          const bot = q + ((d[r1 + x1] as number) - q) * tx;
          out[i] = (out[i] as number) + (top + (bot - top) * ty) * a;
        }
      }
    }
    if (only === undefined) for (let i = 0; i < n; i++) out[i] = (out[i] as number) * inv;
    return out;
  };

  return {
    octaves,
    octave,
    grid,
    fbm(u, v) {
      let sum = 0;
      let amp = 1;
      for (let o = 0; o < octaves; o++) {
        sum += octave(o, u, v) * amp;
        amp *= 0.5;
      }
      return sum * inv;
    },
  };
}

/**
 * `noise`: tileable grey fBm (default), painted on a 32² grid and upscaled bilinearly, or
 * `variant: "white"` per-pixel white noise. Linear data (no colour space), for masks and shader
 * lookups.
 */
export const noiseRecipe: TextureRecipe = {
  name: "noise",
  size: () => 128,
  aspect: 1,
  colorSpace: "none",
  wrap: "repeat",
  tint: (p) => p.ink,
  paint({ ctx, w, h, rng, variant, scratch }) {
    if (variant === "white") {
      paintPixels(ctx, w, h, (d) => {
        for (let i = 0; i < d.length; i += 4) {
          const v = (rng.float() * 256) | 0;
          d[i] = v;
          d[i + 1] = v;
          d[i + 2] = v;
          d[i + 3] = 255;
        }
      });
      return;
    }
    const n = createTileNoise(rng, 4, 4, 3);
    const fw = Math.min(32, w);
    const fh = Math.min(32, h);
    const f = n.grid(new Float64Array(fw * fh), fw, fh);
    drawPeriodicField(ctx, scratch, w, h, fw, fh, (_d, _fw, _fh, px) => {
      for (let i = 0; i < px.length; i++)
        px[i] = ((((f[i] as number) * 255) | 0) * GREY + OPAQUE) >>> 0;
    });
  },
};
