/**
 * Blob-shadow material (SPEC §10 "Shadows: blob" on every tier, research 03 §5.3): the shared
 * 64² radial blob texture tinted with the mode's `shadow` token, transparent, no depth write and
 * a polygon offset so it never z-fights the mat. With `instanced: true` each instance reads its
 * opacity from an `aOpacity` instance attribute, so a jumping token's shadow fades with height
 * while every shadow stays one draw call.
 *
 * @module
 */
import { MeshBasicMaterial, type Texture } from "three";
import { toColor } from "../color.ts";
import type { ColorLike } from "../types.ts";
import type { PatchableShader } from "./toon.ts";

/** Program cache key of instanced blob shadows. */
export const BLOB_INSTANCED_KEY = "sg-blob-instanced-v1";
/** The per-instance opacity attribute read by instanced blob shadows. */
export const BLOB_OPACITY_ATTRIBUTE = "aOpacity";

/** Options of {@link makeBlobShadowMaterial}. */
export interface BlobShadowOptions {
  /** The blob texture (`textures.blob()`). */
  map: Texture;
  /** The mode's `shadow` token. */
  color?: ColorLike;
  /** The mode's shadow alpha (SPEC §13.2, 26–45%). */
  opacity?: number;
  /** Read per-instance opacity from `aOpacity`. */
  instanced?: boolean;
}

/** Adds the per-instance opacity to a basic-material shader (throws if three changed). */
export function patchInstanceOpacity(shader: PatchableShader): void {
  const vAnchor = "#include <begin_vertex>";
  const fAnchor = "#include <alphamap_fragment>";
  if (!shader.vertexShader.includes(vAnchor) || !shader.fragmentShader.includes(fAnchor))
    throw new Error("blob shadow: three.js basic shader layout changed");
  shader.vertexShader =
    `attribute float ${BLOB_OPACITY_ATTRIBUTE};\nvarying float vSgOpacity;\n` +
    shader.vertexShader.replace(vAnchor, `${vAnchor}\n  vSgOpacity = ${BLOB_OPACITY_ATTRIBUTE};`);
  shader.fragmentShader =
    "varying float vSgOpacity;\n" +
    shader.fragmentShader.replace(fAnchor, `${fAnchor}\n  diffuseColor.a *= vSgOpacity;`);
}

/** Creates a blob-shadow material (the caller owns and disposes it). */
export function makeBlobShadowMaterial(o: BlobShadowOptions): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    map: o.map,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    opacity: o.opacity ?? 0.32,
  });
  toColor(o.color ?? "#7A3F5C", m.color);
  m.name = "sg-blob-shadow";
  m.userData["sgKind"] = o.instanced === true ? "blob-instanced" : "blob";
  if (o.instanced === true) {
    m.onBeforeCompile = (shader) => patchInstanceOpacity(shader as unknown as PatchableShader);
    m.customProgramCacheKey = () => BLOB_INSTANCED_KEY;
  }
  return m;
}
