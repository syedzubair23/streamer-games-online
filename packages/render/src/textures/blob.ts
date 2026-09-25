/**
 * `blob`: the blob-shadow and halo sprite (research 03 §6): a 64² radial gradient, white, with
 * alpha falling from 1 at the centre to 0 at the edge on a smoothstep. The shadow colour comes
 * from the material (`shadow` token), so one texture serves every mode. Drawn with a native
 * radial gradient whose stops sample the smoothstep curve.
 *
 * @module
 */
import { smoothstep } from "../color.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Alpha of the blob at normalised radius `r` (0 centre, 1 edge). */
export function blobAlpha(r: number): number {
  return 1 - smoothstep(0, 1, r);
}

/** Gradient stops sampling {@link blobAlpha}. */
export const BLOB_STOPS = 12;

export const blobRecipe: TextureRecipe = {
  name: "blob",
  size: () => 64,
  aspect: 1,
  colorSpace: "none",
  wrap: "clamp",
  tint: () => "#FFFFFF",
  paint({ ctx, w, h, tint }) {
    const r = Math.min(w, h) / 2;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r);
    for (let i = 0; i <= BLOB_STOPS; i++) {
      const t = i / BLOB_STOPS;
      g.addColorStop(t, `rgba(${tint[0]},${tint[1]},${tint[2]},${blobAlpha(t).toFixed(4)})`);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
};
