/**
 * Lambert + vertex-colour AO (SPEC §13.5): the room and table material. Lighting is evaluated
 * by Lambert (no specular), and ambient occlusion is baked into a `color` vertex attribute once
 * at build time by {@link bakeVertexAO}, so it costs nothing per frame.
 *
 * @module
 */
import { BufferAttribute, MeshLambertMaterial, type BufferGeometry } from "three";
import { clamp01 } from "../color.ts";
import type { MaterialOptions } from "../types.ts";
import { applyOptions } from "./shared.ts";

/**
 * Creates a Lambert material with vertex colours on (the caller owns and disposes it). Geometry
 * drawn with it needs a `color` attribute ({@link bakeVertexAO}); pass `vertexColors: false`
 * for plain Lambert.
 */
export function makeLambertVCMaterial(o?: MaterialOptions): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true });
  applyOptions(m, o);
  m.userData["sgKind"] = m.vertexColors ? "lambert-vc" : "lambert";
  return m;
}

/** Options of {@link bakeVertexAO}. */
export interface VertexAOOptions {
  /** Darkening at the lowest vertices (default 0.35). */
  strength?: number;
  /** Extra darkening of faces pointing down (default 0.25). */
  underside?: number;
  /** Height (above the geometry's min Y) over which AO fades out (default: full height). */
  falloff?: number;
}

/**
 * Bakes a soft height- and orientation-based ambient occlusion into a grey-scale `color`
 * attribute (multiplied with the material colour): vertices near the bottom of the geometry and
 * faces pointing down get darker, which grounds props on the table without shadow maps.
 * Overwrites an existing `color` attribute. Returns the geometry.
 */
export function bakeVertexAO<G extends BufferGeometry>(geometry: G, o: VertexAOOptions = {}): G {
  const pos = geometry.getAttribute("position");
  const nrm = geometry.hasAttribute("normal") ? geometry.getAttribute("normal") : undefined;
  const n = pos.count;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const minY = box?.min.y ?? 0;
  const span = o.falloff ?? Math.max(1e-6, (box?.max.y ?? 1) - minY);
  const strength = o.strength ?? 0.35;
  const under = o.underside ?? 0.25;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const h = clamp01((pos.getY(i) - minY) / span);
    let ao = 1 - strength * (1 - h) * (1 - h);
    if (nrm !== undefined) {
      const ny = nrm.getY(i);
      if (ny < 0) ao += under * ny;
    }
    const v = clamp01(ao);
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}
