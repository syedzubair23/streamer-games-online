/**
 * `ramp`: the toon gradient (SPEC §13.5, research 03 §6): a 3 × 1 single-channel `DataTexture`
 * with the steps `[140, 205, 255]`, nearest-filtered and without mipmaps so the toon shading
 * shows three clean bands.
 *
 * @module
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  UnsignedByteType,
} from "three";

/** The SPEC §13.5 toon ramp. */
export const TOON_RAMP: readonly number[] = Object.freeze([140, 205, 255]);

/** Creates the toon ramp texture (optionally other steps, e.g. for a softer variant). */
export function createRampTexture(steps: readonly number[] = TOON_RAMP): DataTexture {
  const data = new Uint8Array(steps.map((s) => Math.max(0, Math.min(255, Math.round(s)))));
  const tex = new DataTexture(data, data.length, 1, RedFormat, UnsignedByteType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
