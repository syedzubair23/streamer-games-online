/**
 * Toon material factory (SPEC §13.5): `MeshToonMaterial` on the 3-step ramp `[140, 205, 255]`,
 * plus the signature rim "toy glow" `pow(1 - N·V, 3) * 0.35` on mid and high tiers (research 03
 * §5.2). The rim is a four-line `onBeforeCompile` patch reading shared uniforms, so every rim toon
 * shares one program and a mode change only updates uniform values.
 *
 * @module
 */
import { MeshToonMaterial, type Texture } from "three";
import type { MaterialOptions } from "../types.ts";
import { applyOptions, type SharedUniforms } from "./shared.ts";

/** Program cache key of rim toons (all rim toons share one program). */
export const TOON_RIM_KEY = "sg-toon-rim-v1";

/** The GLSL inserted before `#include <opaque_fragment>` in the toon fragment shader. */
export const RIM_GLSL = /* glsl */ `
  {
    float sgRim = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );
    outgoingLight += uRimColor * ( sgRim * uRimStrength );
  }
`;

const ANCHOR = "#include <opaque_fragment>";

/** Inputs of {@link makeToonMaterial}. */
export interface ToonContext {
  ramp: Texture;
  uniforms: SharedUniforms;
  /** Rim on by default (mid/high tiers). */
  rimDefault: boolean;
}

/** A shader as `onBeforeCompile` receives it (the fields the patches touch). */
export interface PatchableShader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
  vertexShader: string;
}

/** Adds the rim term to a toon fragment shader (throws if three's chunk layout changed). */
export function patchRim(shader: PatchableShader, u: SharedUniforms): void {
  if (!shader.fragmentShader.includes(ANCHOR))
    throw new Error("toon rim: three.js toon shader has no <opaque_fragment> chunk");
  shader.uniforms["uRimColor"] = u.uRimColor;
  shader.uniforms["uRimStrength"] = u.uRimStrength;
  shader.fragmentShader =
    "uniform vec3 uRimColor;\nuniform float uRimStrength;\n" +
    shader.fragmentShader.replace(ANCHOR, `${RIM_GLSL}\n${ANCHOR}`);
}

/** Creates a toon material (the caller owns and disposes it). */
export function makeToonMaterial(
  ctx: ToonContext,
  o?: MaterialOptions & { rim?: boolean },
): MeshToonMaterial {
  const m = new MeshToonMaterial({ gradientMap: ctx.ramp });
  applyOptions(m, o);
  const rim = o?.rim ?? ctx.rimDefault;
  m.userData["sgKind"] = rim ? "toon-rim" : "toon";
  if (rim) {
    m.onBeforeCompile = (shader) => patchRim(shader as unknown as PatchableShader, ctx.uniforms);
    m.customProgramCacheKey = () => TOON_RIM_KEY;
  }
  return m;
}
