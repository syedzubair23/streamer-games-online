/**
 * Matcap material factory (SPEC §13.5): `MeshMatcapMaterial` on the procedural clay matcap, for
 * chess and clay objects. `variant: "blend"` (the default) samples the warm and the cool matcap
 * and mixes them by the shared `uMatcapBlend` uniform, so the ambient mode tints clay without a
 * texture swap or a recompile. `warm` / `cool` use one matcap and the stock program.
 *
 * @module
 */
import { MeshMatcapMaterial, type Texture } from "three";
import type { MaterialOptions } from "../types.ts";
import { applyOptions, type SharedUniforms } from "./shared.ts";
import type { PatchableShader } from "./toon.ts";

/** Program cache key of blended matcaps. */
export const MATCAP_BLEND_KEY = "sg-matcap-blend-v1";

const SAMPLE = "vec4 matcapColor = texture2D( matcap, uv );";
const BLENDED =
  "vec4 matcapColor = mix( texture2D( matcap, uv ), texture2D( uMatcapCool, uv ), uMatcapBlend );";

/** Inputs of {@link makeMatcapMaterial}. */
export interface MatcapContext {
  warm: Texture;
  cool: Texture;
  uniforms: SharedUniforms;
}

/** Replaces the matcap sample with the warm/cool blend (throws if three's shader changed). */
export function patchMatcapBlend(shader: PatchableShader, u: SharedUniforms): void {
  if (!shader.fragmentShader.includes(SAMPLE))
    throw new Error("matcap blend: three.js matcap shader layout changed");
  shader.uniforms["uMatcapCool"] = u.uMatcapCool;
  shader.uniforms["uMatcapBlend"] = u.uMatcapBlend;
  shader.fragmentShader =
    "uniform sampler2D uMatcapCool;\nuniform float uMatcapBlend;\n" +
    shader.fragmentShader.replace(SAMPLE, BLENDED);
}

/** Creates a matcap material (the caller owns and disposes it). */
export function makeMatcapMaterial(
  ctx: MatcapContext,
  o?: MaterialOptions & { variant?: "warm" | "cool" | "blend" },
): MeshMatcapMaterial {
  const variant = o?.variant ?? "blend";
  const m = new MeshMatcapMaterial({ matcap: variant === "cool" ? ctx.cool : ctx.warm });
  applyOptions(m, o);
  m.userData["sgKind"] = `matcap-${variant}`;
  if (variant === "blend") {
    if (ctx.uniforms.uMatcapCool.value === null) ctx.uniforms.uMatcapCool.value = ctx.cool;
    m.onBeforeCompile = (shader) =>
      patchMatcapBlend(shader as unknown as PatchableShader, ctx.uniforms);
    m.customProgramCacheKey = () => MATCAP_BLEND_KEY;
  }
  return m;
}
