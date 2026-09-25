/**
 * State shared by every material factory: the uniforms an ambient mode change updates (so a
 * mode switch never recompiles a shader, ROADMAP M1-07), and the option applier.
 *
 * `onBeforeCompile` is allowed **only inside** `@sg/render/materials` (SPEC §10). Every patched
 * material sets a fixed `customProgramCacheKey`, so all materials of one kind share one program.
 *
 * @module
 */
import { Color, type Material, type Texture } from "three";
import { toColor } from "../color.ts";
import type { MaterialOptions } from "../types.ts";

/** A uniform slot (three's `IUniform`). */
export interface Uniform<T> {
  value: T;
}

/**
 * Uniforms shared by reference across every material a factory set creates. The ambient mode
 * system lerps these values; programs never change.
 */
export interface SharedUniforms {
  /** Rim "toy glow" colour (mixed toward `hemi-sky`, SPEC §13.5). */
  uRimColor: Uniform<Color>;
  /** Rim strength: `pow(1 - N·V, 3) * uRimStrength`; 0.35 on mid/high. */
  uRimStrength: Uniform<number>;
  /** Warm → cool matcap blend (0 warm, 1 cool) for `variant: "blend"` matcaps. */
  uMatcapBlend: Uniform<number>;
  /** The cool matcap sampled by blended matcaps. */
  uMatcapCool: Uniform<Texture | null>;
}

/** The SPEC §13.5 rim strength. */
export const RIM_STRENGTH = 0.35;

/** Creates the shared uniforms. */
export function createSharedUniforms(rimColor: Color = new Color(1, 1, 1)): SharedUniforms {
  return {
    uRimColor: { value: rimColor },
    uRimStrength: { value: RIM_STRENGTH },
    uMatcapBlend: { value: 0 },
    uMatcapCool: { value: null },
  };
}

/** The material fields {@link applyOptions} writes. */
type Optionable = Material & {
  color: Color;
  map: Texture | null;
};

/** Applies {@link MaterialOptions} to a material. */
export function applyOptions(m: Optionable, o: MaterialOptions | undefined): void {
  if (o === undefined) return;
  toColor(o.color, m.color);
  if (o.map !== undefined) m.map = o.map;
  if (o.vertexColors !== undefined) m.vertexColors = o.vertexColors;
  if (o.opacity !== undefined) {
    m.opacity = o.opacity;
    if (o.opacity < 1 && o.transparent === undefined) m.transparent = true;
  }
  if (o.transparent !== undefined) m.transparent = o.transparent;
}
