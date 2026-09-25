/**
 * The material factories (SPEC §13.5, §10): **the only source of materials**. Games reach them
 * through `ctx.materials`; lint bans `new *Material` everywhere outside `@sg/render`.
 *
 * {@link createMaterialFactories} binds the factories to a tier and to the shared procedural
 * textures (toon ramp, clay matcaps, blob). Materials keep the number of shader programs small:
 * every patched kind has a fixed program cache key, and ambient mode changes go through
 * {@link RenderMaterials.uniforms}.
 *
 * @module
 */
import type { Color, MeshBasicMaterial, ShaderMaterial, Texture } from "three";
import { toColor } from "../color.ts";
import { TIERS } from "../quality.ts";
import type { MaterialFactories, QualityTier } from "../types.ts";
import { makeBasicMaterial } from "./basic.ts";
import { makeBlobShadowMaterial, type BlobShadowOptions } from "./blob.ts";
import { makeLambertVCMaterial } from "./lambert-vc.ts";
import { makeMatcapMaterial } from "./matcap.ts";
import { createSharedUniforms, type SharedUniforms } from "./shared.ts";
import { makeSkyMaterial, type SkyOptions, type SkyUniforms } from "./sky.ts";
import { makeToonMaterial } from "./toon.ts";
import type { ColorLike } from "../types.ts";

export { makeBasicMaterial } from "./basic.ts";
export {
  BLOB_INSTANCED_KEY,
  BLOB_OPACITY_ATTRIBUTE,
  makeBlobShadowMaterial,
  patchInstanceOpacity,
  type BlobShadowOptions,
} from "./blob.ts";
export { bakeVertexAO, makeLambertVCMaterial, type VertexAOOptions } from "./lambert-vc.ts";
export { MATCAP_BLEND_KEY, makeMatcapMaterial, patchMatcapBlend } from "./matcap.ts";
export {
  applyOptions,
  createSharedUniforms,
  RIM_STRENGTH,
  type SharedUniforms,
  type Uniform,
} from "./shared.ts";
export {
  makeSkyMaterial,
  SKY_FRAGMENT,
  SKY_VERTEX,
  type SkyOptions,
  type SkyUniforms,
} from "./sky.ts";
export {
  makeToonMaterial,
  patchRim,
  RIM_GLSL,
  TOON_RIM_KEY,
  type PatchableShader,
} from "./toon.ts";

/** The shared textures the factories sample. */
export interface MaterialTextures {
  /** The 3-step toon ramp (`textures.ramp()`). */
  ramp: Texture;
  /** Warm and cool clay matcaps (`textures.matcap({ variant })`). */
  matcapWarm: Texture;
  matcapCool: Texture;
  /** The blob-shadow texture (`textures.blob()`). */
  blob: Texture;
}

/** The game-facing factories plus the shell-only ones and the shared uniforms. */
export interface RenderMaterials extends MaterialFactories {
  /** The sky gradient (shell only). */
  makeSky(opts?: SkyOptions): ShaderMaterial & { uniforms: SkyUniforms };
  /** A blob-shadow material on the shared blob texture (optionally per-instance opacity). */
  makeBlobShadow(opts?: Omit<BlobShadowOptions, "map">): MeshBasicMaterial;
  /** Uniforms shared by every material from these factories (the mode system lerps them). */
  readonly uniforms: SharedUniforms;
  /** Sets the rim colour (the mode's `hemi-sky`). */
  setRimColor(c: ColorLike): void;
  /** Sets the warm → cool matcap blend (0..1). */
  setMatcapBlend(t: number): void;
  readonly tier: QualityTier;
}

/** Creates the material factories for a tier. */
export function createMaterialFactories(
  tier: QualityTier,
  textures: MaterialTextures,
  uniforms: SharedUniforms = createSharedUniforms(),
): RenderMaterials {
  uniforms.uMatcapCool.value = textures.matcapCool;
  const rimDefault = TIERS[tier].rim;
  const toonCtx = { ramp: textures.ramp, uniforms, rimDefault };
  const matcapCtx = { warm: textures.matcapWarm, cool: textures.matcapCool, uniforms };
  return {
    tier,
    uniforms,
    makeToon: (o) => makeToonMaterial(toonCtx, o),
    makeMatcap: (o) => makeMatcapMaterial(matcapCtx, o),
    makeLambertVC: (o) => makeLambertVCMaterial(o),
    makeBasic: (o) => makeBasicMaterial(o),
    makeSky: (o) => makeSkyMaterial(o),
    makeBlobShadow: (o) => makeBlobShadowMaterial({ ...o, map: textures.blob }),
    setRimColor(c) {
      toColor(c, uniforms.uRimColor.value as Color);
    },
    setMatcapBlend(t) {
      uniforms.uMatcapBlend.value = Math.min(1, Math.max(0, t));
    },
  };
}
