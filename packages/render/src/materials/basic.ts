/**
 * Unlit material factory (SPEC §13.5): sky planes, halos ("fake bloom"), confetti and shadows.
 * `additive` gives the halo recipe: additive blending, transparent, no depth write.
 *
 * @module
 */
import { AdditiveBlending, MeshBasicMaterial } from "three";
import type { MaterialOptions } from "../types.ts";
import { applyOptions } from "./shared.ts";

/** Creates an unlit material (the caller owns and disposes it). */
export function makeBasicMaterial(
  o?: MaterialOptions & { additive?: boolean; depthWrite?: boolean },
): MeshBasicMaterial {
  const m = new MeshBasicMaterial();
  applyOptions(m, o);
  if (o?.additive === true) {
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
  }
  if (o?.depthWrite !== undefined) m.depthWrite = o.depthWrite;
  m.userData["sgKind"] = o?.additive === true ? "basic-additive" : "basic";
  return m;
}
