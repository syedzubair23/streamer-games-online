/**
 * Sky material (research 03 §6: "Sky: none (shader)"): a vertical `sky-bottom → sky-top`
 * gradient with a smoothstep, and hashed-noise stars at night faded in by `uStars`. Colours and
 * star strength are uniforms, so an ambient mode change is a uniform lerp, never a recompile.
 * Drawn on the inside of a sphere (`BackSide`), unlit, no fog, no depth write.
 *
 * @module
 */
import { BackSide, Color, ShaderMaterial } from "three";
import { toColor } from "../color.ts";
import type { ColorLike } from "../types.ts";
import type { Uniform } from "./shared.ts";

/** The sky's uniforms (lerped by the ambient mode system). */
export interface SkyUniforms {
  [name: string]: Uniform<unknown>;
  uTop: Uniform<Color>;
  uBottom: Uniform<Color>;
  /** Star visibility 0..1 (night). */
  uStars: Uniform<number>;
  /** Direction `y` where the gradient starts and ends (default -0.05 … 0.6). */
  uLow: Uniform<number>;
  uHigh: Uniform<number>;
}

/** Options of {@link makeSkyMaterial}. */
export interface SkyOptions {
  top?: ColorLike;
  bottom?: ColorLike;
  stars?: number;
}

/** Vertex shader: passes the object-space direction. */
export const SKY_VERTEX = /* glsl */ `
varying vec3 vSkyDir;
void main() {
  vSkyDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** Fragment shader: gradient, hashed stars, tone mapping and output colour space. */
export const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uStars;
uniform float uLow;
uniform float uHigh;
varying vec3 vSkyDir;
float sgHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
void main() {
  vec3 d = normalize( vSkyDir );
  float h = smoothstep( uLow, uHigh, d.y );
  vec3 col = mix( uBottom, uTop, h );
  if ( uStars > 0.0 ) {
    vec2 cell = floor( vec2( atan( d.z, d.x ) * 90.0, d.y * 140.0 ) );
    float r = sgHash( cell );
    float star = step( 0.9965, r ) * smoothstep( 0.08, 0.45, d.y );
    col += vec3( 1.0, 0.94, 0.82 ) * star * uStars * ( 0.55 + 0.45 * fract( r * 97.0 ) );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Creates the sky material (the caller owns and disposes it). */
export function makeSkyMaterial(o: SkyOptions = {}): ShaderMaterial & { uniforms: SkyUniforms } {
  const uniforms: SkyUniforms = {
    uTop: { value: toColor(o.top ?? "#F6A58B", new Color()) },
    uBottom: { value: toColor(o.bottom ?? "#FFE1A8", new Color()) },
    uStars: { value: o.stars ?? 0 },
    uLow: { value: -0.05 },
    uHigh: { value: 0.6 },
  };
  const m = new ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  m.name = "sg-sky";
  m.userData["sgKind"] = "sky";
  return m as ShaderMaterial & { uniforms: SkyUniforms };
}
