/**
 * `matcap`: the procedural clay matcap (research 03 §6). A lit sphere drawn with native radial
 * gradients: the base shades from a warm mid tone (#E8DCD6) at the top-left toward the rim tone
 * (#9C8AA0) at the bottom right, a white highlight top-left, a subtle second highlight, and a
 * soft fresnel darkening at the silhouette. Outside the disc the rim tone continues (matcap
 * lookups stay inside at 0.495). `variant: "cool"` swaps in cool mid/rim tones (the matcap
 * material blends warm and cool per mode); a `tint` replaces the mid tone.
 *
 * @module
 */
import { rgba, toRGB, type RGB } from "../color.ts";
import type { TextureRecipe } from "./recipe.ts";

/** Warm and cool tone sets (mid, rim). */
export const MATCAP_TONES: Readonly<Record<"warm" | "cool", Readonly<{ mid: RGB; rim: RGB }>>> =
  Object.freeze({
    warm: Object.freeze({ mid: toRGB("#E8DCD6"), rim: toRGB("#9C8AA0") }),
    cool: Object.freeze({ mid: toRGB("#DCE2EC"), rim: toRGB("#8A90B2") }),
  });

const WHITE: RGB = [255, 255, 255];

export const matcapRecipe: TextureRecipe = {
  name: "matcap",
  size: () => 256,
  aspect: 1,
  colorSpace: "srgb",
  wrap: "clamp",
  tint: () => "#E8DCD6",
  paint({ ctx, w, h, variant, tint, tinted }) {
    const tones = MATCAP_TONES[variant === "cool" ? "cool" : "warm"];
    const mid = tinted ? tint : tones.mid;
    const rim = tones.rim;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2;
    ctx.fillStyle = rgba(rim, 1);
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    // Diffuse: lit from the top-left, falling to the rim tone at the bottom right.
    const base = ctx.createRadialGradient(w * 0.36, h * 0.3, 0, w * 0.42, h * 0.38, r * 1.25);
    base.addColorStop(0, rgba(mid, 1));
    base.addColorStop(0.45, rgba(mid, 1));
    base.addColorStop(1, rgba(rim, 1));
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    // Fresnel: soften toward the rim tone at the silhouette.
    const fres = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
    fres.addColorStop(0, rgba(rim, 0));
    fres.addColorStop(1, rgba(rim, 0.5));
    ctx.fillStyle = fres;
    ctx.fillRect(0, 0, w, h);
    // Key highlight (top-left) and a subtle second highlight (bottom-right bounce).
    const spec = ctx.createRadialGradient(w * 0.35, h * 0.29, 0, w * 0.35, h * 0.29, r * 0.42);
    spec.addColorStop(0, rgba(WHITE, 0.92));
    spec.addColorStop(0.35, rgba(WHITE, 0.45));
    spec.addColorStop(1, rgba(WHITE, 0));
    ctx.fillStyle = spec;
    ctx.fillRect(0, 0, w, h);
    const bounce = ctx.createRadialGradient(w * 0.72, h * 0.74, 0, w * 0.72, h * 0.74, r * 0.22);
    bounce.addColorStop(0, rgba(WHITE, 0.22));
    bounce.addColorStop(1, rgba(WHITE, 0));
    ctx.fillStyle = bounce;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  },
};
